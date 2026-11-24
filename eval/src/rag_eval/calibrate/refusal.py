from __future__ import annotations

import hashlib
import json
import math
import re
from datetime import datetime, timezone
from bisect import bisect_left
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Callable, Literal, Sequence

from pydantic import BaseModel, ConfigDict

from rag_sidecar.contracts.baseline import NoiseConfig
from rag_sidecar.contracts.eval_run import RagTrace, TraceRefusal
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
from rag_eval.config_files import finalize_config, write_config_atomically
from rag_eval.golden_io import golden_sha256, load_golden
from rag_eval.harness_runner import HarnessRun, run_harness
from rag_eval.paths import REPO_ROOT
from rag_eval.split import assign_split

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
HARNESS_DIR = "harness"
INPUTS_DIR = "inputs"
THRESHOLDS_PATH = REPO_ROOT / "eval" / "config" / "refusal-thresholds.json"
CALIBRATION_PATH = REPO_ROOT / "eval" / "config" / "refusal-calibration.json"
NOISE_PATH = REPO_ROOT / "eval" / "config" / "noise.json"
DEFAULT_GOLDEN = REPO_ROOT / "eval" / "fixtures" / "golden.jsonl"
HASH_PATTERN = re.compile(r"^[a-f0-9]{64}$")
REFUSAL_SWITCH = "RAG_REFUSAL_THRESHOLD"
RERANKER_SWITCH = "RAG_RERANKER"


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
    same_upper_95: float | None = None
    same_answerable: int | None = None
    cross_false_refusal: float | None = None
    cross_upper_95: float | None = None
    cross_answerable: int | None = None
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


def reranker_identity(run_config: dict[str, Any]) -> RerankerIdentity:
    """Provider from the run-config env, model from its rerank_model override; the reranker must be on and named."""
    env = run_config.get("env") or {}
    provider = str(env.get(RERANKER_SWITCH) or "").strip()
    if not provider or provider == "none":
        raise CalibrationError(f"the run-config must keep a reranker on: set env.{RERANKER_SWITCH} to a provider")
    overrides = run_config.get("overrides") or {}
    model = str(overrides.get("rerank_model") or "").strip()
    if not model:
        raise CalibrationError("the run-config must name the reranker model in overrides.rerank_model (cells are keyed by it)")
    return RerankerIdentity(provider, model)


def calibration_run_config(base: dict[str, Any]) -> dict[str, Any]:
    """Copy of the run-config with threshold refusal forced off; the reranker settings stay as given."""
    forced = json.loads(json.dumps(base))
    env = dict(forced.get("env") or {})
    env[REFUSAL_SWITCH] = "false"
    forced["env"] = env
    return forced


def collect_rows(
    traces: Sequence[RagTrace], golden: Sequence[GoldenItem], reranker: RerankerIdentity
) -> tuple[list[CalibrationRow], dict[str, int]]:
    by_id = {item.id: item for item in golden}
    rows: list[CalibrationRow] = []
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
        assignment = assign_cell(trace, reranker)
        if isinstance(assignment, Exclusion):
            skip(assignment.reason)
            continue
        if trace.retrieval_versions is None:
            skip("no_retrieval_versions")
            continue
        if not HASH_PATTERN.match(trace.retrieval_config_hash or ""):
            skip("no_config_hash")
            continue
        rows.append(
            CalibrationRow(
                item_id=item.id,
                split=item.split,
                answerable=item.answerable,
                score=assignment.top_score,
                key=assignment.key,
                provider=assignment.provider,
                model=assignment.model,
                query_language=assignment.query_language,
                pairing=assignment.pairing,
                tokenizer_version=trace.retrieval_versions.lexical,
                rerank_text_version=trace.retrieval_versions.rerank_text,
                config_hash=trace.retrieval_config_hash or "",
            )
        )
    return rows, excluded


GATE_REASONS = ("below_threshold", "above_threshold")


def _gate_decided(refusal: TraceRefusal) -> bool:
    """The threshold gate decided, as opposed to the fallback similarity floor (D-30), which runs with the switch off."""
    if refusal.decision not in ("refuse", "answer"):
        return False
    return refusal.basis == "rerank_threshold" or refusal.reason in GATE_REASONS or refusal.cell_key is not None


def _assert_refusal_off(traces: Sequence[RagTrace]) -> None:
    for trace in traces:
        if trace.refusal is not None and _gate_decided(trace.refusal):
            raise CalibrationError(
                f"the run applied the refusal threshold gate (decision {trace.refusal.decision!r} on item {trace.item_id!r}); "
                f"calibration needs {REFUSAL_SWITCH} off so every candidate is scored"
            )


