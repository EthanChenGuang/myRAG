"""Gate tiered routing against fixed routing on retrieval quality (D-40, SC6).

Runs the ingest fixture mode once per routing mode and run (`npm run test-rag -- --fixture-mode ingest --routing <mode>`), then
compares `tiered` with `fixed` item by item on the gated split: the paired difference of each Recall@k and of correct-refusal, per
gated slice, against the Phase 1 D-10 noise band (max(k * spread of the fixed runs, floor)). The gate fails when `tiered` is lower
beyond the band. Premium page share and the projected cost per 1,000 pages come from the ledger rows of each build (PDF jobs
only: tier_page_counts, or the fixed chain's tier for every page) priced with the routing cost table.

    python -m rag_eval.parse_gate --spec eval/config/phase31-parse-gate.json --out eval/reports/phase-03.1
"""

from __future__ import annotations

import argparse
import json
import math
import os
import statistics
import subprocess
import sys
from collections.abc import Sequence
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field, ValidationError
from rag_sidecar.contracts.baseline import NoiseConfig
from rag_sidecar.contracts.parse_eval import ModeProjection, PairedMetricDelta, ParseGateReport
from rag_sidecar.contracts.report import EvalReport, ItemResult
from rag_sidecar.contracts.routing import ParseRoutingConfig
from rag_sidecar.preflight.config import load_routing_config

from rag_eval.gate import _report_slices
from rag_eval.paired import _slice_members, _stat, is_gated_slice, item_metrics
from rag_eval.paths import REPO_ROOT, resolve_cli_path

EXIT_PASS = 0
EXIT_INVALID = 2
EXIT_RUN_FAILED = 3
EXIT_REGRESSION = 10
MODES: tuple[Literal["fixed", "tiered"], ...] = ("fixed", "tiered")
PRICED_TIERS = ("native", "fast", "structured", "premium")
LEDGER_FILE = "ingest-ledger.json"
REPORT_FILE = "parse-gate.json"
DETAILS_FILE = "parse-gate-details.json"
RecallMetric = Literal["recall_at_5", "recall_at_10"]
RefusalMetric = Literal["correct_refusal_rate"]


class _Model(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)


class GateSpec(_Model):
    schema_version: Literal[1] = 1
    runs: int = Field(default=3, ge=1)
    noise: str = "eval/config/noise.json"
    routing_config: str = "config/rag/parse-routing.json"
    recall_metrics: list[RecallMetric] = Field(default_factory=lambda: ["recall_at_5", "recall_at_10"], min_length=1)
    refusal_metrics: list[RefusalMetric] = Field(default_factory=lambda: ["correct_refusal_rate"], min_length=1)
    run_root: str = "eval/out/parse-gate"
    sweep: dict[str, Any] | None = None


class LedgerJob(BaseModel):
    """One queued job's ledger row as the ingest-mode harness writes it (eval/harness/ingest-mode.mts)."""

    model_config = ConfigDict(extra="ignore", frozen=True)

    filename: str
    mime_type: str | None = None
    status: str
    tier: str | None = None
    pages: int | None = None
    harness_page_count: int | None = None
    tier_page_counts: dict[str, float] = Field(default_factory=dict)
    attempts: list[dict[str, Any]] = Field(default_factory=list)


class IngestLedger(BaseModel):
    model_config = ConfigDict(extra="ignore", frozen=True)

    routing: Literal["fixed", "tiered"]
    force_tier: str | None = None
    jobs: list[LedgerJob]


class GateMismatch(ValueError):
    """The runs cannot be compared: another golden file, another request scope, or a run of the wrong routing mode."""


@dataclass(frozen=True)
class ModeRun:
    report: EvalReport
    ledger: IngestLedger


class MetricCell(_Model):
    metric: str
    n: int = Field(ge=0)
    n_nonzero: int = Field(ge=0)
    mean_d: float | None
    ci_low: float | None
    ci_high: float | None
    fixed_spread: float = Field(ge=0)
    band: float = Field(ge=0)
    within_noise_band: bool


class ModePages(_Model):
    runs: int = Field(ge=1)
    pdf_jobs: int = Field(ge=0)
    pages_by_tier: dict[str, float]


class GateDetails(_Model):
    gate_split: str
    fixed_runs: list[str]
    tiered_runs: list[str]
    fixed_corpus_sha256: str | None
    tiered_corpus_sha256: str | None
    golden_sha256: str
    cells: list[MetricCell]
    offenders: list[str]
    fixed_pages: ModePages
    tiered_pages: ModePages
    projection_population: str = "PDF jobs of each build; fixed jobs count every page at the fixed chain's tier"


@dataclass(frozen=True)
class GateOutcome:
    report: ParseGateReport
    details: GateDetails


