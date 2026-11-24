import logging
import re
from collections import Counter
from dataclasses import dataclass
from datetime import date
from decimal import Decimal

from rag_sidecar.contracts.ingest import InvoiceFields, InvoiceLineItem, InvoiceParty, OcrLanguage
from rag_sidecar.extract.amounts import detect_currency, parse_amount
from rag_sidecar.extract.dates import find_date
from rag_sidecar.extract.labels import COLUMN_LABELS, FIELD_LABELS, TOTAL_ROW_LABELS
from rag_sidecar.extract.tax_ids import TaxIdCheck, classify_tax_id

logger = logging.getLogger(__name__)

_MAX_LINE_CHARS = 400
_MAX_MERGED_LINE_CHARS = 4000
_MAX_INVOICE_NUMBER_CHARS = 64
_MAX_LINE_ITEMS = 1000
_TOTALS_TOLERANCE = Decimal("0.01")
_REQUIRED_FIELDS = ("invoice_number", "issue_date", "supplier", "buyer", "gross_total")
_MISSING_NUMBER_CONFIDENCE_CAP = 0.4
_TOTALS_MISMATCH_PENALTY = 0.2
_INVALID_TAX_ID_PENALTY = 0.1

_QUALIFIER = r"(?:[\s.#°\d%％,/\-]|[(（][^)）\n]{0,12}[)）])*"
_LATIN_BOUNDARY = r"(?![A-Za-zÀ-ÖØ-öø-ÿ])"
_LEADING_MARKUP = re.compile(r"^[#>*\-\s]+")
_SEPARATOR_CELL = re.compile(r":?-*:?")
_PARTY_ROLES = ("supplier", "buyer")
_AMOUNT_FIELDS = ("gross_total", "net_total", "tax_total")


@dataclass(frozen=True)
class _LabelRule:
    field: str
    language: str
    length: int
    pattern: re.Pattern[str]
    inline: re.Pattern[str]


def _compile_rules() -> list[_LabelRule]:
    rules: list[_LabelRule] = []
    for field, by_language in FIELD_LABELS.items():
        for language, labels in by_language.items():
            for label in labels:
                boundary = _LATIN_BOUNDARY if label[-1].isascii() and label[-1].isalpha() else ""
                head = rf"{re.escape(label)}{boundary}{_QUALIFIER}[:：]"
                pattern = re.compile(rf"{head}\s*(?P<value>.*)", re.IGNORECASE)
                inline = re.compile(rf"(?<!\S){head}", re.IGNORECASE)
                rules.append(_LabelRule(field, language, len(label), pattern, inline))
    return rules


def _compile_headings() -> dict[str, str]:
    return {
        label.casefold(): role
        for role in _PARTY_ROLES
        for labels in FIELD_LABELS[role].values()
        for label in labels
    }


def _compile_column_labels() -> list[tuple[str, str]]:
    return [
        (label.casefold(), field)
        for field, by_language in COLUMN_LABELS.items()
        for labels in by_language.values()
        for label in labels
    ]


_RULES = _compile_rules()
_HEADINGS = _compile_headings()
_COLUMN_LABELS = _compile_column_labels()
_TOTAL_ROW_LABELS = {label.casefold() for label in TOTAL_ROW_LABELS}


def _clean_line(raw: str) -> str:
    return _LEADING_MARKUP.sub("", raw.strip().replace("**", "")).strip()


def _clean_value(value: str) -> str:
    return value.strip().strip("*_ ").strip()


def _label_starts(line: str) -> list[int]:
    spans = sorted(
        ((match.start(), match.end()) for rule in _RULES for match in rule.inline.finditer(line)),
        key=lambda span: (span[0], -span[1]),
    )
    starts: list[int] = []
    covered = 0
    for start, end in spans:
        if start < covered:
            continue
        starts.append(start)
        covered = end
    return starts


def _segments(raw: str) -> list[str]:
    """Docling joins adjacent short Latin lines into one paragraph, so a line may carry several labelled fields."""
    if len(raw) > _MAX_MERGED_LINE_CHARS:
        return []
    if len(raw) <= _MAX_LINE_CHARS and raw.count(":") + raw.count("：") < 2:
        return [raw]
    cuts = [start for start in _label_starts(raw) if start > 0]
    if not cuts:
        return [raw] if len(raw) <= _MAX_LINE_CHARS else []
    bounds = [0, *cuts, len(raw)]
    return [raw[a:b] for a, b in zip(bounds, bounds[1:], strict=False) if len(raw[a:b]) <= _MAX_LINE_CHARS]


