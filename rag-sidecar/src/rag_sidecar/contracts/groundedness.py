from typing import Annotated, Any, Literal

from pydantic import BaseModel, ConfigDict, Field, model_validator

GroundednessStatus = Literal["scored", "not_checked"]
GroundednessScorer = Literal["hhem_2_3_vectara", "hhem_2_1_open", "llm_judge", "none"]
ThresholdSource = Literal["default", "calibrated"]
ReasonCode = Annotated[str, Field(pattern=r"^[a-z][a-z0-9_]{0,63}$")]


class _Contract(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)


class GroundednessRequest(_Contract):
    request_id: str = Field(min_length=1)
    language: str = Field(min_length=1)
    premise_texts: list[Annotated[str, Field(min_length=1)]] = Field(min_length=1)
    hypothesis: str = Field(min_length=1)
    allow_vectara: bool


class GroundednessResult(_Contract):
    status: GroundednessStatus
    scorer: GroundednessScorer
    score: float | None = Field(default=None, ge=0, le=1)
    reason: ReasonCode | None = None
    truncated: bool = False
    latency_ms: int = Field(ge=0)

    @model_validator(mode="after")
    def _status_rules(self) -> "GroundednessResult":
        if self.status == "scored":
            if self.score is None:
                raise ValueError("a scored result requires a score")
            if self.scorer == "none":
                raise ValueError("a scored result requires a scorer other than none")
        else:
            if self.score is not None:
                raise ValueError("a not_checked result carries no score")
            if self.reason is None:
                raise ValueError("a not_checked result requires a reason")
        return self


class GroundednessThresholdCell(_Contract):
    scorer: Literal["hhem_2_3_vectara", "hhem_2_1_open"]
    language: str = Field(min_length=1)
    threshold: float = Field(ge=0, le=1)
    source: ThresholdSource
    fitted_at: str | None = None
    dev: dict[str, Any] | None = None
    holdout: dict[str, Any] | None = None


class GroundednessThresholds(_Contract):
    schema_version: Literal[1] = 1
    cells: list[GroundednessThresholdCell] = Field(default_factory=list)

    @model_validator(mode="after")
    def _unique_cells(self) -> "GroundednessThresholds":
        keys = [(cell.scorer, cell.language) for cell in self.cells]
        if len(keys) != len(set(keys)):
            raise ValueError("duplicate (scorer, language) threshold cell")
        return self
