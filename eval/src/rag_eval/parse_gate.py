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
import shutil
import subprocess
import sys
import tempfile
from collections.abc import Callable, Sequence
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field, ValidationError
from rag_sidecar.contracts.baseline import NoiseConfig
from rag_sidecar.contracts.golden import GoldenItem
from rag_sidecar.contracts.parse_eval import ModeProjection, PairedMetricDelta, ParseGateReport
from rag_sidecar.contracts.report import EvalReport, ItemResult
from rag_sidecar.contracts.routing import ParseRoutingConfig
from rag_sidecar.preflight.config import load_routing_config

from rag_eval.gate import _report_slices
from rag_eval.metrics import report_gate_items
from rag_eval.paired import _slice_members, _stat, is_gated_slice, item_metrics
from rag_eval.parser_eval import LINK_TAG, _scored_fixtures, load_fixture_outputs, normalize_text
from rag_eval.paths import REPO_ROOT, resolve_cli_path
from rag_eval.split import assign_split

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
ForcedTier = Literal["fast", "structured", "premium"]
SWEEP_SPLIT_RULE = "dev and test fixtures by rag_eval.split.assign_split(fixture_id) (Phase 1 D-14); dev items are dev-split items on dev fixtures"


class _Model(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)


class SweepCandidate(_Model):
    """One set of the swept L1 thresholds (the routing file's l1 block)."""

    garbled_ratio: float = Field(ge=0, le=1)
    min_ruling_paths: int = Field(ge=0)
    scanned_max_chars: int = Field(ge=0)


class SweepGrid(_Model):
    garbled_ratio: list[float] = Field(min_length=1)
    min_ruling_paths: list[int] = Field(min_length=1)
    scanned_max_chars: list[int] = Field(min_length=1)

    def candidates(self) -> list[SweepCandidate]:
        return [
            SweepCandidate(garbled_ratio=garbled, min_ruling_paths=ruling, scanned_max_chars=scanned)
            for garbled in self.garbled_ratio
            for ruling in self.min_ruling_paths
            for scanned in self.scanned_max_chars
        ]


class SweepSpec(_Model):
    fixtures: str = "eval/fixtures/parse"
    combo: Literal["L1", "L1+L2", "L1+L2+L3"] = "L1+L2"
    metric: RecallMetric = "recall_at_5"
    grid: SweepGrid
    forced_runs: dict[ForcedTier, str] = Field(
        default_factory=lambda: {tier: f"eval/out/parse-gate/tier-{tier}" for tier in ("fast", "structured", "premium")}
    )
    report: str


class GateSpec(_Model):
    schema_version: Literal[1] = 1
    runs: int = Field(default=3, ge=1)
    noise: str = "eval/config/noise.json"
    routing_config: str = "config/rag/parse-routing.json"
    recall_metrics: list[RecallMetric] = Field(default_factory=lambda: ["recall_at_5", "recall_at_10"], min_length=1)
    refusal_metrics: list[RefusalMetric] = Field(default_factory=lambda: ["correct_refusal_rate"], min_length=1)
    run_root: str = "eval/out/parse-gate"
    sweep: SweepSpec | None = None


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
    return report_gate_items(report.items, report.golden_filter.gate_split, report.gate_population)


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


class SweepFixture(_Model):
    fixture_id: str
    split: str
    expected_tiers: dict[int, str]


class SweepItem(_Model):
    """A golden item linked to a parse fixture: the pages holding its evidence (empty: unknown, every page), its Recall@k when
    every page is pinned to each tier, and its Recall@k under fixed routing."""

    item_id: str
    fixture_id: str
    split: str
    pages: list[int]
    recall_by_tier: dict[str, float]
    fixed_recall: float = Field(ge=0, le=1)


class CandidateScore(_Model):
    candidate: SweepCandidate
    dev_pages: int = Field(ge=0)
    dev_tier_correct: int = Field(ge=0)
    dev_tier_accuracy: float = Field(ge=0, le=1)
    dev_below_expected: int = Field(ge=0)
    dev_cost_per_page_usd: float = Field(ge=0)
    dev_projected_recall: float = Field(ge=0, le=1)
    within_band: bool


class SplitScore(_Model):
    fixtures: list[str]
    pages: int = Field(ge=0)
    tier_correct: int = Field(ge=0)
    tier_accuracy: float = Field(ge=0, le=1)
    below_expected: int = Field(ge=0)
    items: int = Field(ge=0)
    projected_recall: float | None
    fixed_recall: float | None


