import collections
import json
import re
from decimal import Decimal

import pytest
from test_fixture_pii import email_violations, phone_violations

from rag_eval.corpus import load_corpus
from rag_eval.paths import REPO_ROOT

DOMAIN = REPO_ROOT / "eval/fixtures/domain"
DOMAIN_CORPUS = DOMAIN / "corpus"
DOMAIN_MANIFEST = DOMAIN / "manifest.json"
MAIN_CORPUS = REPO_ROOT / "eval/fixtures/corpus"
REQUIREMENTS = REPO_ROOT / ".planning/REQUIREMENTS.md"

LANGUAGES = ("zh", "en", "it")
DOC_TYPES = ("contract_legal", "financial_report")
DOC_STEMS = {"contract_legal": "contract-legal-a", "financial_report": "financial-report-a"}
EXTRA_NEUTRALITY_TERMS = ("lodging", "vpn", "password", "branch")

ZH_NUMERALS = "一二三四五六七八九十"
SECTION_HEADING = {
    "en": re.compile(r"^## Clause (\d+)\b"),
    "it": re.compile(r"^## Articolo (\d+)\b"),
    "zh": re.compile(rf"^## 第([{ZH_NUMERALS}]+)条"),
}
CROSS_REFERENCE = {
    "en": re.compile(r"\bClause (\d+)\b"),
    "it": re.compile(r"\b[Aa]rticolo (\d+)\b"),
    "zh": re.compile(rf"第([{ZH_NUMERALS}]+)条"),
}
EXCEPTION_MARKER = {
    "en": re.compile(r"\b(?:[Nn]otwithstanding|[Bb]y way of exception to) Clause (\d+)\b"),
    "it": re.compile(r"\b[Ii]n deroga all'articolo (\d+)\b"),
    "zh": re.compile(rf"作为第([{ZH_NUMERALS}]+)条的例外"),
}
DEFINED_TERM = {
    "en": re.compile(r"“([^”]{2,40})”"),
    "it": re.compile(r"«([^»]{2,40})»"),
    "zh": re.compile(r"“([^”]{1,20})”"),
}
TOTAL_LABEL = {"en": "Total", "it": "Totale", "zh": "合计"}
LOCALE_NUMBER = {
    "en": re.compile(r"^-?\d{1,3}(?:,\d{3})*(?:\.\d+)?$"),
    "zh": re.compile(r"^-?\d{1,3}(?:,\d{3})*(?:\.\d+)?$"),
    "it": re.compile(r"^-?\d{1,3}(?:\.\d{3})*(?:,\d+)?$"),
}
GROUPED_THOUSANDS = {"en": ",", "zh": ",", "it": "."}
CAPITALISED_NAME = re.compile(r"[A-Z][a-zà-ÿ]+(?:[ -][A-Z][a-zà-ÿ]+)+")
ZH_COMPANY = re.compile(r"[一-鿿]{2,12}(?:股份有限公司|有限公司)")
TAX_ID_PATTERNS = (
    re.compile(r"\b[A-Z]{6}\d{2}[A-Z]\d{2}[A-Z]\d{3}[A-Z]\b"),
    re.compile(r"(?<![\d.,])\d{11}(?![\d.,])"),
    re.compile(r"(?<![0-9A-Z])[0-9A-HJ-NPQRTUWXY]{2}\d{6}[0-9A-HJ-NPQRTUWXY]{10}(?![0-9A-Z])"),
    re.compile(r"\b\d{3}-\d{2}-\d{4}\b"),
)
IBAN_RE = re.compile(r"\b[A-Z]{2}\d{2}(?: ?[A-Z0-9]{4}){3,7}(?: ?[A-Z0-9]{1,3})?\b")


def _zh_number(numeral: str) -> int:
    values = {ch: index + 1 for index, ch in enumerate(ZH_NUMERALS)}
    if numeral == "十":
        return 10
    if numeral.startswith("十"):
        return 10 + values[numeral[1]]
    if "十" in numeral:
        tens, _, units = numeral.partition("十")
        return values[tens] * 10 + (values[units] if units else 0)
    return values[numeral]


def _section_number(language: str, raw: str) -> int:
    return _zh_number(raw) if language == "zh" else int(raw)


def _domain_files():
    assert DOMAIN_CORPUS.is_dir(), "eval/fixtures/domain/corpus is missing"
    return sorted(DOMAIN_CORPUS.rglob("*.md"))


def _pack_text_files():
    files = list(_domain_files()) + [DOMAIN_MANIFEST]
    for name in ("golden.jsonl", "split-manifest.json"):
        if (DOMAIN / name).exists():
            files.append(DOMAIN / name)
    return files


