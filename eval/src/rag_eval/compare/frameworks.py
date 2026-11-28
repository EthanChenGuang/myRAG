"""Paired comparison of the two query-layer frameworks on one golden set (QRY-08, D-40, D-42 c).

LangChain is compared against LlamaIndex (the native default) item by item: paired differences on Recall@k, MRR and the
refusal rates per language, category and language pair with the shared bootstrap of rag_eval.paired, per-transform output
differences read from the traces' query plans (item ids and field names only, never query text), and fused candidate order
differences split into those caused by tied fused scores and real rank differences.
"""

from __future__ import annotations

import argparse
import json
import sys
from collections.abc import Callable
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field, ValidationError
from rag_sidecar.contracts.baseline import PairedStat
from rag_sidecar.contracts.eval_run import RagTrace, TraceCandidate
from rag_sidecar.contracts.report import EvalReport, ItemResult

from rag_eval.paired import (
    METRICS,
    RESAMPLES,
    SEED,
    _slice_members,
    _stat,
    item_metrics,
)
from rag_eval.paths import REPO_ROOT, resolve_cli_path
from rag_eval.traces import load_traces

EXIT_OK = 0
EXIT_INVALID = 2

REFERENCE = "llamaindex"
CANDIDATE = "langchain"
FRAMEWORKS = (REFERENCE, CANDIDATE)
RUN_CONFIGS = {
    REFERENCE: "eval/config/runs/query-layer-llamaindex.json",
    CANDIDATE: "eval/config/runs/query-layer-langchain.json",
}
DEFAULT_WORK = "eval/out/compare-frameworks"
FIXTURE_EMBEDDER_PREFIX = "fixture"
DIGITS = 6
TIE_TOLERANCE = 1e-12

TRANSFORMS = ("condense_history", "normalize_dates", "expand", "hyde", "decompose", "translate")
TRACE_TRANSFORM = {"condense": "condense_history"}
VARIANT_KINDS = {
    "condense_history": ("condensed",),
    "expand": ("expanded",),
    "hyde": ("hyde",),
    "decompose": ("sub_question",),
    "translate": ("translated",),
}
PLAN_FIELDS = {"condense_history": ("standalone",), "normalize_dates": ("date_range",), "decompose": ("sub_questions",)}
VARIANT_ATTRIBUTES = ("text", "language", "sub_question_index", "protected_ok")
ERROR_STATUS = "error"

TRANSLATE_NOTE = (
    "translate is compared as plumbing only: both frameworks render the same shared translate prompt, so a translate "
    "difference shows wiring, not prompt quality."
)
FIXTURE_NOTE = (
    "Fixture numbers reflect the lexical fixture embedder (word and n-gram hashing, not cross-lingual) and the scripted fake "
    "query LLM; they prove the comparison runs and the frameworks agree, not which framework retrieves better. The live "
    "comparison on the real golden set is a separate operator run."
)
TIE_NOTE = (
    "Fused order: LangChain's EnsembleRetriever keeps first-seen order on tied fused scores while the native fusion breaks "
    "ties by chunk id, so tie-order differences are counted apart from rank differences."
)


class ComparisonError(RuntimeError):
    pass


class _Model(BaseModel):
    model_config = ConfigDict(extra="forbid")


class TransformItemDifference(_Model):
    item_id: str
    fields: list[str]


class TransformDifference(_Model):
    transform: str
    n_items: int = Field(ge=0)
    items: list[TransformItemDifference]


class FusedOrderDifferences(_Model):
    compared: int = Field(ge=0)
    identical: int = Field(ge=0)
    tie_only: int = Field(ge=0)
    rank: int = Field(ge=0)
    tie_only_items: list[str] = Field(default_factory=list)
    rank_items: list[str] = Field(default_factory=list)


class RunSummary(_Model):
    framework: str
    items: int = Field(ge=0)
    run_config_hash: str | None
    embedder: str | None


SliceStats = dict[str, PairedStat]


class FrameworkComparison(_Model):
    schema_version: Literal[1] = 1
    reference: Literal["llamaindex"] = REFERENCE
    candidate: Literal["langchain"] = CANDIDATE
    difference: str = f"{CANDIDATE} minus {REFERENCE}, per item"
    seed: int = SEED
    resamples: int = RESAMPLES
    fixture: bool
    runs: list[RunSummary]
    items: int = Field(ge=0)
    all_zero: bool
    overall: SliceStats
    languages: dict[str, SliceStats]
    categories: dict[str, SliceStats]
    language_pairs: dict[str, SliceStats]
    transforms: list[TransformDifference]
    fused_order: FusedOrderDifferences
    problems: list[str] = Field(default_factory=list)
    notes: list[str] = Field(default_factory=list)


