from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, model_validator

from rag_sidecar.contracts.eval_run import ConversationTurn
from rag_sidecar.contracts.retrieval import RetrievalFilters

Language = Literal["zh", "en", "it"]
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
]
ReviewStatus = Literal["draft", "approved", "rejected"]
Provenance = Literal["synthetic_fixture", "claude_draft", "ragas_generated", "human", "production"]
Split = Literal["dev", "test"]


class _Contract(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)


class GoldSpan(_Contract):
    document: str
    section: str
    quote: str = Field(min_length=2)


class GoldenItem(_Contract):
    id: str = Field(pattern=r"^[a-z0-9][a-z0-9._-]{2,63}$")
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

    @model_validator(mode="after")
    def _check_rules(self) -> "GoldenItem":
        if (self.category == "no_answer") == self.answerable:
            raise ValueError("category no_answer if and only if answerable is false")
        if self.answerable:
            if not self.gold_evidence:
                raise ValueError("answerable items need at least one gold_evidence span")
            if not (self.expected_answer and self.expected_answer.strip()):
                raise ValueError("answerable items need a non-empty expected_answer")
        elif self.gold_evidence:
            raise ValueError("no_answer items must have no gold_evidence spans")
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
        return self


class GoldenSplitManifest(_Contract):
    schema_version: Literal[1] = 1
    rule: Literal["sha256-first8hex-mod100-lt70-dev"]
    assignments: dict[str, Split]


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
