from __future__ import annotations

import argparse
import hashlib
import json
import math
import os
import sys
from collections.abc import Callable, Mapping, Sequence
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

from pydantic import ValidationError
from rag_sidecar.contracts.baseline import NoiseConfig
from rag_sidecar.contracts.eval_run import RagTrace
from rag_sidecar.contracts.golden import GoldenItem
from rag_sidecar.contracts.report import ItemResult
from rag_sidecar.contracts.retrieval import (
    ChunkingDecision,
    ChunkingGateRegression,
    ChunkingMetricValue,
    ChunkingProfile,
    ChunkingProfileGate,
    ChunkingProfileMetrics,
    ChunkingSliceMetrics,
    ChunkingSweepProfileEntry,
    ChunkingSweepReport,
    ConfigProvenance,
    RetrievalParams,
    chunking_profile_findings,
)

from rag_eval.bounds import upper_bound
from rag_eval.config_files import finalize_config
from rag_eval.golden_io import load_golden
from rag_eval.harness_runner import HarnessError, HarnessRun, run_harness
from rag_eval.metrics import CLAUSE_TAG, GENERAL_DOC_TYPE, question_kind, score_items
from rag_eval.paired import _slice_members, item_metrics
from rag_eval.paths import REPO_ROOT, resolve_cli_path
from rag_eval.split import assign_split
from rag_eval.sweep.retrieval import NOISE_PATH, PARAMS_PATH, noise_band

LEGACY_ID = "legacy"
FIXTURE_MODE = "ingest"
REPORT_NAME = "chunking-sweep.json"
MARKDOWN_NAME = "chunking-sweep.md"
CELLS_DIR = "chunking-cells"
DEFAULT_GOLDEN = (
    REPO_ROOT / "eval" / "fixtures" / "golden.jsonl",
    REPO_ROOT / "eval" / "fixtures" / "ingest" / "golden-ingest.jsonl",
)
INGEST_MANIFEST = REPO_ROOT / "eval" / "fixtures" / "ingest" / "manifest.json"
DECISIONS_DIR = REPO_ROOT / "eval" / "decisions" / "chunking"
INDEX_NAME = "index.json"
GENERATION_STAGE = "generation"
CLAUSE_SLICE = "clause"
PARENT_CHILD_ENV = {"RAG_PARENT_CHILD": "true"}
GATED_PREFIXES = ("overall", "language:")
KNOWN_PRESETS = frozenset({"128/512", "256/1024", "256/2048"})
DEFAULT_K = 10
MAX_CHILD_TOKENS = 8191
DEFAULT_CONTEXT_BUDGET = 6000
EPSILON = 1e-9
JUDGE_KEYS = ("OPENROUTER_API_KEY", "OPENAI_API_KEY")
CHOSEN_METRICS = ("recall_at_k", "mrr", "correct_refusal_rate", "false_refusal_rate", "context_tokens", "latency_p95_ms")
CLAUSE_CHOSEN_METRICS = ("recall_at_k", "mrr", "context_tokens")

EXIT_OK = 0
EXIT_USAGE = 2
EXIT_HARNESS = 3

FIXTURE_NOTE = (
    "Fixture run: the numbers prove the mechanism (seeded profiles, dual-write, override, gate); "
    "the live sweep decides real profiles."
)
SCOPE_NOTE = (
    "Scope: dev split only; the test split is never read (D-14). Mode: ingest fixture, compared with the legacy profile "
    "built in the same mode (D-21)."
)
CLAUSE_NOTE = "Question kind 'clause' is the clause-tagged subset of context_heavy, reported on its own."

JudgeOutcome = tuple[dict[str, float] | None, str | None]
JudgeFn = Callable[[HarnessRun, list[GoldenItem]], JudgeOutcome]
Runner = Callable[..., HarnessRun]


class ChunkingUsageError(Exception):
    pass


@dataclass(frozen=True)
class Preset:
    child_tokens: int
    parent_tokens: int
    preset: str
    slug: str


