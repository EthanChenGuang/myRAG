"""D-17, D-18, A-10: the release regression runner (placeholder until the plan, run and decide subcommands land)."""

from dataclasses import dataclass
from pathlib import Path
from typing import Any

LEGACY_PROFILE = "openai-3-small-1536"
INCUMBENT_CONFIG = "b.incumbent"
CONFIRM_CONFIG = "confirm"
ABLATIONS: tuple = ()


@dataclass(frozen=True)
class RunArtifacts:
    report: Any
    traces: list
    manifest: dict | None = None
    judge: Any = None


def load_artifacts(out_dir: Path) -> RunArtifacts:
    return RunArtifacts(report=None, traces=[])


def read_ledger(path: Path) -> list:
    return []


def markdown_path(decisions_dir: Path, decision: Any) -> Path:
    return decisions_dir / "unset.md"


def main(argv: list[str] | None = None, *, clock=None, runner=None) -> int:
    return 1
