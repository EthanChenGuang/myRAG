from __future__ import annotations

import json
import os
import subprocess
import tempfile
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Callable

from pydantic import ValidationError
from rag_sidecar.contracts.eval_run import RagTrace, RunManifest
from rag_sidecar.contracts.report import EvalReport

from rag_eval.golden_io import load_golden, write_golden
from rag_eval.paths import REPO_ROOT
from rag_eval.split import assign_split
from rag_eval.traces import load_manifest, load_traces

HARNESS_SCRIPT = "eval/harness/run-smoke.mts"
TAIL_LINES = 20
INPUTS_DIR = "inputs"

Spawner = Callable[[list[str], Path], Any]


class HarnessError(RuntimeError):
    def __init__(self, message: str, *, exit_code: int | None = None, stdout_tail: str = "", stderr_tail: str = "") -> None:
        super().__init__(message)
        self.exit_code = exit_code
        self.stdout_tail = stdout_tail
        self.stderr_tail = stderr_tail


@dataclass(frozen=True)
class HarnessRun:
    out_dir: Path
    golden_path: Path
    run_config_path: Path
    argv: list[str]
    report: EvalReport | None = None
    traces: list[RagTrace] = field(default_factory=list)
    manifest: RunManifest | None = None
    notes: list[str] = field(default_factory=list)


def _tail(text: str | bytes | None, lines: int = TAIL_LINES) -> str:
    if text is None:
        return ""
    if isinstance(text, bytes):
        text = text.decode("utf-8", errors="replace")
    return "\n".join(text.splitlines()[-lines:])


def default_spawner(argv: list[str], cwd: Path) -> subprocess.CompletedProcess[str]:
    return subprocess.run(argv, cwd=cwd, capture_output=True, text=True, check=False, env=os.environ.copy())


def dev_only_golden(path: Path, dest: Path | None = None) -> Path:
    """Write the dev-split items of a golden file (rule split and split field both dev); the test split never passes."""
    items = [item for item in load_golden(Path(path)) if assign_split(item.id) == "dev" and item.split == "dev"]
    if dest is None:
        handle, name = tempfile.mkstemp(prefix="golden-dev-", suffix=".jsonl")
        os.close(handle)
        target = Path(name)
    else:
        target = Path(dest)
    write_golden(target, items)
    return target


def _read_run_config(path: Path) -> dict[str, Any]:
    try:
        payload = json.loads(Path(path).read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise HarnessError(f"run-config {path} is unreadable: {exc}") from exc
    if not isinstance(payload, dict):
        raise HarnessError(f"run-config {path} must be a JSON object")
    return payload


def merged_run_config(base: dict[str, Any], overrides: dict[str, Any] | None, *, live: bool) -> dict[str, Any]:
    merged = dict(base)
    combined = dict(base.get("overrides") or {})
    combined.update(overrides or {})
    if combined:
        merged["overrides"] = combined
    else:
        merged.pop("overrides", None)
    if live:
        merged["env"] = {}
    return merged


def run_harness(
    *,
    run_config: Path,
    golden: Path,
    out: Path,
    overrides: dict[str, Any] | None = None,
    base_url: str | None = None,
    fixture_mode: str | None = None,
    spawner: Spawner | None = None,
    repo_root: Path = REPO_ROOT,
) -> HarnessRun:
    out_dir = Path(out)
    inputs = out_dir / INPUTS_DIR
    inputs.mkdir(parents=True, exist_ok=True)

    golden_path = dev_only_golden(Path(golden), inputs / "golden.dev.jsonl")
    base = _read_run_config(Path(run_config))
    notes: list[str] = []
    if base_url and base.get("env"):
        notes.append("run-config env overlay dropped: it applies to in-process runs only and a live run uses the deployed environment")
    config_path = inputs / "run-config.json"
    config_path.write_text(
        json.dumps(merged_run_config(base, overrides, live=bool(base_url)), sort_keys=True, indent=2) + "\n", encoding="utf-8"
    )

    argv = [
        "npx",
        "tsx",
        HARNESS_SCRIPT,
        "--run-config",
        str(config_path),
        "--golden",
        str(golden_path),
        "--no-gate",
        "--out",
        str(out_dir),
    ]
    if base_url:
        argv.extend(["--base-url", base_url])
    if fixture_mode:
        argv.extend(["--fixture-mode", fixture_mode])

    result = (spawner or default_spawner)(argv, Path(repo_root))
    code = getattr(result, "returncode", None)
    if code != 0:
        stdout_tail = _tail(getattr(result, "stdout", ""))
        stderr_tail = _tail(getattr(result, "stderr", ""))
        message = f"harness exited with exit code {code}"
        if stdout_tail:
            message += f"\n--- last {TAIL_LINES} stdout lines ---\n{stdout_tail}"
        raise HarnessError(message, exit_code=code, stdout_tail=stdout_tail, stderr_tail=stderr_tail)

    try:
        report = EvalReport.model_validate_json((out_dir / "report.json").read_text(encoding="utf-8"))
    except (OSError, ValidationError, ValueError) as exc:
        raise HarnessError(f"harness wrote no readable report.json in {out_dir}: {exc}", exit_code=0) from exc
    try:
        traces = load_traces(out_dir / "traces.jsonl")
    except (OSError, ValueError) as exc:
        raise HarnessError(f"harness wrote no readable traces.jsonl in {out_dir}: {exc}", exit_code=0) from exc
    manifest: RunManifest | None = None
    manifest_path = out_dir / "run.json"
    if manifest_path.is_file():
        try:
            manifest = load_manifest(manifest_path)
        except (OSError, ValueError) as exc:
            raise HarnessError(f"harness wrote an unreadable run.json in {out_dir}: {exc}", exit_code=0) from exc

    return HarnessRun(
        out_dir=out_dir,
        golden_path=golden_path,
        run_config_path=config_path,
        argv=argv,
        report=report,
        traces=traces,
        manifest=manifest,
        notes=notes,
    )
