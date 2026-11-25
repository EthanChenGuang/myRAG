"""D-20 on the Docling path: a table continued on the next page without its own header takes the previous header.

The rule runs on a deep copy of the DoclingDocument just before chunking, so the docling.json the parse result
stores stays the unmodified document and a later re-chunk without the switch gives today's chunks.
"""

from __future__ import annotations

from dataclasses import dataclass

from docling_core.types.doc import DoclingDocument


@dataclass(frozen=True)
class TableHeaderRules:
    rules_version: str
    numeric_cell_pattern: str
    min_non_numeric_share: float
    max_repeated_value_share: float


@dataclass(frozen=True)
class TableHeaderCarry:
    """The document to chunk and the self_ref of every table that took a carried header."""

    document: DoclingDocument
    carried: tuple[str, ...]


def load_table_header_rules() -> TableHeaderRules:
    return TableHeaderRules(rules_version="", numeric_cell_pattern="", min_non_numeric_share=0.0, max_repeated_value_share=0.0)


def is_header_like(row: list[str], neighbours: list[list[str]], rules: TableHeaderRules) -> bool:
    return True


def carry_table_headers(doc: DoclingDocument, rules: TableHeaderRules | None = None) -> TableHeaderCarry:
    return TableHeaderCarry(document=doc.model_copy(deep=True), carried=())