def _manifest() -> dict[str, str]:
    assert DOMAIN_MANIFEST.is_file(), "eval/fixtures/domain/manifest.json is missing"
    raw = json.loads(DOMAIN_MANIFEST.read_text(encoding="utf-8"))
    assert raw.get("schema_version") == 1
    assert isinstance(raw.get("documents"), dict)
    return raw["documents"]


def _documents():
    assert DOMAIN_CORPUS.is_dir(), "eval/fixtures/domain/corpus is missing"
    return {doc.relpath: doc for doc in load_corpus(DOMAIN_CORPUS)}


def _documents_of(doc_type: str):
    return [doc for doc in _documents().values() if doc.doc_type == doc_type]


def _neutrality_terms() -> list[str]:
    text = REQUIREMENTS.read_text(encoding="utf-8")
    paragraph = next(line for line in text.split("\n") if line.startswith("**Domain neutrality"))
    listed = re.search(r"Examples[^(]*\(([^)]*)\)", paragraph)
    assert listed, "the Domain neutrality paragraph no longer lists its illustrations in parentheses"
    terms = []
    for part in listed.group(1).split(","):
        term = re.sub(r"\s+and similar$", "", part.strip()).strip()
        if term:
            terms.append(term.casefold())
    assert len(terms) >= 4
    return terms + list(EXTRA_NEUTRALITY_TERMS)


def _main_corpus_names() -> set[str]:
    names: set[str] = set()
    for path in MAIN_CORPUS.rglob("*.md"):
        text = path.read_text(encoding="utf-8")
        names.update(CAPITALISED_NAME.findall(text))
        names.update(ZH_COMPANY.findall(text))
    assert names
    return names


def test_documents_six_files_one_per_doc_type_and_language():
    files = _domain_files()
    assert len(files) == 6
    expected = {
        f"{language}/{DOC_STEMS[doc_type]}.{language}.md" for doc_type in DOC_TYPES for language in LANGUAGES
    }
    assert {path.relative_to(DOMAIN_CORPUS).as_posix() for path in files} == expected


def test_documents_manifest_lists_every_document_with_its_parsed_doc_type():
    manifest = _manifest()
    documents = _documents()
    assert set(manifest) == set(documents)
    cells = collections.Counter()
    for relpath, doc in documents.items():
        assert manifest[relpath] in DOC_TYPES, relpath
        assert doc.doc_type == manifest[relpath], relpath
        assert relpath.startswith(f"{doc.language}/")
        cells[(doc.doc_type, doc.language)] += 1
    assert cells == {(doc_type, language): 1 for doc_type in DOC_TYPES for language in LANGUAGES}


def test_documents_have_a_fixture_meta_line_and_chunk_markers():
    for path in _domain_files():
        lines = path.read_text(encoding="utf-8").split("\n")
        assert lines[0].startswith("<!-- fixture-meta {"), path.name
        assert '"doc_type"' in lines[0], path.name
        assert lines.count("<!-- chunk -->") >= 6, path.name
    for doc in _documents().values():
        assert all(chunk.section for chunk in doc.chunks), doc.relpath
        sections = [chunk.section for chunk in doc.chunks]
        assert len(sections) == len(set(sections)), doc.relpath


def test_documents_contract_has_numbered_sections_terms_references_and_an_exception():
    contracts = _documents_of("contract_legal")
    assert len(contracts) == 3
    for doc in contracts:
        language = doc.language
        numbered: dict[int, int] = {}
        for chunk in doc.chunks:
            match = SECTION_HEADING[language].match(f"## {chunk.section}")
            if match:
                numbered[chunk.index] = _section_number(language, match.group(1))
        numbers = sorted(numbered.values())
        assert len(numbers) >= 6, doc.relpath
        assert numbers == list(range(1, len(numbers) + 1)), doc.relpath

        definition_index = min(numbered)
        terms = set(DEFINED_TERM[language].findall(doc.chunks[definition_index].text))
        later = "\n".join(chunk.text for chunk in doc.chunks if chunk.index > definition_index)
        reused = {term for term in terms if term in later}
        assert len(reused) >= 4, (doc.relpath, sorted(terms), sorted(reused))

        references = 0
        exceptions = 0
        for chunk in doc.chunks:
            if chunk.index not in numbered:
                continue
            own = numbered[chunk.index]
            body = chunk.text.split("\n", 1)[1] if "\n" in chunk.text else ""
            for match in CROSS_REFERENCE[language].finditer(body):
                target = _section_number(language, match.group(1))
                if target != own and target in numbers:
                    references += 1
            for match in EXCEPTION_MARKER[language].finditer(body):
                target = _section_number(language, match.group(1))
                if target != own and target in numbers:
                    exceptions += 1
        assert references >= 2, doc.relpath
        assert exceptions >= 1, doc.relpath


