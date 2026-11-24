from __future__ import annotations

import hashlib
import json
import math
from bisect import bisect_left
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Callable, Literal, Sequence

from pydantic import BaseModel, ConfigDict

from rag_sidecar.contracts.eval_run import RagTrace
from rag_sidecar.contracts.golden import GoldenItem
from rag_sidecar.contracts.retrieval import (
    FilterLanguage,
    Pairing,
    RefusalCalibrationConfig,
    RefusalCell,
    RefusalMetricBlock,
    RefusalThresholds,
    compute_config_hash,
)

from rag_eval.bounds import binom_cdf, upper_bound
from rag_eval.harness_runner import HarnessRun
from rag_eval.paths import REPO_ROOT

NEVER_REFUSE = float("-inf")
LANGUAGES = ("zh", "en", "it")
TOP_MARGIN = 1e-9
DEV_SPLIT = "dev"
TEST_SPLIT = "test"
PASS_EPSILON = 1e-12


class CalibrationError(RuntimeError):
    pass


@dataclass(frozen=True)
class RerankerIdentity:
    provider: str
    model: str


@dataclass(frozen=True)
class Assignment:
    provider: str
    model: str
    query_language: FilterLanguage
    pairing: Pairing
    top_score: float
    key: str


@dataclass(frozen=True)
class Exclusion:
    reason: str


@dataclass(frozen=True)
class CalibrationRow:
    item_id: str
    split: str
    answerable: bool
    score: float
    key: str
    provider: str
    model: str
    query_language: FilterLanguage
    pairing: Pairing
    tokenizer_version: int
    rerank_text_version: int
    config_hash: str


@dataclass(frozen=True)
class FitResult:
    threshold: float
    false_refusal: float
    correct_refusal: float


@dataclass(frozen=True)
class CellFit:
    key: str
    provider: str
    model: str
    query_language: FilterLanguage
    pairing: Pairing
    threshold: float | None
    status: str
    dev: RefusalMetricBlock
    tokenizer_version: int
    rerank_text_version: int
    config_hash: str


def cell_key(provider: str, model: str, query_language: str, pairing: str) -> str:
    return f"{provider}|{model}|{query_language}|{pairing}"


def assign_cell(trace: RagTrace, reranker: RerankerIdentity) -> Assignment | Exclusion:
    scored = [c for c in trace.candidates if c.rerank_score is not None and math.isfinite(c.rerank_score)]
    if not scored:
        return Exclusion("no_rerank_score")
    language = trace.query_language
    if language not in LANGUAGES:
        return Exclusion("no_query_language")
    top = min(scored, key=lambda c: (-(c.rerank_score or 0.0), c.rank))
    pairing: Pairing = "cross" if top.language is not None and top.language != language else "same"
    return Assignment(
        provider=reranker.provider,
        model=reranker.model,
        query_language=language,  # type: ignore[arg-type]
        pairing=pairing,
        top_score=float(top.rerank_score),  # type: ignore[arg-type]
        key=cell_key(reranker.provider, reranker.model, language, pairing),
    )


def fit_threshold(answerable: Sequence[float], no_answer: Sequence[float], target: float) -> FitResult:
    """Highest correct-refusal rate whose false-refusal rate is at or below target; the lowest such threshold wins ties."""
    if not answerable or not no_answer:
        raise ValueError("fit_threshold needs at least one answerable and one no-answer score")
    ans = sorted(answerable)
    non = sorted(no_answer)
    scores = sorted(set(ans) | set(non))
    candidates = [NEVER_REFUSE] + [(a + b) / 2 for a, b in zip(scores, scores[1:])] + [scores[-1] + TOP_MARGIN]
    best: FitResult | None = None
    for threshold in candidates:
        false_refusal = bisect_left(ans, threshold) / len(ans)
        correct_refusal = bisect_left(non, threshold) / len(non)
        if false_refusal <= target and (best is None or correct_refusal > best.correct_refusal):
            best = FitResult(threshold, false_refusal, correct_refusal)
    assert best is not None
    return best


