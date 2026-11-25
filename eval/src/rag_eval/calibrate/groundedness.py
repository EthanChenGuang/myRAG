from __future__ import annotations

import hashlib
import json
import os
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Literal, Protocol, Sequence

import httpx
from pydantic import BaseModel, ConfigDict, Field, ValidationError

from rag_sidecar.contracts.groundedness import (
    GroundednessRequest,
    GroundednessResult,
    GroundednessThresholdCell,
    GroundednessThresholds,
)

from rag_eval.config_files import write_config_atomically
from rag_eval.paths import REPO_ROOT, repo_relative

CELL_LANGUAGES = ("en", "zh-Hans")
CELL_SCORERS = ("hhem_2_3_vectara", "hhem_2_1_open")
DEFAULT_THRESHOLD = 0.5
DEV_MIN_PER_CLASS = 8
TEST_MIN_PER_CLASS = 4
CHANCE = 0.5
PASS_EPSILON = 1e-12
DEV_SPLIT = "dev"
TEST_SPLIT = "test"

FIXTURES_DIR = REPO_ROOT / "eval" / "fixtures"
DEFAULT_PAIRS = FIXTURES_DIR / "groundedness" / "pairs.jsonl"
THRESHOLDS_PATH = REPO_ROOT / "eval" / "config" / "groundedness-thresholds.json"
EVAL_OUT = REPO_ROOT / "eval" / "out"
DEFAULT_OUT = EVAL_OUT / "calibrate-groundedness"
RESULT_NAME = "groundedness-calibration.json"
REPORT_NAME = "groundedness-calibration.md"

SIDECAR_PATH = "/v1/groundedness"
SECRET_ENV_VAR = "RAG_SIDECAR_SECRET"
URL_ENV_VAR = "RAG_SIDECAR_URL"
SECRET_HEADER = "x-sidecar-secret"
REQUEST_PREFIX = "calib-"


class CalibrationError(RuntimeError):
    pass


class GroundednessPair(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)

    id: str = Field(min_length=1)
    language: Literal["en", "zh-Hans", "it"]
    split: Literal["dev", "test"]
    premise_texts: list[str] = Field(min_length=1)
    hypothesis: str = Field(min_length=1)
    label: Literal["faithful", "unfaithful"]


def load_pairs(path: Path) -> list[GroundednessPair]:
    try:
        text = Path(path).read_text(encoding="utf-8")
    except OSError as exc:
        raise CalibrationError(f"cannot read pairs file {path}: {exc}") from exc
    pairs: list[GroundednessPair] = []
    seen: set[str] = set()
    for number, line in enumerate(text.splitlines(), start=1):
        if not line.strip():
            continue
        try:
            pair = GroundednessPair.model_validate_json(line)
        except ValidationError as exc:
            raise CalibrationError(f"{path}:{number}: malformed pair: {exc}") from exc
        if any(not t.strip() for t in pair.premise_texts) or not pair.hypothesis.strip():
            raise CalibrationError(f"{path}:{number}: blank premise or hypothesis")
        if pair.id in seen:
            raise CalibrationError(f"{path}:{number}: duplicate pair id {pair.id!r}")
        seen.add(pair.id)
        pairs.append(pair)
    if not pairs:
        raise CalibrationError(f"{path} holds no pairs")
    return pairs


def build_request(pair: GroundednessPair, *, allow_vectara: bool) -> GroundednessRequest:
    return GroundednessRequest(
        request_id=f"{REQUEST_PREFIX}{pair.id}",
        language=pair.language,
        premise_texts=list(pair.premise_texts),
        hypothesis=pair.hypothesis,
        allow_vectara=allow_vectara,
    )


class Scorer(Protocol):
    name: str
    live: bool
    allow_vectara: bool

    def score(self, request: GroundednessRequest) -> GroundednessResult: ...


