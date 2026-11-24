from typing import Literal

from pydantic import BaseModel, ConfigDict

DocType = Literal[
    "general",
    "financial_report",
    "contract_legal",
    "invoice_receipt",
    "product_technical",
    "scanned_image",
]
DocTypeChoice = Literal[
    "auto",
    "general",
    "financial_report",
    "contract_legal",
    "invoice_receipt",
    "product_technical",
    "scanned_image",
]


class _Contract(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)


class DoclingOptions(_Contract):
    ocr: bool
    force_full_page_ocr: bool
    table_mode: str
    heading_hierarchy: bool
    generate_picture_images: bool


class ParserSettings(_Contract):
    preference: list[str]
    docling: DoclingOptions
    ocr_languages: list[str]


class ChunkerSettings(_Contract):
    kind: str
    max_tokens: int
    overlap_tokens: int
    repeat_table_header: bool
    min_chunk_tokens: int
    clause_patterns: list[str] = []
    lead_in_phrases: list[str] = []


class EmbeddingTextTemplate(_Contract):
    version: int
    header: str | None = None


class ParentChild(_Contract):
    parent_max_tokens: int
    child_max_tokens: int


class ProcessingProfile(_Contract):
    id: str
    version: int
    doc_type: str
    parser: ParserSettings
    chunker: ChunkerSettings
    extractors: list[str]
    embedding_text_template: EmbeddingTextTemplate
    scan_injection: bool
    min_tier: str | None = None
    max_tier: str | None = None
    parent_child: ParentChild | None = None


class ProcessingProfileSet(_Contract):
    schema_version: int = 1
    profiles: list[ProcessingProfile]


class InjectionRule(_Contract):
    id: str
    language: str
    pattern: str
    kind: str
    severity: str


class InjectionRuleSet(_Contract):
    schema_version: int = 1
    rules: list[InjectionRule]


class DocTypeDetection(_Contract):
    doc_type: str
    confidence: float
    signals: list[str]
    method: str
