"""Phase 5.2.1 whole-prompt token budget contracts (05.2 D-80, D-81, D-85 to D-88).

`PromptBudgetConfig` is `config/rag/prompt-budget.json`, `TokenizerCalibration` is
`eval/config/tokenizer-calibration.json` (written by the calibration tool only); the trace and the summary record
counts and codes, never prompt text.
"""

from typing import Annotated, Literal

from pydantic import BaseModel, ConfigDict, Field, model_validator

Count = Annotated[int, Field(ge=0)]
FamilyName = Annotated[str, Field(pattern=r"^[a-z0-9][a-z0-9._-]{0,63}$")]
TokenizerEncoding = Literal["cl100k_base"]
FactorSource = Literal["measured", "default"]


class _Contract(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)


class PromptBudgetConfig(_Contract):
    version: int = Field(ge=1)
    default_window: int = Field(ge=1024)
    margin_ratio: float = Field(ge=0, le=0.5)
    margin_tokens: Count
    near_limit_ratio: float = Field(ge=0.5, le=1)
    mcp_tool_reserve: Count
    voice_document_budget: Count
    voice_system_reserve: Count
    voice_answer_reserve: Count
    refine_max_calls: int = Field(ge=1, le=4)


class TokenizerFamilyFactor(_Contract):
    """One model family's estimate factor over `cl100k_base` counts, at the stated quantile of measured ratios."""

    family: FamilyName
    factor: float = Field(ge=0.5)
    quantile: float = Field(ge=0, le=1)
    samples: Count
    source: FactorSource
    run_ids: list[Annotated[str, Field(min_length=1)]] = Field(default_factory=list)
    computed_at: str | None = None

    @model_validator(mode="after")
    def _measured_needs_samples(self) -> "TokenizerFamilyFactor":
        if self.source == "measured" and (self.samples < 1 or not self.run_ids):
            raise ValueError("a measured factor needs samples and run_ids")
        return self


class TokenizerCalibration(_Contract):
    version: int = Field(ge=1)
    encoding: TokenizerEncoding = "cl100k_base"
    default_factor: float = Field(ge=1)
    families: list[TokenizerFamilyFactor] = Field(default_factory=list)
    written_by: str = Field(min_length=1, max_length=120)

    @model_validator(mode="after")
    def _unique_families(self) -> "TokenizerCalibration":
        names = [cell.family for cell in self.families]
        if len(names) != len(set(names)):
            raise ValueError("a family appears at most once")
        return self


class PromptBudgetParts(_Contract):
    """Estimated tokens per prompt part; `reserve` is the answer reserve (the effective output cap)."""

    system: Count
    rules: Count
    tools: Count
    history: Count
    question: Count
    documents: Count
    reserve: Count


class PromptBudgetEstimator(_Contract):
    encoding: TokenizerEncoding = "cl100k_base"
    family: FamilyName | None = None
    factor: float = Field(ge=0.5)
    factor_source: FactorSource


class PromptBudgetTrace(_Contract):
    parts: PromptBudgetParts
    estimated_raw_total: Count
    window: int = Field(ge=1)
    window_source: Literal["model", "default"]
    context_length_unknown: bool
    estimator: PromptBudgetEstimator
    dropped_documents: Count
    dropped_history_turns: Count
    near_limit: bool
    overflow_mode: Literal["truncate", "refine"]
    status: Literal["ok", "exceeded"]
    standalone_kept: bool


class PromptBudgetSummary(_Contract):
    """The part of `PromptBudgetTrace` stored in `rag_answer_records.checks`."""

    parts: PromptBudgetParts
    window: int = Field(ge=1)
    dropped_documents: Count
    dropped_history_turns: Count
    near_limit: bool
    status: Literal["ok", "exceeded"]