class SweepReport(_Model):
    split_rule: str = SWEEP_SPLIT_RULE
    combo: str
    metric: str
    selection: str = (
        "highest dev page-tier accuracy among candidates whose projected dev Recall@k is not below fixed by more than the band; "
        "ties: fewer pages below the expected tier, lower cost per page, closest to the current values"
    )
    recall_projection: str = (
        "per item, the forced-tier run's Recall@k at the tier its evidence pages are routed to (the lowest when several)"
    )
    current: SweepCandidate
    chosen: SweepCandidate
    chosen_score: CandidateScore
    noise_band: float = Field(ge=0)
    fixed_spread: float = Field(ge=0)
    dev_reference_recall: float | None
    dev_fixtures: list[str]
    dev_items: list[str]
    candidates: list[CandidateScore]
    test_split: SplitScore
    routing_config_version: str
    forced_runs: dict[str, str] = Field(default_factory=dict)
    fixed_runs: list[str] = Field(default_factory=list)


class SweepFailed(ValueError):
    """No candidate keeps dev Recall@k within the band."""


Router = Callable[[Sequence[SweepCandidate], Sequence[str]], list[dict[str, dict[int, str]]]]
_TIER_RANK = {"native": 0, "fast": 1, "structured": 2, "premium": 3}


def fixture_split(fixture_id: str) -> str:
    """Parse fixtures carry no split; they take the golden-set rule over their id, so the assignment is fixed and auditable."""
    return assign_split(fixture_id)


def _recall_tier(tier: str) -> str:
    return "fast" if tier == "native" else tier


def _item_recall(item: SweepItem, routed: dict[int, str]) -> float:
    pages = [page for page in item.pages if page in routed] or sorted(routed)
    return min(item.recall_by_tier[_recall_tier(routed[page])] for page in pages)


def _mean(values: Sequence[float]) -> float | None:
    return math.fsum(values) / len(values) if values else None


def _split_score(
    fixtures: Sequence[SweepFixture], routed: dict[str, dict[int, str]], items: Sequence[SweepItem], item_routes: dict[str, dict[int, str]]
) -> tuple[int, int, int, float, float | None, float | None]:
    pages = correct = below = 0
    for fixture in fixtures:
        got = routed[fixture.fixture_id]
        for page, want in fixture.expected_tiers.items():
            pages += 1
            correct += got[page] == want
            below += _TIER_RANK[got[page]] < _TIER_RANK[want]
    projected = _mean([_item_recall(item, item_routes[item.fixture_id]) for item in items])
    reference = _mean([item.fixed_recall for item in items])
    return pages, correct, below, (correct / pages if pages else 1.0), projected, reference


def _cost_per_page(routed: dict[str, dict[int, str]], cfg: ParseRoutingConfig) -> float:
    tiers = [tier for pages in routed.values() for tier in pages.values()]
    return math.fsum(getattr(cfg.costs.tier, tier).usd_per_page for tier in tiers) / len(tiers) if tiers else 0.0


def _distance(candidate: SweepCandidate, current: SweepCandidate) -> float:
    return (
        abs(candidate.garbled_ratio - current.garbled_ratio) / 0.01
        + abs(candidate.min_ruling_paths - current.min_ruling_paths)
        + abs(candidate.scanned_max_chars - current.scanned_max_chars) / 10
    )


