"""D-19, D-49: duplicate-cluster threshold calibration, precision first.

The threshold is fitted on labelled candidate pairs (the pair dump of eval/harness/run-dup-pairs.mts, or a labelled pair file
from a live workspace kept outside the repository). A fixture run stores a per-profile entry with source fixture, which the app
applies in eval only; the top-level threshold is never moved by this tool.
"""

from __future__ import annotations

import json
from collections.abc import Callable, Sequence
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Literal

from pydantic import BaseModel, ValidationError
from rag_sidecar.contracts.retrieval import DupClusterParamsFile, DupClusterProfileEntry

from rag_eval.config_files import finalize_config, write_config_atomically
from rag_eval.harness_runner import HarnessError, Spawner, _tail, default_spawner
from rag_eval.paths import REPO_ROOT, repo_relative

PARAMS_PATH = REPO_ROOT / "eval/config/dup-cluster-params.json"
DEFAULT_OUT = REPO_ROOT / "eval/out/calibrate-dup-clusters"
DEFAULT_CORPUS = "eval/fixtures/corpus"
HARNESS_SCRIPT = "eval/harness/run-dup-pairs.mts"
PAIRS_NAME = "pairs.jsonl"
REPORT_NAME = "dup-cluster-calibration.md"
RESULT_NAME = "dup-cluster-calibration.json"
PAIR_KEYS = frozenset({"tenant", "embedding_profile_id", "chunk_a", "chunk_b", "hamming", "cosine", "same_template"})
# DupClusterParams.threshold: gt 0, le 1.
BOUNDS = (0.0, 1.0)

Source = Literal["fixture", "live"]
PairSource = Callable[[], Sequence["DupPair"]]


class CalibrationError(RuntimeError):
    """Usage error: the run cannot start or must not write."""


@dataclass(frozen=True)
class DupPair:
    tenant: str
    embedding_profile_id: str
    chunk_a: str
    chunk_b: str
    hamming: int | None
    cosine: float | None
    same_template: bool


@dataclass(frozen=True)
class ThresholdRow:
    threshold: float
    precision: float
    recall: float
    n: int


@dataclass(frozen=True)
class DupFit:
    status: Literal["calibrated", "uncalibrated"]
    threshold: float | None
    precision: float | None
    recall: float | None
    n_pairs: int
    n_same_template: int
    table: list[ThresholdRow] = field(default_factory=list)
    reason: str | None = None


class TableEntry(BaseModel):
    threshold: float
    precision: float
    recall: float
    n: int


class DupCalibrationResult(BaseModel):
    source: Source
    embedding_profile_id: str | None
    status: Literal["calibrated", "uncalibrated"]
    threshold: float | None
    precision: float | None
    recall: float | None
    n_pairs: int
    n_same_template: int
    reason: str | None
    table: list[TableEntry]
    pairs_path: str | None
    params_path: str
    params_written: bool
    write_skipped_reason: str | None = None


def _pair_from(payload: Any, where: str) -> DupPair:
    if not isinstance(payload, dict) or set(payload) != PAIR_KEYS:
        keys = sorted(payload) if isinstance(payload, dict) else type(payload).__name__
        raise CalibrationError(f"{where}: a pair line holds exactly {sorted(PAIR_KEYS)} (ids and numbers only), got {keys}")
    hamming = payload["hamming"]
    cosine = payload["cosine"]
    if not all(isinstance(payload[key], str) and payload[key] for key in ("tenant", "embedding_profile_id", "chunk_a", "chunk_b")):
        raise CalibrationError(f"{where}: tenant, embedding_profile_id, chunk_a and chunk_b must be non-empty strings")
    if hamming is not None and (isinstance(hamming, bool) or not isinstance(hamming, int)):
        raise CalibrationError(f"{where}: hamming must be an integer or null")
    if cosine is not None and (isinstance(cosine, bool) or not isinstance(cosine, (int, float))):
        raise CalibrationError(f"{where}: cosine must be a number or null")
    if not isinstance(payload["same_template"], bool):
        raise CalibrationError(f"{where}: same_template must be a boolean")
    return DupPair(
        tenant=payload["tenant"],
        embedding_profile_id=payload["embedding_profile_id"],
        chunk_a=payload["chunk_a"],
        chunk_b=payload["chunk_b"],
        hamming=hamming,
        cosine=None if cosine is None else float(cosine),
        same_template=payload["same_template"],
    )


