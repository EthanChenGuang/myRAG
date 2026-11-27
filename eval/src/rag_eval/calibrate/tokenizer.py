"""Per-family token estimate factors from recorded eval runs (05.2 D-81).

Reads `traces.jsonl` from run output directories, pairs each trace's pre-factor `cl100k_base` estimate
(`prompt_budget.estimated_raw_total`) with the provider-reported `usage.input_tokens`, and fits one factor per model
family as a high quantile of reported over estimated tokens. It is the only writer of
`eval/config/tokenizer-calibration.json`; it reads files only and calls no provider tokenizer.
"""

from __future__ import annotations

import json
import math
from collections import defaultdict
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Iterable, Sequence

from pydantic import ValidationError
from rag_sidecar.contracts.prompt_budget import TokenizerCalibration, TokenizerFamilyFactor

from rag_eval.config_files import write_config_atomically
from rag_eval.paths import REPO_ROOT
from rag_eval.traces import load_traces

WRITTEN_BY = "rag_eval.calibrate tokenizer"
CALIBRATION_PATH = REPO_ROOT / "eval" / "config" / "tokenizer-calibration.json"
DEFAULT_FACTOR = 1.25
DEFAULT_QUANTILE = 0.95
DEFAULT_MIN_SAMPLES = 20
MIN_FACTOR = 0.5
FACTOR_PLACES = 4
TRACES_NAME = "traces.jsonl"
MANIFEST_NAME = "manifest.json"


class CalibrationError(RuntimeError):
    pass


@dataclass(frozen=True)
class TokenSample:
    family: str
    estimated_raw_total: int
    input_tokens: int
    run_id: str

    @property
    def ratio(self) -> float:
        return self.input_tokens / self.estimated_raw_total


@dataclass
class TokenizerCalibrationResult:
    calibration: TokenizerCalibration
    fitted: list[TokenizerFamilyFactor] = field(default_factory=list)
    under_sampled: dict[str, int] = field(default_factory=dict)
    skipped: dict[str, int] = field(default_factory=dict)
    written: bool = False
    out_path: Path | None = None


def _run_id(run_dir: Path) -> str:
    manifest = run_dir / MANIFEST_NAME
    if manifest.is_file():
        try:
            run_id = json.loads(manifest.read_text(encoding="utf-8")).get("run_id")
        except (OSError, json.JSONDecodeError, AttributeError) as exc:
            raise CalibrationError(f"cannot read {manifest}: {exc}") from exc
        if isinstance(run_id, str) and run_id.strip():
            return run_id
    return run_dir.name


def load_samples(run_dirs: Iterable[Path]) -> tuple[list[TokenSample], dict[str, int]]:
    """Samples from every run's traces, and the count of traces skipped per reason."""
    samples: list[TokenSample] = []
    skipped: dict[str, int] = defaultdict(int)
    for run_dir in run_dirs:
        run_dir = Path(run_dir)
        traces_path = run_dir / TRACES_NAME
        if not traces_path.is_file():
            raise CalibrationError(f"no {TRACES_NAME} in {run_dir}")
        run_id = _run_id(run_dir)
        try:
            traces = load_traces(traces_path)
        except (OSError, ValueError) as exc:
            raise CalibrationError(str(exc)) from exc
        for trace in traces:
            budget, usage = trace.prompt_budget, trace.usage
            if budget is None:
                skipped["no_prompt_budget"] += 1
            elif usage is None:
                skipped["no_usage"] += 1
            elif budget.estimator.family is None:
                skipped["no_family"] += 1
            elif budget.estimated_raw_total <= 0 or usage.input_tokens <= 0:
                skipped["zero_tokens"] += 1
            else:
                samples.append(TokenSample(budget.estimator.family, budget.estimated_raw_total, usage.input_tokens, run_id))
    return samples, dict(skipped)


def _quantile(values: Sequence[float], quantile: float) -> float:
    """Nearest-rank quantile: an observed ratio, never an interpolation below the one at the rank."""
    ordered = sorted(values)
    return ordered[max(1, math.ceil(quantile * len(ordered))) - 1]


def _round_up(value: float) -> float:
    scale = 10**FACTOR_PLACES
    return math.ceil(round(value * scale, 6)) / scale


def fit_factors(
    samples: Sequence[TokenSample], *, quantile: float, min_samples: int, computed_at: str
) -> tuple[list[TokenizerFamilyFactor], dict[str, int]]:
    """Measured cells for families with at least `min_samples` samples, and the sample counts of the others."""
    by_family: dict[str, list[TokenSample]] = defaultdict(list)
    for sample in samples:
        by_family[sample.family].append(sample)
    fitted: list[TokenizerFamilyFactor] = []
    under: dict[str, int] = {}
    for family in sorted(by_family):
        rows = by_family[family]
        if len(rows) < min_samples:
            under[family] = len(rows)
            continue
        factor = max(MIN_FACTOR, _round_up(_quantile([row.ratio for row in rows], quantile)))
        fitted.append(
            TokenizerFamilyFactor(
                family=family,
                factor=factor,
                quantile=quantile,
                samples=len(rows),
                source="measured",
                run_ids=sorted({row.run_id for row in rows}),
                computed_at=computed_at,
            )
        )
    return fitted, under


def _existing(out_path: Path) -> TokenizerCalibration | None:
    if not out_path.exists():
        return None
    try:
        return TokenizerCalibration.model_validate_json(out_path.read_text(encoding="utf-8"))
    except (OSError, ValidationError, ValueError) as exc:
        raise CalibrationError(f"{out_path} is not a valid tokenizer calibration; refusing to overwrite it: {exc}") from exc


def run_tokenizer_calibration(
    run_dirs: Sequence[Path],
    out_path: Path = CALIBRATION_PATH,
    quantile: float = DEFAULT_QUANTILE,
    min_samples: int = DEFAULT_MIN_SAMPLES,
    write: bool = True,
) -> TokenizerCalibrationResult:
    if not 0 < quantile <= 1:
        raise CalibrationError("--quantile must be in (0, 1]")
    if min_samples < 1:
        raise CalibrationError("--min-samples must be at least 1")
    if not run_dirs:
        raise CalibrationError("name at least one run directory")
    out_path = Path(out_path)
    existing = _existing(out_path)
    samples, skipped = load_samples(run_dirs)
    computed_at = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    fitted, under = fit_factors(samples, quantile=quantile, min_samples=min_samples, computed_at=computed_at)
    measured = {cell.family: cell for cell in fitted}
    kept = [cell for cell in (existing.families if existing else []) if cell.family not in measured]
    families = sorted([*kept, *fitted], key=lambda cell: cell.family)
    try:
        calibration = TokenizerCalibration(
            version=existing.version if existing else 1,
            default_factor=existing.default_factor if existing else DEFAULT_FACTOR,
            families=families,
            written_by=WRITTEN_BY,
        )
    except ValidationError as exc:
        raise CalibrationError(f"the fitted calibration is invalid: {exc}") from exc
    if write:
        write_config_atomically(out_path, calibration)
    return TokenizerCalibrationResult(
        calibration=calibration,
        fitted=fitted,
        under_sampled=under,
        skipped=skipped,
        written=write,
        out_path=out_path,
    )