def sweep(
    spec: SweepSpec,
    *,
    fixtures: Sequence[SweepFixture],
    items: Sequence[SweepItem],
    router: Router,
    current: SweepCandidate,
    cfg: ParseRoutingConfig,
    noise: NoiseConfig,
    fixed_spread: float = 0.0,
) -> SweepReport:
    """Chooses the L1 thresholds on the dev split only, then scores the test split once with the choice (D-41).

    Selection sees dev fixtures and the dev items on them and nothing else; the router is never asked for a test fixture until the
    choice is made, so a test fixture or a test item cannot move it.
    """
    dev_fixtures = [fixture for fixture in fixtures if fixture.split == "dev"]
    test_fixtures = [fixture for fixture in fixtures if fixture.split != "dev"]
    dev_ids = {fixture.fixture_id for fixture in dev_fixtures}
    dev_items = [item for item in items if item.split == "dev" and item.fixture_id in dev_ids]
    if not dev_fixtures or not dev_items:
        raise SweepFailed("the sweep needs dev fixtures and dev items linked to them")
    band = max(noise.k * fixed_spread, noise.floor)
    reference = _mean([item.fixed_recall for item in dev_items])
    assert reference is not None

    candidates = spec.grid.candidates()
    routed_all = router(candidates, [fixture.fixture_id for fixture in dev_fixtures])
    scores: list[CandidateScore] = []
    for candidate, routed in zip(candidates, routed_all, strict=True):
        pages, correct, below, accuracy, projected, _reference = _split_score(dev_fixtures, routed, dev_items, routed)
        assert projected is not None
        scores.append(
            CandidateScore(
                candidate=candidate,
                dev_pages=pages,
                dev_tier_correct=correct,
                dev_tier_accuracy=accuracy,
                dev_below_expected=below,
                dev_cost_per_page_usd=_cost_per_page(routed, cfg),
                dev_projected_recall=projected,
                within_band=projected >= reference - band - 1e-12,
            )
        )
    kept = [score for score in scores if score.within_band]
    if not kept:
        raise SweepFailed(f"no candidate keeps dev {spec.metric} within {band:.3f} of fixed ({reference:.3f})")
    best = min(
        kept,
        key=lambda score: (
            -score.dev_tier_accuracy,
            score.dev_below_expected,
            score.dev_cost_per_page_usd,
            _distance(score.candidate, current),
            score.candidate.garbled_ratio,
            score.candidate.min_ruling_paths,
            score.candidate.scanned_max_chars,
        ),
    )
    chosen = best.candidate
    chosen_dev_routes = routed_all[candidates.index(chosen)]

    test_routes: dict[str, dict[int, str]] = {}
    if test_fixtures:
        [test_routes] = router([chosen], [fixture.fixture_id for fixture in test_fixtures])
    test_items = [item for item in items if item not in dev_items and (item.split != "dev" or item.fixture_id not in dev_ids)]
    pages, correct, below, accuracy, projected, test_reference = _split_score(
        test_fixtures, test_routes, test_items, {**chosen_dev_routes, **test_routes}
    )
    return SweepReport(
        combo=spec.combo,
        metric=spec.metric,
        current=current,
        chosen=chosen,
        chosen_score=best,
        noise_band=band,
        fixed_spread=fixed_spread,
        dev_reference_recall=reference,
        dev_fixtures=sorted(dev_ids),
        dev_items=sorted(item.item_id for item in dev_items),
        candidates=scores,
        test_split=SplitScore(
            fixtures=[fixture.fixture_id for fixture in test_fixtures],
            pages=pages,
            tier_correct=correct,
            tier_accuracy=accuracy,
            below_expected=below,
            items=len(test_items),
            projected_recall=projected,
            fixed_recall=test_reference,
        ),
        routing_config_version=cfg.version,
    )


def apply_thresholds(raw: dict[str, Any], chosen: SweepCandidate, reference: str) -> dict[str, Any]:
    """The routing file with the chosen L1 values and the reference to the report that chose them; validated, key order kept."""
    updated = json.loads(json.dumps(raw))
    updated["l1"] = {**updated["l1"], **chosen.model_dump()}
    updated["thresholds_ref"] = reference
    ParseRoutingConfig.model_validate(updated)
    return updated


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


def sidecar_router(fixtures_dir: Path, combo: str, routing_config: Path, work: Path) -> Router:
    """Routes through `python -m rag_sidecar.preflight.sweep` in the sidecar project (L1 and L2 need pdfplumber and pypdfium2)."""

    def route(candidates: Sequence[SweepCandidate], fixture_ids: Sequence[str]) -> list[dict[str, dict[int, str]]]:
        work.mkdir(parents=True, exist_ok=True)
        candidates_path = work / "candidates.json"
        out_path = work / "routed.json"
        candidates_path.write_text(json.dumps([candidate.model_dump() for candidate in candidates]), encoding="utf-8")
        command = [
            shutil.which("uv") or "uv",
            "run",
            "--directory",
            str(REPO_ROOT / "rag-sidecar"),
            "--frozen",
            "--extra",
            "chunking",
            "--extra",
            "preflight",
            "python",
            "-m",
            "rag_sidecar.preflight.sweep",
            "--fixtures",
            str(fixtures_dir),
            "--combo",
            combo,
            "--routing-config",
            str(routing_config),
            "--candidates",
            str(candidates_path),
            "--out",
            str(out_path),
        ]
        for fixture_id in fixture_ids:
            command.extend(["--fixture", fixture_id])
        env = {key: value for key, value in os.environ.items() if key != "VIRTUAL_ENV"}
        result = subprocess.run(command, cwd=REPO_ROOT, check=False, env=env)
        if result.returncode != 0:
            raise SweepFailed(f"routing the candidates exited with code {result.returncode}")
        routed = json.loads(out_path.read_text(encoding="utf-8"))
        return [{fixture: {int(row["page"]): str(row["tier"]) for row in rows} for fixture, rows in entry.items()} for entry in routed]

    return route