class StubScorer:
    """Deterministic offline scorer: label-driven scores for en, not_checked elsewhere (mirrors the sidecar's local route)."""

    name = "stub"
    live = False
    allow_vectara = False

    def __init__(self, pairs: Sequence[GroundednessPair], *, faithful: float = 0.8, unfaithful: float = 0.3) -> None:
        self._scores = {f"{REQUEST_PREFIX}{p.id}": faithful if p.label == "faithful" else unfaithful for p in pairs}

    def score(self, request: GroundednessRequest) -> GroundednessResult:
        if request.language != "en":
            return GroundednessResult(status="not_checked", scorer="none", reason="unsupported_language", latency_ms=0)
        return GroundednessResult(status="scored", scorer="hhem_2_1_open", score=self._scores[request.request_id], latency_ms=0)


class SidecarScorer:
    """Scores through the sidecar's POST /v1/groundedness with the shared secret; Vectara only when explicitly allowed."""

    name = "sidecar"
    live = True

    def __init__(
        self,
        base_url: str,
        *,
        secret: str | None = None,
        allow_vectara: bool = False,
        transport: httpx.BaseTransport | None = None,
        timeout: float = 60.0,
    ) -> None:
        if not base_url:
            raise CalibrationError(f"the sidecar scorer needs a base URL (--sidecar-url or {URL_ENV_VAR})")
        resolved = secret if secret is not None else os.environ.get(SECRET_ENV_VAR, "")
        self.allow_vectara = allow_vectara
        self._client = httpx.Client(
            base_url=base_url.rstrip("/"),
            headers={SECRET_HEADER: resolved},
            transport=transport,
            timeout=timeout,
        )

    def score(self, request: GroundednessRequest) -> GroundednessResult:
        if request.allow_vectara and not self.allow_vectara:
            raise CalibrationError("refusing to send pairs to Vectara without --allow-vectara")
        try:
            response = self._client.post(SIDECAR_PATH, json=request.model_dump(mode="json"))
        except httpx.HTTPError as exc:
            raise CalibrationError(f"sidecar request {request.request_id} failed: {type(exc).__name__}") from exc
        try:
            return GroundednessResult.model_validate(response.json())
        except (ValueError, ValidationError) as exc:
            raise CalibrationError(f"sidecar returned an invalid result for {request.request_id}") from exc

    def close(self) -> None:
        self._client.close()


@dataclass(frozen=True)
class ScoredRow:
    pair_id: str
    language: str
    split: str
    faithful: bool
    scorer: str
    score: float


@dataclass(frozen=True)
class CellFit:
    scorer: str
    language: str
    status: Literal["fitted", "insufficient_data", "no_separation"]
    threshold: float | None
    dev: dict[str, Any]


@dataclass(frozen=True)
class HoldoutResult:
    status: Literal["calibrated", "failed_holdout", "insufficient_data"]
    metrics: dict[str, Any]


CellStatus = Literal["calibrated", "failed_holdout", "insufficient_data", "no_separation", "holdout_insufficient_data"]


class CellRecord(BaseModel):
    model_config = ConfigDict(extra="forbid")

    status: CellStatus
    cell: GroundednessThresholdCell
    dev: dict[str, Any]
    holdout: dict[str, Any] | None = None


class GroundednessCalibrationResult(BaseModel):
    model_config = ConfigDict(extra="forbid")

    scorer_kind: str
    live: bool
    allow_vectara: bool
    pairs_path: str
    pairs_sha256: str
    fixture_pairs: bool
    dev_min_per_class: int = DEV_MIN_PER_CLASS
    test_min_per_class: int = TEST_MIN_PER_CLASS
    default_threshold: float = DEFAULT_THRESHOLD
    cells: list[CellRecord] = Field(default_factory=list)
    not_checked: dict[str, dict[str, int]] = Field(default_factory=dict)
    thresholds_written: bool = False
    thresholds_path: str | None = None
    notes: list[str] = Field(default_factory=list)


def balanced_accuracy(faithful: Sequence[float], unfaithful: Sequence[float], threshold: float) -> float:
    passed = sum(1 for s in faithful if s >= threshold) / len(faithful)
    flagged = sum(1 for s in unfaithful if s < threshold) / len(unfaithful)
    return (passed + flagged) / 2