def parse_presets(text: str) -> list[Preset]:
    presets: list[Preset] = []
    seen: set[tuple[int, int]] = set()
    for part in (piece.strip() for piece in text.split(",")):
        if not part:
            continue
        pieces = part.split("/")
        if len(pieces) != 2:
            raise ChunkingUsageError(f"preset {part!r} must be child/parent tokens, e.g. 256/1024")
        try:
            child, parent = int(pieces[0]), int(pieces[1])
        except ValueError as exc:
            raise ChunkingUsageError(f"preset {part!r} must be two integers") from exc
        if child < 1 or parent < child * 2:
            raise ChunkingUsageError(f"preset {part!r}: the parent must be at least twice the child")
        if (child, parent) in seen:
            raise ChunkingUsageError(f"preset {part!r} is listed twice")
        seen.add((child, parent))
        label = f"{child}/{parent}"
        presets.append(Preset(child, parent, label if label in KNOWN_PRESETS else "custom", f"p{child}-{parent}"))
    if not presets:
        raise ChunkingUsageError("--presets needs at least one child/parent preset")
    return presets


def ingest_doc_types(manifest_path: Path = INGEST_MANIFEST) -> dict[str, str]:
    """Filename -> doc_type of the typed ingest fixtures; corpus documents are ingested as general."""
    payload = json.loads(Path(manifest_path).read_text(encoding="utf-8"))
    return {Path(entry["path"]).name: entry["doc_type"] for entry in payload["fixtures"]}


def _profiles_for(preset: Preset, doc_types: Sequence[str]) -> list[ChunkingProfile]:
    return [
        ChunkingProfile(
            id=f"{preset.slug}-{doc_type}",
            doc_type=doc_type,
            child_tokens=preset.child_tokens,
            parent_mode="structure",
            parent_tokens=preset.parent_tokens,
            status="building",
            preset=preset.preset,
        )
        for doc_type in doc_types
    ]


def _metric(values: list[float], *, bound: bool = False) -> ChunkingMetricValue:
    if not values:
        return ChunkingMetricValue(value=None, n=0, upper_95=None)
    hits = sum(1 for value in values if value >= 1.0)
    return ChunkingMetricValue(
        value=math.fsum(values) / len(values),
        n=len(values),
        upper_95=upper_bound(hits, len(values)) if bound else None,
    )


def _nearest_rank(values: list[float], quantile: float) -> float:
    ordered = sorted(values)
    return ordered[max(1, math.ceil(quantile * len(ordered))) - 1]


def _latency(trace: RagTrace) -> float | None:
    values = [
        value
        for stage, value in trace.stage_latency_ms.items()
        if stage != GENERATION_STAGE and math.isfinite(value) and value >= 0
    ]
    return math.fsum(values) if values else None


def _context_tokens(trace: RagTrace) -> float:
    return float(trace.context_tokens) if trace.context_tokens is not None else len(trace.context) / 4


def _recall(result: ItemResult, k: int) -> float:
    hit = result.spans_hit_at_5 if k == 5 else result.spans_hit_at_10
    return hit / result.span_count


def _slice_metrics(
    results: list[ItemResult], traces: Mapping[str, RagTrace], judge_scores: Mapping[str, float] | None, k: int
) -> ChunkingSliceMetrics:
    answerable = [r for r in results if r.answerable]
    unanswerable = [r for r in results if not r.answerable]
    latencies = [value for value in (_latency(traces[r.item_id]) for r in results) if value is not None]
    judged = [judge_scores[r.item_id] for r in results if judge_scores is not None and r.item_id in judge_scores]
    return ChunkingSliceMetrics(
        recall_at_k=_metric([_recall(r, k) for r in answerable]),
        mrr=_metric([1 / r.first_hit_rank if r.first_hit_rank else 0.0 for r in answerable]),
        correct_refusal_rate=_metric([1.0 if r.refused else 0.0 for r in unanswerable], bound=True),
        false_refusal_rate=_metric([1.0 if r.refused else 0.0 for r in answerable], bound=True),
        judge_correctness=_metric(judged),
        judge_skipped=judge_scores is None,
        context_tokens=_metric([_context_tokens(traces[r.item_id]) for r in results]),
        latency_p50_ms=ChunkingMetricValue(value=_nearest_rank(latencies, 0.5) if latencies else None, n=len(latencies)),
        latency_p95_ms=ChunkingMetricValue(value=_nearest_rank(latencies, 0.95) if latencies else None, n=len(latencies)),
    )