def _metric_block(answerable: Sequence[float], no_answer: Sequence[float], threshold: float | None) -> RefusalMetricBlock:
    cut = NEVER_REFUSE if threshold is None else threshold
    false_refusals = sum(1 for s in answerable if s < cut)
    correct_refusals = sum(1 for s in no_answer if s < cut)
    return RefusalMetricBlock(
        no_answer_count=len(no_answer),
        answerable_count=len(answerable),
        false_refusal_rate=false_refusals / len(answerable) if answerable else 0.0,
        false_refusal_rate_upper_bound=upper_bound(false_refusals, len(answerable)),
        correct_refusal_rate=correct_refusals / len(no_answer) if no_answer else 0.0,
    )


def _cell_identity(rows: Sequence[CalibrationRow]) -> CalibrationRow:
    first = rows[0]
    for row in rows[1:]:
        if (row.tokenizer_version, row.rerank_text_version, row.config_hash) != (
            first.tokenizer_version,
            first.rerank_text_version,
            first.config_hash,
        ):
            raise CalibrationError(f"cell {first.key} mixes retrieval versions or config hashes within one run")
    return first


def fit_cells(rows: Sequence[CalibrationRow], config: RefusalCalibrationConfig, *, environment: str) -> dict[str, CellFit]:
    """Fit one threshold per cell. Test-split rows are dropped before anything is computed (A-2 rule 1)."""
    minimums = getattr(config.dev_minimums, environment)
    grouped: dict[str, list[CalibrationRow]] = {}
    for row in rows:
        if row.split != DEV_SPLIT:
            continue
        grouped.setdefault(row.key, []).append(row)

    fits: dict[str, CellFit] = {}
    for key in sorted(grouped):
        cell_rows = sorted(grouped[key], key=lambda r: r.item_id)
        identity = _cell_identity(cell_rows)
        answerable = [r.score for r in cell_rows if r.answerable]
        no_answer = [r.score for r in cell_rows if not r.answerable]
        threshold: float | None = None
        if len(answerable) < minimums.answerable or len(no_answer) < minimums.no_answer:
            status = "insufficient_data"
        else:
            fit = fit_threshold(answerable, no_answer, config.target_false_refusal)
            if fit.threshold == NEVER_REFUSE:
                status = "no_separation"
            else:
                status = "fitted"
                threshold = fit.threshold
        fits[key] = CellFit(
            key=key,
            provider=identity.provider,
            model=identity.model,
            query_language=identity.query_language,
            pairing=identity.pairing,
            threshold=threshold,
            status=status,
            dev=_metric_block(answerable, no_answer, threshold),
            tokenizer_version=identity.tokenizer_version,
            rerank_text_version=identity.rerank_text_version,
            config_hash=identity.config_hash,
        )
    return fits


HoldoutStatus = Literal["calibrated", "failed_holdout", "insufficient_data"]


class HoldoutResult(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)

    status: HoldoutStatus
    metrics: RefusalMetricBlock
    false_refusal_count: int
    correct_refusal_count: int
    pass_limit: float
    false_refusal_p_value: float


class PreviousCell(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)

    holdout_evaluations: int
    input_hash: str | None = None
    recorded_at: str | None = None


class CellRecord(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)

    cell: RefusalCell
    fit_status: str
    input_hash: str | None = None
    holdout_pass_limit: float | None = None
    holdout_false_refusal_p_value: float | None = None


def _check_one_row_set(test_rows: Sequence[CalibrationRow]) -> None:
    for row in test_rows:
        if row.split != TEST_SPLIT:
            raise ValueError(f"holdout_check reads test-split rows only, got {row.split!r} for {row.item_id}")


def _p_value_at_least(k: int, n: int, p: float) -> float:
    if n == 0 or k == 0:
        return 1.0
    return min(1.0, max(0.0, 1.0 - binom_cdf(k - 1, n, p)))