@dataclass(frozen=True)
class FrameworkRun:
    framework: str
    items: list[ItemResult]
    traces: list[RagTrace] = field(default_factory=list)
    run_config_hash: str | None = None
    embedder: str | None = None


@dataclass(frozen=True)
class RunRequest:
    name: str
    run_config: dict[str, Any]
    fixture_mode: str
    out_dir: Path


Runner = Callable[[RunRequest], FrameworkRun]


def _round(value: float | None) -> float | None:
    return None if value is None else round(value, DIGITS) + 0.0


def _rounded(stat: PairedStat) -> PairedStat:
    return stat.model_copy(update={key: _round(getattr(stat, key)) for key in ("mean_d", "ci_low", "ci_high")})


def _paired_slices(reference: list[ItemResult], candidate: dict[str, ItemResult]) -> dict[str, SliceStats]:
    slices: dict[str, SliceStats] = {}
    for name, members in sorted(_slice_members(reference).items()):
        stats: SliceStats = {}
        for metric in METRICS:
            differences: list[float] = []
            for item in members:
                observed = item_metrics(candidate[item.item_id])[metric]
                recorded = item_metrics(item)[metric]
                if observed is not None and recorded is not None:
                    differences.append(observed - recorded)
            stats[metric] = _rounded(_stat(differences))
        slices[name] = stats
    return slices


def _variants(plan: dict[str, Any], kind: str) -> list[dict[str, Any]]:
    return [variant for variant in plan.get("variants") or [] if variant.get("kind") == kind]


def _variant_fields(a: list[dict[str, Any]], b: list[dict[str, Any]], kind: str) -> list[str]:
    if len(a) != len(b):
        return [f"variants[{kind}].count"]
    return [
        f"variants[{kind}].{attribute}"
        for attribute in VARIANT_ATTRIBUTES
        if [row.get(attribute) for row in a] != [row.get(attribute) for row in b]
    ]


def _skipped(plan: dict[str, Any], transform: str) -> list[str]:
    return sorted(str(entry.get("reason")) for entry in plan.get("skipped") or [] if entry.get("transform") == transform)


def _statuses(trace: RagTrace, transform: str) -> list[tuple[str, str]]:
    return sorted(
        (str(entry.status), str(entry.reason))
        for entry in trace.query_transforms
        if entry.transform is not None and TRACE_TRANSFORM.get(entry.transform, entry.transform) == transform
    )


def _plan(trace: RagTrace) -> dict[str, Any] | None:
    return None if trace.query_plan is None else trace.query_plan.model_dump(mode="json")


def transform_fields(reference: RagTrace, candidate: RagTrace) -> dict[str, list[str]]:
    """Field names that differ per transform between two traces of one item; never the values."""
    a, b = _plan(reference), _plan(candidate)
    if (a is None) != (b is None):
        return {"query_plan": ["presence"]}
    out: dict[str, list[str]] = {}
    if a is not None and b is not None and a.get("gate") != b.get("gate"):
        out["query_gate"] = ["gate"]
    for transform in TRANSFORMS:
        fields: list[str] = []
        if a is not None and b is not None:
            fields += [name for name in PLAN_FIELDS.get(transform, ()) if a.get(name) != b.get(name)]
            for kind in VARIANT_KINDS.get(transform, ()):
                fields += _variant_fields(_variants(a, kind), _variants(b, kind), kind)
            if _skipped(a, transform) != _skipped(b, transform):
                fields.append("skipped")
        if _statuses(reference, transform) != _statuses(candidate, transform):
            fields.append("status")
        if fields:
            out[transform] = fields
    return out


def _tie_groups(candidates: list[TraceCandidate]) -> list[tuple[float, list[str]]] | None:
    groups: list[tuple[float, list[str]]] = []
    for row in candidates:
        if row.fused_score is None:
            return None
        if groups and abs(row.fused_score - groups[-1][0]) <= TIE_TOLERANCE * max(1.0, abs(groups[-1][0])):
            groups[-1][1].append(row.chunk_id)
        else:
            groups.append((row.fused_score, [row.chunk_id]))
    return [(score, sorted(ids)) for score, ids in groups]


