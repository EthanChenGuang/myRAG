"""Terminology dictionary contracts (Phase 4.1.1 D-04, D-17, D-23, D-24, D-26, D-32, D-33, D-34, D-35).

Languages come from the Phase 3.2 registry (D-35); an entry may also use the literal `any`.
"""

from __future__ import annotations

from datetime import datetime
from typing import Annotated, Literal
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field, StringConstraints, field_validator, model_validator

from .languages import LANGUAGE_CODES, Language, build_language_type
from .retrieval import ConfigProvenance, compute_config_hash

ANY_LANGUAGE = "any"

TermLanguage = build_language_type(LANGUAGE_CODES, extra=(ANY_LANGUAGE,))

TerminologyKind = Literal["synonym", "abbreviation", "alias", "identifier", "translation", "misspelling"]
TerminologyMode = Literal["one_way", "equivalent"]
TerminologyLayer = Literal["shared", "workspace"]
TerminologyIssueCode = Literal[
    "conflict",
    "chain",
    "cycle",
    "invalid_variant",
    "invalid_language",
    "invalid_translation",
    "limit",
    "duplicate",
    "override",
]
TerminologyIssueSeverity = Literal["error", "warning"]
TerminologyCandidateStatus = Literal["pending", "accepted", "dismissed"]
TerminologyCandidateSource = Literal["miss_log", "feedback", "langfuse"]

MAX_TERM_CHARS = 64
MAX_VARIANTS = 16
MAX_NOTE_CHARS = 500
MAX_EXPANSION_MATCHES = 8
MAX_EXPANSION_TOKENS = 24
MAX_CANDIDATE_EXAMPLES = 3

TermText = Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=MAX_TERM_CHARS)]
NoteText = Annotated[str, StringConstraints(max_length=MAX_NOTE_CHARS)]
Token = Annotated[str, Field(min_length=1, max_length=256)]
Normalized = Annotated[str, Field(min_length=1, max_length=256)]
ExpansionVersion = Annotated[str, Field(pattern=r"^s\d+(\.w\d+)?$")]
LayerVersion = Annotated[str, Field(pattern=r"^s\d+\.w\d+$")]


class _Contract(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)


def _unique_variants(variants: list[str]) -> list[str]:
    seen: set[str] = set()
    for variant in variants:
        if variant in seen:
            raise ValueError(f"duplicate variant {variant!r}")
        seen.add(variant)
    return variants


class _TranslationRules(_Contract):
    """D-04, D-32: the translation-pair encoding, shared by entries and import rows."""

    language: TermLanguage
    kind: TerminologyKind
    mode: TerminologyMode = "one_way"
    source_language: Language | None = None
    target_language: Language | None = None

    @model_validator(mode="after")
    def _translation_pair(self) -> _TranslationRules:
        if self.kind == "translation":
            if self.source_language is None or self.target_language is None:
                raise ValueError("a translation needs source_language and target_language")
            if self.source_language == self.target_language:
                raise ValueError("source_language and target_language must differ")
            if self.language != self.source_language:
                raise ValueError("a translation's language must equal its source_language")
            if self.mode != "one_way":
                raise ValueError("a translation's mode must be one_way")
        elif self.source_language is not None or self.target_language is not None:
            raise ValueError("source_language and target_language are only set on a translation")
        return self


class TerminologyEntry(_TranslationRules):
    id: UUID | None = None
    layer: TerminologyLayer
    canonical: TermText
    variants: list[TermText] = Field(default_factory=list, max_length=MAX_VARIANTS)
    enabled: bool = True
    note: NoteText | None = None
    suppresses_entry_id: UUID | None = None

    @field_validator("variants")
    @classmethod
    def _variants_unique(cls, value: list[str]) -> list[str]:
        return _unique_variants(value)

    @model_validator(mode="after")
    def _suppression(self) -> TerminologyEntry:
        if self.suppresses_entry_id is not None:
            if self.variants:
                raise ValueError("a suppression row has no variants")
            if self.layer != "workspace":
                raise ValueError("only a workspace row can suppress an entry")
        elif not self.variants:
            raise ValueError("an entry needs at least one variant")
        return self


class TerminologyImportRow(_TranslationRules):
    """One CSV row of D-23 (variants already split on `|`); also one line of the fixture dictionary (D-27)."""

    canonical: TermText
    variants: list[TermText] = Field(min_length=1, max_length=MAX_VARIANTS)
    enabled: bool = True
    note: NoteText | None = None

    @field_validator("variants")
    @classmethod
    def _variants_unique(cls, value: list[str]) -> list[str]:
        return _unique_variants(value)