def _is_pdf(job: LedgerJob) -> bool:
    return (job.mime_type or "").split(";")[0].strip().lower() == "application/pdf" or job.filename.lower().endswith(".pdf")


def job_tier_pages(job: LedgerJob) -> dict[str, float]:
    """Pages per tier of one PDF job: its tier_page_counts, or every page at the fixed chain's tier (fixed records no counts)."""
    counts = {tier: float(value) for tier, value in job.tier_page_counts.items() if tier in PRICED_TIERS and value > 0}
    if counts:
        return counts
    pages = job.pages or job.harness_page_count
    tier = next((str(attempt.get("tier")) for attempt in reversed(job.attempts) if attempt.get("reason") == "fixed_chain"), None) or job.tier
    if not pages or tier not in PRICED_TIERS:
        raise GateMismatch(f"ledger row {job.filename} has neither tier_page_counts nor a fixed chain tier and page count")
    return {tier: float(pages)}


def _pages_by_tier(ledgers: Sequence[IngestLedger]) -> tuple[dict[str, float], int]:
    totals = dict.fromkeys(PRICED_TIERS, 0.0)
    jobs = 0
    for ledger in ledgers:
        for job in ledger.jobs:
            if not _is_pdf(job):
                continue
            jobs += 1
            for tier, pages in job_tier_pages(job).items():
                totals[tier] += pages
    runs = max(1, len(ledgers))
    return {tier: value / runs for tier, value in totals.items()}, jobs // runs


def mode_projection(ledgers: Sequence[IngestLedger], cfg: ParseRoutingConfig) -> ModeProjection:
    """Premium page share and the cost of 1,000 pages at the routed tier mix, averaged over the runs (D-40)."""
    pages, _jobs = _pages_by_tier(ledgers)
    total = math.fsum(pages.values())
    if total == 0:
        return ModeProjection(premium_page_share=0.0, projected_cost_per_1000_pages_usd=0.0)
    cost = math.fsum(pages[tier] * getattr(cfg.costs.tier, tier).usd_per_page for tier in PRICED_TIERS)
    return ModeProjection(premium_page_share=pages["premium"] / total, projected_cost_per_1000_pages_usd=1000 * cost / total)


def _require_same(name: str, values: Sequence[object]) -> None:
    if any(value != values[0] for value in values[1:]):
        raise GateMismatch(f"{name} differs between runs: {sorted({repr(value) for value in values})}")


def _check_runs(fixed: Sequence[ModeRun], tiered: Sequence[ModeRun]) -> None:
    if not fixed or not tiered:
        raise GateMismatch("each routing mode needs at least one run")
    for mode, runs in (("fixed", fixed), ("tiered", tiered)):
        for run in runs:
            if run.ledger.routing != mode or run.ledger.force_tier is not None:
                raise GateMismatch(f"a {mode} run holds a {run.ledger.routing} routing ledger (forced tier {run.ledger.force_tier})")
        _require_same(f"{mode} corpus_sha256", [run.report.corpus_sha256 for run in runs])
    every = [run.report for run in [*fixed, *tiered]]
    _require_same("golden_sha256", [report.golden_sha256 for report in every])
    _require_same("golden_filter", [report.golden_filter for report in every])
    _require_same("gate_population", [report.gate_population for report in every])
    _require_same("deployment_mode", [report.deployment_mode for report in every])
    _require_same("embedder", [(report.embedder_id, report.embedder_version, report.embedder_source_sha256) for report in every])
    _require_same("request_options", [report.request_options for report in every])


def _gated_items(report: EvalReport) -> list[ItemResult]:
    items = [item for item in report.items if item.split == report.golden_filter.gate_split]
    if report.gate_population == "production":
        items = [item for item in items if item.provenance == "production"]
    return items


def _item_means(runs: Sequence[ModeRun]) -> tuple[dict[str, dict[str, float | None]], dict[str, ItemResult]]:
    """Per item and metric, the mean over the runs (None when the metric does not apply to the item)."""
    values: dict[str, dict[str, list[float]]] = {}
    items: dict[str, ItemResult] = {}
    for run in runs:
        for item in _gated_items(run.report):
            items.setdefault(item.item_id, item)
            for metric, value in item_metrics(item).items():
                if value is not None:
                    values.setdefault(item.item_id, {}).setdefault(metric, []).append(value)
    means: dict[str, dict[str, float | None]] = {}
    for item_id in items:
        per = values.get(item_id, {})
        means[item_id] = {metric: (math.fsum(per[metric]) / len(per[metric]) if metric in per else None) for metric in item_metrics(items[item_id])}
    return means, items


