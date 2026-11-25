"""D-20 on the Docling path: a table continued on the next page without its own header takes the previous header.

The rule runs on a deep copy of the DoclingDocument just before chunking, so the docling.json the parse result
stores stays the unmodified document and a later re-chunk without the switch gives today's chunks.
"""

from __future__ import annotations

import json
import re
from dataclasses import dataclass
from functools import lru_cache
from pathlib import Path

from docling_core.types.doc import DoclingDocument, TableCell, TableData, TableItem
from docling_core.types.doc.document import RefItem

from rag_sidecar.config_files import resolve_config_file

RULES_FILE = "table-header-rules.json"


@dataclass(frozen=True)
class TableHeaderRules:
    """config/rag/table-header-rules.json, the same data the TypeScript rule (chunkers/markdown-tables.ts) reads."""

    rules_version: str
    numeric_cell_pattern: str
    min_non_numeric_share: float
    max_repeated_value_share: float

    @property
    def numeric(self) -> re.Pattern[str]:
        return _numeric_pattern(self.numeric_cell_pattern)


@dataclass(frozen=True)
class TableHeaderCarry:
    """The document to chunk and the self_ref of every table that took a carried header."""

    document: DoclingDocument
    carried: tuple[str, ...]


@lru_cache(maxsize=8)
def _numeric_pattern(pattern: str) -> re.Pattern[str]:
    # JavaScript's \d is ASCII-only; Python's matches every Unicode digit.
    return re.compile(pattern.replace(r"\d", "[0-9]"))


def _share(value: object) -> bool:
    return isinstance(value, (int, float)) and not isinstance(value, bool) and 0 <= value <= 1


def parse_table_header_rules(raw: object) -> TableHeaderRules:
    if not isinstance(raw, dict):
        raise ValueError(f"{RULES_FILE} is invalid")
    if (
        raw.get("schema_version") != 1
        or not isinstance(raw.get("rules_version"), str)
        or not isinstance(raw.get("numeric_cell_pattern"), str)
        or not _share(raw.get("min_non_numeric_share"))
        or not _share(raw.get("max_repeated_value_share"))
    ):
        raise ValueError(f"{RULES_FILE} is invalid")
    return TableHeaderRules(
        rules_version=raw["rules_version"],
        numeric_cell_pattern=raw["numeric_cell_pattern"],
        min_non_numeric_share=float(raw["min_non_numeric_share"]),
        max_repeated_value_share=float(raw["max_repeated_value_share"]),
    )


@lru_cache(maxsize=1)
def _default_rules() -> TableHeaderRules:
    return parse_table_header_rules(json.loads(resolve_config_file(RULES_FILE).read_text(encoding="utf-8")))


def load_table_header_rules(path: Path | None = None) -> TableHeaderRules:
    if path is None:
        return _default_rules()
    return parse_table_header_rules(json.loads(path.read_text(encoding="utf-8")))


def is_header_like(row: list[str], neighbours: list[list[str]], rules: TableHeaderRules) -> bool:
    """Same rule as isHeaderLike in TS: enough non-numeric cells, few of them repeated in the same column nearby.

    A row without any non-empty cell counts as header-like, so nothing is carried onto it.
    """
    filled = [(cell, column) for column, cell in enumerate(row) if cell != ""]
    if not filled:
        return True
    numeric = rules.numeric
    non_numeric = sum(1 for cell, _ in filled if not numeric.search(cell)) / len(filled)
    repeated = sum(
        1 for cell, column in filled if any(column < len(other) and other[column] == cell for other in neighbours)
    ) / len(filled)
    return non_numeric >= rules.min_non_numeric_share and repeated <= rules.max_repeated_value_share


def _rows(table: TableItem) -> list[list[str]]:
    return [[cell.text.strip() for cell in row] for row in table.data.grid]


def _first_row_flagged(table: TableItem) -> bool:
    return any(cell.column_header for cell in table.data.table_cells if cell.start_row_offset_idx == 0)


def _pages(table: TableItem) -> list[int]:
    return [provenance.page_no for provenance in table.prov]


def _own_header(table: TableItem, rules: TableHeaderRules) -> list[TableCell] | None:
    """Row 0 of a table that has a header: flagged by the layout model or header-like against the other rows."""
    rows = _rows(table)
    if not rows or not (_first_row_flagged(table) or is_header_like(rows[0], rows[1:], rules)):
        return None
    return [cell for cell in table.data.table_cells if cell.start_row_offset_idx == 0]


def _continues(previous: TableItem, previous_rows: list[list[str]], candidate: TableItem, rules: TableHeaderRules) -> bool:
    """D-20: starts a page right after a table that ended the previous page, same column count, first row not a header."""
    if not previous.prov or not candidate.prov or min(_pages(candidate)) != max(_pages(previous)) + 1:
        return False
    if candidate.data.num_cols != previous.data.num_cols or _first_row_flagged(candidate):
        return False
    rows = _rows(candidate)
    return bool(rows) and not is_header_like(rows[0], [*previous_rows, *rows[1:]], rules)


def _with_header(data: TableData, header: list[TableCell]) -> TableData:
    cells = [cell.model_copy(update={"start_row_offset_idx": 0, "end_row_offset_idx": 1, "column_header": True}) for cell in header]
    cells += [
        cell.model_copy(
            update={"start_row_offset_idx": cell.start_row_offset_idx + 1, "end_row_offset_idx": cell.end_row_offset_idx + 1}
        )
        for cell in data.table_cells
    ]
    return TableData(num_rows=data.num_rows + 1, num_cols=data.num_cols, table_cells=cells)


def carry_table_headers(doc: DoclingDocument, rules: TableHeaderRules | None = None) -> TableHeaderCarry:
    """Returns a deep copy of doc in which every continuation table starts with the carried header row.

    Tables are walked in reading order with their page provenance. A chain of continuations keeps the first header;
    a first table without a header carries nothing. The input document is never modified.
    """
    rules = rules or load_table_header_rules()
    copy = doc.model_copy(deep=True)
    carried: list[str] = []
    headers: dict[str, list[TableCell]] = {}
    previous = None
    for item, _level in doc.iterate_items():
        if not getattr(item, "prov", None):
            continue
        if isinstance(item, TableItem) and isinstance(previous, TableItem):
            carried_onto_previous = previous.self_ref in headers
            header = headers.get(previous.self_ref) or _own_header(previous, rules)
            previous_rows = _rows(previous) if carried_onto_previous else _rows(previous)[1:]
            if header is not None and _continues(previous, previous_rows, item, rules):
                target = RefItem(cref=item.self_ref).resolve(copy)
                assert isinstance(target, TableItem)
                target.data = _with_header(target.data, header)
                headers[item.self_ref] = header
                carried.append(item.self_ref)
        previous = item
    return TableHeaderCarry(document=copy, carried=tuple(carried))
