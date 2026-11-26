"""Release gate contracts (Phase 5.3 D-33 to D-36).

`skipped` and `not_applicable` are their own values and are never folded into `passed`; only ship_check may be
`not_applicable` (population legacy). The override reason is the only operator-written text.
"""

from typing import Annotated, Literal

from pydantic import BaseModel, ConfigDict, Field, model_validator

from .monitor import CODE_PATTERN, SHA256_PATTERN, Code, Sha256, Timestamp
from .retrieval import ConfigProvenance

GIT_SHA_PATTERN = r"^[a-f0-9]{40}$"
GITHUB_LOGIN_PATTERN = r"^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})(\[bot\])?$"

ReleaseGatePartName = Literal["nightly_absolute", "judge_floors", "ship_check", "pr_smoke"]
ReleaseGatePartResult = Literal["passed", "failed", "skipped", "not_applicable"]
ReleaseGateOutcome = Literal["passed", "failed", "skipped"]
ReleaseGateSource = Literal["ci", "local_prerelease", "override"]
GateFile = Literal["quality_gates", "release_gate", "noise"]

GitSha = Annotated[str, Field(pattern=GIT_SHA_PATTERN)]
GithubLogin = Annotated[str, Field(pattern=GITHUB_LOGIN_PATTERN)]


class _Contract(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)


class ReleaseGatePart(_Contract):
    part: ReleaseGatePartName
    result: ReleaseGatePartResult
    reason: str | None = Field(default=None, pattern=CODE_PATTERN)

    @model_validator(mode="after")
    def _consistent(self) -> "ReleaseGatePart":
        if self.result == "not_applicable" and self.part != "ship_check":
            raise ValueError("only ship_check can be not_applicable")
        if self.result == "skipped" and self.reason is None:
            raise ValueError("a skipped part names its reason")
        return self


class ReleaseGateResult(_Contract):
    sha: GitSha
    result: ReleaseGateOutcome
    skip_reason: Code | None = None
    parts: list[ReleaseGatePart] = Field(min_length=1)
    gate_file_hashes: dict[GateFile, Sha256] = Field(default_factory=dict)
    changed_gate_files: list[GateFile] = Field(default_factory=list)
    source: ReleaseGateSource
    actor: GithubLogin | None = None
    override_reason: str | None = Field(default=None, min_length=10, max_length=500)
    report_hashes: dict[Code, Sha256] = Field(default_factory=dict)
    created_at: Timestamp

    @model_validator(mode="after")
    def _consistent(self) -> "ReleaseGateResult":
        names = [part.part for part in self.parts]
        if len(set(names)) != len(names):
            raise ValueError("parts must not repeat")
        if len(set(self.changed_gate_files)) != len(self.changed_gate_files):
            raise ValueError("changed_gate_files must not repeat")
        if (self.result == "skipped") != (self.skip_reason is not None):
            raise ValueError("skip_reason is set exactly when the result is skipped")
        if self.source == "override":
            if self.actor is None or self.override_reason is None:
                raise ValueError("an override needs actor and override_reason")
            if self.result != "passed":
                raise ValueError("an override records result passed")
            return self
        if self.override_reason is not None:
            raise ValueError("override_reason belongs to an override only")
        results = {part.result for part in self.parts}
        if "failed" in results:
            expected = "failed"
        elif "skipped" in results:
            expected = "skipped"
        else:
            expected = "passed"
        if self.result != expected:
            raise ValueError(f"parts give result {expected}, not {self.result}")
        return self


class ReleaseGateConfig(_Contract):
    schema_version: Literal[1] = 1
    status_context: Literal["rag-release-gate"]
    required_parts: list[ReleaseGatePartName] = Field(min_length=1)
    provenance: ConfigProvenance
    config_hash: str | None = Field(default=None, pattern=SHA256_PATTERN)

    @model_validator(mode="after")
    def _distinct(self) -> "ReleaseGateConfig":
        if len(set(self.required_parts)) != len(self.required_parts):
            raise ValueError("required_parts must not repeat")
        return self


def default_release_gate() -> ReleaseGateConfig:
    return ReleaseGateConfig(
        status_context="rag-release-gate",
        required_parts=["nightly_absolute", "judge_floors", "ship_check", "pr_smoke"],
        provenance=ConfigProvenance(source="defaults"),
    )