def load_pairs(path: Path) -> list[DupPair]:
    pairs: list[DupPair] = []
    for number, line in enumerate(Path(path).read_text(encoding="utf-8").splitlines(), start=1):
        if not line.strip():
            continue
        try:
            payload = json.loads(line)
        except json.JSONDecodeError as exc:
            raise CalibrationError(f"{path}:{number}: not JSON: {exc}") from exc
        pairs.append(_pair_from(payload, f"{path}:{number}"))
    return pairs


def fit_dup_threshold(pairs: Sequence[DupPair], bounds: tuple[float, float] = BOUNDS) -> DupFit:
    """The smallest candidate cosine t inside (low, high] such that every pair with cosine >= t is same_template."""
    low, high = bounds
    scored = [p for p in pairs if p.cosine is not None]
    positives = sum(1 for p in scored if p.same_template)
    candidates = sorted({p.cosine for p in scored if p.cosine is not None and low < p.cosine <= high}, reverse=True)
    table: list[ThresholdRow] = []
    for t in candidates:
        selected = [p for p in scored if p.cosine is not None and p.cosine >= t]
        same = sum(1 for p in selected if p.same_template)
        table.append(
            ThresholdRow(threshold=t, precision=same / len(selected), recall=same / positives if positives else 0.0, n=len(selected))
        )
    base = {"n_pairs": len(pairs), "n_same_template": sum(1 for p in pairs if p.same_template), "table": table}
    if positives == 0:
        return DupFit(status="uncalibrated", threshold=None, precision=None, recall=None, reason="no same_template pair with a cosine", **base)
    chosen = [row for row in table if row.precision == 1.0]
    if not chosen:
        return DupFit(
            status="uncalibrated",
            threshold=None,
            precision=None,
            recall=None,
            reason=f"no threshold in ({low}, {high}] reaches precision 1.0",
            **base,
        )
    best = min(chosen, key=lambda row: row.threshold)
    return DupFit(status="calibrated", threshold=best.threshold, precision=best.precision, recall=best.recall, **base)


def _inside(path: Path, root: Path) -> bool:
    try:
        path.resolve().relative_to(root.resolve())
    except ValueError:
        return False
    return True


def _harness_pairs(
    out: Path, *, corpus: str, deployment_mode: str, spawner: Spawner | None, repo_root: Path
) -> tuple[list[DupPair], Path]:
    pairs_path = out / PAIRS_NAME
    argv = ["npx", "tsx", HARNESS_SCRIPT, "--corpus", corpus, "--deployment-mode", deployment_mode, "--out", str(pairs_path)]
    result = (spawner or default_spawner)(argv, Path(repo_root))
    code = getattr(result, "returncode", None)
    if code != 0:
        stdout_tail = _tail(getattr(result, "stdout", ""))
        stderr_tail = _tail(getattr(result, "stderr", ""))
        raise HarnessError(
            f"pair harness exited with exit code {code}\n{stderr_tail or stdout_tail}",
            exit_code=code,
            stdout_tail=stdout_tail,
            stderr_tail=stderr_tail,
        )
    if not pairs_path.is_file():
        raise HarnessError(f"pair harness wrote no {pairs_path}", exit_code=0)
    return load_pairs(pairs_path), pairs_path


def _single_profile(pairs: Sequence[DupPair]) -> str | None:
    profiles = sorted({p.embedding_profile_id for p in pairs})
    if len(profiles) > 1:
        raise CalibrationError(f"the pairs name more than one embedding profile: {profiles}")
    return profiles[0] if profiles else None


def _load_params(path: Path) -> DupClusterParamsFile:
    if not path.is_file():
        return DupClusterParamsFile()
    try:
        return DupClusterParamsFile.model_validate_json(path.read_text(encoding="utf-8"))
    except (OSError, ValidationError, ValueError) as exc:
        raise CalibrationError(f"{path}: not a valid DupClusterParamsFile; fix or remove it first: {exc}") from exc


def _write_entry(path: Path, profile: str, threshold: float, source: Source) -> str | None:
    """Writes the profile's entry; returns why nothing was written, or None."""
    existing = _load_params(path)
    current = existing.by_profile.get(profile)
    if source == "fixture" and current is not None and current.source == "live":
        return f"profile {profile} already has a live entry; a fixture run never replaces it"
    by_profile = dict(existing.by_profile)
    by_profile[profile] = DupClusterProfileEntry(threshold=threshold, source=source)
    model = DupClusterParamsFile(threshold=existing.threshold, by_profile=by_profile)
    write_config_atomically(path, finalize_config(model, provenance_source="calibration"))
    return None