def _group(results: list[ItemResult], key: Callable[[ItemResult], str]) -> dict[str, list[ItemResult]]:
    groups: dict[str, list[ItemResult]] = {}
    for result in results:
        groups.setdefault(key(result), []).append(result)
    return dict(sorted(groups.items()))


def profile_metrics(
    results: list[ItemResult],
    traces: Sequence[RagTrace],
    golden: Sequence[GoldenItem],
    judge_scores: Mapping[str, float] | None,
    k: int = DEFAULT_K,
) -> ChunkingProfileMetrics:
    by_trace = {trace.item_id: trace for trace in traces if trace.item_id is not None}
    clause_ids = {item.id for item in golden if CLAUSE_TAG in item.tags}

    def build(members: list[ItemResult]) -> ChunkingSliceMetrics:
        return _slice_metrics(members, by_trace, judge_scores, k)

    kinds = {
        name: build(members)
        for name, members in _group(results, lambda r: r.question_kind or question_kind(r.category, [])).items()
    }
    clause = [r for r in results if r.item_id in clause_ids]
    if clause:
        kinds[CLAUSE_SLICE] = build(clause)
    return ChunkingProfileMetrics(
        overall=build(results),
        by_doc_type={name: build(m) for name, m in _group(results, lambda r: r.doc_type or GENERAL_DOC_TYPE).items()},
        by_language={name: build(m) for name, m in _group(results, lambda r: r.language).items()},
        by_question_kind=dict(sorted(kinds.items())),
    )


def _item_values(result: ItemResult, k: int) -> dict[str, float | None]:
    values = item_metrics(result)
    values[f"recall_at_{k}"] = _recall(result, k) if result.answerable else None
    return values


def _gated(slice_name: str) -> bool:
    return any(slice_name == p if not p.endswith(":") else slice_name.startswith(p) for p in GATED_PREFIXES)


def gate_against_legacy(
    candidate: list[ItemResult], legacy: list[ItemResult], noise: NoiseConfig, k: int = DEFAULT_K
) -> ChunkingProfileGate:
    """Paired item differences (candidate - legacy) on the overall and language slices; a mean worse than the noise band regresses."""
    band = noise_band(noise)
    baseline = {result.item_id: _item_values(result, k) for result in legacy}
    directions = {f"recall_at_{k}": noise.metrics.get(f"recall_at_{k}", "higher")}
    for metric in ("mrr", "correct_refusal_rate", "false_refusal_rate"):
        directions[metric] = noise.metrics.get(metric, "lower" if metric == "false_refusal_rate" else "higher")
    regressions: list[ChunkingGateRegression] = []
    for slice_name, members in sorted(_slice_members(candidate).items()):
        if not _gated(slice_name):
            continue
        for metric, direction in directions.items():
            diffs: list[float] = []
            for result in members:
                observed = _item_values(result, k)[metric]
                recorded = baseline.get(result.item_id, {}).get(metric)
                if observed is None or recorded is None:
                    continue
                diffs.append(observed - recorded)
            if not diffs:
                continue
            mean = math.fsum(diffs) / len(diffs)
            worse = mean < -band - EPSILON if direction == "higher" else mean > band + EPSILON
            if worse:
                regressions.append(ChunkingGateRegression(slice=slice_name, metric=metric, diff=mean, band=band))
    return ChunkingProfileGate(baseline_profile_id=LEGACY_ID, passed=not regressions, regressions=regressions)


