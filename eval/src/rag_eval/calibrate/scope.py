"""Scope gate calibration (plan 06.2-26, D-27): threshold and margin per embedding profile and RAG mode.

Reads the `scope_gate` scores of a score-only eval run (RAG_SCOPE_GATE on, empty calibration), fits a threshold per mode on the dev
split with the refusal tool's fit_threshold, checks the cut `threshold - margin` once per margin step on the frozen holdout with its
holdout_check, and writes eval/config/scope-gate.json. Only this tool writes that file.

D-34 review gate: a run scored with the fixture embedder writes `source: fixture`; `--source live` needs a real-embedder separation
report and a run scored with a real embedder. No cell is written for a profile other than the scored run's.
"""

from __future__ import annotations

import json
import math
from dataclasses import dataclass, field
from datetime import datetime
from pathlib import Path
from typing import Any, Literal, Sequence

from rag_sidecar.contracts.baseline import NoiseConfig
from rag_sidecar.contracts.eval_run import RagTrace, RunManifest
from rag_sidecar.contracts.golden import GoldenItem
from rag_sidecar.contracts.retrieval import RefusalCalibrationConfig, RefusalMode
from rag_sidecar.contracts.scope_gate import ScopeGateCalibration, ScopeGateCalibrationCell

from rag_eval.bounds import upper_bound
from rag_eval.calibrate.refusal import (
    CALIBRATION_PATH,
    DEFAULT_GOLDEN,
    MODES,
    NEVER_REFUSE,
    NOISE_PATH,
    CalibrationRow,
    CellFit,
    _metric_block,
    fit_threshold,
    holdout_check,
)
from rag_eval.config_files import write_config_atomically
from rag_eval.golden_io import load_golden
from rag_eval.paths import REPO_ROOT
from rag_eval.split import assign_split
from rag_eval.traces import load_manifest, load_traces

SCOPE_GATE_PATH = REPO_ROOT / "eval" / "config" / "scope-gate.json"
FIXTURE_EMBEDDER = "fixture-ngram"
LEGACY_PROFILE_ID = "openai-3-small-1536"
MARGIN_STEP = 0.005
MAX_MARGIN_STEPS = 40
DEV_SPLIT = "dev"
TEST_SPLIT = "test"
Source = Literal["fixture", "live"]


class ScopeCalibrationError(RuntimeError):
    pass


@dataclass(frozen=True)
class ScopeRow:
    item_id: str
    split: str
    answerable: bool
    score: float


@dataclass
class ScopeCalibrationResult:
    source: Source
    profile_id: str
    rows: int
    excluded: dict[str, int] = field(default_factory=dict)
    cells: list[ScopeGateCalibrationCell] = field(default_factory=list)
    out_path: Path | None = None


def mode_targets(config: RefusalCalibrationConfig) -> dict[str, float]:
    """D-27, P-01: the per-mode RNK-07 false-refusal target when set, otherwise the single target for every mode."""
    by_mode = config.targets_by_mode or {}
    targets: dict[str, float] = {}
    for mode in MODES:
        entry = by_mode.get(mode)
        targets[mode] = entry.target_false_refusal if entry is not None and entry.target_false_refusal is not None else config.target_false_refusal
    return targets


def _calibration_rows(rows: Sequence[ScopeRow], split: str, key: str) -> list[CalibrationRow]:
    return [
        CalibrationRow(
            item_id=row.item_id,
            split=row.split,
            answerable=row.answerable,
            score=row.score,
            key=key,
            provider="scope_gate",
            model="scope_gate",
            query_language="en",
            pairing="same",
            tokenizer_version=0,
            rerank_text_version=0,
            config_hash="",
        )
        for row in rows
        if row.split == split
    ]


def _cell_fit(key: str, threshold: float, target: float, dev: Any) -> CellFit:
    return CellFit(
        key=key,
        provider="scope_gate",
        model="scope_gate",
        query_language="en",
        pairing="same",
        threshold=threshold,
        status="fitted",
        dev=dev,
        tokenizer_version=0,
        rerank_text_version=0,
        config_hash="",
        target=target,
    )


