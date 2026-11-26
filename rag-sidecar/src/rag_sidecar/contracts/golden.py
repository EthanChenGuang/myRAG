import unicodedata
from datetime import datetime
from typing import Annotated, Any, Literal

from pydantic import BaseModel, ConfigDict, Field, model_validator

from rag_sidecar.contracts.eval_run import ConversationTurn
from rag_sidecar.contracts.retrieval import RetrievalFilters

from .languages import Language
from .omit import OmitNoneModel, omit_none_schema

Category = Literal[
    "multi_turn",
    "compound",
    "exact_term",
    "table",
    "scanned",
    "no_answer",
    "general",
    "colloquial",
    "ambiguous",
    "typo",
    "cross_lingual",
    "selective_filter",
    "injection",
    "injection_evasive",
    "cache_paraphrase",
    "cache_near_miss",
    "small_talk",
    "table_split",
    "duplicate_flood",
    "identifier_near_miss",
]
INJECTION_CATEGORIES = frozenset({"injection", "injection_evasive"})
CACHE_PAIR_CATEGORIES = frozenset({"cache_paraphrase", "cache_near_miss"})
UNANSWERABLE_CATEGORIES = frozenset({"no_answer", "small_talk"})
ITEM_ID_PATTERN = r"^[a-z0-9][a-z0-9._-]{2,63}$"
UUID_PATTERN = r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$"
ReviewStatus = Literal["draft", "approved", "rejected"]
Provenance = Literal["synthetic_fixture", "claude_draft", "ragas_generated", "human", "production"]
Split = Literal["dev", "test"]
NativeReviewOrigin = Literal["native", "machine_translated", "llm_drafted"]
NativeReviewStatus = Literal["pending", "approved"]


class _Contract(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)


class GoldSpan(OmitNoneModel):
    _omit_when_none = ("document_id",)

    document: str
    section: str
    quote: str = Field(min_length=2)
    document_id: str | None = Field(default=None, pattern=UUID_PATTERN, json_schema_extra=omit_none_schema)


def _optional_object_schema(schema: dict[str, Any]) -> None:
    schema.pop("default", None)
    branches = schema.pop("anyOf", None) or []
    for branch in branches:
        if branch.get("type") != "null":
            schema.update(branch)


class TableAnswer(_Contract):
    """The one cell a table_split item asks for, plus same-unit values from other cells (D-45)."""

    value: str = Field(min_length=1)
    column: str = Field(min_length=1)
    distractor_values: list[str] = Field(default_factory=list)

    @model_validator(mode="after")
    def _check_distractors(self) -> "TableAnswer":
        if len(set(self.distractor_values)) != len(self.distractor_values):
            raise ValueError("distractor_values must not repeat")
        if self.value in self.distractor_values:
            raise ValueError("distractor_values must not contain the answer value")
        if any(not value.strip() for value in self.distractor_values):
            raise ValueError("distractor_values must be non-empty")
        return self


class NativeReview(_Contract):
    """Native-speaker review state of an item (D-45, XLG-02 delta); provenance is unchanged."""

    origin: NativeReviewOrigin
    status: NativeReviewStatus
    reviewer: str | None = Field(default=None, min_length=1, max_length=200)
    reviewed_at: datetime | None = None

    @model_validator(mode="after")
    def _approved_needs_reviewer(self) -> "NativeReview":
        if self.status == "approved" and (self.reviewer is None or self.reviewed_at is None):
            raise ValueError("an approved native_review needs reviewer and reviewed_at")
        return self


def _fold(text: str) -> str:
    return unicodedata.normalize("NFKC", text).casefold()


class AttackSpec(_Contract):
    canary: str = Field(min_length=6, max_length=128, pattern=r"^[A-Za-z0-9._:-]+$")
    injected_quotes: list[GoldSpan] = Field(min_length=1)
    forbidden_claims: list[str] = Field(min_length=1)

    @model_validator(mode="after")
    def _check_attack(self) -> "AttackSpec":
        if any(not claim.strip() for claim in self.forbidden_claims):
            raise ValueError("forbidden_claims must be non-empty literal strings")
        if any("<" in span.quote or ">" in span.quote for span in self.injected_quotes):
            raise ValueError("injected quotes must not contain < or >")
        return self


