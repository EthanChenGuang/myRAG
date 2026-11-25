from datetime import date, datetime
from typing import Annotated, Literal

from pydantic import BaseModel, ConfigDict, Field, model_validator

Uuid = Annotated[str, Field(pattern=r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$")]
SupersessionDirection = Literal["document_is_newer", "candidate_is_newer"]
SupersessionStatus = Literal["pending", "confirmed", "dismissed"]
SupersessionOrigin = Literal["detected", "uploader", "answer_conflict"]

MAX_EVIDENCE_QUOTE_CHARS = 2_000


class _Contract(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)


class SupersessionSignals(_Contract):
    title_match: bool
    content_overlap_percent: int = Field(ge=0, le=100)
    conflicting_numbers: int = Field(ge=0)


class SupersessionCandidate(_Contract):
    """A possible replacement between two documents of one tenant (D-41); never applied without an admin decision."""

    id: Uuid
    document_id: Uuid
    candidate_document_id: Uuid
    signals: SupersessionSignals
    direction: SupersessionDirection | None = None
    status: SupersessionStatus
    origin: SupersessionOrigin
    decided_by: Uuid | None = None
    decided_at: datetime | None = None

    @model_validator(mode="after")
    def _check_decision(self) -> "SupersessionCandidate":
        if self.document_id == self.candidate_document_id:
            raise ValueError("candidate_document_id must name another document")
        decided = self.decided_by is not None or self.decided_at is not None
        if self.status == "pending" and decided:
            raise ValueError("a pending candidate has no decided_by or decided_at")
        if self.status != "pending" and (self.decided_by is None or self.decided_at is None):
            raise ValueError("a confirmed or dismissed candidate needs decided_by and decided_at")
        if self.status == "confirmed" and self.direction is None:
            raise ValueError("a confirmed candidate needs a direction")
        return self


class SupersessionRules(_Contract):
    """Detector thresholds, stored as data in config/rag/supersession-rules.json (D-41)."""

    schema_version: Literal[1] = 1
    rules_version: str = Field(min_length=1, max_length=64)
    title_similarity_min: float = Field(gt=0, le=1)
    content_overlap_min_percent: int = Field(ge=1, le=100)
    min_conflicting_numbers: int = Field(ge=1)


class EffectiveDateExtraction(_Contract):
    """Structured model output for effective dates (D-43); accepted only when evidence_quote is found verbatim."""

    effective_from: date | None = None
    effective_to: date | None = None
    confidence: float = Field(ge=0, le=1)
    evidence_quote: str = Field(min_length=1, max_length=MAX_EVIDENCE_QUOTE_CHARS)

    @model_validator(mode="after")
    def _check_dates(self) -> "EffectiveDateExtraction":
        if self.effective_from is None and self.effective_to is None:
            raise ValueError("at least one of effective_from and effective_to is required")
        if self.effective_from is not None and self.effective_to is not None and self.effective_from > self.effective_to:
            raise ValueError("effective_from must be on or before effective_to")
        if not self.evidence_quote.strip():
            raise ValueError("evidence_quote must not be blank")
        return self