def _page_texts(fixtures_dir: Path, sha256: str, page_count: int) -> dict[int, list[str]]:
    texts: dict[int, list[str]] = {page: [] for page in range(1, page_count + 1)}
    for pages in load_fixture_outputs(fixtures_dir, sha256, page_count).values():
        for page, output in enumerate(pages, start=1):
            texts[page].append(normalize_text(" ".join([*output.blocks, *(cell for _row, _col, cell in output.cells)])))
    return texts


def _evidence_pages(item: GoldenItem, texts: dict[int, list[str]]) -> list[int]:
    """The pages holding an item's quotes in any recorded parse; empty when a quote is on no single page."""
    pages: set[int] = set()
    for evidence in item.gold_evidence:
        quote = normalize_text(evidence.quote)
        found = [page for page, variants in texts.items() if any(quote in variant for variant in variants)]
        if not found:
            return []
        pages.update(found)
    return sorted(pages)


def _item_recalls(directory: Path, metric: str) -> dict[str, float]:
    report = EvalReport.model_validate_json((directory / "report.json").read_text(encoding="utf-8"))
    return {item.item_id: value for item in report.items if (value := item_metrics(item)[metric]) is not None}


def load_sweep_inputs(spec: GateSpec, sweep_spec: SweepSpec) -> tuple[list[SweepFixture], list[SweepItem], float, list[str]]:
    """Fixtures with their expected tiers and split, linked items with their per-tier and fixed Recall@k, and the fixed spread."""
    fixtures_dir = resolve_cli_path(sweep_spec.fixtures)
    scored, _excluded = _scored_fixtures(fixtures_dir)
    fixtures = [
        SweepFixture(
            fixture_id=expected.fixture_id,
            split=fixture_split(expected.fixture_id),
            expected_tiers={page.page: page.tier for page in expected.pages},
        )
        for _row, expected in scored
    ]
    rows = {row["id"]: row for row, _expected in scored}
    forced = {tier: _item_recalls(resolve_cli_path(path), sweep_spec.metric) for tier, path in sweep_spec.forced_runs.items()}
    if set(forced) != {"fast", "structured", "premium"}:
        raise SweepFailed("forced_runs must name the fast, structured and premium runs")
    fixed_dirs = [run_dir(spec, "fixed", index) for index in range(1, spec.runs + 1)]
    fixed = [_item_recalls(directory, sweep_spec.metric) for directory in fixed_dirs]
    golden_path = resolve_cli_path(sweep_spec.forced_runs["structured"]) / "golden.merged.jsonl"
    items: list[SweepItem] = []
    texts: dict[str, dict[int, list[str]]] = {}
    for line in golden_path.read_text(encoding="utf-8").splitlines():
        if not line.strip():
            continue
        golden = GoldenItem.model_validate_json(line)
        fixture_id = next((tag[len(LINK_TAG) :] for tag in golden.tags if tag.startswith(LINK_TAG)), None)
        if fixture_id not in rows or not golden.answerable or golden.review_status != "approved":
            continue
        if fixture_id not in texts:
            texts[fixture_id] = _page_texts(fixtures_dir, rows[fixture_id]["sha256"], rows[fixture_id]["page_count"])
        missing = [tier for tier, values in forced.items() if golden.id not in values] + [
            str(index) for index, values in enumerate(fixed, start=1) if golden.id not in values
        ]
        if missing:
            raise SweepFailed(f"no {sweep_spec.metric} for {golden.id} in run(s) {', '.join(missing)}")
        items.append(
            SweepItem(
                item_id=golden.id,
                fixture_id=fixture_id,
                split=golden.split,
                pages=_evidence_pages(golden, texts[fixture_id]),
                recall_by_tier={tier: values[golden.id] for tier, values in forced.items()},
                fixed_recall=math.fsum(values[golden.id] for values in fixed) / len(fixed),
            )
        )
    dev_ids = {fixture.fixture_id for fixture in fixtures if fixture.split == "dev"}
    dev_items = [item.item_id for item in items if item.split == "dev" and item.fixture_id in dev_ids]
    per_run = [math.fsum(values[item_id] for item_id in dev_items) / len(dev_items) for values in fixed] if dev_items else []
    spread = statistics.stdev(per_run) if len(per_run) > 1 else 0.0
    return fixtures, items, spread, [str(directory) for directory in fixed_dirs]


def _shown(path: Path) -> str:
    try:
        return path.resolve().relative_to(REPO_ROOT.resolve()).as_posix()
    except ValueError:
        return path.as_posix()