def fused_order_kind(reference: list[TraceCandidate], candidate: list[TraceCandidate]) -> Literal["identical", "tie_only", "rank"]:
    """identical, tie_only (the orders differ only inside groups of equal fused score, the last one possibly cut by top-k) or rank."""
    if [row.chunk_id for row in reference] == [row.chunk_id for row in candidate]:
        return "identical"
    a, b = _tie_groups(reference), _tie_groups(candidate)
    if a is None or b is None or len(a) != len(b) or len(reference) != len(candidate):
        return "rank"
    for index, ((score_a, ids_a), (score_b, ids_b)) in enumerate(zip(a, b)):
        if abs(score_a - score_b) > TIE_TOLERANCE * max(1.0, abs(score_a)) or len(ids_a) != len(ids_b):
            return "rank"
        last = index == len(a) - 1
        if ids_a != ids_b and not (last and len(ids_a) > 1):
            return "rank"
    return "tie_only"


def _run_problems(run: FrameworkRun) -> list[str]:
    problems: list[str] = []
    missing = sum(1 for trace in run.traces if trace.query_plan is None)
    if missing:
        problems.append(f"{run.framework}: {missing} item(s) have no query plan; the comparison needs the query layer on")
    fallback = sum(1 for trace in run.traces if trace.query_plan is not None and trace.query_plan.framework != run.framework)
    if fallback:
        problems.append(f"{run.framework}: {fallback} item(s) ran under another framework (framework fallback)")
    errors: dict[str, int] = {}
    for trace in run.traces:
        failed = {
            TRACE_TRANSFORM.get(entry.transform, entry.transform)
            for entry in trace.query_transforms
            if entry.transform is not None and (entry.status == ERROR_STATUS or entry.reason == ERROR_STATUS)
        }
        if trace.query_plan is not None:
            failed |= {entry.transform for entry in trace.query_plan.skipped if entry.reason == ERROR_STATUS}
        for transform in failed:
            errors[transform] = errors.get(transform, 0) + 1
    for transform, count in sorted(errors.items()):
        problems.append(f"{run.framework}: {transform} skipped with error on {count} item(s)")
    return problems


def compare(reference: FrameworkRun, candidate: FrameworkRun) -> FrameworkComparison:
    ids_a = [item.item_id for item in reference.items]
    ids_b = {item.item_id for item in candidate.items}
    if set(ids_a) != ids_b or len(ids_a) != len(ids_b):
        only_a, only_b = sorted(set(ids_a) - ids_b), sorted(ids_b - set(ids_a))
        raise ComparisonError(
            f"the two runs scored different items ({len(only_a)} only in {reference.framework}, {len(only_b)} only in "
            f"{candidate.framework}); compare runs over the same golden set"
        )
    by_id = {item.item_id: item for item in candidate.items}
    slices = _paired_slices(reference.items, by_id)
    cells = [stat for stats in slices.values() for stat in stats.values()]

    problems = _run_problems(reference) + _run_problems(candidate)
    traces_a = {trace.item_id: trace for trace in reference.traces}
    traces_b = {trace.item_id: trace for trace in candidate.traces}
    transforms: dict[str, list[TransformItemDifference]] = {}
    order = FusedOrderDifferences(compared=0, identical=0, tie_only=0, rank=0)
    untraced = 0
    for item_id in sorted(ids_a):
        a, b = traces_a.get(item_id), traces_b.get(item_id)
        if a is None or b is None:
            untraced += 1
            continue
        for transform, fields in transform_fields(a, b).items():
            transforms.setdefault(transform, []).append(TransformItemDifference(item_id=item_id, fields=fields))
        kind = fused_order_kind(a.candidates, b.candidates)
        order.compared += 1
        if kind == "identical":
            order.identical += 1
        elif kind == "tie_only":
            order.tie_only += 1
            order.tie_only_items.append(item_id)
        else:
            order.rank += 1
            order.rank_items.append(item_id)
    if untraced:
        problems.append(f"{untraced} item(s) have no trace in one of the runs")

    embedders = {run.embedder for run in (reference, candidate)}
    fixture = all(embedder is not None and embedder.startswith(FIXTURE_EMBEDDER_PREFIX) for embedder in embedders)
    order_keys = {name: index for index, name in enumerate(("query_plan", "query_gate", *TRANSFORMS))}
    return FrameworkComparison(
        fixture=fixture,
        runs=[
            RunSummary(framework=run.framework, items=len(run.items), run_config_hash=run.run_config_hash, embedder=run.embedder)
            for run in (reference, candidate)
        ],
        items=len(ids_a),
        all_zero=any(stat.n for stat in cells) and all(stat.n_nonzero == 0 for stat in cells),
        overall=slices["overall"],
        languages={name.split(":", 1)[1]: stats for name, stats in slices.items() if name.startswith("language:")},
        categories={name.split(":", 1)[1]: stats for name, stats in slices.items() if name.startswith("category:")},
        language_pairs={name.split(":", 1)[1]: stats for name, stats in slices.items() if name.startswith("pair:")},
        transforms=[
            TransformDifference(transform=name, n_items=len(rows), items=rows)
            for name, rows in sorted(transforms.items(), key=lambda entry: order_keys[entry[0]])
        ],
        fused_order=order,
        problems=problems,
        notes=[TRANSLATE_NOTE, TIE_NOTE, *([FIXTURE_NOTE] if fixture else [])],
    )


