from datetime import date
from typing import Annotated, Literal

from pydantic import ConfigDict, Field, field_validator, model_validator

from rag_sidecar.contracts.ingest import DocType
from rag_sidecar.contracts.omit import omit_default_schema, omit_none_schema
from rag_sidecar.contracts.retrieval import ConfigProvenance, _Contract
from rag_sidecar.contracts.scopes import ScopeDimension, ScopeSlug

from .languages import Language

Lang = Language
Transform = Literal["condense_history", "normalize_dates", "decompose", "expand", "translate"]
QueryFramework = Literal["llamaindex", "langchain"]
VariantKind = Literal["original", "condensed", "expanded", "hyde", "sub_question", "translated", "history_fallback"]
SkipReason = Literal[
    "timeout", "error", "aborted", "protected_token_lost", "length", "cap", "disabled_for_profile", "glossary_term_lost"
]
SkippableTransform = Literal["condense_history", "normalize_dates", "decompose", "expand", "hyde", "translate"]

MAX_LLM_VARIANTS = 2
MAX_TRANSLATIONS = 2
MAX_SUB_QUESTIONS = 4
MAX_SEARCHES = 8
LLM_LIST_CAP = 4
MAX_SCOPE_FILTER_VALUES = 20


def _omit_none(value: object) -> bool:
    return value is None


def _omit_empty(value: object) -> bool:
    return value == []


def _omit_false(value: object) -> bool:
    return value is False


class RewriteGateResult(_Contract):
    rewrite: bool
    transforms: list[Transform] = Field(max_length=5)
    reasons: list[str] = Field(max_length=32)
    lang: Lang
    protected_tokens: list[str] = Field(max_length=64)
    skip_retrieval: bool = False


class DateRange(_Contract):
    from_date: date
    to_date: date
    include_undated: bool = False
    time_zone: str = Field(min_length=1, max_length=64)

    @model_validator(mode="after")
    def _from_before_to(self) -> "DateRange":
        if self.from_date > self.to_date:
            raise ValueError("from_date must be on or before to_date")
        return self


class QueryVariantOut(_Contract):
    text: str = Field(min_length=1, max_length=4000)
    language: Lang
    kind: VariantKind
    sub_question_index: int | None = Field(default=None, ge=0, lt=MAX_SUB_QUESTIONS)
    protected_ok: bool
    filter_applied: bool = Field(default=False, exclude_if=_omit_false, json_schema_extra=omit_default_schema)

    @model_validator(mode="after")
    def _index_matches_kind(self) -> "QueryVariantOut":
        if self.kind == "sub_question" and self.sub_question_index is None:
            raise ValueError("sub_question variants require sub_question_index")
        if self.kind != "sub_question" and self.sub_question_index is not None:
            raise ValueError("only sub_question variants carry sub_question_index")
        return self


class SkippedTransform(_Contract):
    transform: SkippableTransform
    reason: SkipReason


class SubQuestionDateRange(_Contract):
    """D-05: a sub-question's period; no include flags (the undated rule stays the request's own)."""

    model_config = ConfigDict(extra="forbid", frozen=True, serialize_by_alias=True)

    from_: Annotated[date, Field(alias="from")]
    to: date

    @model_validator(mode="after")
    def _from_before_to(self) -> "SubQuestionDateRange":
        if self.from_ > self.to:
            raise ValueError("date_range.from must be on or before date_range.to")
        return self


ScopeFilterValues = Annotated[list[ScopeSlug], Field(min_length=1, max_length=MAX_SCOPE_FILTER_VALUES)]


class SubQuestionFilter(_Contract):
    """D-05, T-06.2-01: the only narrowing a decomposer may propose. No tenant, document, source, version or include
    field; every field is required and nullable for strict structured output (A-5). Plan 06.2-25 adds versions."""

    date_range: SubQuestionDateRange | None
    scopes: dict[ScopeDimension, ScopeFilterValues] | None
    doc_types: list[DocType] | None = Field(min_length=1)
    languages: list[Language] | None = Field(min_length=1)

    @field_validator("scopes", mode="after")
    @classmethod
    def _scopes_named(cls, value: dict[str, list[str]] | None) -> dict[str, list[str]] | None:
        if value is not None:
            if not value:
                raise ValueError("scopes must name at least one dimension")
            for dimension, values in value.items():
                if len(set(values)) != len(values):
                    raise ValueError(f"scopes.{dimension} must not repeat")
        return value

    @field_validator("doc_types", "languages", mode="after")
    @classmethod
    def _unique(cls, value: list[str] | None) -> list[str] | None:
        if value is not None and len(set(value)) != len(value):
            raise ValueError("filter values must not repeat")
        return value