def fit_threshold(faithful: Sequence[float], unfaithful: Sequence[float]) -> tuple[float, float]:
    """Threshold with the highest balanced accuracy; ties go to the candidate nearest the default, then the lowest."""
    if not faithful or not unfaithful:
        raise ValueError("fit_threshold needs at least one faithful and one unfaithful score")
    scores = sorted(set(faithful) | set(unfaithful))
    candidates = [scores[0]] + [(a + b) / 2 for a, b in zip(scores, scores[1:])] + [min(1.0, scores[-1] + 1e-9)]
    best: tuple[float, float] | None = None
    for threshold in candidates:
        accuracy = balanced_accuracy(faithful, unfaithful, threshold)
        if best is None:
            best = (threshold, accuracy)
            continue
        if accuracy > best[1] + PASS_EPSILON or (
            abs(accuracy - best[1]) <= PASS_EPSILON
            and abs(threshold - DEFAULT_THRESHOLD) < abs(best[0] - DEFAULT_THRESHOLD) - PASS_EPSILON
        ):
            best = (threshold, accuracy)
    assert best is not None
    return best


def _metrics(faithful: Sequence[float], unfaithful: Sequence[float], threshold: float | None) -> dict[str, Any]:
    block: dict[str, Any] = {"faithful_count": len(faithful), "unfaithful_count": len(unfaithful)}
    if threshold is not None and faithful and unfaithful:
        block.update(
            threshold=threshold,
            balanced_accuracy=balanced_accuracy(faithful, unfaithful, threshold),
            faithful_pass_rate=sum(1 for s in faithful if s >= threshold) / len(faithful),
            unfaithful_flag_rate=sum(1 for s in unfaithful if s < threshold) / len(unfaithful),
        )
    return block


def _split_scores(rows: Sequence[ScoredRow]) -> tuple[list[float], list[float]]:
    return [r.score for r in rows if r.faithful], [r.score for r in rows if not r.faithful]


def fit_cells(rows: Sequence[ScoredRow]) -> dict[tuple[str, str], CellFit]:
    """One fit per (scorer, language) cell. Test-split rows are dropped before anything is computed."""
    grouped: dict[tuple[str, str], list[ScoredRow]] = {}
    for row in rows:
        if row.split != DEV_SPLIT:
            continue
        grouped.setdefault((row.scorer, row.language), []).append(row)
    fits: dict[tuple[str, str], CellFit] = {}
    for key in sorted(grouped):
        faithful, unfaithful = _split_scores(grouped[key])
        if len(faithful) < DEV_MIN_PER_CLASS or len(unfaithful) < DEV_MIN_PER_CLASS:
            fits[key] = CellFit(key[0], key[1], "insufficient_data", None, _metrics(faithful, unfaithful, None))
            continue
        threshold, accuracy = fit_threshold(faithful, unfaithful)
        if accuracy <= CHANCE + PASS_EPSILON:
            fits[key] = CellFit(key[0], key[1], "no_separation", None, _metrics(faithful, unfaithful, threshold))
            continue
        fits[key] = CellFit(key[0], key[1], "fitted", threshold, _metrics(faithful, unfaithful, threshold))
    return fits


def holdout_check(fit: CellFit, test_rows: Sequence[ScoredRow]) -> HoldoutResult:
    """Apply the fitted threshold to the cell's test rows once. It passes only when it beats chance and is at least
    as good as the default threshold on the same rows."""
    if fit.threshold is None:
        raise ValueError(f"cell {fit.scorer}|{fit.language} has no threshold to check")
    for row in test_rows:
        if row.split != TEST_SPLIT:
            raise ValueError(f"holdout_check reads test-split rows only, got {row.split!r} for {row.pair_id}")
    cell_rows = [r for r in test_rows if (r.scorer, r.language) == (fit.scorer, fit.language)]
    faithful, unfaithful = _split_scores(cell_rows)
    if len(faithful) < TEST_MIN_PER_CLASS or len(unfaithful) < TEST_MIN_PER_CLASS:
        return HoldoutResult("insufficient_data", _metrics(faithful, unfaithful, None))
    metrics = _metrics(faithful, unfaithful, fit.threshold)
    default_accuracy = balanced_accuracy(faithful, unfaithful, DEFAULT_THRESHOLD)
    metrics["default_balanced_accuracy"] = default_accuracy
    accuracy = metrics["balanced_accuracy"]
    passed = accuracy > CHANCE + PASS_EPSILON and accuracy + PASS_EPSILON >= default_accuracy
    return HoldoutResult("calibrated" if passed else "failed_holdout", metrics)