def load_run(directory: Path, framework: str) -> FrameworkRun:
    directory = Path(directory)
    try:
        report = EvalReport.model_validate_json((directory / "report.json").read_text(encoding="utf-8"))
        traces = load_traces(directory / "traces.jsonl")
    except (OSError, ValidationError, ValueError) as exc:
        raise ComparisonError(f"{framework} run in {directory} is unreadable: {exc}") from exc
    return FrameworkRun(
        framework=framework,
        items=list(report.items),
        traces=traces,
        run_config_hash=report.run_config_hash,
        embedder=report.embedder_id,
    )


def default_runner(request: RunRequest) -> FrameworkRun:
    """One in-process fixture run through eval/harness/run-smoke.mts (fake edge, fake query LLM, PGlite)."""
    from rag_eval import phase_compare

    output = phase_compare.default_runner(
        phase_compare.RunRequest(
            name=request.name, run_config=request.run_config, fixture_mode=request.fixture_mode, out_dir=request.out_dir
        )
    )
    return FrameworkRun(
        framework=request.name,
        items=list(output.report.items),
        traces=output.traces,
        run_config_hash=output.report.run_config_hash,
        embedder=output.report.embedder_id,
    )


def _fmt(value: float | None) -> str:
    return "n/a" if value is None else f"{value:+.4f}"


def _cell(stat: PairedStat) -> str:
    if stat.n == 0:
        return "n=0"
    return f"{_fmt(stat.mean_d)} [{_fmt(stat.ci_low)}, {_fmt(stat.ci_high)}] n={stat.n} nz={stat.n_nonzero}"


def _slice_table(title: str, rows: dict[str, SliceStats]) -> list[str]:
    lines = [f"## {title}", "", "| slice | " + " | ".join(METRICS) + " |", "|---|" + "---|" * len(METRICS)]
    for name, stats in rows.items():
        lines.append(f"| {name} | " + " | ".join(_cell(stats[metric]) for metric in METRICS) + " |")
    return [*lines, ""]


def render_markdown(report: FrameworkComparison) -> str:
    lines = ["# Query-layer framework comparison: LangChain against LlamaIndex", ""]
    lines += [f"> {note}" for note in report.notes]
    lines += [
        "",
        (
            f"Paired difference: {report.difference}, on {report.items} items. Each cell is the mean difference with its 95% "
            f"bootstrap interval (seed {report.seed}, {report.resamples} resamples), the paired item count n and the count "
            "of items whose value differs (nz)."
        ),
        "",
        f"All paired differences zero: {'yes' if report.all_zero else 'no'}.",
        "",
        "| run | items | run config hash | embedder |",
        "|---|---|---|---|",
    ]
    lines += [f"| {run.framework} | {run.items} | `{(run.run_config_hash or 'n/a')[:12]}` | {run.embedder or 'n/a'} |" for run in report.runs]
    lines.append("")
    lines += _slice_table("Overall", {"overall": report.overall})
    lines += _slice_table("Per language", report.languages)
    lines += _slice_table("Per category", report.categories)
    lines += _slice_table("Per language pair (query language -> evidence language)", report.language_pairs)
    lines += ["## Per-transform output differences", ""]
    if not report.transforms:
        lines += ["No transform output differs between the frameworks.", ""]
    else:
        lines += ["| transform | items | item ids and differing fields |", "|---|---|---|"]
        for entry in report.transforms:
            detail = "; ".join(f"{row.item_id}: {', '.join(row.fields)}" for row in entry.items)
            lines.append(f"| {entry.transform} | {entry.n_items} | {detail} |")
        lines.append("")
    order = report.fused_order
    lines += [
        "## Fused candidate order",
        "",
        (
            f"Compared {order.compared} items: {order.identical} identical, {order.tie_only} differ only by tie order, "
            f"{order.rank} differ by rank."
        ),
        "",
    ]
    if order.tie_only_items:
        lines += [f"Tie order only: {', '.join(order.tie_only_items)}", ""]
    if order.rank_items:
        lines += [f"Rank differences: {', '.join(order.rank_items)}", ""]
    lines += ["## Problems", ""]
    lines += [f"- {problem}" for problem in report.problems] if report.problems else ["None."]
    return "\n".join(lines).rstrip() + "\n"


