"""Phase 6.2 trace, wire and decision-record contracts (D-10, D-12, D-20, D-21, D-22, D-31).

T-06.2-02, T-06.2-03: trace parts carry counts, codes and timings only; RagTurnMetadata is query text plus, for an
out_of_scope answer, the scope-gate label (T-06.2-66).
"""

from datetime import datetime
from typing import Annotated, Literal

from pydantic import Field, model_validator

from rag_sidecar.contracts.omit import omit_none_schema
from rag_sidecar.contracts.retrieval import _Contract
from rag_sidecar.contracts.scope_gate import ScopeGateLabel

from .languages import Language

RuleId = Annotated[str, Field(pattern=r"^[a-z][a-z0-9_]{0,63}$")]
SwitchName = Annotated[str, Field(pattern=r"^RAG_[A-Z0-9_]{1,64}$")]
SliceName = Annotated[str, Field(min_length=1, max_length=128)]
D31Letter = Literal["a", "b", "c", "d", "e", "f", "g", "h", "i"]
DECISION_TOOL = "rag_eval.compare query-additions"


class ModelRoute(_Contract):
    """D-20: which tier answered and why; never the model's prompt."""

    tier: Literal["fast", "quality"]
    rule: RuleId
    selection: Literal["auto", "explicit"]


class SpeculativeTrace(_Contract):
    """D-21: speculative retrieval timing and waste."""

    started_ms: float = Field(ge=0)
    overlap_ms: float = Field(ge=0)
    cancelled_by_cache: bool
    wasted_searches: int = Field(ge=0)


class AnswerStructure(_Contract):
    """D-12 post-check: parts of a decomposed answer; cited_parts is None when not measured (no labeller)."""

    parts: int = Field(ge=0)
    cited_parts: int | None = Field(ge=0)
    uncovered_parts: int = Field(ge=0)


class RagTurnMetadata(_Contract):
    """D-22 wire shape (camelCase): the standalone query of a turn, sent back by the client as history only."""

    standaloneQuery: str = Field(min_length=1, max_length=1000)
    queryLanguage: Language | None
    # D-26, T-06.2-66: the scope-gate label of a turn answered without knowledge-base context; the label only, never a score
    scopeGate: ScopeGateLabel | None = Field(
        default=None,
        exclude_if=lambda value: value is None,
        json_schema_extra=omit_none_schema,
    )


class SwitchDecision(_Contract):
    name: SwitchName
    eligible: bool
    improved_slices: list[SliceName] = Field(default_factory=list)
    regressions: list[SliceName] = Field(default_factory=list)
    notes: str = Field(default="", max_length=2000)


class D31CheckEntry(_Contract):
    letter: D31Letter
    passed: bool
    evidence: str = Field(min_length=1, max_length=2000)


class QueryAdditionsDecisionRecord(_Contract):
    """D-10, D-31: written only by the decision-record tool (06.2-39)."""

    schema_version: Literal[1] = 1
    recorded_at: datetime
    report_hash: str = Field(pattern=r"^[a-f0-9]{64}$")
    source: Literal["fixture", "live"]
    decided_by: Literal["rag_eval.compare query-additions"] = DECISION_TOOL
    switches: list[SwitchDecision] = Field(default_factory=list)
    d31_checklist: list[D31CheckEntry] = Field(default_factory=list, max_length=9)

    @model_validator(mode="after")
    def _unique(self) -> "QueryAdditionsDecisionRecord":
        names = [switch.name for switch in self.switches]
        if len(set(names)) != len(names):
            raise ValueError("switches must not repeat a name")
        letters = [entry.letter for entry in self.d31_checklist]
        if len(set(letters)) != len(letters):
            raise ValueError("d31_checklist must not repeat a letter")
        return self
