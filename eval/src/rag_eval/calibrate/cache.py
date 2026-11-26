"""D-37: fit the semantic-cache distance on the dev cache pairs, check it once on test, gate near-miss wrong hits at zero."""

from __future__ import annotations

import json
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Sequence

from pydantic import ValidationError

from rag_sidecar.contracts.cache import (
    CACHE_MAX_DISTANCE,
    CachePairResult,
    CachePairsRun,
    CacheSplitMetrics,
    SemanticCacheCalibration,
    SemanticCacheProfileCalibration,
)

from rag_eval.config_files import write_config_atomically
from rag_eval.paths import REPO_ROOT, repo_relative

DEFAULT_MAX_DISTANCE = 0.05
FIXTURE_PROFILE_ID = "fixture-ngram"
CONFIG_PATH = REPO_ROOT / "eval" / "config" / "semantic-cache.json"
DEFAULT_OUT = REPO_ROOT / "eval" / "out" / "calibrate-cache"
RESULT_NAME = "cache-calibration.json"
REPORT_NAME = "cache-calibration.md"
SPLITS = ("dev", "test")
PARAPHRASE = "cache_paraphrase"
NEAR_MISS = "cache_near_miss"
EPSILON = 1e-12


class CalibrationError(RuntimeError):
    pass


@dataclass
class CacheCalibrationResult:
    profile: SemanticCacheProfileCalibration
    bypasses: dict[str, dict[str, int]]
    check_failures: list[str] = field(default_factory=list)
    reason: str | None = None


def load_pairs_data(payload: object) -> CachePairsRun:
    try:
        return CachePairsRun.model_validate(payload)
    except ValidationError as exc:
        raise CalibrationError(f"malformed cache-pairs data: {exc}") from exc