def _uncalibrated(profile_id: str, mode: RefusalMode, threshold: float | None, answerable: list[float], no_answer: list[float]) -> ScopeGateCalibrationCell:
    cut = NEVER_REFUSE if threshold is None else threshold
    false_refusals = sum(1 for s in answerable if s < cut)
    correct = sum(1 for s in no_answer if s < cut)
    return ScopeGateCalibrationCell(
        embedding_profile_id=profile_id,
        rag_mode=mode,
        threshold=threshold,
        margin=None,
        false_refusal_rate=false_refusals / len(answerable) if answerable else None,
        false_refusal_n=len(answerable),
        correct_refusal_rate=correct / len(no_answer) if no_answer else None,
        correct_refusal_n=len(no_answer),
        false_refusal_upper_95=upper_bound(false_refusals, len(answerable)) if answerable else None,
        status="uncalibrated",
    )


def fit_scope_cells(
    rows: Sequence[ScopeRow],
    profile_id: str,
    targets: dict[str, float],
    *,
    config: RefusalCalibrationConfig,
    environment: Source,
    noise_floor: float,
) -> list[ScopeGateCalibrationCell]:
    """One cell per RAG mode: fit on dev, then the smallest margin whose holdout cut passes the refusal pass rule."""
    dev_answerable = [r.score for r in rows if r.split == DEV_SPLIT and r.answerable]
    dev_no_answer = [r.score for r in rows if r.split == DEV_SPLIT and not r.answerable]
    test_answerable = [r.score for r in rows if r.split == TEST_SPLIT and r.answerable]
    test_no_answer = [r.score for r in rows if r.split == TEST_SPLIT and not r.answerable]
    dev_min = getattr(config.dev_minimums, environment)
    cells: list[ScopeGateCalibrationCell] = []
    for mode in MODES:
        target = targets[mode]
        if len(dev_answerable) < dev_min.answerable or len(dev_no_answer) < dev_min.no_answer:
            cells.append(_uncalibrated(profile_id, mode, None, test_answerable, test_no_answer))
            continue
        fit = fit_threshold(dev_answerable, dev_no_answer, target)
        if not math.isfinite(fit.threshold):
            cells.append(_uncalibrated(profile_id, mode, None, test_answerable, test_no_answer))
            continue
        key = f"scope|{profile_id}|{mode}"
        test_rows = _calibration_rows(rows, TEST_SPLIT, key)
        dev_block = _metric_block(dev_answerable, dev_no_answer, fit.threshold)
        chosen: tuple[float, Any] | None = None
        for step in range(MAX_MARGIN_STEPS + 1):
            margin = round(step * MARGIN_STEP, 6)
            cut = round(fit.threshold - margin, 9)
            result = holdout_check(
                _cell_fit(key, cut, target, dev_block), test_rows, config=config, environment=environment, noise_floor=noise_floor
            )
            if result.status == "insufficient_data":
                break
            if result.status == "calibrated":
                chosen = (margin, result)
                break
        if chosen is None:
            cells.append(_uncalibrated(profile_id, mode, round(fit.threshold, 9), test_answerable, test_no_answer))
            continue
        margin, result = chosen
        cells.append(
            ScopeGateCalibrationCell(
                embedding_profile_id=profile_id,
                rag_mode=mode,
                threshold=round(fit.threshold, 9),
                margin=margin,
                false_refusal_rate=result.metrics.false_refusal_rate,
                false_refusal_n=result.metrics.answerable_count,
                correct_refusal_rate=result.metrics.correct_refusal_rate,
                correct_refusal_n=result.metrics.no_answer_count,
                false_refusal_upper_95=result.metrics.false_refusal_rate_upper_bound,
                status="calibrated",
            )
        )
    return cells


def collect_scope_rows(traces: Sequence[RagTrace], golden: Sequence[GoldenItem]) -> tuple[list[ScopeRow], dict[str, int]]:
    by_id = {item.id: item for item in golden}
    rows: list[ScopeRow] = []
    excluded: dict[str, int] = {}
    seen: set[str] = set()

    def skip(reason: str) -> None:
        excluded[reason] = excluded.get(reason, 0) + 1

    for trace in traces:
        item = by_id.get(trace.item_id) if trace.item_id else None
        if item is None:
            skip("unknown_item")
            continue
        if item.id in seen:
            skip("duplicate_trace")
            continue
        seen.add(item.id)
        if assign_split(item.id) != item.split:
            skip("split_mismatch")
            continue
        gate = trace.scope_gate
        if gate is None or gate.score is None or not math.isfinite(gate.score):
            skip("no_scope_score")
            continue
        rows.append(ScopeRow(item_id=item.id, split=item.split, answerable=item.answerable, score=float(gate.score)))
    return rows, excluded


