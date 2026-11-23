from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, model_validator

from rag_sidecar.contracts.eval_run import ConversationTurn

Language = Literal["zh", "en", "it"]
Category = Literal["multi_turn", "compound", "exact_term", "table", "scanned", "no_answer", "general"]
ReviewStatus = Literal["draft", "approved", "rejected"]
Provenance = Literal["synthetic_fixture", "claude_draft", "ragas_generated", "human"]
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
    review_status: ReviewStatus
    provenance: Provenance
    split: Split

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
        return self


class _SkeletonBase(BaseModel):
    model_config = ConfigDict(frozen=True)


class GoldenSplitManifest(_SkeletonBase):
    schema_version: int = 1
    rule: str
    assignments: dict[str, str]


class DraftedItemProposal(_SkeletonBase):
    id: str | None = None
    question: str
    conversation: list[ConversationTurn] = Field(default_factory=list)
    language: str
    category: str
    answerable: bool
    expected_answer: str | None = None
    gold_evidence: list[GoldSpan] = Field(default_factory=list)


class DraftedItemBatch(_SkeletonBase):
    items: list[DraftedItemProposal]