def _default_cell(scorer: str, language: str) -> GroundednessThresholdCell:
    return GroundednessThresholdCell(scorer=scorer, language=language, threshold=DEFAULT_THRESHOLD, source="default")  # type: ignore[arg-type]


def calibrate_cells(rows: Sequence[ScoredRow], *, now: str) -> list[CellRecord]:
    fits = fit_cells(rows)
    test_rows = [r for r in rows if r.split == TEST_SPLIT]
    records: list[CellRecord] = []
    for key in sorted(fits):
        fit = fits[key]
        if fit.status != "fitted":
            records.append(CellRecord(status=fit.status, cell=_default_cell(*key), dev=fit.dev))
            continue
        holdout = holdout_check(fit, test_rows)
        if False:
            cell = GroundednessThresholdCell(
                scorer=fit.scorer,  # type: ignore[arg-type]
                language=fit.language,
                threshold=fit.threshold,  # type: ignore[arg-type]
                source="calibrated",
                fitted_at=now,
                dev=fit.dev,
                holdout=holdout.metrics,
            )
            records.append(CellRecord(status="calibrated", cell=cell, dev=fit.dev, holdout=holdout.metrics))
        else:
            status: CellStatus = "failed_holdout" if holdout.status == "failed_holdout" else "holdout_insufficient_data"
            records.append(CellRecord(status=status, cell=_default_cell(*key), dev=fit.dev, holdout=holdout.metrics))
    return records


def score_pairs(
    pairs: Sequence[GroundednessPair], scorer: Scorer
) -> tuple[list[ScoredRow], dict[str, dict[str, int]], list[str]]:
    rows: list[ScoredRow] = []
    not_checked: dict[str, dict[str, int]] = {}
    notes: list[str] = []

    def skip(language: str, reason: str) -> None:
        bucket = not_checked.setdefault(language, {})
        bucket[reason] = bucket.get(reason, 0) + 1

    for pair in pairs:
        result = scorer.score(build_request(pair, allow_vectara=scorer.allow_vectara))
        if pair.language not in CELL_LANGUAGES:
            if result.status == "scored":
                notes.append(f"{pair.id}: scorer returned a score for unsupported language {pair.language}; ignored")
            skip(pair.language, "unsupported_language" if result.status == "scored" else (result.reason or "not_checked"))
            continue
        if result.status != "scored" or result.score is None or result.scorer not in CELL_SCORERS:
            skip(pair.language, result.reason or "not_checked")
            continue
        rows.append(
            ScoredRow(
                pair_id=pair.id,
                language=pair.language,
                split=pair.split,
                faithful=pair.label == "faithful",
                scorer=result.scorer,
                score=float(result.score),
            )
        )
    return rows, not_checked, notes


def merge_thresholds(existing: GroundednessThresholds, records: Sequence[CellRecord]) -> GroundednessThresholds:
    updates = {(r.cell.scorer, r.cell.language): r.cell for r in records}
    cells = [updates.pop((c.scorer, c.language), c) for c in existing.cells]
    cells += [updates[key] for key in sorted(updates)]
    return GroundednessThresholds(cells=cells)


def _sha256(path: Path) -> str:
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def is_fixture_pairs(path: Path) -> bool:
    resolved = Path(path).resolve()
    if resolved.is_relative_to(FIXTURES_DIR.resolve()):
        return True
    return DEFAULT_PAIRS.is_file() and resolved.is_file() and _sha256(resolved) == _sha256(DEFAULT_PAIRS)


def _check_out_dir(out: Path) -> None:
    resolved = Path(out).resolve()
    if resolved.is_relative_to(REPO_ROOT.resolve()) and not resolved.is_relative_to(EVAL_OUT.resolve()):
        raise CalibrationError(f"--out must be under {repo_relative(EVAL_OUT)} when inside the repository, got {repo_relative(resolved)}")


