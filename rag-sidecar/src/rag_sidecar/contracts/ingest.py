from typing import Literal, get_args

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

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
ParserPreference = Literal["configured", "docling", "llamaparse"]
TableMode = Literal["off", "fast", "accurate"]
OcrLanguage = Literal["zh", "en", "it"]
ChunkerKind = Literal["markdown_sections", "legal_clauses", "table_aware", "invoice", "image_caption"]
Extractor = Literal["dates", "financial", "invoice", "urls"]
Tier = Literal["fast", "structured", "premium"]
RuleKind = Literal["phrase", "regex"]
RuleSeverity = Literal["low", "medium", "high"]
RuleLanguage = Literal["zh", "en", "it", "any"]
DetectionMethod = Literal["rules", "llm"]

_TIER_ORDER = {"fast": 0, "structured": 1, "premium": 2}
_PATTERN_MAX_LENGTH = 200


class _Contract(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)


def _require_unique(values: list[str], what: str) -> list[str]:
    if len(set(values)) != len(values):
        raise ValueError(f"{what} must not repeat a value")
    return values


def has_backreference(pattern: str) -> bool:
    """True when a regex uses a numbered, named (JS) or (?P=name) back-reference; escaped backslashes are skipped."""
    index = 0
    while index < len(pattern):
        char = pattern[index]
        if char == "\\":
            following = pattern[index + 1 : index + 2]
            if following != "" and "1" <= following <= "9":
                return True
            if following == "k" and pattern[index + 2 : index + 3] == "<":
                return True
            index += 2
            continue
        if pattern.startswith("(?P=", index):
            return True
        index += 1
    return False


class DoclingOptions(_Contract):
    ocr: bool
    force_full_page_ocr: bool
    table_mode: TableMode
    heading_hierarchy: bool
    generate_picture_images: bool


class ParserSettings(_Contract):
    preference: list[ParserPreference] = Field(min_length=1)
    docling: DoclingOptions
    ocr_languages: list[OcrLanguage] = Field(min_length=1)

    @field_validator("preference")
    @classmethod
    def _preference_unique(cls, value: list[str]) -> list[str]:
        return _require_unique(value, "parser preference")

    @field_validator("ocr_languages")
    @classmethod
    def _languages_unique(cls, value: list[str]) -> list[str]:
        return _require_unique(value, "ocr_languages")


class ChunkerSettings(_Contract):
    kind: ChunkerKind
    max_tokens: int = Field(ge=64, le=4096)
    overlap_tokens: int = Field(ge=0)
    repeat_table_header: bool
    min_chunk_tokens: int = Field(ge=0)
    clause_patterns: list[str] = Field(default_factory=list)
    lead_in_phrases: list[str] = Field(default_factory=list)

    @model_validator(mode="after")
    def _budgets_are_consistent(self) -> "ChunkerSettings":
        if self.overlap_tokens >= self.max_tokens:
            raise ValueError("overlap_tokens must be smaller than max_tokens")
        if self.min_chunk_tokens > self.max_tokens:
            raise ValueError("min_chunk_tokens must not exceed max_tokens")
        return self


class EmbeddingTextTemplate(_Contract):
    version: int = Field(ge=1)
    header: str | None = Field(default=None, max_length=200)


class ParentChild(_Contract):
    parent_max_tokens: int = Field(ge=64, le=16384)
    child_max_tokens: int = Field(ge=32, le=4096)

    @model_validator(mode="after")
    def _child_fits_in_parent(self) -> "ParentChild":
        if self.child_max_tokens >= self.parent_max_tokens:
            raise ValueError("child_max_tokens must be smaller than parent_max_tokens")
        return self


class ProcessingProfile(_Contract):
    id: str = Field(pattern=r"^[a-z][a-z_]*@[1-9][0-9]*$")
    version: int = Field(ge=1)
    doc_type: DocType
    parser: ParserSettings
    chunker: ChunkerSettings
    extractors: list[Extractor]
    embedding_text_template: EmbeddingTextTemplate
    scan_injection: bool
    min_tier: Tier | None = None
    max_tier: Tier | None = None
    parent_child: ParentChild | None = None

    @field_validator("extractors")
    @classmethod
    def _extractors_unique(cls, value: list[str]) -> list[str]:
        return _require_unique(value, "extractors")

    @model_validator(mode="after")
    def _identity_and_tiers_are_consistent(self) -> "ProcessingProfile":
        if self.id != f"{self.doc_type}@{self.version}":
            raise ValueError("id must equal <doc_type>@<version>")
        if self.min_tier and self.max_tier and _TIER_ORDER[self.min_tier] > _TIER_ORDER[self.max_tier]:
            raise ValueError("min_tier must not rank above max_tier")
        return self


class ProcessingProfileSet(_Contract):
    schema_version: Literal[1] = 1
    profiles: list[ProcessingProfile]

    @model_validator(mode="after")
    def _one_profile_per_doc_type(self) -> "ProcessingProfileSet":
        seen = [profile.doc_type for profile in self.profiles]
        if len(set(seen)) != len(seen):
            raise ValueError("a doc type must have exactly one profile")
        missing = sorted(set(get_args(DocType)) - set(seen))
        if missing:
            raise ValueError(f"missing profiles for doc types: {', '.join(missing)}")
        return self


class InjectionRule(_Contract):
    id: str = Field(pattern=r"^[a-z0-9][a-z0-9._-]{1,63}$")
    language: RuleLanguage
    pattern: str = Field(min_length=1, max_length=_PATTERN_MAX_LENGTH)
    kind: RuleKind
    severity: RuleSeverity

    @model_validator(mode="after")
    def _regex_has_no_backreference(self) -> "InjectionRule":
        if self.kind == "regex" and has_backreference(self.pattern):
            raise ValueError("regex rules must not use back-references")
        return self


class InjectionRuleSet(_Contract):
    schema_version: Literal[1] = 1
    rules: list[InjectionRule]

    @model_validator(mode="after")
    def _rule_ids_are_unique(self) -> "InjectionRuleSet":
        ids = [rule.id for rule in self.rules]
        if len(set(ids)) != len(ids):
            raise ValueError("rule ids must be unique")
        return self


class DocTypeDetection(_Contract):
    doc_type: DocType
    confidence: float = Field(ge=0, le=1)
    signals: list[str]
    method: DetectionMethod