def holdout_check(
    fit: CellFit,
    test_rows: Sequence[CalibrationRow],
    *,
    config: RefusalCalibrationConfig,
    environment: str,
    noise_floor: float,
) -> HoldoutResult:
    """Apply the fitted threshold to the cell's frozen test rows once; the result holds counts and rates only."""
    if fit.threshold is None:
        raise ValueError(f"cell {fit.key} has no threshold to check")
    _check_one_row_set(test_rows)
    cell_rows = [r for r in test_rows if r.key == fit.key]
    answerable = [r.score for r in cell_rows if r.answerable]
    no_answer = [r.score for r in cell_rows if not r.answerable]
    block = _metric_block(answerable, no_answer, fit.threshold)
    false_refusals = sum(1 for s in answerable if s < fit.threshold)
    correct_refusals = sum(1 for s in no_answer if s < fit.threshold)
    target = config.target_false_refusal
    limit = target + max(noise_floor, 1 / len(answerable) if answerable else 0.0)
    minimums = getattr(config.holdout_minimums, environment)
    status: HoldoutStatus
    if len(answerable) < minimums.answerable or len(no_answer) < minimums.no_answer:
        status = "insufficient_data"
    elif block.false_refusal_rate <= limit + PASS_EPSILON:
        status = "calibrated"
    else:
        status = "failed_holdout"
    return HoldoutResult(
        status=status,
        metrics=block,
        false_refusal_count=false_refusals,
        correct_refusal_count=correct_refusals,
        pass_limit=limit,
        false_refusal_p_value=_p_value_at_least(false_refusals, len(answerable), target),
    )


def _input_hash(fit: CellFit, rows: Sequence[CalibrationRow], config: RefusalCalibrationConfig, *, with_test: bool) -> str:
    picked = sorted(
        ((r.item_id, r.split, r.answerable, r.score) for r in rows if r.key == fit.key and (with_test or r.split == DEV_SPLIT)),
    )
    payload = {
        "cell": fit.key,
        "rows": picked,
        "calibration_config": compute_config_hash(config),
        "retrieval_config": fit.config_hash,
        "tokenizer_version": fit.tokenizer_version,
        "rerank_text_version": fit.rerank_text_version,
    }
    return hashlib.sha256(json.dumps(payload, sort_keys=True, separators=(",", ":")).encode("utf-8")).hexdigest()


def _no_read_status(fit: CellFit) -> Literal["insufficient_data", "uncalibrated"]:
    return "insufficient_data" if fit.status == "insufficient_data" else "uncalibrated"


def calibrate_cells(
    rows: Sequence[CalibrationRow],
    config: RefusalCalibrationConfig,
    *,
    source: str,
    noise_floor: float,
    previous: dict[str, PreviousCell] | None = None,
    now: str,
) -> list[CellRecord]:
    """Fit on dev, check once on test, and record every number. The test split is read only for cells that have a threshold."""
    if source not in ("fixture", "live"):
        raise ValueError(f"source must be fixture or live, got {source!r}")
    prior = previous or {}
    fits = fit_cells(rows, config, environment=source)
    test_rows = [r for r in rows if r.split == TEST_SPLIT]
    records: list[CellRecord] = []
    for key in sorted(fits):
        fit = fits[key]
        before = prior.get(key)
        holdout: HoldoutResult | None = None
        if fit.threshold is not None:
            holdout = holdout_check(fit, test_rows, config=config, environment=source, noise_floor=noise_floor)
        digest = _input_hash(fit, rows, config, with_test=holdout is not None)
        unchanged = before is not None and before.input_hash == digest
        previous_evaluations = before.holdout_evaluations if before else 0
        if holdout is None:
            evaluations = previous_evaluations
            status: str = _no_read_status(fit)
            holdout_block = _metric_block([], [], None)
            holdout_block = holdout_block.model_copy(update={"false_refusal_rate_upper_bound": 1.0})
        else:
            evaluations = previous_evaluations if unchanged else previous_evaluations + 1
            status = holdout.status
            holdout_block = holdout.metrics
        recorded_at = before.recorded_at if unchanged and before and before.recorded_at else now
        cell = RefusalCell(
            key=key,
            provider=fit.provider,
            model=fit.model,
            query_language=fit.query_language,
            pairing=fit.pairing,
            threshold=fit.threshold,
            status=status,  # type: ignore[arg-type]
            tokenizer_version=fit.tokenizer_version,
            rerank_text_version=fit.rerank_text_version,
            config_hash=fit.config_hash,
            source=source,  # type: ignore[arg-type]
            recorded_at=recorded_at,
            holdout_evaluations=evaluations,
            dev=fit.dev,
            holdout=holdout_block,
        )
        records.append(
            CellRecord(
                cell=cell,
                fit_status=fit.status,
                input_hash=digest,
                holdout_pass_limit=holdout.pass_limit if holdout else None,
                holdout_false_refusal_p_value=holdout.false_refusal_p_value if holdout else None,
            )
        )
    return records


