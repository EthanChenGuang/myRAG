from __future__ import annotations

import math
from bisect import bisect_left
from dataclasses import dataclass
from typing import Literal, Sequence

from pydantic import BaseModel, ConfigDict

from rag_sidecar.contracts.eval_run import RagTrace
from rag_sidecar.contracts.retrieval import (
    FilterLanguage,
    Pairing,
    RefusalCalibrationConfig,
    RefusalCell,
    RefusalMetricBlock,
)

from rag_eval.bounds import upper_bound

NEVER_REFUSE = float("-inf")
LANGUAGES = ("zh", "en", "it")
TOP_MARGIN = 1e-9
DEV_SPLIT = "dev"


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


def holdout_check(
    fit: CellFit,
    test_rows: Sequence[CalibrationRow],
    *,
    config: RefusalCalibrationConfig,
    environment: str,
    noise_floor: float,
) -> HoldoutResult:
    block = _metric_block([], [], None)
    return HoldoutResult(
        status="insufficient_data", metrics=block, false_refusal_count=0, correct_refusal_count=0, pass_limit=0.0, false_refusal_p_value=1.0
    )


def calibrate_cells(
    rows: Sequence[CalibrationRow],
    config: RefusalCalibrationConfig,
    *,
    source: str,
    noise_floor: float,
    previous: dict[str, PreviousCell] | None = None,
    now: str,
) -> list[CellRecord]:
    return []