def _spread(runs: Sequence[ModeRun], slice_name: str, metric: str) -> float:
    present: list[float] = []
    for run in runs:
        metrics = _report_slices(run.report).get(slice_name)
        value = getattr(metrics, metric).value if metrics is not None else None
        if value is not None:
            present.append(value)
    return statistics.stdev(present) if len(present) > 1 else 0.0


def run_gate(
    fixed: Sequence[ModeRun],
    tiered: Sequence[ModeRun],
    noise: NoiseConfig,
    cfg: ParseRoutingConfig,
    *,
    recall_metrics: Sequence[str] = ("recall_at_5", "recall_at_10"),
    refusal_metrics: Sequence[str] = ("correct_refusal_rate",),
) -> GateOutcome:
    """Paired differences tiered minus fixed per gated slice; a mean below minus the band fails (D-40)."""
    _check_runs(fixed, tiered)
    fixed_means, fixed_items = _item_means(fixed)
    tiered_means, _tiered_items = _item_means(tiered)
    slices = {name: members for name, members in _slice_members(list(fixed_items.values())).items() if is_gated_slice(name, noise)}

    cells: list[MetricCell] = []
    recall: list[PairedMetricDelta] = []
    refusal: list[PairedMetricDelta] = []
    for slice_name in sorted(slices):
        for metric in [*recall_metrics, *refusal_metrics]:
            differences: list[float] = []
            for item in slices[slice_name]:
                observed = tiered_means.get(item.item_id, {}).get(metric)
                recorded = fixed_means.get(item.item_id, {}).get(metric)
                if observed is None or recorded is None:
                    continue
                differences.append(observed - recorded)
            if not differences:
                continue
            stat = _stat(differences)
            spread = _spread(fixed, slice_name, metric)
            band = max(noise.k * spread, noise.floor)
            assert stat.mean_d is not None
            within = stat.mean_d >= -band
            name = f"{slice_name}/{metric}"
            cells.append(
                MetricCell(
                    metric=name,
                    n=stat.n,
                    n_nonzero=stat.n_nonzero,
                    mean_d=stat.mean_d,
                    ci_low=stat.ci_low,
                    ci_high=stat.ci_high,
                    fixed_spread=spread,
                    band=band,
                    within_noise_band=within,
                )
            )
            entry = PairedMetricDelta(metric=name, delta=stat.mean_d, within_noise_band=within)
            (recall if metric in recall_metrics else refusal).append(entry)

    fixed_pages, fixed_jobs = _pages_by_tier([run.ledger for run in fixed])
    tiered_pages, tiered_jobs = _pages_by_tier([run.ledger for run in tiered])
    offenders = [cell.metric for cell in cells if not cell.within_noise_band]
    report = ParseGateReport(
        recall_at_k=recall,
        correct_refusal=refusal,
        noise_band_k=noise.k,
        noise_band_floor=noise.floor,
        fixed=mode_projection([run.ledger for run in fixed], cfg),
        tiered=mode_projection([run.ledger for run in tiered], cfg),
        passed=bool(cells) and not offenders,
    )
    details = GateDetails(
        gate_split=fixed[0].report.golden_filter.gate_split,
        fixed_runs=[run.report.run_id for run in fixed],
        tiered_runs=[run.report.run_id for run in tiered],
        fixed_corpus_sha256=fixed[0].report.corpus_sha256,
        tiered_corpus_sha256=tiered[0].report.corpus_sha256,
        golden_sha256=fixed[0].report.golden_sha256,
        cells=cells,
        offenders=offenders,
        fixed_pages=ModePages(runs=len(fixed), pdf_jobs=fixed_jobs, pages_by_tier=fixed_pages),
        tiered_pages=ModePages(runs=len(tiered), pdf_jobs=tiered_jobs, pages_by_tier=tiered_pages),
    )
    return GateOutcome(report=report, details=details)


# -------------------------------------------------------------------------------------------------------------------------
# Threshold sweep (D-41)
# -------------------------------------------------------------------------------------------------------------------------


class SweepCandidate(_Model):
    garbled_ratio: float
    min_ruling_paths: int
    scanned_max_chars: int


class SweepGrid(_Model):
    garbled_ratio: list[float]
    min_ruling_paths: list[int]
    scanned_max_chars: list[int]


class SweepSpec(_Model):
    grid: SweepGrid
    report: str


class SweepFixture(_Model):
    fixture_id: str
    split: str
    expected_tiers: dict[int, str]


class SweepItem(_Model):
    item_id: str
    fixture_id: str
    split: str
    pages: list[int]
    recall_by_tier: dict[str, float]
    fixed_recall: float


def fixture_split(fixture_id: str) -> str:
    return "dev"