def render_report(result: DupCalibrationResult) -> str:
    lines = [
        "# Duplicate-cluster threshold calibration",
        "",
        f"- Source: {result.source}",
        f"- Embedding profile: {result.embedding_profile_id or 'none'}",
        f"- Pairs: {result.n_pairs} ({result.n_same_template} same_template)",
        f"- Status: {result.status}" + (f" ({result.reason})" if result.reason else ""),
        "- Rule: the smallest candidate cosine t in (0, 1] such that every pair with cosine >= t is same_template (precision 1.0).",
    ]
    if result.threshold is not None:
        lines.append(f"- Chosen threshold: {result.threshold:.4f} (precision {result.precision:.4f}, recall {result.recall:.4f})")
    if result.source == "fixture":
        lines.append(
            "- A fixture-fitted value applies in eval only: the fixture embedder is a hashed n-gram bag and says nothing about a real model."
        )
    if result.params_written:
        lines.append(f"- Wrote the {result.source} entry of {result.embedding_profile_id} to {result.params_path}; the top-level threshold is unchanged.")
    elif result.write_skipped_reason:
        lines.append(f"- Not written: {result.write_skipped_reason}")
    else:
        lines.append("- Not written (run with --write-params to store the entry).")
    lines += ["", "| threshold | precision | recall | n | chosen |", "| --- | --- | --- | --- | --- |"]
    for row in result.table:
        chosen = "yes" if result.threshold is not None and row.threshold == result.threshold else ""
        lines.append(f"| {row.threshold:.4f} | {row.precision:.4f} | {row.recall:.4f} | {row.n} | {chosen} |")
    return "\n".join(lines) + "\n"


def run_dup_cluster_calibration(
    out: Path,
    *,
    source: Source = "fixture",
    pairs_path: Path | None = None,
    embedding_profile: str | None = None,
    write_params: bool = False,
    params_path: Path = PARAMS_PATH,
    corpus: str = DEFAULT_CORPUS,
    deployment_mode: str = "single-tenant",
    pair_source: PairSource | None = None,
    spawner: Spawner | None = None,
    repo_root: Path = REPO_ROOT,
) -> DupCalibrationResult:
    if source not in ("fixture", "live"):
        raise CalibrationError(f"--source must be fixture or live, got {source!r}")
    if source == "live":
        if pairs_path is None or not embedding_profile:
            raise CalibrationError("--source live needs --pairs <file> (labelled outside the repository) and --embedding-profile <id>")
        if write_params and _inside(Path(pairs_path), repo_root):
            raise CalibrationError(
                f"{pairs_path} is inside the repository; pairs from a live workspace never enter git, keep them outside it"
            )
    out = Path(out)
    out.mkdir(parents=True, exist_ok=True)
    used_pairs: Path | None = None
    if pair_source is not None:
        pairs = list(pair_source())
    elif pairs_path is not None:
        used_pairs = Path(pairs_path)
        pairs = load_pairs(used_pairs)
    else:
        pairs, used_pairs = _harness_pairs(out, corpus=corpus, deployment_mode=deployment_mode, spawner=spawner, repo_root=repo_root)

    profile = _single_profile(pairs)
    if source == "live":
        if profile is not None and profile != embedding_profile:
            raise CalibrationError(f"the pairs name embedding profile {profile}, not {embedding_profile}")
        profile = embedding_profile
    elif embedding_profile and profile is not None and profile != embedding_profile:
        raise CalibrationError(f"the pairs name embedding profile {profile}, not {embedding_profile}")

    fit = fit_dup_threshold(pairs)
    written = False
    skipped: str | None = None
    if write_params and fit.status == "calibrated" and fit.threshold is not None:
        if profile is None:
            skipped = "no embedding profile in the pairs"
        else:
            skipped = _write_entry(Path(params_path), profile, fit.threshold, source)
            written = skipped is None
    elif write_params:
        skipped = f"status {fit.status}: {fit.reason}"

    result = DupCalibrationResult(
        source=source,
        embedding_profile_id=profile,
        status=fit.status,
        threshold=fit.threshold,
        precision=fit.precision,
        recall=fit.recall,
        n_pairs=fit.n_pairs,
        n_same_template=fit.n_same_template,
        reason=fit.reason,
        table=[TableEntry(threshold=r.threshold, precision=r.precision, recall=r.recall, n=r.n) for r in fit.table],
        pairs_path=repo_relative(used_pairs) if used_pairs is not None else None,
        params_path=repo_relative(params_path),
        params_written=written,
        write_skipped_reason=skipped,
    )
    (out / RESULT_NAME).write_text(json.dumps(result.model_dump(mode="json"), sort_keys=True, indent=2) + "\n", encoding="utf-8")
    (out / REPORT_NAME).write_text(render_report(result), encoding="utf-8")
    return result
