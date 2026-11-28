from typing import Annotated, Literal

from pydantic import Field, model_validator

from rag_sidecar.contracts.groundedness import GroundednessScorer, GroundednessStatus, _Contract

# D-22: per-answer sentence cap; the remaining sentences are not_checked with reason too_many.
MAX_CLAIMS = 40
MAX_CLAIM_PREMISES = 64
MAX_PREMISE_TEXT_CHARS = 60_000
MAX_HYPOTHESIS_CHARS = 4_000

ClaimReason = Literal[
    "timeout",
    "too_many",
    "unsupported_language",
    "judge_not_configured",
    "judge_same_family",
    "judge_uncalibrated",
    "error",
]
JudgeVerdict = Literal["supported", "unsupported", "not_enough_info"]
JudgeThresholdSource = Literal["calibrated", "fixture"]
PremiseRef = Annotated[str, Field(pattern=r"^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$")]
Share = Annotated[float, Field(ge=0, le=1)]

_UNIQUE = {"uniqueItems": True}


def _require_unique(values: list, what: str) -> None:
    if len(values) != len(set(values)):
        raise ValueError(f"{what} must not repeat")


class ClaimPremise(_Contract):
    ref: PremiseRef
    text: str = Field(min_length=1, max_length=MAX_PREMISE_TEXT_CHARS)


class ClaimInput(_Contract):
    index: int = Field(ge=0)
    hypothesis: str = Field(min_length=1, max_length=MAX_HYPOTHESIS_CHARS)
    premise_refs: list[PremiseRef] = Field(min_length=1, max_length=MAX_CLAIM_PREMISES, json_schema_extra=_UNIQUE)


class ClaimCheckRequest(_Contract):
    request_id: str = Field(min_length=1)
    language: str = Field(min_length=1)
    premises: list[ClaimPremise] = Field(min_length=1, max_length=MAX_CLAIM_PREMISES)
    claims: list[ClaimInput] = Field(min_length=1, max_length=MAX_CLAIMS)
    allow_vectara: bool

    @model_validator(mode="after")
    def _refs_resolve(self) -> "ClaimCheckRequest":
        refs = [premise.ref for premise in self.premises]
        _require_unique(refs, "premise refs")
        _require_unique([claim.index for claim in self.claims], "claim indexes")
        known = set(refs)
        for claim in self.claims:
            _require_unique(claim.premise_refs, "premise_refs of a claim")
            if not set(claim.premise_refs) <= known:
                raise ValueError("a claim names a premise_ref that is not in premises")
        return self


class ClaimVerdict(_Contract):
    index: int = Field(ge=0)
    status: GroundednessStatus
    scorer: GroundednessScorer
    score: float | None = Field(default=None, ge=0, le=1)
    reason: ClaimReason | None = None

    @model_validator(mode="after")
    def _status_rules(self) -> "ClaimVerdict":
        if self.status == "scored":
            if self.score is None:
                raise ValueError("a scored claim requires a score")
            if self.scorer == "none":
                raise ValueError("a scored claim requires a scorer other than none")
        else:
            if self.score is not None:
                raise ValueError("a not_checked claim carries no score")
            if self.reason is None:
                raise ValueError("a not_checked claim requires a reason")
        return self


class ClaimCheckResult(_Contract):
    claims: list[ClaimVerdict] = Field(max_length=MAX_CLAIMS)
    latency_ms: int = Field(ge=0)

    @model_validator(mode="after")
    def _unique_indexes(self) -> "ClaimCheckResult":
        _require_unique([claim.index for claim in self.claims], "claim indexes")
        return self


class ClaimJudgementItem(_Contract):
    index: int = Field(ge=0)
    verdict: JudgeVerdict
    evidence_ref: str | None = Field(default=None, pattern=r"^S[1-9][0-9]*$")


class ClaimJudgement(_Contract):
    """D-25: the structured output of the in-app judge, one item per sentence."""

    judgements: list[ClaimJudgementItem] = Field(max_length=MAX_CLAIMS)

    @model_validator(mode="after")
    def _unique_indexes(self) -> "ClaimJudgement":
        _require_unique([item.index for item in self.judgements], "judgement indexes")
        return self


class GroundednessJudgeThresholdCell(_Contract):
    """D-27: an answer is verified while its unsupported share stays at or below the cell's maximum."""

    judge_model: str = Field(min_length=1)
    judge_version: str = Field(min_length=1)
    language: str = Field(min_length=1)
    max_unsupported_share: Share
    recall: Share
    precision: Share
    source: JudgeThresholdSource
    run_ids: list[Annotated[str, Field(min_length=1)]] = Field(min_length=1)
    config_hash: str = Field(min_length=1)
    fitted_at: str | None = None


class GroundednessJudgeThresholds(_Contract):
    schema_version: Literal[1] = 1
    cells: list[GroundednessJudgeThresholdCell] = Field(default_factory=list)

    @model_validator(mode="after")
    def _unique_cells(self) -> "GroundednessJudgeThresholds":
        keys = [(cell.judge_model, cell.judge_version, cell.language) for cell in self.cells]
        if len(keys) != len(set(keys)):
            raise ValueError("duplicate (judge_model, judge_version, language) threshold cell")
        return self
