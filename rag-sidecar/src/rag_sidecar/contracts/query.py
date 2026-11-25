from datetime import date
from typing import Literal

from pydantic import Field, model_validator

from rag_sidecar.contracts.golden import _Contract
from rag_sidecar.contracts.retrieval import ConfigProvenance

Lang = Literal["zh", "en", "it"]
Transform = Literal["condense_history", "normalize_dates", "decompose", "expand", "translate"]
QueryFramework = Literal["llamaindex", "langchain"]
VariantKind = Literal["original", "condensed", "expanded", "hyde", "sub_question", "translated"]
SkipReason = Literal["timeout", "error", "aborted", "protected_token_lost", "length", "cap", "disabled_for_profile"]
SkippableTransform = Literal["condense_history", "normalize_dates", "decompose", "expand", "hyde", "translate"]

MAX_LLM_VARIANTS = 2
MAX_TRANSLATIONS = 2
MAX_SUB_QUESTIONS = 4
MAX_SEARCHES = 8
LLM_LIST_CAP = 4


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

    @model_validator(mode="after")
    def _sub_question_indexes_resolve(self) -> "QueryPlan":
        for variant in self.variants:
            if variant.sub_question_index is not None and variant.sub_question_index >= len(self.sub_questions):
                raise ValueError("sub_question_index must point at an entry of sub_questions")
        return self


class CondensedQuery(_Contract):
    standalone: str
    unchanged: bool


class QueryVariants(_Contract):
    queries: list[str] = Field(max_length=LLM_LIST_CAP)


class HypotheticalDocument(_Contract):
    passage: str


class SubQuestions(_Contract):
    questions: list[str] = Field(max_length=LLM_LIST_CAP)


class QueryTranslation(_Contract):
    target_language: Lang
    text: str


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
