from datetime import date
from typing import Annotated, Literal
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

from rag_sidecar.contracts.answer_checks import AnswerChecks
from rag_sidecar.contracts.groundedness import GroundednessScorer, ReasonCode, ThresholdSource

CitationStrategy = Literal["claude-citations", "chunk-alias"]
AnswerGroundednessStatus = Literal["pending", "scored", "not_checked"]
GroundednessLabel = Literal["verified", "possibly_unreliable", "not_checked"]
FeedbackVote = Literal["helpful", "not_helpful"]
FeedbackReason = Literal["wrong", "incomplete", "not_from_documents", "bad_citation"]
AnswerRagMode = Literal["strict", "balanced", "flexible", "bypass"]
DocumentAvailability = Literal["current", "unavailable"]
TextsSource = Literal["registry", "legacy"]


class _Contract(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)


def _omit_none(value: object) -> bool:
    return value is None


def _omit_empty_checks(value: object) -> bool:
    return value == AnswerChecks()


def _omit_none_schema(schema: dict) -> None:
    schema.pop("default", None)
    branches = [branch for branch in schema.pop("anyOf", None) or [] if branch.get("type") != "null"]
    if len(branches) == 1:
        schema.update(branches[0])


class CitationAlsoIn(_Contract):
    """D-21: a duplicate of the cited chunk in another document, collapsed under this citation."""

    documentId: str = Field(min_length=1)
    filename: str
    chunkId: str = Field(min_length=1)


class CitationRecord(_Contract):
    n: int = Field(ge=1)
    alias: str = Field(pattern=r"^S[1-9][0-9]*$")
    chunkIds: list[Annotated[str, Field(min_length=1)]]
    documentId: str = Field(min_length=1)
    documentName: str
    documentVersion: int | None = None
    page: int | None = None
    sectionPath: list[str] | None = None
    quote: str = Field(min_length=1)
    quoteHash: str = Field(pattern=r"^[a-f0-9]{64}$")
    strategy: CitationStrategy
    isCurrent: bool | None = Field(default=None, exclude_if=_omit_none, json_schema_extra=_omit_none_schema)
    versionLabel: str | None = Field(
        default=None, max_length=40, exclude_if=_omit_none, json_schema_extra=_omit_none_schema
    )
    effectiveFrom: date | None = Field(default=None, exclude_if=_omit_none, json_schema_extra=_omit_none_schema)
    effectiveTo: date | None = Field(default=None, exclude_if=_omit_none, json_schema_extra=_omit_none_schema)
    alsoIn: list[CitationAlsoIn] | None = Field(
        default=None, exclude_if=_omit_none, json_schema_extra=_omit_none_schema
    )


class AnswerGroundedness(_Contract):
    status: AnswerGroundednessStatus
    scorer: GroundednessScorer | None = None
    score: float | None = Field(default=None, ge=0, le=1)
    label: GroundednessLabel | None = None
    threshold: float | None = Field(default=None, ge=0, le=1)
    thresholdSource: ThresholdSource | None = None
    reason: ReasonCode | None = None
    truncated: bool = False
    latencyMs: int | None = Field(default=None, ge=0)
    checkedAt: str | None = None

    @model_validator(mode="after")
    def _status_rules(self) -> "AnswerGroundedness":
        if self.status == "pending":
            if self.label is not None or self.score is not None or self.scorer is not None:
                raise ValueError("a pending result carries no scorer, score or label")
        elif self.status == "scored":
            if self.score is None or self.threshold is None or self.thresholdSource is None:
                raise ValueError("a scored result requires score, threshold and thresholdSource")
            if self.scorer is None or self.scorer == "none":
                raise ValueError("a scored result requires a scorer other than none")
            expected = "verified" if self.score >= self.threshold else "possibly_unreliable"
            if self.label != expected:
                raise ValueError("label must follow score >= threshold")
        else:
            if self.label != "not_checked":
                raise ValueError("a not_checked result has label not_checked")
            if self.score is not None:
                raise ValueError("a not_checked result carries no score")
            if self.reason is None:
                raise ValueError("a not_checked result requires a reason")
        return self


def _unique_reasons(reasons: list[str]) -> list[str]:
    if len(reasons) != len(set(reasons)):
        raise ValueError("feedback reasons must not repeat")
    return reasons


class AnswerFeedback(_Contract):
    vote: FeedbackVote
    reasons: list[FeedbackReason] = Field(
        default_factory=list, max_length=4, json_schema_extra={"uniqueItems": True}
    )
    comment: str | None = Field(default=None, max_length=500)
    updatedAt: str = Field(min_length=1)

    @field_validator("reasons")
    @classmethod
    def _no_repeats(cls, value: list[str]) -> list[str]:
        return _unique_reasons(value)


class AnswerFeedbackRequest(_Contract):
    vote: FeedbackVote
    reasons: list[FeedbackReason] = Field(
        default_factory=list, max_length=4, json_schema_extra={"uniqueItems": True}
    )
    comment: str | None = Field(default=None, max_length=500)
    chatId: UUID | None = None

    @field_validator("reasons")
    @classmethod
    def _no_repeats(cls, value: list[str]) -> list[str]:
        return _unique_reasons(value)


class AnswerRecord(_Contract):
    answerId: UUID
    chatId: UUID | None = None
    traceId: str = Field(min_length=1)
    modelId: str = Field(min_length=1)
    citationStrategy: CitationStrategy | None = None
    ragMode: AnswerRagMode
    answerLanguage: str | None = None
    invalidCitations: int = Field(default=0, ge=0)
    citations: list[CitationRecord] = Field(default_factory=list)
    groundedness: AnswerGroundedness
    feedback: AnswerFeedback | None = None
    documents: dict[str, DocumentAvailability] = Field(default_factory=dict)
    feedbackEnabled: bool = False
    createdAt: str = Field(min_length=1)
    updatedAt: str = Field(min_length=1)
    checks: AnswerChecks = Field(default_factory=AnswerChecks, exclude_if=_omit_empty_checks)
    textsSource: TextsSource | None = Field(default=None, exclude_if=_omit_none, json_schema_extra=_omit_none_schema)
