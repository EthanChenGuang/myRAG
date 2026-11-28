from typing import Annotated, Literal

from pydantic import Field, model_validator

from rag_sidecar.contracts.groundedness import _Contract
from rag_sidecar.contracts.ingest import RuleLanguage, has_backreference

OutputCapMode = Literal["strict", "balanced"]
OutputCapSource = Literal["default", "sweep"]

_CAP_MODES: tuple[OutputCapMode, ...] = ("strict", "balanced")
_PATTERN_MAX_LENGTH = 200

RuleId = Annotated[str, Field(pattern=r"^[a-z0-9][a-z0-9._-]{1,63}$")]
RuleTerm = Annotated[str, Field(min_length=1, max_length=80)]
UrlScheme = Annotated[str, Field(pattern=r"^[a-z][a-z0-9+.-]{0,31}$")]


class CredentialRule(_Contract):
    """D-39: a request form and a secret or log-in term inside one sentence; security vocabulary only."""

    id: RuleId
    language: RuleLanguage
    request_terms: list[RuleTerm] = Field(min_length=1)
    secret_terms: list[RuleTerm] = Field(min_length=1)


class ObfuscationPattern(_Contract):
    id: RuleId
    pattern: str = Field(min_length=1, max_length=_PATTERN_MAX_LENGTH)

    @model_validator(mode="after")
    def _no_backreference(self) -> "ObfuscationPattern":
        if has_backreference(self.pattern):
            raise ValueError("obfuscation patterns must not use back-references")
        return self


class OutputGuardRules(_Contract):
    """D-39: `config/rag/output-guard-rules.json`, versioned; `version` is the rules_version on every summary."""

    schema_version: Literal[1] = 1
    version: str = Field(min_length=1, max_length=64)
    credential_rules: list[CredentialRule] = Field(default_factory=list)
    obfuscation_patterns: list[ObfuscationPattern] = Field(default_factory=list)
    opaque_schemes: list[UrlScheme] = Field(default_factory=list, json_schema_extra={"uniqueItems": True})

    @model_validator(mode="after")
    def _unique(self) -> "OutputGuardRules":
        ids = [rule.id for rule in self.credential_rules] + [item.id for item in self.obfuscation_patterns]
        if len(ids) != len(set(ids)):
            raise ValueError("rule ids must be unique")
        if len(self.opaque_schemes) != len(set(self.opaque_schemes)):
            raise ValueError("opaque_schemes must not repeat")
        return self


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