def _run_versions(rows: Sequence[CalibrationRow]) -> tuple[int, int] | None:
    versions = {(r.tokenizer_version, r.rerank_text_version) for r in rows}
    if not versions:
        return None
    if len(versions) > 1:
        raise CalibrationError("the run mixes tokenizer or rerank-text versions; one run must use one configuration")
    return next(iter(versions))


def compare_cross_same(records: Sequence[CellRecord], noise_floor: float) -> list[CrossComparison]:
    groups: dict[tuple[str, str, str], dict[str, CellRecord]] = {}
    for record in records:
        cell = record.cell
        groups.setdefault((cell.provider, cell.model, cell.query_language), {})[cell.pairing] = record

    comparisons: list[CrossComparison] = []
    for (provider, model, language), pair in sorted(groups.items()):
        same, cross = pair.get("same"), pair.get("cross")
        base = {
            "provider": provider,
            "model": model,
            "query_language": language,
            "same_key": same.cell.key if same else None,
            "cross_key": cross.cell.key if cross else None,
            "noise_band": noise_floor,
        }
        if same is None or cross is None:
            missing = "same" if same is None else "cross"
            comparisons.append(CrossComparison(**base, note=f"no {missing} cell in this run"))
            continue
        if same.cell.threshold is None or cross.cell.threshold is None:
            comparisons.append(CrossComparison(**base, note="a cell without a threshold has no false-refusal rate to compare"))
            continue
        use_holdout = (
            same.holdout_pass_limit is not None
            and cross.holdout_pass_limit is not None
            and same.cell.holdout.answerable_count > 0
            and cross.cell.holdout.answerable_count > 0
        )
        basis: Literal["holdout", "dev"] = "holdout" if use_holdout else "dev"
        a = same.cell.holdout if use_holdout else same.cell.dev
        b = cross.cell.holdout if use_holdout else cross.cell.dev
        gap = b.false_refusal_rate - a.false_refusal_rate
        comparisons.append(
            CrossComparison(
                **base,
                comparable=True,
                basis=basis,
                same_false_refusal=a.false_refusal_rate,
                same_upper_95=a.false_refusal_rate_upper_bound,
                same_answerable=a.answerable_count,
                cross_false_refusal=b.false_refusal_rate,
                cross_upper_95=b.false_refusal_rate_upper_bound,
                cross_answerable=b.answerable_count,
                gap=gap,
                exceeds_noise_band=gap > noise_floor + PASS_EPSILON,
            )
        )
    return comparisons


def _is_stale(cell: RefusalCell, versions: tuple[int, int] | None) -> bool:
    return versions is not None and (cell.tokenizer_version, cell.rerank_text_version) != versions


def merge_thresholds(
    existing: RefusalThresholds,
    new_cells: Sequence[RefusalCell],
    *,
    tokenizer_version: int | None,
    rerank_text_version: int | None,
) -> RefusalThresholds:
    """New cells replace same-key cells; cells from another tokenizer or rerank-text version are stale and dropped."""
    versions = (tokenizer_version, rerank_text_version) if tokenizer_version is not None and rerank_text_version is not None else None
    fresh = {cell.key: cell for cell in new_cells}
    carried = [c for c in existing.cells if c.key not in fresh and not _is_stale(c, versions)]
    merged = sorted([*carried, *fresh.values()], key=lambda c: c.key)
    return finalize_config(RefusalThresholds(cells=merged), provenance_source="calibration")


def _fmt(value: float | None, digits: int = 3) -> str:
    return "-" if value is None else f"{value:.{digits}f}"


def _cell_text(text: str) -> str:
    return text.replace("|", "\\|")


def _counts(block: RefusalMetricBlock) -> str:
    return f"{block.answerable_count} / {block.no_answer_count}"


def _rate(block: RefusalMetricBlock) -> str:
    if block.answerable_count == 0:
        return "-"
    return f"{_fmt(block.false_refusal_rate)} ({_fmt(block.false_refusal_rate_upper_bound)})"


def _correct(block: RefusalMetricBlock) -> str:
    return "-" if block.no_answer_count == 0 else _fmt(block.correct_refusal_rate)