def _fmt(value: Any) -> str:
    return f"{value:.3f}" if isinstance(value, float) else "-" if value is None else str(value)


def render_report(result: GroundednessCalibrationResult) -> str:
    kind = "live" if result.live else "offline (stub scorer; proves the tooling only, never written to the committed thresholds)"
    lines = [
        "# Groundedness calibration",
        "",
        f"- scorer: {result.scorer_kind} ({kind})",
        f"- allow_vectara: {str(result.allow_vectara).lower()}",
        f"- pairs: `{result.pairs_path}` (sha256 {result.pairs_sha256[:12]}){' — fixture pairs' if result.fixture_pairs else ''}",
        f"- rule: fit on dev by balanced accuracy (at least {result.dev_min_per_class} per class), check once on test "
        f"(at least {result.test_min_per_class} per class); calibrated only when the holdout beats chance and the "
        f"{result.default_threshold} default",
        "",
        "## Cells",
        "",
        "| scorer | language | status | threshold | source | dev BA | holdout BA | default BA on holdout |",
        "| --- | --- | --- | --- | --- | --- | --- | --- |",
    ]
    for record in result.cells:
        holdout = record.holdout or {}
        lines.append(
            f"| {record.cell.scorer} | {record.cell.language} | {record.status} | {_fmt(record.cell.threshold)} | "
            f"{record.cell.source} | {_fmt(record.dev.get('balanced_accuracy'))} | {_fmt(holdout.get('balanced_accuracy'))} | "
            f"{_fmt(holdout.get('default_balanced_accuracy'))} |"
        )
    if not result.cells:
        lines.append("| - | - | no cells | - | - | - | - | - |")
    lines += ["", "## not_checked", "", "| language | reason | count |", "| --- | --- | --- |"]
    for language in sorted(result.not_checked):
        for reason, count in sorted(result.not_checked[language].items()):
            lines.append(f"| {language} | {reason} | {count} |")
    if not result.not_checked:
        lines.append("| - | - | 0 |")
    if result.thresholds_written:
        lines += ["", f"Written to `{result.thresholds_path}`."]
    if result.notes:
        lines += ["", "## Notes", "", *[f"- {note}" for note in result.notes]]
    return "\n".join(lines) + "\n"


def run_groundedness_calibration(
    pairs: Path,
    out: Path,
    *,
    scorer: Scorer,
    write: Path | None = None,
    now: str | None = None,
) -> GroundednessCalibrationResult:
    pairs_path = Path(pairs)
    out_dir = Path(out)
    fixture = is_fixture_pairs(pairs_path)
    if write is not None:
        pass
    existing = GroundednessThresholds(cells=[])
    if write is not None and Path(write).is_file():
        try:
            existing = GroundednessThresholds.model_validate_json(Path(write).read_text(encoding="utf-8"))
        except (OSError, ValueError) as exc:
            raise CalibrationError(f"{write} is not a valid thresholds file: {exc}") from exc

    loaded = load_pairs(pairs_path)
    day = now or datetime.now(timezone.utc).date().isoformat()
    rows, not_checked, notes = score_pairs(loaded, scorer)
    records = calibrate_cells(rows, now=day)
    result = GroundednessCalibrationResult(
        scorer_kind=scorer.name,
        live=scorer.live,
        allow_vectara=scorer.allow_vectara,
        pairs_path=repo_relative(pairs_path),
        pairs_sha256=_sha256(pairs_path),
        fixture_pairs=fixture,
        cells=records,
        not_checked=not_checked,
        notes=notes,
    )
    if write is not None:
        write_config_atomically(Path(write), merge_thresholds(existing, records))
        result.thresholds_written = True
        result.thresholds_path = repo_relative(Path(write))
    out_dir.mkdir(parents=True, exist_ok=True)
    payload = json.dumps(result.model_dump(mode="json"), sort_keys=True, indent=2, ensure_ascii=False) + "\n"
    (out_dir / RESULT_NAME).write_text(payload, encoding="utf-8")
    (out_dir / REPORT_NAME).write_text(render_report(result), encoding="utf-8")
    return result