def _parse_number(language: str, cell: str) -> Decimal | None:
    value = cell.strip()
    if not LOCALE_NUMBER[language].match(value):
        return None
    if language == "it":
        value = value.replace(".", "").replace(",", ".")
    else:
        value = value.replace(",", "")
    return Decimal(value)


def _table_rows(text: str) -> list[list[str]]:
    rows = []
    for line in text.split("\n"):
        stripped = line.strip()
        if not (stripped.startswith("|") and stripped.endswith("|")):
            continue
        cells = [cell.strip() for cell in stripped.strip("|").split("|")]
        if all(re.fullmatch(r":?-{3,}:?", cell) for cell in cells):
            continue
        rows.append(cells)
    return rows


def test_documents_financial_report_table_totals_add_up_in_locale_format():
    reports = _documents_of("financial_report")
    assert len(reports) == 3
    for doc in reports:
        language = doc.language
        tables = [(chunk, _table_rows(chunk.text)) for chunk in doc.chunks if _table_rows(chunk.text)]
        assert tables, doc.relpath
        chunk, rows = tables[0]
        header, body = rows[0], rows[1:]
        total_rows = [row for row in body if row[0].strip("* ") == TOTAL_LABEL[language]]
        assert len(total_rows) == 1, doc.relpath
        total = total_rows[0]
        data = [row for row in body if row is not total]
        assert len(data) >= 5, doc.relpath
        numeric_columns = [
            column
            for column in range(1, len(header))
            if all(_parse_number(language, row[column]) is not None for row in data + [total])
        ]
        assert len(numeric_columns) >= 3, (doc.relpath, header)
        for column in numeric_columns:
            column_sum = sum(_parse_number(language, row[column]) for row in data)
            assert column_sum == _parse_number(language, total[column]), (doc.relpath, header[column])
        grouped = [
            row[column]
            for row in data + [total]
            for column in numeric_columns
            if GROUPED_THOUSANDS[language] in row[column]
        ]
        assert grouped, f"{doc.relpath}: no figure uses the locale thousands separator"

        narrative = [
            other
            for other in doc.chunks
            if other.index != chunk.index and not _table_rows(other.text)
            and any(cell in other.text for row in data + [total] for cell in row[1:] if len(cell) >= 3)
        ]
        assert len(narrative) >= 2, doc.relpath


def test_documents_avoid_requirement_illustrations_and_main_corpus_names():
    terms = _neutrality_terms()
    for doc in _documents().values():
        text = doc.content.casefold()
        if doc.language == "en":
            for term in terms:
                assert term not in text, (doc.relpath, term)
    names = _main_corpus_names()
    for path in _pack_text_files():
        text = path.read_text(encoding="utf-8")
        for name in names:
            assert name not in text, (path.name, name)


def test_documents_subjects_and_parties_differ_across_the_pack():
    documents = list(_documents().values())
    names_by_doc = {doc.relpath: set(CAPITALISED_NAME.findall(doc.content)) | set(ZH_COMPANY.findall(doc.content)) for doc in documents}
    for doc in documents:
        assert names_by_doc[doc.relpath], doc.relpath
    relpaths = sorted(names_by_doc)
    for index, first in enumerate(relpaths):
        for second in relpaths[index + 1 :]:
            assert not (names_by_doc[first] & names_by_doc[second]), (first, second)
    titles = [doc.chunks[0].section for doc in documents]
    assert len(set(titles)) == len(titles)


def tax_id_violations(text: str) -> list[str]:
    return [m.group(0) for pattern in TAX_ID_PATTERNS for m in pattern.finditer(text)]


def iban_violations(text: str) -> list[str]:
    return [m.group(0) for m in IBAN_RE.finditer(text)]


def test_pii_checker_flags_tax_ids_and_ibans():
    assert tax_id_violations("codice fiscale RSSMRA80A01H501U") != []
    assert tax_id_violations("partita IVA 01234567890") != []
    assert tax_id_violations("统一社会信用代码 91310000MA1FL8XQ30") != []
    assert tax_id_violations("SSN 078-05-1120") != []
    assert iban_violations("IBAN IT60 X054 2811 1010 0000 0123 456") != []
    assert iban_violations("IBAN GB82WEST12345698765432") != []
    assert tax_id_violations("total 1,248,300 and 1.248.300,50") == []
    assert iban_violations("section 4.2 of the 2025 report") == []


def test_pii_pack_has_no_phone_email_tax_id_or_iban():
    files = _pack_text_files()
    assert len(files) >= 7
    for path in files:
        text = path.read_text(encoding="utf-8")
        assert phone_violations(text) == [], path.name
        assert email_violations(text) == [], path.name
        assert tax_id_violations(text) == [], path.name
        assert iban_violations(text) == [], path.name