def _write_text(path: Path, text: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(path.name + ".tmp")
    tmp.write_text(text, encoding="utf-8")
    tmp.replace(path)


def _run_config(framework: str) -> dict[str, Any]:
    path = REPO_ROOT / RUN_CONFIGS[framework]
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise ComparisonError(f"run config {RUN_CONFIGS[framework]} is unreadable: {exc}") from exc
    if not isinstance(payload, dict):
        raise ComparisonError(f"run config {RUN_CONFIGS[framework]} must be a JSON object")
    return payload


def main(argv: list[str] | None = None, runner: Runner | None = None) -> int:
    parser = argparse.ArgumentParser(prog="rag_eval.compare frameworks", description="Paired LlamaIndex vs LangChain comparison (D-40)")
    source = parser.add_mutually_exclusive_group(required=True)
    source.add_argument("--fixtures", action="store_true", help="run both query-layer run configs in-process on the fixture corpus")
    source.add_argument("--llamaindex", type=Path, help="an existing run directory (report.json, traces.jsonl) under llamaindex")
    parser.add_argument("--langchain", type=Path, help="the matching run directory under langchain (with --llamaindex)")
    parser.add_argument("--fixture-mode", choices=("prechunked", "ingest"), default="prechunked")
    parser.add_argument("--work", type=Path, default=Path(DEFAULT_WORK), help=f"harness output directory for --fixtures (default {DEFAULT_WORK})")
    parser.add_argument("--out", required=True, type=Path)
    args = parser.parse_args(argv)
    if args.llamaindex is not None and args.langchain is None:
        parser.error("--llamaindex needs --langchain")
    if args.fixtures and args.langchain is not None:
        parser.error("--langchain goes with --llamaindex, not --fixtures")

    try:
        if args.fixtures:
            run = runner or default_runner
            work = resolve_cli_path(args.work)
            runs = {}
            for framework in FRAMEWORKS:
                print(f"[Compare Frameworks] run {framework} ({args.fixture_mode})", file=sys.stderr)
                runs[framework] = run(
                    RunRequest(name=framework, run_config=_run_config(framework), fixture_mode=args.fixture_mode, out_dir=work / framework)
                )
        else:
            runs = {
                REFERENCE: load_run(resolve_cli_path(args.llamaindex), REFERENCE),
                CANDIDATE: load_run(resolve_cli_path(args.langchain), CANDIDATE),
            }
        report = compare(runs[REFERENCE], runs[CANDIDATE])
    except (ComparisonError, RuntimeError) as exc:
        print(f"error: {exc}", file=sys.stderr)
        return EXIT_INVALID

    out = resolve_cli_path(args.out)
    _write_text(out / "report.json", report.model_dump_json(indent=2) + "\n")
    _write_text(out / "report.md", render_markdown(report))
    order = report.fused_order
    print(
        f"frameworks: {'ALL ZERO' if report.all_zero else 'DIFFERENCES PRESENT'}; {len(report.transforms)} transform(s) differ; "
        f"fused order {order.tie_only} tie-only, {order.rank} rank; {len(report.problems)} problem(s)"
    )
    for problem in report.problems:
        print(f"problem: {problem}", file=sys.stderr)
    return EXIT_INVALID if report.problems else EXIT_OK


if __name__ == "__main__":
    raise SystemExit(main())