def apply_thresholds(raw: dict[str, Any], chosen: SweepCandidate, reference: str) -> dict[str, Any]:
    return dict(raw)


def sweep(spec, *, fixtures, items, router, current, cfg, noise):
    raise NotImplementedError


# -------------------------------------------------------------------------------------------------------------------------
# Runs and the CLI
# -------------------------------------------------------------------------------------------------------------------------


def run_dir(spec: GateSpec, mode: str, index: int) -> Path:
    return resolve_cli_path(spec.run_root) / f"{mode}-{index}"


def harness_run(arguments: Sequence[str], out: Path) -> int:
    """One ingest-mode harness run (run-smoke) into ``out``; the exit code of the harness."""
    command = ["npx", "tsx", "eval/harness/run-smoke.mts", "--fixture-mode", "ingest", *arguments, "--out", str(out)]
    print(f"[Parse Gate] {' '.join(command)}", file=sys.stderr)
    return subprocess.run(command, cwd=REPO_ROOT, check=False, env=os.environ.copy()).returncode


def load_mode_run(directory: Path) -> ModeRun:
    report = EvalReport.model_validate_json((directory / "report.json").read_text(encoding="utf-8"))
    ledger = IngestLedger.model_validate_json((directory / LEDGER_FILE).read_text(encoding="utf-8"))
    return ModeRun(report=report, ledger=ledger)


def _dump(model: BaseModel) -> str:
    return json.dumps(model.model_dump(mode="json"), sort_keys=True, ensure_ascii=False, indent=2) + "\n"


def write_atomic(path: Path, text: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(f".{path.name}.tmp")
    tmp.write_text(text, encoding="utf-8")
    os.replace(tmp, path)


def load_spec(path: Path) -> GateSpec:
    return GateSpec.model_validate_json(path.read_text(encoding="utf-8"))


def _gate(args: argparse.Namespace) -> int:
    try:
        spec = load_spec(resolve_cli_path(args.spec))
        noise = NoiseConfig.model_validate_json(resolve_cli_path(spec.noise).read_text(encoding="utf-8"))
        cfg = load_routing_config(resolve_cli_path(spec.routing_config))
    except (OSError, ValidationError, ValueError) as exc:
        print(f"error: {exc}", file=sys.stderr)
        return EXIT_INVALID

    if not args.skip_runs:
        for mode in MODES:
            for index in range(1, spec.runs + 1):
                code = harness_run(["--routing", mode], run_dir(spec, mode, index))
                if code != 0:
                    print(f"error: the {mode} run {index} exited with code {code}", file=sys.stderr)
                    return EXIT_RUN_FAILED

    try:
        runs = {mode: [load_mode_run(run_dir(spec, mode, index)) for index in range(1, spec.runs + 1)] for mode in MODES}
        outcome = run_gate(
            runs["fixed"],
            runs["tiered"],
            noise,
            cfg,
            recall_metrics=spec.recall_metrics,
            refusal_metrics=spec.refusal_metrics,
        )
    except (OSError, ValidationError, ValueError) as exc:
        print(f"error: {exc}", file=sys.stderr)
        return EXIT_INVALID

    out = resolve_cli_path(args.out)
    write_atomic(out / REPORT_FILE, _dump(outcome.report))
    write_atomic(out / DETAILS_FILE, _dump(outcome.details))
    report = outcome.report
    print(
        f"[Parse Gate] premium share fixed {report.fixed.premium_page_share:.3f} tiered {report.tiered.premium_page_share:.3f}; "
        f"cost per 1,000 pages fixed ${report.fixed.projected_cost_per_1000_pages_usd:.2f} "
        f"tiered ${report.tiered.projected_cost_per_1000_pages_usd:.2f}",
        file=sys.stderr,
    )
    if not report.passed:
        for cell in outcome.details.cells:
            if not cell.within_noise_band:
                print(f"  {cell.metric}: tiered - fixed = {cell.mean_d:+.4f} below -{cell.band:.4f}", file=sys.stderr)
        print(f"[Parse Gate] FAIL ({len(outcome.details.offenders)} metric(s) beyond the noise band)", file=sys.stderr)
        return EXIT_REGRESSION
    print(f"[Parse Gate] PASS ({len(outcome.details.cells)} paired metrics within the noise band)", file=sys.stderr)
    return EXIT_PASS


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="rag_eval.parse_gate", description=__doc__.splitlines()[0])
    parser.add_argument("--spec", default="eval/config/phase31-parse-gate.json")
    parser.add_argument("--out", default="eval/reports/phase-03.1")
    parser.add_argument("--skip-runs", action="store_true", help="gate the runs already under run_root instead of running them")
    args = parser.parse_args(argv)
    return _gate(args)


if __name__ == "__main__":
    raise SystemExit(main())
