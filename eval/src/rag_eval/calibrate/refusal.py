from __future__ import annotations

from dataclasses import dataclass
from typing import Sequence

from rag_sidecar.contracts.eval_run import RagTrace
from rag_sidecar.contracts.retrieval import FilterLanguage, Pairing, RefusalCalibrationConfig, RefusalMetricBlock

NEVER_REFUSE = float("-inf")


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


def assign_cell(trace: RagTrace, reranker: RerankerIdentity) -> Assignment | Exclusion:
    return Exclusion("not_implemented")


def fit_threshold(answerable: Sequence[float], no_answer: Sequence[float], target: float) -> FitResult:
    return FitResult(0.0, 1.0, 0.0)


def fit_cells(rows: Sequence[CalibrationRow], config: RefusalCalibrationConfig, *, environment: str) -> dict[str, CellFit]:
    return {}