def load_pairs(path: Path) -> CachePairsRun:
    try:
        payload = json.loads(Path(path).read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise CalibrationError(f"cannot read cache pairs {path}: {exc}") from exc
    return load_pairs_data(payload)


def hits_at(pair: CachePairResult, threshold: float) -> bool:
    """A pair hits at a threshold when it was a hit at the probe within that distance; bypasses and failures never hit."""
    return pair.outcome == "hit" and pair.distance is not None and pair.distance <= threshold + EPSILON


def split_metrics(pairs: Sequence[CachePairResult], threshold: float) -> CacheSplitMetrics:
    paraphrases = [pair for pair in pairs if pair.category == PARAPHRASE]
    near_misses = [pair for pair in pairs if pair.category == NEAR_MISS]
    para_hits = sum(1 for pair in paraphrases if hits_at(pair, threshold))
    near_hits = sum(1 for pair in near_misses if hits_at(pair, threshold))
    return CacheSplitMetrics(
        paraphrase_pairs=len(paraphrases),
        near_miss_pairs=len(near_misses),
        paraphrase_hit_rate=para_hits / len(paraphrases) if paraphrases else 0.0,
        near_miss_wrong_hit_rate=near_hits / len(near_misses) if near_misses else 0.0,
    )


def fit_threshold(pairs: Sequence[CachePairResult]) -> float | None:
    """Over the dev pairs only: the largest observed distance with no near-miss wrong hit and the best paraphrase hit rate.

    None when no such distance lets a paraphrase hit."""
    dev = [pair for pair in pairs if pair.split == "dev"]
    candidates = sorted({pair.distance for pair in dev if pair.outcome == "hit" and pair.distance is not None and pair.distance <= CACHE_MAX_DISTANCE})
    best: tuple[float, float] | None = None
    for threshold in candidates:
        metrics = split_metrics(dev, threshold)
        if metrics.near_miss_wrong_hit_rate > 0 or metrics.paraphrase_hit_rate <= 0:
            continue
        key = (metrics.paraphrase_hit_rate, threshold)
        if best is None or key > best:
            best = key
    return best[1] if best is not None else None


def _bypasses(pairs: Sequence[CachePairResult]) -> dict[str, dict[str, int]]:
    out: dict[str, dict[str, int]] = {split: {} for split in SPLITS}
    for pair in pairs:
        if pair.outcome == "bypass" and pair.bypass_reason:
            bucket = out.setdefault(pair.split, {})
            bucket[pair.bypass_reason] = bucket.get(pair.bypass_reason, 0) + 1
    return {split: dict(sorted(counts.items())) for split, counts in out.items()}


def _profile_id(run: CachePairsRun, override: str | None) -> str:
    profile_id = override or run.embedding_profile_id
    if not profile_id:
        raise CalibrationError("the cache pairs name no embedding profile; pass --profile")
    # P-13: the fixture embedder proves the tooling only; its pairs never calibrate a real profile.
    if run.source == "fixture" and profile_id != FIXTURE_PROFILE_ID:
        raise CalibrationError(f"fixture cache pairs calibrate only the {FIXTURE_PROFILE_ID} profile, not {profile_id}")
    return profile_id


def calibrate(
    run: CachePairsRun,
    *,
    profile_id: str | None = None,
    default_distance: float = DEFAULT_MAX_DISTANCE,
    now: datetime | None = None,
) -> CacheCalibrationResult:
    profile = _profile_id(run, profile_id)
    fitted_at = (now or datetime.now(timezone.utc)).isoformat().replace("+00:00", "Z")
    dev_pairs = [pair for pair in run.pairs if pair.split == "dev"]
    test_pairs = [pair for pair in run.pairs if pair.split == "test"]
    threshold = fit_threshold(dev_pairs)
    applied = threshold if threshold is not None else default_distance
    dev = split_metrics(dev_pairs, applied)
    test = split_metrics(test_pairs, applied)
    failures = [name for name, metrics in (("dev", dev), ("test", test)) if metrics.near_miss_wrong_hit_rate > 0]
    reason: str | None = None
    if threshold is None:
        reason = "no_safe_paraphrase_distance"
    elif failures:
        reason = "near_miss_wrong_hit_on_" + "_and_".join(failures)
    elif any(m.paraphrase_pairs == 0 or m.near_miss_pairs == 0 for m in (dev, test)):
        reason = "missing_pairs"
    source = "calibrated" if reason is None else "default"
    entry = SemanticCacheProfileCalibration(
        embedding_profile_id=profile,
        max_distance=applied if source == "calibrated" else default_distance,
        source=source,
        fitted_at=fitted_at,
        dev=dev,
        test=test,
    )
    return CacheCalibrationResult(profile=entry, bypasses=_bypasses(run.pairs), check_failures=failures, reason=reason)


def read_config(path: Path) -> SemanticCacheCalibration:
    if not Path(path).is_file():
        return SemanticCacheCalibration()
    try:
        return SemanticCacheCalibration.model_validate_json(Path(path).read_text(encoding="utf-8"))
    except (OSError, ValidationError, ValueError) as exc:
        raise CalibrationError(f"invalid cache calibration file {path}: {exc}") from exc


def merge_profile(config: SemanticCacheCalibration, entry: SemanticCacheProfileCalibration) -> SemanticCacheCalibration:
    others = [profile for profile in config.profiles if profile.embedding_profile_id != entry.embedding_profile_id]
    merged = sorted([*others, entry], key=lambda profile: profile.embedding_profile_id)
    return SemanticCacheCalibration(profiles=merged)


def effective_threshold(config: SemanticCacheCalibration, profile_id: str, default_distance: float) -> float:
    """What the app uses (src/lib/rag/cache/threshold.ts): a calibrated entry's distance, else the configured default."""
    for profile in config.profiles:
        if profile.embedding_profile_id == profile_id and profile.source == "calibrated":
            return profile.max_distance
    return default_distance


def check(run: CachePairsRun, threshold: float) -> list[str]:
    """The splits on which the threshold gives a near-miss wrong hit."""
    return [
        split
        for split in SPLITS
        if split_metrics([pair for pair in run.pairs if pair.split == split], threshold).near_miss_wrong_hit_rate > 0
    ]


def _report(result: CacheCalibrationResult, pairs_path: Path, effective: float | None, gate: list[str] | None) -> str:
    entry = result.profile
    lines = [
        "# Semantic cache calibration",
        "",
        f"- pairs: `{repo_relative(pairs_path)}`",
        f"- embedding profile: `{entry.embedding_profile_id}`",
        f"- source: {entry.source}" + (f" ({result.reason})" if result.reason else ""),
        f"- max distance: {entry.max_distance:.4f}",
        "",
        "| split | paraphrase pairs | paraphrase hit rate | near-miss pairs | near-miss wrong-hit rate | bypasses |",
        "|---|---|---|---|---|---|",
    ]
    for name in SPLITS:
        metrics = getattr(entry, name)
        bypass = ", ".join(f"{reason}={count}" for reason, count in result.bypasses.get(name, {}).items()) or "none"
        lines.append(
            f"| {name} | {metrics.paraphrase_pairs} | {metrics.paraphrase_hit_rate:.3f} | {metrics.near_miss_pairs} | "
            f"{metrics.near_miss_wrong_hit_rate:.3f} | {bypass} |"
        )
    if effective is not None:
        verdict = "pass" if not gate else "FAIL on " + ", ".join(gate)
        lines += ["", f"Wrong-hit gate at the effective distance {effective:.4f}: {verdict}"]
    return "\n".join(lines) + "\n"


def run_cache_calibration(
    pairs_path: Path,
    out_dir: Path,
    *,
    profile_id: str | None = None,
    write: Path | None = None,
    config_path: Path = CONFIG_PATH,
    gate: bool = False,
    default_distance: float = DEFAULT_MAX_DISTANCE,
) -> tuple[CacheCalibrationResult, list[str] | None, float | None]:
    if not 0 < default_distance <= CACHE_MAX_DISTANCE:
        raise CalibrationError(f"--default-distance must be above 0 and at most {CACHE_MAX_DISTANCE}")
    run = load_pairs(pairs_path)
    result = calibrate(run, profile_id=profile_id, default_distance=default_distance)
    target = config_path
    if write is not None:
        merged = merge_profile(read_config(write), result.profile)
        write_config_atomically(write, merged)
        target = write
    gate_failures: list[str] | None = None
    effective: float | None = None
    if gate:
        effective = effective_threshold(read_config(target), result.profile.embedding_profile_id, default_distance)
        gate_failures = check(run, effective)
    out_dir.mkdir(parents=True, exist_ok=True)
    payload = {
        "profile": result.profile.model_dump(mode="json"),
        "reason": result.reason,
        "bypasses": result.bypasses,
        "check_failures": result.check_failures,
        "effective_max_distance": effective,
        "gate_failures": gate_failures,
    }
    (out_dir / RESULT_NAME).write_text(json.dumps(payload, sort_keys=True, indent=2) + "\n", encoding="utf-8")
    (out_dir / REPORT_NAME).write_text(_report(result, pairs_path, effective, gate_failures), encoding="utf-8")
    return result, gate_failures, effective