def _best_rule(line: str) -> tuple[_LabelRule, str] | None:
    best: tuple[_LabelRule, str] | None = None
    for rule in _RULES:
        match = rule.pattern.match(line)
        if match and (best is None or rule.length > best[0].length):
            best = (rule, match.group("value"))
    return best


def _row_cells(line: str) -> list[str]:
    body = line.strip()
    if body.startswith("|"):
        body = body[1:]
    if body.endswith("|"):
        body = body[:-1]
    return [cell.replace("**", "").strip() for cell in body.split("|")]


def _split_tables(text: str) -> list[list[list[str]]]:
    tables: list[list[list[str]]] = []
    current: list[list[str]] = []
    for line in text.splitlines():
        if line.lstrip().startswith("|"):
            current.append(_row_cells(line))
        elif current:
            tables.append(current)
            current = []
    if current:
        tables.append(current)
    return tables


def _is_separator(cells: list[str]) -> bool:
    return all(_SEPARATOR_CELL.fullmatch(cell) for cell in cells)


def _column_fields(header: list[str]) -> dict[int, str]:
    mapping: dict[int, str] = {}
    for index, cell in enumerate(header):
        text = cell.casefold()
        best: tuple[int, str] | None = None
        for label, field in _COLUMN_LABELS:
            if (text == label or text.startswith(label)) and (best is None or len(label) > best[0]):
                best = (len(label), field)
        if best is not None and best[1] not in mapping.values():
            mapping[index] = best[1]
    return mapping


def _is_line_item_header(mapping: dict[int, str]) -> bool:
    fields = set(mapping.values())
    return "description" in fields and bool(fields & {"amount", "unit_price", "quantity"})


def _amount(raw: str | None, locale: str | None) -> str | None:
    return parse_amount(raw, locale) if raw else None


def _rate(raw: str, locale: str | None) -> str | None:
    return parse_amount(raw.replace("%", "").replace("％", ""), locale)


@dataclass
class _TableResult:
    items: list[InvoiceLineItem]
    net_raw: str | None = None
    tax_raw: str | None = None


def _read_line_items(tables: list[list[list[str]]], locale: str | None) -> _TableResult:
    for rows in tables:
        body = [cells for cells in rows if not _is_separator(cells)]
        if not body:
            continue
        mapping = _column_fields(body[0])
        if not _is_line_item_header(mapping):
            continue
        by_field = {field: index for index, field in mapping.items()}
        result = _TableResult(items=[])
        for cells in body[1:]:

            def cell(field: str, row: list[str] = cells) -> str:
                index = by_field.get(field)
                return row[index] if index is not None and index < len(row) else ""

            label = cell("description") or next((value for value in cells if value), "")
            if label.casefold() in _TOTAL_ROW_LABELS:
                if result.net_raw is None and result.tax_raw is None:
                    result.net_raw = cell("amount") or None
                    result.tax_raw = cell("tax_amount") or None
                continue
            description = cell("description")
            if not description or len(result.items) >= _MAX_LINE_ITEMS:
                continue
            result.items.append(
                InvoiceLineItem(
                    description=description,
                    quantity=_amount(cell("quantity"), locale),
                    unit_price=_amount(cell("unit_price"), locale),
                    amount=_amount(cell("amount"), locale),
                    tax_rate=_rate(cell("tax_rate"), locale) if cell("tax_rate") else None,
                )
            )
        return result
    return _TableResult(items=[])


def _pick_tax_id(raw: str) -> TaxIdCheck | None:
    tokens = raw.split()
    candidates = (raw, *tokens) if len(tokens) > 1 else (raw,)
    for candidate in candidates:
        check = classify_tax_id(candidate)
        if check.valid:
            return check
    return None


def _resolve_party(
    role: str, name: str | None, raw_tax_id: str | None, errors: list[str]
) -> tuple[InvoiceParty, bool]:
    if raw_tax_id is None:
        return InvoiceParty(name=name), False
    check = _pick_tax_id(raw_tax_id)
    if check is None:
        errors.append(f"invalid_tax_id:{role}")
        return InvoiceParty(name=name), True
    return InvoiceParty(name=name, tax_id=check.normalized, tax_id_scheme=check.scheme), False


def _totals_mismatch(net: str | None, tax: str | None, gross: str | None) -> bool:
    if net is None or tax is None or gross is None:
        return False
    return abs(Decimal(net) + Decimal(tax) - Decimal(gross)) > _TOTALS_TOLERANCE


