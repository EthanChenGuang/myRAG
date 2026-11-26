from typing import Annotated, Literal

from pydantic import Field, model_validator

from rag_sidecar.contracts.groundedness import GroundednessScorer, ReasonCode, _Contract

SentenceKind = Literal["sentence", "list_item", "table", "heading", "code", "truncated"]
SentenceSupport = Literal["supported", "unsupported", "not_checked"]
OutputGuardMode = Literal["flag", "enforce"]
VersionGroupRule = Literal["supersession_link", "supersession_candidate", "title_match"]
# Lowercase hex SHA-256 of the persisted text part the offsets address (UI-SPEC 8.1).
TextHash = Annotated[str, Field(pattern=r"^[a-f0-9]{64}$")]
FinishReason = Annotated[str, Field(pattern=r"^[a-z][a-z0-9_-]{0,31}$")]
Count = Annotated[int, Field(ge=0)]

_UNIQUE = {"uniqueItems": True}


def _check_span(start: int, end: int) -> None:
    if end <= start:
        raise ValueError("end must be greater than start")


class BlockedRange(_Contract):
    """Offsets are UTF-16 code units into text part `part`, valid only while its hash matches."""

    part: int = Field(ge=0)
    start: int = Field(ge=0)
    end: int = Field(ge=0)
    text_hash: TextHash

    @model_validator(mode="after")
    def _ordered(self) -> "BlockedRange":
        _check_span(self.start, self.end)
        return self


class AnswerSentence(_Contract):
    index: int = Field(ge=0)
    part: int = Field(ge=0)
    start: int = Field(ge=0)
    end: int = Field(ge=0)
    kind: SentenceKind
    text_hash: TextHash
    factual: bool
    cited: bool
    support: SentenceSupport = "not_checked"
    scorer: GroundednessScorer | None = None
    reason: ReasonCode | None = None

    @model_validator(mode="after")
    def _rules(self) -> "AnswerSentence":
        _check_span(self.start, self.end)
        if self.support == "not_checked":
            if self.reason is None:
                raise ValueError("a not_checked sentence requires a reason")
        elif self.scorer is None or self.scorer == "none":
            raise ValueError("a supported or unsupported sentence requires a scorer other than none")
        return self


class OutputGuardSummary(_Contract):
    mode: OutputGuardMode
    rules_version: str = Field(min_length=1, max_length=64)
    links_checked: Count = 0
    links_removed: Count = 0
    credential_blocked: Count = 0
    credential_warned: Count = 0
    rule_ids: list[str] = Field(default_factory=list)
    event_ids: list[str] = Field(default_factory=list)
    source_chunk_ids: list[str] = Field(default_factory=list)
    blocked_ranges: list[BlockedRange] = Field(default_factory=list)


class VersionConflict(_Contract):
    document_ids: list[Annotated[str, Field(min_length=1)]] = Field(min_length=2, json_schema_extra=_UNIQUE)
    latest_document_id: str = Field(min_length=1)
    group_rule: VersionGroupRule
    mixed_versions: bool = False

    @model_validator(mode="after")
    def _rules(self) -> "VersionConflict":
        if len(set(self.document_ids)) != len(self.document_ids):
            raise ValueError("document_ids must not repeat")
        if self.latest_document_id not in self.document_ids:
            raise ValueError("latest_document_id must be one of document_ids")
        return self


class AnswerNotice(_Contract):
    kind: ReasonCode
    text: str = Field(min_length=1)
    language: str = Field(min_length=1)


class ClaimsSummary(_Contract):
    total: Count = 0
    unsupported: Count = 0
    not_checked: Count = 0
    reasons: dict[ReasonCode, Count] = Field(default_factory=dict)
    scorer: GroundednessScorer | None = None
    judge_version: str | None = None

    @model_validator(mode="after")
    def _counts(self) -> "ClaimsSummary":
        if self.unsupported + self.not_checked > self.total:
            raise ValueError("unsupported plus not_checked must not exceed total")
        return self


class AnswerChecks(_Contract):
    """D-23: per-answer checks; `{}` validates so rows written before this column keep loading."""

    sentences: list[AnswerSentence] = Field(default_factory=list)
    output_guard: OutputGuardSummary | None = None
    version_conflict: VersionConflict | None = None
    claims: ClaimsSummary | None = None
    truncated: bool = False
    finish_reason: FinishReason | None = None
    # D-89: the language detected from the answer text; the question's language stays on the record.
    text_language: str | None = None

    @model_validator(mode="after")
    def _unique_indexes(self) -> "AnswerChecks":
        indexes = [sentence.index for sentence in self.sentences]
        if len(indexes) != len(set(indexes)):
            raise ValueError("sentence indexes must not repeat")
        return self