def stable_json(model: ScopeGateCalibration) -> str:
    return json.dumps(model.model_dump(mode="json"), sort_keys=True, indent=2, ensure_ascii=False) + "\n"


def _read_json(path: Path, what: str) -> dict[str, Any]:
    try:
        return json.loads(Path(path).read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise ScopeCalibrationError(f"{what} {path} is unreadable: {exc}") from exc


def _run_is_fixture(manifest: RunManifest, traces: Sequence[RagTrace]) -> bool:
    if manifest.embedder is not None and manifest.embedder.id == FIXTURE_EMBEDDER:
        return True
    return any(trace.effective_config.embedding_model == FIXTURE_EMBEDDER for trace in traces)


def _run_profile(manifest: RunManifest, traces: Sequence[RagTrace]) -> str:
    if manifest.embedding_profile:
        return manifest.embedding_profile
    profiles_env = {(trace.effective_config.rag_env.get("RAG_EMBEDDING_PROFILES") or "off") for trace in traces}
    if profiles_env <= {"off", "false"}:
        return LEGACY_PROFILE_ID
    raise ScopeCalibrationError("the run used embedding profiles but its manifest names no profile; the scored profile is unknown")


def _check_separation_report(path: Path | None) -> None:
    if path is None:
        raise ScopeCalibrationError("--source live needs --separation-report naming a real-embedder separation report (D-34 review)")
    report = _read_json(path, "separation report")
    embedder = report.get("embedder")
    if not isinstance(embedder, str) or not embedder or embedder == FIXTURE_EMBEDDER:
        raise ScopeCalibrationError(f"the separation report {path} was made with {embedder!r}; a live calibration needs a real embedder, not {FIXTURE_EMBEDDER}")
    verdict = report.get("verdict")
    if not isinstance(verdict, dict) or "d34_separates_at_least_as_well" not in verdict:
        raise ScopeCalibrationError(f"the separation report {path} has no D-34 verdict")


def run_scope_calibration(
    report_dir: Path,
    *,
    out_path: Path = SCOPE_GATE_PATH,
    golden_path: Path = DEFAULT_GOLDEN,
    calibration_path: Path = CALIBRATION_PATH,
    noise_path: Path = NOISE_PATH,
    source: Literal["auto", "live"] = "auto",
    separation_report: Path | None = None,
    profile_id: str | None = None,
) -> ScopeCalibrationResult:
    report_dir = Path(report_dir)
    try:
        traces = load_traces(report_dir / "traces.jsonl")
        manifest = load_manifest(report_dir / "run.json")
        golden = load_golden(Path(golden_path))
    except (OSError, ValueError) as exc:
        raise ScopeCalibrationError(str(exc)) from exc
    try:
        config = RefusalCalibrationConfig.model_validate(_read_json(Path(calibration_path), "calibration config"))
        noise = NoiseConfig.model_validate(_read_json(Path(noise_path), "noise config"))
    except ValueError as exc:
        raise ScopeCalibrationError(str(exc)) from exc

    fixture_run = _run_is_fixture(manifest, traces)
    resolved: Source
    if source == "live":
        _check_separation_report(separation_report)
        if fixture_run:
            raise ScopeCalibrationError(f"--source live refused: the run was scored with the fixture embedder {FIXTURE_EMBEDDER}")
        resolved = "live"
    elif fixture_run:
        resolved = "fixture"
    else:
        raise ScopeCalibrationError("the run was scored with a real embedder: use --source live with --separation-report")

    scored_profile = _run_profile(manifest, traces)
    if profile_id is not None and profile_id != scored_profile:
        raise ScopeCalibrationError(f"no cell for profile {profile_id!r}: the run was scored with profile {scored_profile!r}")

    rows, excluded = collect_scope_rows(traces, golden)
    cells = fit_scope_cells(
        rows, scored_profile, mode_targets(config), config=config, environment=resolved, noise_floor=noise.floor
    )
    recorded_at = datetime.fromisoformat(manifest.created_at.replace("Z", "+00:00"))
    calibration = ScopeGateCalibration(recorded_at=recorded_at, source=resolved, cells=cells)
    write_config_atomically(Path(out_path), calibration)
    return ScopeCalibrationResult(
        source=resolved, profile_id=scored_profile, rows=len(rows), excluded=excluded, cells=cells, out_path=Path(out_path)
    )