class SubQuestionSpec(_Contract):
    text: str = Field(min_length=1, max_length=4000)
    filter: SubQuestionFilter | None


class SubQuestionsWithFilters(_Contract):
    """P-18: the decomposer output used only with RAG_QUERY_SUBQ_FILTERS on; SubQuestions stays the default."""

    questions: list[SubQuestionSpec] = Field(max_length=LLM_LIST_CAP)


class CompletenessResult(_Contract):
    """D-04, T-06.2-03: counts and the action only, never the term text."""

    required_count: int = Field(ge=0)
    missing_count: int = Field(ge=0)
    action: Literal["ok", "added", "discarded"]


LanguageDetectionSource = Literal[
    "single_language", "detector", "sidecar", "llm", "previous_turn", "ui_language", "primary"
]


class LanguageDetection(_Contract):
    """D-17: the resolved query language and the step of the chain that decided it."""

    language: Lang | None
    confidence: float = Field(ge=0, le=1)
    source: LanguageDetectionSource


SubQuestionFilterStatus = Literal[
    "applied", "dropped_invalid", "dropped_empty_intersection", "dropped_unknown_values", "stripped_switch_off"
]


class SubQuestionFilterTrace(_Contract):
    index: int = Field(ge=0, lt=MAX_SUB_QUESTIONS)
    status: SubQuestionFilterStatus
    retried: bool
    retry_skipped_cap: bool


class QueryPlan(_Contract):
    original: str = Field(min_length=1, max_length=4000)
    standalone: str = Field(min_length=1, max_length=4000)
    language: Lang
    gate: RewriteGateResult
    date_range: DateRange | None = None
    variants: list[QueryVariantOut] = Field(default_factory=list, max_length=MAX_SEARCHES)
    sub_questions: list[str] = Field(default_factory=list, max_length=MAX_SUB_QUESTIONS)
    skipped: list[SkippedTransform] = Field(default_factory=list)
    framework: QueryFramework
    sub_question_specs: list[SubQuestionSpec] = Field(
        default_factory=list,
        max_length=MAX_SUB_QUESTIONS,
        exclude_if=_omit_empty,
        json_schema_extra=omit_default_schema,
    )
    completeness: CompletenessResult | None = Field(
        default=None, exclude_if=_omit_none, json_schema_extra=omit_none_schema
    )
    language_detection: LanguageDetection | None = Field(
        default=None, exclude_if=_omit_none, json_schema_extra=omit_none_schema
    )
    filter_trace: list[SubQuestionFilterTrace] = Field(
        default_factory=list,
        max_length=MAX_SUB_QUESTIONS,
        exclude_if=_omit_empty,
        json_schema_extra=omit_default_schema,
    )

    @model_validator(mode="after")
    def _sub_question_indexes_resolve(self) -> "QueryPlan":
        for variant in self.variants:
            if variant.sub_question_index is not None and variant.sub_question_index >= len(self.sub_questions):
                raise ValueError("sub_question_index must point at an entry of sub_questions")
        return self

    @model_validator(mode="after")
    def _specs_match_sub_questions(self) -> "QueryPlan":
        if self.sub_question_specs and [spec.text for spec in self.sub_question_specs] != self.sub_questions:
            raise ValueError("sub_question_specs texts must equal sub_questions")
        for entry in self.filter_trace:
            if entry.index >= len(self.sub_questions):
                raise ValueError("filter_trace index must point at an entry of sub_questions")
        return self


class CondensedQuery(_Contract):
    standalone: str
    unchanged: bool
    language: Lang | None