def render_report(result: CalibrationResult) -> str:
    lines = ["# Refusal calibration", ""]
    environment = (
        "live (deployed app; these cells can drive production refusal once calibrated)"
        if result.source == "live"
        else "fixture (fake edge; fixture cells never drive production refusal, they prove the tooling only)"
    )
    lines += [
        f"- Source: {environment}",
        f"- Run config: {result.run_config_name or '-'}",
        f"- Reranker: {result.reranker or '-'}",
        f"- Versions: tokenizer {result.tokenizer_version if result.tokenizer_version is not None else '-'}, "
        f"rerank text {result.rerank_text_version if result.rerank_text_version is not None else '-'}",
        f"- Target false-refusal rate: {_fmt(result.target_false_refusal)}",
        f"- Holdout pass rule: `{result.pass_rule}` (noise floor {_fmt(result.noise_floor)})",
        "- Scope: thresholds are fitted on the dev split only. The frozen test split is read once per cell that has a "
        "threshold; this report carries counts and rates for it, never per-item scores. A failed cell is not re-fitted on test.",
        "",
        "## Cells",
        "",
    ]
    if result.cells:
        lines += [
            "| Cell | Status | Threshold | Dev answerable / no-answer | Dev false refusal (95% upper) | Dev correct refusal "
            "| Holdout answerable / no-answer | Holdout false refusal (95% upper) | Holdout correct refusal | Holdout evaluations |",
            "| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |",
        ]
        for record in result.cells:
            c = record.cell
            read = record.holdout_pass_limit is not None
            lines.append(
                f"| {_cell_text(c.key)} | {c.status} | {_fmt(c.threshold, 4)} | {_counts(c.dev)} | {_rate(c.dev)} | {_correct(c.dev)} "
                f"| {_counts(c.holdout) if read else '-'} | {_rate(c.holdout) if read else '-'} "
                f"| {_correct(c.holdout) if read else '-'} | {c.holdout_evaluations} |"
            )
        lines += [
            "",
            "A point estimate at or below target is not evidence until its 95% upper bound is. "
            "Only `calibrated` cells are applied; every other status never refuses.",
        ]
        unseparated = [r.cell.key for r in result.cells if r.fit_status == "no_separation"]
        if unseparated:
            lines += ["", "No threshold separated no-answer from answerable items within the target in: " + ", ".join(unseparated) + "."]
    else:
        lines.append("No cells: no trace had a usable rerank score and query language.")

    if result.excluded:
        lines += ["", "## Excluded traces", ""]
        lines += [f"- {reason}: {count}" for reason, count in sorted(result.excluded.items())]

    lines += ["", "## Stale cells", ""]
    if result.stale_cells:
        lines.append("The committed thresholds file holds cells from another tokenizer or rerank-text version. They are stale, never applied, and not carried over:")
        lines += [f"- {key}" for key in result.stale_cells]
    else:
        lines.append("None.")

    lines += ["", "## XLG-03: cross-lingual versus same-language cells", ""]
    band = _fmt(result.noise_floor)
    if not result.cross_vs_same:
        lines.append("No cells to compare.")
    else:
        lines += [
            f"The noise band is {band} (noise.json floor; single run, no spread). The gap is cross minus same false-refusal rate on the holdout split when both cells were read, otherwise on dev.",
            "",
            "| Query language | Basis | Same (n answerable) | Cross (n answerable) | Gap | Verdict |",
            "| --- | --- | --- | --- | --- | --- |",
        ]
        for cmp in result.cross_vs_same:
            if not cmp.comparable:
                lines.append(f"| {cmp.query_language} ({cmp.provider} / {cmp.model}) | - | - | - | - | not comparable: {cmp.note} |")
                continue
            verdict = (
                f"cross exceeds the same-language rate by more than the noise band ({band})"
                if cmp.exceeds_noise_band
                else f"cross does not exceed the same-language rate by more than the noise band ({band})"
            )
            lines.append(
                f"| {cmp.query_language} ({cmp.provider} / {cmp.model}) | {cmp.basis} "
                f"| {_fmt(cmp.same_false_refusal)} (upper {_fmt(cmp.same_upper_95)}, n={cmp.same_answerable}) "
                f"| {_fmt(cmp.cross_false_refusal)} (upper {_fmt(cmp.cross_upper_95)}, n={cmp.cross_answerable}) "
                f"| {cmp.gap:+.3f} | {verdict} |"
            )
        flagged = [c for c in result.cross_vs_same if c.exceeds_noise_band]
        comparable = [c for c in result.cross_vs_same if c.comparable]
        lines.append("")
        if not comparable:
            lines.append("No query language has both a same and a cross cell with a threshold, so the comparison is open.")
        elif flagged:
            lines.append(
                "Cross-lingual false refusal exceeds the same-language rate by more than the noise band for: "
                + ", ".join(c.query_language for c in flagged)
                + "."
            )
        else:
            lines.append("Cross-lingual false refusal does not exceed the same-language rate by more than the noise band in any comparable language.")
    for note in result.notes:
        lines += ["", f"Note: {note}"]
    return "\n".join(lines) + "\n"


def _default_runner(**kwargs: Any) -> HarnessRun:
    return run_harness(splits=("dev", "test"), **kwargs)