class GoldenItem(_Contract):
    id: str = Field(pattern=ITEM_ID_PATTERN)
    question: str
    conversation: list[ConversationTurn] = Field(default_factory=list)
    language: Language
    category: Category
    answerable: bool
    expected_answer: str | None = None
    gold_evidence: list[GoldSpan] = Field(default_factory=list)
    evidence_language: Language | None = None
    review_status: ReviewStatus
    provenance: Provenance
    split: Split
    retrieval_filters: RetrievalFilters | None = None
    tags: list[str] = Field(default_factory=list)
    attack: AttackSpec | None = None
    pair_of: str | None = Field(default=None, pattern=ITEM_ID_PATTERN)
    table_answer: TableAnswer | None = Field(
        default=None,
        exclude_if=lambda value: value is None,
        json_schema_extra=_optional_object_schema,
    )
    native_review: NativeReview | None = Field(
        default=None,
        exclude_if=lambda value: value is None,
        json_schema_extra=_optional_object_schema,
    )
    evidence_groups: list[list[Annotated[int, Field(ge=0)]]] | None = Field(
        default=None,
        exclude_if=lambda value: value is None,
        json_schema_extra=_optional_object_schema,
    )

    @model_validator(mode="after")
    def _check_evidence_groups(self) -> "GoldenItem":
        if self.evidence_groups is None:
            return self
        if not self.evidence_groups:
            raise ValueError("evidence_groups must not be an empty list")
        seen: set[int] = set()
        for group in self.evidence_groups:
            if not group:
                raise ValueError("an evidence group must not be empty")
            for index in group:
                if index >= len(self.gold_evidence):
                    raise ValueError("evidence_groups index out of range of gold_evidence")
                if index in seen:
                    raise ValueError("a gold_evidence index belongs to at most one evidence group")
                seen.add(index)
        return self

    @model_validator(mode="after")
    def _check_rules(self) -> "GoldenItem":
        if self.category in INJECTION_CATEGORIES and not self.answerable:
            raise ValueError("injection items must be answerable")
        if (self.category in UNANSWERABLE_CATEGORIES) == self.answerable:
            raise ValueError("category no_answer or small_talk if and only if answerable is false")
        if self.answerable:
            if not self.gold_evidence:
                raise ValueError("answerable items need at least one gold_evidence span")
            if not (self.expected_answer and self.expected_answer.strip()):
                raise ValueError("answerable items need a non-empty expected_answer")
        elif self.gold_evidence:
            raise ValueError("no_answer and small_talk items must have no gold_evidence spans")
        if self.category == "multi_turn" and not self.conversation:
            raise ValueError("multi_turn items need a non-empty conversation")
        if len(set(self.gold_evidence)) != len(self.gold_evidence):
            raise ValueError("gold_evidence contains identical spans")
        if self.category == "cross_lingual":
            if self.evidence_language is None:
                raise ValueError("cross_lingual items need an evidence_language")
            if self.evidence_language == self.language:
                raise ValueError("cross_lingual evidence_language must differ from the question language")
        elif self.evidence_language is not None and self.evidence_language != self.language:
            raise ValueError("evidence_language must equal the question language outside cross_lingual items")
        if (self.category == "table_split") != (self.table_answer is not None):
            raise ValueError("table_answer is required exactly for table_split items")
        self._check_pair()
        self._check_attack()
        return self

    def _check_pair(self) -> None:
        if (self.category in CACHE_PAIR_CATEGORIES) != (self.pair_of is not None):
            raise ValueError("pair_of is required exactly for cache_paraphrase and cache_near_miss items")
        if self.pair_of is not None and self.pair_of == self.id:
            raise ValueError("pair_of must name another item")

    def _check_attack(self) -> None:
        if (self.category in INJECTION_CATEGORIES) != (self.attack is not None):
            raise ValueError("attack is required exactly for injection and injection_evasive items")
        if self.attack is None:
            return
        canary = _fold(self.attack.canary)
        if canary in _fold(self.expected_answer or ""):
            raise ValueError("attack canary must not appear in expected_answer")
        if any(canary in _fold(span.quote) for span in self.gold_evidence):
            raise ValueError("attack canary must not appear in any gold_evidence quote")
        gold_documents = {span.document for span in self.gold_evidence}
        if any(span.document in gold_documents for span in self.attack.injected_quotes):
            raise ValueError("injected documents must not be gold documents")


ITEM_SPLIT_RULE = "sha256-first8hex-mod100-lt70-dev"
DOCGROUP_SPLIT_RULE = "docgroup-sha256-first8hex-mod100-lt70-dev"


class GoldenSplitManifest(OmitNoneModel):
    _omit_when_none = ("group_assignments",)

    schema_version: Literal[1] = 1
    rule: Literal["sha256-first8hex-mod100-lt70-dev", "docgroup-sha256-first8hex-mod100-lt70-dev"]
    assignments: dict[str, Split]
    group_assignments: dict[str, Split] | None = Field(default=None, json_schema_extra=omit_none_schema)

    @model_validator(mode="after")
    def _groups_only_under_the_docgroup_rule(self) -> "GoldenSplitManifest":
        if self.rule == DOCGROUP_SPLIT_RULE and self.group_assignments is None:
            raise ValueError("the docgroup rule needs group_assignments")
        if self.rule == ITEM_SPLIT_RULE and self.group_assignments is not None:
            raise ValueError("group_assignments exist only under the docgroup rule")
        return self


class DraftedItemProposal(_Contract):
    question: str
    conversation: list[ConversationTurn] = Field(default_factory=list)
    language: Language
    category: Category
    answerable: bool
    expected_answer: str | None = None
    gold_evidence: list[GoldSpan] = Field(default_factory=list)
    evidence_language: Language | None = None


class DraftedItemBatch(_Contract):
    items: list[DraftedItemProposal]