class QueryVariants(_Contract):
    queries: list[str] = Field(max_length=LLM_LIST_CAP)


class HypotheticalDocument(_Contract):
    passage: str


class SubQuestions(_Contract):
    questions: list[str] = Field(max_length=LLM_LIST_CAP)


class QueryTranslation(_Contract):
    target_language: Lang
    text: str
    source_language: Lang | None


class QueryBudgetMs(_Contract):
    chat: int = Field(default=1200, ge=1, le=60000)
    embed: int = Field(default=1200, ge=1, le=60000)
    voice: int = Field(default=300, ge=1, le=60000)


class QueryBudgetMsOverride(_Contract):
    chat: int | None = Field(default=None, ge=1, le=60000)
    embed: int | None = Field(default=None, ge=1, le=60000)
    voice: int | None = Field(default=None, ge=1, le=60000)


def _check_caps(model: object) -> None:
    caps = {
        "max_llm_variants": MAX_LLM_VARIANTS,
        "max_translations": MAX_TRANSLATIONS,
        "max_sub_questions": MAX_SUB_QUESTIONS,
        "max_searches": MAX_SEARCHES,
    }
    for name, cap in caps.items():
        value = getattr(model, name)
        if value is not None and value > cap:
            raise ValueError(f"{name} must not exceed {cap}")


class QueryParams(_Contract):
    schema_version: Literal[1] = 1
    max_llm_variants: int = Field(default=2, ge=0, le=MAX_LLM_VARIANTS)
    max_translations: int = Field(default=2, ge=0, le=MAX_TRANSLATIONS)
    max_sub_questions: int = Field(default=4, ge=0, le=MAX_SUB_QUESTIONS)
    max_searches: int = Field(default=8, ge=1, le=MAX_SEARCHES)
    variant_max_chars: int = Field(default=500, ge=1, le=4000)
    variant_max_ratio: float = Field(default=4.0, gt=0, le=20)
    history_turns: int = Field(default=6, ge=0, le=20)
    history_turn_chars: int = Field(default=1000, ge=1, le=4000)
    group_deadline_ms: int = Field(default=900, ge=1, le=60000)
    query_budget_ms: QueryBudgetMs = Field(default_factory=QueryBudgetMs)
    language_confidence_threshold: float = Field(default=0.6, ge=0, le=1)
    routing_fast_max_context_tokens: int = Field(default=2000, ge=1, le=200000)
    subq_filter_vocab_cap: int = Field(default=20, ge=1, le=200)
    langid_timeout_ms: int = Field(default=30, ge=1, le=60000)
    provenance: ConfigProvenance = Field(default_factory=lambda: ConfigProvenance(source="defaults"))
    config_hash: str | None = Field(default=None, pattern=r"^[a-f0-9]{64}$")

    @model_validator(mode="after")
    def _d08_limits(self) -> "QueryParams":
        _check_caps(self)
        return self


class QueryParamsOverride(_Contract):
    max_llm_variants: int | None = Field(default=None, ge=0, le=MAX_LLM_VARIANTS)
    max_translations: int | None = Field(default=None, ge=0, le=MAX_TRANSLATIONS)
    max_sub_questions: int | None = Field(default=None, ge=0, le=MAX_SUB_QUESTIONS)
    max_searches: int | None = Field(default=None, ge=1, le=MAX_SEARCHES)
    variant_max_chars: int | None = Field(default=None, ge=1, le=4000)
    variant_max_ratio: float | None = Field(default=None, gt=0, le=20)
    history_turns: int | None = Field(default=None, ge=0, le=20)
    history_turn_chars: int | None = Field(default=None, ge=1, le=4000)
    group_deadline_ms: int | None = Field(default=None, ge=1, le=60000)
    query_budget_ms: QueryBudgetMsOverride | None = None

    @model_validator(mode="after")
    def _d08_limits(self) -> "QueryParamsOverride":
        _check_caps(self)
        return self


class QueryTransformToggles(_Contract):
    condense: bool | None = None
    normalize_dates: bool | None = None
    translate: bool | None = None
    expand: bool | None = None
    hyde: bool | None = None
    decompose: bool | None = None