def _stable_json(payload: Any) -> str:
    return json.dumps(payload, sort_keys=True, indent=2, ensure_ascii=False) + "\n"


def _read_json(path: Path, what: str) -> dict[str, Any]:
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise CalibrationError(f"{what} {path} is unreadable: {exc}") from exc
    if not isinstance(payload, dict):
        raise CalibrationError(f"{what} {path} must be a JSON object")
    return payload


def _previous_cells(result_path: Path, existing: RefusalThresholds) -> dict[str, PreviousCell]:
    previous = {
        c.key: PreviousCell(holdout_evaluations=c.holdout_evaluations, input_hash=None, recorded_at=None) for c in existing.cells
    }
    if result_path.is_file():
        try:
            prior = CalibrationResult.model_validate_json(result_path.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            return previous
        for record in prior.cells:
            previous[record.cell.key] = PreviousCell(
                holdout_evaluations=record.cell.holdout_evaluations,
                input_hash=record.input_hash,
                recorded_at=record.cell.recorded_at,
            )
    return previous


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
    out_dir = Path(out)
    golden_path = Path(golden) if golden else DEFAULT_GOLDEN
    thresholds_file = Path(thresholds_path) if thresholds_path else THRESHOLDS_PATH
    source: Literal["fixture", "live"] = "live" if base_url else "fixture"
    day = now or datetime.now(timezone.utc).date().isoformat()

    base = _read_json(Path(run_config), "run-config")
    reranker = reranker_identity(base)
    try:
        config = RefusalCalibrationConfig.model_validate(_read_json(Path(calibration_path or CALIBRATION_PATH), "calibration config"))
        noise = NoiseConfig.model_validate(_read_json(Path(noise_path or NOISE_PATH), "noise config"))
        golden_items = load_golden(golden_path)
    except (OSError, ValueError) as exc:
        raise CalibrationError(str(exc)) from exc

    existing = RefusalThresholds(cells=[])
    notes: list[str] = []
    if thresholds_file.is_file():
        try:
            existing = RefusalThresholds.model_validate_json(thresholds_file.read_text(encoding="utf-8"))
        except (OSError, ValueError) as exc:
            if write:
                raise CalibrationError(f"{thresholds_file} is not a valid thresholds file: {exc}") from exc
            notes.append(f"{thresholds_file} is not a valid thresholds file; stale cells could not be checked")

    inputs = out_dir / INPUTS_DIR
    inputs.mkdir(parents=True, exist_ok=True)
    forced_text = _stable_json(calibration_run_config(base))
    forced_path = inputs / "base-run-config.json"
    forced_path.write_text(forced_text, encoding="utf-8")

    run = (runner or _default_runner)(
        run_config=forced_path, golden=golden_path, out=out_dir / HARNESS_DIR, base_url=base_url, fixture_mode=fixture_mode
    )
    notes.extend(getattr(run, "notes", []) or [])
    _assert_refusal_off(run.traces)
    rows, excluded = collect_rows(run.traces, golden_items, reranker)
    versions = _run_versions(rows)

    records = calibrate_cells(
        rows,
        config,
        source=source,
        noise_floor=noise.floor,
        previous=_previous_cells(out_dir / RESULT_NAME, existing),
        now=day,
    )
    new_keys = {r.cell.key for r in records}
    stale = sorted(c.key for c in existing.cells if c.key not in new_keys and _is_stale(c, versions))

    result = CalibrationResult(
        source=source,
        run_config_name=str(base.get("name") or ""),
        reranker=f"{reranker.provider} / {reranker.model}",
        golden_sha256=golden_sha256(golden_path),
        run_config_sha256=hashlib.sha256(forced_text.encode("utf-8")).hexdigest(),
        target_false_refusal=config.target_false_refusal,
        pass_rule=config.pass_rule,
        noise_floor=noise.floor,
        tokenizer_version=versions[0] if versions else None,
        rerank_text_version=versions[1] if versions else None,
        cells=records,
        excluded=excluded,
        stale_cells=stale,
        cross_vs_same=compare_cross_same(records, noise.floor),
        notes=notes,
    )

    if write:
        merged = merge_thresholds(
            existing,
            [r.cell for r in records],
            tokenizer_version=result.tokenizer_version,
            rerank_text_version=result.rerank_text_version,
        )
        write_config_atomically(thresholds_file, merged)
        result.thresholds_written = True
        result.thresholds_path = str(thresholds_file)

    out_dir.mkdir(parents=True, exist_ok=True)
    (out_dir / RESULT_NAME).write_text(_stable_json(result.model_dump(mode="json")), encoding="utf-8")
    (out_dir / REPORT_NAME).write_text(render_report(result), encoding="utf-8")
    return result
