from __future__ import annotations

import shutil
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Callable

from rag_sidecar.contracts.eval_run import RagTrace, RunManifest
from rag_sidecar.contracts.report import EvalReport


class HarnessError(RuntimeError):
    pass


@dataclass(frozen=True)
class HarnessRun:
    out_dir: Path
    golden_path: Path
    run_config_path: Path
    argv: list[str]
    report: EvalReport | None = None
    traces: list[RagTrace] = field(default_factory=list)
    manifest: RunManifest | None = None


Spawner = Callable[[list[str], Path], Any]


def dev_only_golden(path: Path, dest: Path | None = None) -> Path:
    target = Path(dest) if dest is not None else Path(path)
    if Path(path) != target:
        shutil.copyfile(path, target)
    return target


def run_harness(**_kwargs: Any) -> HarnessRun:
    return HarnessRun(out_dir=Path("."), golden_path=Path("."), run_config_path=Path("."), argv=[])