Runner = Callable[..., HarnessRun]

RESULT_NAME = "refusal-calibration-result.json"
REPORT_NAME = "report.md"
THRESHOLDS_PATH = REPO_ROOT / "eval" / "config" / "refusal-thresholds.json"
CALIBRATION_PATH = REPO_ROOT / "eval" / "config" / "refusal-calibration.json"
NOISE_PATH = REPO_ROOT / "eval" / "config" / "noise.json"
DEFAULT_GOLDEN = REPO_ROOT / "eval" / "fixtures" / "golden.jsonl"


class CrossComparison(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)

    provider: str
    model: str
    query_language: str
    same_key: str | None = None
    cross_key: str | None = None
    comparable: bool = False
    basis: Literal["holdout", "dev"] | None = None
    same_false_refusal: float | None = None
    cross_false_refusal: float | None = None
    gap: float | None = None
    noise_band: float = 0.0
    exceeds_noise_band: bool | None = None
    note: str = ""


class CalibrationResult(BaseModel):
    model_config = ConfigDict(extra="forbid")

    schema_version: Literal[1] = 1
    source: Literal["fixture", "live"] = "fixture"
    dev_only_fit: bool = True
    run_config_name: str = ""
    reranker: str = ""
    golden_sha256: str = ""
    run_config_sha256: str = ""
    target_false_refusal: float = 0.05
    pass_rule: str = ""
    noise_floor: float = 0.0
    tokenizer_version: int | None = None
    rerank_text_version: int | None = None
    cells: list[CellRecord] = []
    excluded: dict[str, int] = {}
    stale_cells: list[str] = []
    cross_vs_same: list[CrossComparison] = []
    thresholds_written: bool = False
    thresholds_path: str | None = None
    notes: list[str] = []


def collect_rows(traces: Sequence[RagTrace], golden: Sequence[GoldenItem], reranker: RerankerIdentity) -> tuple[list[CalibrationRow], dict[str, int]]:
    return [], {}


def reranker_identity(run_config: dict[str, Any]) -> RerankerIdentity:
    return RerankerIdentity("", "")


def calibration_run_config(base: dict[str, Any]) -> dict[str, Any]:
    return dict(base)


def compare_cross_same(records: Sequence[CellRecord], noise_floor: float) -> list[CrossComparison]:
    return []


def merge_thresholds(existing: RefusalThresholds, new_cells: Sequence[RefusalCell], *, tokenizer_version: int | None, rerank_text_version: int | None) -> RefusalThresholds:
    return existing


def render_report(result: CalibrationResult) -> str:
    return ""


def _default_runner(**kwargs: Any) -> HarnessRun:
    raise NotImplementedError


def run_refusal_calibration(
    run_config: Path,
    out: Path,
    *,
    base_url: str | None = None,
    write: bool = False,
    runner: Runner | None = None,
    golden: Path | None = None,
    fixture_mode: str | None = None,
    thresholds_path: Path | None = None,
    calibration_path: Path | None = None,
    noise_path: Path | None = None,
    now: str | None = None,
) -> CalibrationResult:
    return CalibrationResult()