def default_judge(run: HarnessRun, items: list[GoldenItem]) -> JudgeOutcome:
    missing = [name for name in JUDGE_KEYS if not os.environ.get(name)]
    if missing:
        return None, f"Judge answer correctness skipped: judge key not configured ({', '.join(missing)} not set)."
    return None, (
        "Judge answer correctness skipped: the smoke harness traces carry no generated answers; "
        "judge correctness runs in the nightly tier (rag_eval.judge.run)."
    )


def _require_dev_only(items: Sequence[GoldenItem]) -> None:
    leaked = [item.id for item in items if assign_split(item.id) != "dev" or item.split != "dev"]
    if leaked:
        raise ChunkingUsageError(f"the harness golden file carries non-dev items: {', '.join(sorted(leaked)[:5])}")


def _load_json_object(path: Path, what: str) -> dict[str, Any]:
    try:
        payload = json.loads(Path(path).read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise ChunkingUsageError(f"{what} {path} is unreadable: {exc}") from exc
    if not isinstance(payload, dict):
        raise ChunkingUsageError(f"{what} {path} must be a JSON object")
    return payload


def _top_k(config: Mapping[str, Any], params_path: Path) -> int:
    overrides = config.get("overrides") or {}
    if isinstance(overrides.get("final_top_k"), int):
        return overrides["final_top_k"]
    path = Path(params_path)
    params = RetrievalParams.model_validate_json(path.read_text(encoding="utf-8")) if path.is_file() else RetrievalParams()
    return params.final_top_k


def _context_budget(config: Mapping[str, Any]) -> int:
    raw = (config.get("env") or {}).get("RAG_CONTEXT_TOKEN_BUDGET")
    try:
        return int(raw) if raw else DEFAULT_CONTEXT_BUDGET
    except ValueError:
        return DEFAULT_CONTEXT_BUDGET


def _write_text(path: Path, text: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(path.name + ".tmp")
    tmp.write_text(text, encoding="utf-8")
    os.replace(tmp, path)


def _stable_json(payload: object) -> str:
    return json.dumps(payload, sort_keys=True, indent=2, ensure_ascii=False) + "\n"


def run_chunking_sweep(
    run_config: Path,
    presets: Sequence[Preset],
    out: Path,
    runner: Runner = run_harness,
    judge: JudgeFn | None = None,
    golden: Path | Sequence[Path] = DEFAULT_GOLDEN,
    doc_types: Mapping[str, str] | None = None,
    k: int = DEFAULT_K,
    noise_path: Path = NOISE_PATH,
    params_path: Path = PARAMS_PATH,
    work_dir: Path | None = None,
) -> ChunkingSweepReport:
    if k not in (5, 10):
        raise ChunkingUsageError("--k must be 5 or 10 (the item results carry recall at 5 and 10)")
    if not presets:
        raise ChunkingUsageError("no preset to sweep")
    try:
        noise = NoiseConfig.model_validate_json(Path(noise_path).read_text(encoding="utf-8"))
    except (OSError, ValidationError, ValueError) as exc:
        raise ChunkingUsageError(f"noise config {noise_path} is unreadable: {exc}") from exc
    config = _load_json_object(run_config, "run-config")
    if "chunking_profiles" in config:
        raise ChunkingUsageError("the base run-config must not carry chunking_profiles; the sweep seeds them per preset")
    if (config.get("env") or {}).get("RAG_PIPELINE") != "v2":
        raise ChunkingUsageError("the base run-config must set RAG_PIPELINE=v2 (ingestion dual-write runs only under v2)")
    type_map = dict(doc_types) if doc_types is not None else ingest_doc_types()
    swept_types = sorted(set(type_map.values()) | {GENERAL_DOC_TYPE})
    judge_fn = judge or default_judge
    top_k = _top_k(config, params_path)
    budget = _context_budget(config)
    cells = Path(work_dir) if work_dir is not None else Path(out) / CELLS_DIR

    notes: list[str] = [
        FIXTURE_NOTE,
        SCOPE_NOTE,
        CLAUSE_NOTE,
        (
            f"Recall@k uses k={k}. Gate: paired differences against legacy on the overall and language slices, "
            f"band {noise_band(noise):.4f}. All runs use the base env plus RAG_PARENT_CHILD=true."
        ),
    ]
    plans: list[tuple[str, list[ChunkingProfile] | None]] = [(LEGACY_ID, None)]
    for preset in presets:
        profiles = _profiles_for(preset, swept_types)
        _, warnings = chunking_profile_findings(
            profiles[0].model_dump(), {"max_child_tokens": MAX_CHILD_TOKENS, "top_k": top_k, "context_budget": budget}
        )
        if warnings:
            notes.append(
                f"{preset.slug} validator warnings: {', '.join(warnings)} "
                f"(top-k {top_k} x parent {preset.parent_tokens} = {top_k * preset.parent_tokens} vs context budget {budget})."
            )
        plans.append((preset.slug, profiles))

    entries: list[ChunkingSweepProfileEntry] = []
    legacy_results: list[ItemResult] = []
    golden_ids: set[tuple[str, ...]] = set()
    for profile_id, profiles in plans:
        overrides = {"chunking_profile_by_doc_type": {p.doc_type: p.id for p in profiles}} if profiles else None
        run = runner(
            run_config=Path(run_config),
            golden=golden,
            out=cells / profile_id,
            overrides=overrides,
            fixture_mode=FIXTURE_MODE,
            env_overlay=dict(PARENT_CHILD_ENV),
            chunking_profiles=[p.model_dump(mode="json") for p in profiles] if profiles else None,
        )
        items = load_golden(run.golden_path)
        _require_dev_only(items)
        golden_ids.add(tuple(sorted(item.id for item in items)))
        results = score_items(run.traces, items, doc_types=type_map)
        if profiles is None:
            legacy_results = results
        scores, notice = judge_fn(run, items)
        if notice and notice not in notes:
            notes.append(notice)
        entries.append(
            ChunkingSweepProfileEntry(
                profile_id=profile_id,
                metrics=profile_metrics(results, run.traces, items, scores, k),
                gate=None if profiles is None else gate_against_legacy(results, legacy_results, noise, k),
            )
        )
    if len(golden_ids) != 1:
        raise ChunkingUsageError("the profile runs did not all score the same dev golden items")

    draft = ChunkingSweepReport(profiles=entries, notes=notes, provenance=ConfigProvenance(source="fixture"))
    report = finalize_config(draft, provenance_source="fixture")
    out_dir = Path(out)
    _write_text(out_dir / REPORT_NAME, _stable_json(report.model_dump(mode="json")))
    _write_text(out_dir / MARKDOWN_NAME, render_markdown(report))
    return report


def _fmt(metric: ChunkingMetricValue, *, digits: int = 3, upper: bool = False) -> str:
    if metric.value is None:
        return "-"
    text = f"{metric.value:.{digits}f}"
    if upper and metric.upper_95 is not None:
        text += f" (<= {metric.upper_95:.3f})"
    return f"{text} n={metric.n}"


def _slice_table(title: str, rows: list[tuple[str, str, ChunkingSliceMetrics]]) -> list[str]:
    lines = [
        f"## {title}",
        "",
        "| Profile | Slice | Recall@k | MRR | Correct refusal (upper) | False refusal (upper) | Judge | Context tokens | Latency p50 / p95 ms |",
        "| --- | --- | --- | --- | --- | --- | --- | --- | --- |",
    ]
    for profile_id, slice_name, m in rows:
        judge = "skipped" if m.judge_skipped else _fmt(m.judge_correctness)
        latency = "-" if m.latency_p50_ms.value is None else f"{m.latency_p50_ms.value:.1f} / {m.latency_p95_ms.value:.1f}"
        lines.append(
            f"| {profile_id} | {slice_name} | {_fmt(m.recall_at_k)} | {_fmt(m.mrr)} | "
            f"{_fmt(m.correct_refusal_rate, upper=True)} | {_fmt(m.false_refusal_rate, upper=True)} | {judge} | "
            f"{_fmt(m.context_tokens, digits=1)} | {latency} |"
        )
    lines.append("")
    return lines


def render_markdown(report: ChunkingSweepReport) -> str:
    lines = ["# Chunking sweep", "", f"Source: {report.provenance.source}; config hash {report.config_hash}", ""]
    lines.extend(f"- {note}" for note in report.notes)
    lines.extend(["", "## Gate against legacy", "", "| Profile | Gate | Regressions |", "| --- | --- | --- |"])
    for entry in report.profiles:
        if entry.gate is None:
            lines.append(f"| {entry.profile_id} | baseline | - |")
            continue
        named = "; ".join(f"{r.slice} {r.metric} {r.diff:+.4f} (band {r.band:.4f})" for r in entry.gate.regressions)
        lines.append(f"| {entry.profile_id} | {'passed' if entry.gate.passed else 'failed'} | {named or 'none'} |")
    lines.append("")
    lines.extend(_slice_table("Overall", [(e.profile_id, "overall", e.metrics.overall) for e in report.profiles]))
    for title, attr in (("By document type", "by_doc_type"), ("By language", "by_language"), ("By question kind", "by_question_kind")):
        names = sorted({name for e in report.profiles for name in getattr(e.metrics, attr)})
        rows = [
            (e.profile_id, name, getattr(e.metrics, attr)[name])
            for name in names
            for e in report.profiles
            if name in getattr(e.metrics, attr)
        ]
        lines.extend(_slice_table(title, rows))
    return "\n".join(lines).rstrip("\n") + "\n"


def _chosen_on(entry: ChunkingSweepProfileEntry, doc_type: str) -> dict[str, float]:
    metrics = entry.metrics
    picked: dict[str, float] = {}
    sources = (
        ("", metrics.by_doc_type[doc_type], CHOSEN_METRICS),
        ("overall_", metrics.overall, CHOSEN_METRICS),
        ("clause_", metrics.by_question_kind.get(CLAUSE_SLICE), CLAUSE_CHOSEN_METRICS),
    )
    for prefix, slice_metrics, names in sources:
        if slice_metrics is None:
            continue
        for name in names:
            value = getattr(slice_metrics, name).value
            if value is not None:
                picked[f"{prefix}{name}"] = value
    return picked


def _write_index(out_dir: Path) -> None:
    decisions = [
        ChunkingDecision.model_validate_json(path.read_text(encoding="utf-8"))
        for path in sorted(out_dir.glob("*.json"))
        if path.name != INDEX_NAME
    ]
    payload = [d.model_dump(mode="json") for d in sorted(decisions, key=lambda d: d.doc_type)]
    _write_text(out_dir / INDEX_NAME, _stable_json(payload))


def _previous_recorded_at(target: Path, fields: dict[str, Any]) -> str | None:
    if not target.is_file():
        return None
    try:
        existing = ChunkingDecision.model_validate_json(target.read_text(encoding="utf-8"))
        candidate = ChunkingDecision.model_validate({**fields, "recorded_at": existing.recorded_at})
    except (OSError, ValidationError, ValueError):
        return None
    return existing.recorded_at if existing == candidate else None


def decide_chunking_profile(
    report: Path,
    doc_type: str,
    profile_id: str,
    decided_by: str,
    out_dir: Path = DECISIONS_DIR,
    recorded_at: str | None = None,
) -> ChunkingDecision:
    report_path = Path(report)
    try:
        raw = report_path.read_bytes()
        sweep = ChunkingSweepReport.model_validate_json(raw)
    except (OSError, ValidationError, ValueError) as exc:
        raise ChunkingUsageError(f"report {report_path} is not a readable ChunkingSweepReport: {exc}") from exc
    entry = next((e for e in sweep.profiles if e.profile_id == profile_id), None)
    if entry is None:
        known = ", ".join(e.profile_id for e in sweep.profiles)
        raise ChunkingUsageError(f"profile {profile_id!r} is not in the report ({known})")
    if doc_type not in entry.metrics.by_doc_type:
        raise ChunkingUsageError(f"the report has no {doc_type} slice for {profile_id}")
    if profile_id != LEGACY_ID and (entry.gate is None or not entry.gate.passed):
        named = ", ".join(f"{r.slice} {r.metric}" for r in (entry.gate.regressions if entry.gate else []))
        raise ChunkingUsageError(
            f"profile {profile_id} failed its gate against legacy ({named or 'no gate'}); only a passing candidate or legacy can be decided"
        )
    out_path = Path(out_dir)
    target = out_path / f"{doc_type}.json"
    fields: dict[str, Any] = {
        "doc_type": doc_type,
        "profile_id": LEGACY_ID if profile_id == LEGACY_ID else f"{profile_id}-{doc_type}",
        "chosen_on": _chosen_on(entry, doc_type),
        "gate_passed": True if entry.gate is None else entry.gate.passed,
        "regressions": [] if entry.gate is None else [r.model_dump() for r in entry.gate.regressions],
        "build_run_id": None,
        "report_hash": hashlib.sha256(raw).hexdigest(),
        "decided_by": decided_by,
        "source": "live" if sweep.provenance.source == "live" else "fixture",
    }
    stamp = recorded_at or _previous_recorded_at(target, fields) or datetime.now(UTC).date().isoformat()
    try:
        decision = ChunkingDecision.model_validate({**fields, "recorded_at": stamp})
    except ValidationError as exc:
        raise ChunkingUsageError(f"the decision is not a valid ChunkingDecision: {exc}") from exc
    _write_text(target, _stable_json(decision.model_dump(mode="json")))
    _write_index(out_path)
    return decision


def chunking_command(args: argparse.Namespace) -> int:
    try:
        report = run_chunking_sweep(
            resolve_cli_path(args.run_config),
            parse_presets(args.presets),
            resolve_cli_path(args.out),
            golden=[resolve_cli_path(path) for path in args.golden] if args.golden else DEFAULT_GOLDEN,
            k=args.k,
        )
    except ChunkingUsageError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return EXIT_USAGE
    except HarnessError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return EXIT_HARNESS
    gates = ", ".join(f"{e.profile_id}={'pass' if e.gate.passed else 'fail'}" for e in report.profiles if e.gate is not None)
    print(f"[Chunking Sweep] {len(report.profiles)} profiles; gate {gates}; wrote {REPORT_NAME} and {MARKDOWN_NAME}")
    return EXIT_OK


def decide_command(args: argparse.Namespace) -> int:
    try:
        decision = decide_chunking_profile(
            resolve_cli_path(args.report),
            args.doc_type,
            args.profile,
            args.decided_by,
            resolve_cli_path(args.out_dir),
            recorded_at=args.recorded_at,
        )
    except ChunkingUsageError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return EXIT_USAGE
    print(f"[Chunking Sweep] recorded {decision.doc_type} -> {decision.profile_id} (gate passed: {decision.gate_passed})")
    return EXIT_OK


def register(commands: Any) -> None:
    sweep = commands.add_parser(
        "chunking", help="compare candidate chunking presets with legacy in the ingest fixture mode (dev split)"
    )
    sweep.add_argument("--run-config", required=True, type=Path)
    sweep.add_argument(
        "--presets", required=True, help="comma-separated child/parent token presets, e.g. 128/512,256/1024,256/2048"
    )
    sweep.add_argument("--out", required=True, type=Path)
    sweep.add_argument(
        "--golden", action="append", type=Path, default=None, help="golden file (repeatable); default: the two ingest-mode golden files"
    )
    sweep.add_argument("--k", type=int, default=DEFAULT_K, choices=(5, 10))
    sweep.set_defaults(handler=chunking_command)

    decide = commands.add_parser("chunking-decide", help="record the chosen chunking profile of one doc type from a sweep report")
    decide.add_argument("--report", required=True, type=Path)
    decide.add_argument("--doc-type", required=True)
    decide.add_argument("--profile", required=True, help="a report profile id (a preset slug such as p256-1024, or legacy)")
    decide.add_argument("--decided-by", required=True)
    decide.add_argument("--out-dir", type=Path, default=DECISIONS_DIR)
    decide.add_argument("--recorded-at", default=None)
    decide.set_defaults(handler=decide_command)