def _sweep_cli(args: argparse.Namespace) -> int:
    try:
        spec = load_spec(resolve_cli_path(args.spec))
        if spec.sweep is None:
            raise ValueError("the spec has no sweep section")
        sweep_spec = spec.sweep
        noise = NoiseConfig.model_validate_json(resolve_cli_path(spec.noise).read_text(encoding="utf-8"))
        cfg_path = resolve_cli_path(spec.routing_config)
        cfg = load_routing_config(cfg_path)
    except (OSError, ValidationError, ValueError) as exc:
        print(f"error: {exc}", file=sys.stderr)
        return EXIT_INVALID

    if not args.skip_runs:
        planned = [(["--force-tier", tier], resolve_cli_path(path)) for tier, path in sweep_spec.forced_runs.items()]
        planned += [(["--routing", "fixed"], run_dir(spec, "fixed", index)) for index in range(1, spec.runs + 1)]
        for arguments, out in planned:
            code = harness_run(arguments, out)
            if code != 0:
                print(f"error: {' '.join(arguments)} exited with code {code}", file=sys.stderr)
                return EXIT_RUN_FAILED

    current = SweepCandidate(
        garbled_ratio=cfg.l1.garbled_ratio, min_ruling_paths=cfg.l1.min_ruling_paths, scanned_max_chars=cfg.l1.scanned_max_chars
    )
    try:
        fixtures, items, spread, fixed_runs = load_sweep_inputs(spec, sweep_spec)
        with tempfile.TemporaryDirectory(prefix="parse-sweep-") as work:
            router = sidecar_router(resolve_cli_path(sweep_spec.fixtures), sweep_spec.combo, cfg_path, Path(work))
            report = sweep(sweep_spec, fixtures=fixtures, items=items, router=router, current=current, cfg=cfg, noise=noise, fixed_spread=spread)
    except (OSError, ValidationError, ValueError) as exc:
        print(f"error: {exc}", file=sys.stderr)
        return EXIT_INVALID
    report = report.model_copy(
        update={
            "forced_runs": {tier: _shown(resolve_cli_path(path)) for tier, path in sweep_spec.forced_runs.items()},
            "fixed_runs": [_shown(Path(path)) for path in fixed_runs],
        }
    )
    report_path = resolve_cli_path(sweep_spec.report)
    write_atomic(report_path, _dump(report))
    score = report.chosen_score
    print(
        f"[Parse Sweep] chosen garbled_ratio={report.chosen.garbled_ratio} min_ruling_paths={report.chosen.min_ruling_paths} "
        f"scanned_max_chars={report.chosen.scanned_max_chars}: dev tier accuracy {score.dev_tier_accuracy:.3f}, "
        f"projected dev {report.metric} {score.dev_projected_recall:.3f} (fixed {report.dev_reference_recall:.3f}); "
        f"test tier accuracy {report.test_split.tier_accuracy:.3f}",
        file=sys.stderr,
    )
    if args.write_config:
        raw = json.loads(cfg_path.read_text(encoding="utf-8"))
        updated = apply_thresholds(raw, report.chosen, _shown(report_path))
        write_atomic(cfg_path, json.dumps(updated, indent=2, ensure_ascii=False) + "\n")
        print(f"[Parse Sweep] wrote the choice to {_shown(cfg_path)}", file=sys.stderr)
    return EXIT_PASS


def main(argv: list[str] | None = None) -> int:
    argv = list(sys.argv[1:] if argv is None else argv)
    if argv[:1] == ["sweep"]:
        sweep_parser = argparse.ArgumentParser(prog="rag_eval.parse_gate sweep", description="Choose the L1 thresholds on the dev split (D-41)")
        sweep_parser.add_argument("--spec", default="eval/config/phase31-parse-gate.json")
        sweep_parser.add_argument("--skip-runs", action="store_true", help="use the forced-tier and fixed runs already on disk")
        sweep_parser.add_argument("--write-config", action="store_true", help="write the choice and thresholds_ref to the routing file")
        return _sweep_cli(sweep_parser.parse_args(argv[1:]))
    parser = argparse.ArgumentParser(prog="rag_eval.parse_gate", description=__doc__.splitlines()[0])
    parser.add_argument("--spec", default="eval/config/phase31-parse-gate.json")
    parser.add_argument("--out", default="eval/reports/phase-03.1")
    parser.add_argument("--skip-runs", action="store_true", help="gate the runs already under run_root instead of running them")
    args = parser.parse_args(argv)
    return _gate(args)


if __name__ == "__main__":
    raise SystemExit(main())
