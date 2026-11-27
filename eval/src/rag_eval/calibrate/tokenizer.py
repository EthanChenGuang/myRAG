from __future__ import annotations

from dataclasses import dataclass, field
from pathlib import Path
from typing import Iterable, Sequence

from rag_sidecar.contracts.prompt_budget import TokenizerCalibration, TokenizerFamilyFactor

DEFAULT_FACTOR = 0.0


class CalibrationError(RuntimeError):
    pass


@dataclass(frozen=True)
class TokenSample:
    family: str
    estimated_raw_total: int
    input_tokens: int
    run_id: str


@dataclass
class TokenizerCalibrationResult:
    calibration: TokenizerCalibration
    fitted: list[TokenizerFamilyFactor] = field(default_factory=list)
    under_sampled: dict[str, int] = field(default_factory=dict)
    skipped: dict[str, int] = field(default_factory=dict)
    written: bool = False
    out_path: Path | None = None


def load_samples(run_dirs: Iterable[Path]) -> tuple[list[TokenSample], dict[str, int]]:
    return [], {}


def fit_factors(samples: Sequence[TokenSample], *, quantile: float, min_samples: int, computed_at: str):
    return [], {}


def run_tokenizer_calibration(run_dirs, out_path, quantile=0.95, min_samples=20, write=True):
    return TokenizerCalibrationResult(
        calibration=TokenizerCalibration(version=1, default_factor=1, written_by="stub")
    )
