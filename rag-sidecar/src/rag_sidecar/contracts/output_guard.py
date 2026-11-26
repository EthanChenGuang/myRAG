from typing import Annotated, Literal

from pydantic import Field, model_validator

from rag_sidecar.contracts.groundedness import _Contract

OutputCapMode = Literal["strict", "balanced"]
OutputCapSource = Literal["default", "sweep"]

_CAP_MODES: tuple[OutputCapMode, ...] = ("strict", "balanced")


class OutputCapCell(_Contract):
    mode: OutputCapMode
    # None means the cell is off: the model limit applies unchanged (D-29).
    limit: int | None = Field(default=None, gt=0)
    source: OutputCapSource
    run_ids: list[Annotated[str, Field(min_length=1)]] = Field(default_factory=list)
    config_hash: str | None = Field(default=None, min_length=1)

    @model_validator(mode="after")
    def _sweep_has_evidence(self) -> "OutputCapCell":
        if self.source == "sweep" and (not self.run_ids or self.config_hash is None):
            raise ValueError("a sweep cell requires run_ids and config_hash")
        return self


class OutputCaps(_Contract):
    """D-29/D-34: written only by `python -m rag_eval.sweep output-cap`."""

    schema_version: Literal[1] = 1
    cells: list[OutputCapCell] = Field(min_length=2, max_length=2)

    @model_validator(mode="after")
    def _one_cell_per_mode(self) -> "OutputCaps":
        if sorted(cell.mode for cell in self.cells) != sorted(_CAP_MODES):
            raise ValueError("output caps need exactly one cell per mode (strict, balanced)")
        return self