class TerminologyParams(_Contract):
    schema_version: Literal[1] = 1
    max_matches: int = Field(default=8, ge=1, le=MAX_EXPANSION_MATCHES)
    max_terms_per_match: int = Field(default=4, ge=1, le=MAX_VARIANTS)
    max_expansion_tokens: int = Field(default=24, ge=1, le=MAX_EXPANSION_TOKENS)
    expansion_weight: float = Field(default=0.5, gt=0, le=1)
    dense_weight: float = Field(default=0.5, gt=0, le=0.5)
    min_han_chars: int = Field(default=2, ge=1, le=4)
    reserve_slots: int = Field(default=2, ge=0, le=4)
    provenance: ConfigProvenance = Field(default_factory=lambda: ConfigProvenance(source="defaults"))
    config_hash: str | None = Field(default=None, pattern=r"^[a-f0-9]{64}$")


def terminology_params_sha256(params: TerminologyParams) -> str:
    """The `params_sha256` of the D-21 hash block; provenance and config_hash do not change it."""
    return compute_config_hash(params)


class TerminologyMatch(_Contract):
    surface: Normalized
    canonical: TermText
    entry_id: UUID
    kind: TerminologyKind
    language: TermLanguage
    layer: TerminologyLayer
    start: int = Field(ge=0)
    end: int = Field(ge=1)

    @model_validator(mode="after")
    def _span_and_kind(self) -> TerminologyMatch:
        if self.end <= self.start:
            raise ValueError("end must be greater than start")
        if self.kind == "translation":
            raise ValueError("a translation pair never matches a query (D-32)")
        return self


class TerminologyExpansion(_Contract):
    matches: list[TerminologyMatch] = Field(max_length=MAX_EXPANSION_MATCHES)
    expansion_tokens: list[Token] = Field(max_length=MAX_EXPANSION_TOKENS)
    dense_text: str | None = Field(default=None, min_length=1, max_length=2000)
    capped: bool
    version: ExpansionVersion


class TerminologyValidationIssue(_Contract):
    code: TerminologyIssueCode
    severity: TerminologyIssueSeverity
    row: int | None = Field(default=None, ge=1)
    entry_ids: list[UUID] = Field(default_factory=list)
    message: str = Field(min_length=1, max_length=500)


class TerminologyImportReport(_Contract):
    create: int = Field(ge=0)
    update: int = Field(ge=0)
    unchanged: int = Field(ge=0)
    delete: int = Field(ge=0)
    issues: list[TerminologyValidationIssue]
    layer_version_seen: int = Field(ge=0)
    applied: bool


class TerminologyPreviewRequest(_Contract):
    query: str = Field(min_length=1, max_length=2000)
    layer: TerminologyLayer
    organization_id: UUID | None = None
    draft_entries: list[TerminologyEntry] = Field(default_factory=list, max_length=50)


class TerminologyPreviewResponse(_Contract):
    matches: list[TerminologyMatch]
    original_tokens: list[Token]
    expansion_tokens: list[Token]
    capped: bool
    overrides: list[TerminologyValidationIssue]
    issues: list[TerminologyValidationIssue]
    version: ExpansionVersion


class TerminologyCandidate(_Contract):
    id: UUID
    term: TermText
    language: Language | None
    support: int = Field(ge=1)
    examples: list[Annotated[str, Field(min_length=1, max_length=500)]] = Field(max_length=MAX_CANDIDATE_EXAMPLES)
    corpus_df: int = Field(ge=0)
    status: TerminologyCandidateStatus
    source: TerminologyCandidateSource
    first_seen: datetime
    last_seen: datetime
    entry_id: UUID | None = None

    @model_validator(mode="after")
    def _seen_order(self) -> TerminologyCandidate:
        if self.last_seen < self.first_seen:
            raise ValueError("last_seen must not be before first_seen")
        return self


class TerminologyLexiconTerm(_Contract):
    normalized: Normalized
    language: TermLanguage
    kind: TerminologyKind


class TerminologyTranslationPair(_Contract):
    entry_id: UUID
    source_language: Language
    target_language: Language
    sources: list[TermText] = Field(min_length=1, max_length=MAX_VARIANTS)
    target: TermText
    target_normalized: Normalized

    @model_validator(mode="after")
    def _languages_differ(self) -> TerminologyTranslationPair:
        if self.source_language == self.target_language:
            raise ValueError("source_language and target_language must differ")
        return self


class TerminologyLexicon(_Contract):
    """D-33: the return contract of getTerminologyLexicon (Phase 4.2 LANG-07, Phase 6.2 XLG-05)."""

    version: LayerVersion
    entries_sha256: str = Field(pattern=r"^[a-f0-9]{64}$")
    terms: list[TerminologyLexiconTerm]
    translations: list[TerminologyTranslationPair]