def _extract_fields(markdown: str, tables: list[str], language_hint: OcrLanguage | None) -> InvoiceFields:
    if not markdown.strip():
        return InvoiceFields(confidence=0.0, errors=["empty_input"])

    values: dict[str, str] = {}
    names: dict[str, str] = {}
    tax_ids: dict[str, str] = {}
    due_date: date | None = None
    issue_date: date | None = None
    votes: Counter[str] = Counter()
    current: str | None = None

    lines = (
        segment
        for raw in markdown.splitlines()
        if not raw.lstrip().startswith("|")
        for segment in _segments(raw)
    )
    for raw in lines:
        line = _clean_line(raw)
        if not line:
            continue
        heading = _HEADINGS.get(line.strip(" :：").casefold())
        if heading is not None:
            current = heading
            continue
        if ":" not in line and "：" not in line:
            continue
        found = _best_rule(line)
        if found is None:
            continue
        rule, raw_value = found
        value = _clean_value(raw_value)
        field = rule.field
        if field in _PARTY_ROLES:
            current = field
            if value and field not in names:
                names[field] = value
                votes[rule.language] += 1
        elif field == "party_name":
            if current is not None and value and current not in names:
                names[current] = value
        elif field == "party_tax_id":
            if current is not None and value and current not in tax_ids:
                tax_ids[current] = value
        elif field == "invoice_number":
            if value and "invoice_number" not in values and len(value) <= _MAX_INVOICE_NUMBER_CHARS:
                values["invoice_number"] = value
                votes[rule.language] += 1
        elif field == "issue_date":
            if issue_date is None:
                issue_date = find_date(value)
                if issue_date is not None:
                    votes[rule.language] += 1
        elif field == "due_date":
            if due_date is None:
                due_date = find_date(value)
        elif value and field not in values:
            values[field] = value
            votes[rule.language] += 1

    ranked = votes.most_common(2)
    detected = ranked[0][0] if ranked and (len(ranked) == 1 or ranked[0][1] > ranked[1][1]) else None
    locale = language_hint or detected

    parsed_tables = [table for text in (markdown, *tables) for table in _split_tables(text)]
    table_result = _read_line_items(parsed_tables, locale)

    raw_amounts = {
        "gross_total": values.get("gross_total"),
        "net_total": values.get("net_total") or table_result.net_raw,
        "tax_total": values.get("tax_total") or table_result.tax_raw,
    }
    totals = {field: _amount(raw_amounts[field], locale) for field in _AMOUNT_FIELDS}
    currency = next(
        (code for code in (detect_currency(raw) for raw in raw_amounts.values() if raw) if code), None
    ) or detect_currency(markdown)

    errors: list[str] = []
    invalid_tax_ids = 0
    parties: dict[str, InvoiceParty] = {}
    for role in _PARTY_ROLES:
        parties[role], invalid = _resolve_party(role, names.get(role), tax_ids.get(role), errors)
        invalid_tax_ids += int(invalid)

    present = {
        "invoice_number": "invoice_number" in values,
        "issue_date": issue_date is not None,
        "supplier": parties["supplier"].name is not None,
        "buyer": parties["buyer"].name is not None,
        "gross_total": totals["gross_total"] is not None,
    }
    evidence = (
        any(present.values())
        or due_date is not None
        or bool(table_result.items)
        or bool(tax_ids)
        or any(value is not None for value in totals.values())
    )
    if not evidence:
        return InvoiceFields(confidence=0.0, errors=["no_invoice_labels"])

    errors = [*(f"missing:{field}" for field in _REQUIRED_FIELDS if not present[field]), *errors]
    confidence = sum(present.values()) / len(_REQUIRED_FIELDS)
    if not present["invoice_number"]:
        confidence = min(confidence, _MISSING_NUMBER_CONFIDENCE_CAP)
    if _totals_mismatch(totals["net_total"], totals["tax_total"], totals["gross_total"]):
        errors.append("totals_mismatch")
        confidence -= _TOTALS_MISMATCH_PENALTY
    confidence -= _INVALID_TAX_ID_PENALTY * invalid_tax_ids

    return InvoiceFields(
        invoice_number=values.get("invoice_number"),
        issue_date=issue_date,
        due_date=due_date,
        supplier=parties["supplier"],
        buyer=parties["buyer"],
        currency=currency,
        net_total=totals["net_total"],
        tax_total=totals["tax_total"],
        gross_total=totals["gross_total"],
        line_items=table_result.items,
        confidence=round(min(1.0, max(0.0, confidence)), 4),
        errors=errors,
    )


def extract_invoice(
    markdown: str, tables: list[str] | None = None, language_hint: OcrLanguage | None = None
) -> InvoiceFields:
    """Deterministic label-driven extraction; never raises, failures come back as errors with confidence 0."""
    try:
        return _extract_fields(markdown, tables or [], language_hint)
    except Exception:
        logger.warning("[Invoice Extract] extraction failed", exc_info=True)
        return InvoiceFields(confidence=0.0, errors=["extraction_failed"])
