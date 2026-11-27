"""TPL-09 header A/B check (plan 03.3-26; the must-check of handoffs/03.3-25-requirement-TPL-09.md, decision D-26).

`python -m rag_eval.header_ab_check --header-on <run dir> --header-off <run dir> --out <dir>` compares two finished harness runs
that differ only in RAG_ATTRIBUTE_HEADER. Each run directory holds report.json, traces.jsonl and run.json. As in the phase gate
no_other_slice_drop, templated_collection items are left out and the header-off run is the reference: a retrieval metric of a
slice falls when the header-on value is below the reference minus the noise band (eval/config/noise.json).

Verdicts and exit codes:
- holds (0): neither the target slice (default category:cache_near_miss, recall_at_5) nor any other slice falls beyond the band;
- reopen_d26 (1): the target slice or another non-templated slice falls beyond the band (D-26 is reopened: header lexical-only);
- missing_data (2): the runs cannot be compared (different golden manifests, fewer than --min-items target items, or, with
  --population real, a run that is not a live run on real items); nothing passes vacuously.
header-ab.json and header-ab.md hold numbers, slice names, codes and counts only. Item ids are listed only with --population
fixture; no question, chunk text, document name or tenant value is ever written.
"""

from __future__ import annotations

import argparse
import math
import sys
from pathlib import Path
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field
from rag_sidecar.contracts.baseline import NoiseConfig

from rag_eval.metrics import TEMPLATED_CATEGORY
from rag_eval.paired import _bootstrap_interval, item_metrics
from rag_eval.paths import REPO_ROOT, resolve_cli_path
from rag_eval.phase33_gate import (
    InputError,
    aligned_reference,
    read_run,
    without_categories,
)
from rag_eval.phase_compare import RETRIEVAL_METRICS, RunOutput, no_slice_drop_check
from rag_eval.traces import load_manifest

EXIT_HOLDS, EXIT_REOPEN, EXIT_MISSING, EXIT_INTERNAL = 0, 1, 2, 70
JSON_NAME, MARKDOWN_NAME = "header-ab.json", "header-ab.md"
DEFAULT_NOISE = REPO_ROOT / "eval" / "config" / "noise.json"
DEFAULT_SLICE = "category:cache_near_miss"
DEFAULT_METRIC = "recall_at_5"
DEFAULT_MIN_ITEMS = 10
REAL_POPULATIONS = frozenset({"real", "production"})
LIVE_TIER = "live"

Verdict = Literal["holds", "reopen_d26", "missing_data"]


class TargetSlice(BaseModel):
    model_config = ConfigDict(extra="forbid")

    slice: str
    metric: str
    header_on: float | None = None
    header_off: float | None = None
    n_on: int = 0
    n_off: int = 0
    threshold: float | None = None
    dropped: bool | None = None
    paired_mean_difference: float | None = None
    paired_interval: list[float] | None = None
    worsened: int = 0
    improved: int = 0


class HeaderAbResult(BaseModel):
    model_config = ConfigDict(extra="forbid")

    schema_version: Literal[1] = 1
    decision: Literal["D-26"] = "D-26"
    requirement: Literal["TPL-09"] = "TPL-09"
    verdict: Verdict
    population: Literal["real", "fixture"]
    reasons: list[str] = Field(default_factory=list)
    excluded_categories: list[str] = Field(default_factory=lambda: [TEMPLATED_CATEGORY])
    noise_floor: float | None = None
    target: TargetSlice
    other_drops: list[str] = Field(default_factory=list)
    gate_population: dict[str, str] = Field(default_factory=dict)
    tiers: dict[str, str] = Field(default_factory=dict)
    golden_sha256: str | None = None
    worsened_items: list[str] | None = None


def _slice_items(output: RunOutput, slice_name: str):
    kind, _, name = slice_name.partition(":")
    if slice_name == "overall":
        return list(output.report.items)
    field = {"category": "category", "language": "language"}.get(kind)
    if field is None:
        raise InputError(f"unsupported slice {slice_name}; use overall, category:<name> or language:<code>")
    return [item for item in output.report.items if getattr(item, field) == name]


def _slice_value(output: RunOutput, slice_name: str, metric: str) -> tuple[float | None, int]:
    report = output.report
    if slice_name == "overall":
        metrics = report.overall
    else:
        kind, _, name = slice_name.partition(":")
        metrics = {"category": report.by_category, "language": report.by_language}.get(kind, {}).get(name)
    if metrics is None:
        return None, 0
    value = getattr(metrics, metric, None)
    if value is None:
        return None, 0
    return value.value, value.n


def evaluate(on: RunOutput, off: RunOutput, *, on_tier: str, off_tier: str, noise: NoiseConfig, population: str,
             slice_name: str = DEFAULT_SLICE, metric: str = DEFAULT_METRIC, min_items: int = DEFAULT_MIN_ITEMS) -> HeaderAbResult:
    if metric not in RETRIEVAL_METRICS:
        raise InputError(f"unknown metric {metric}; choose one of {sorted(RETRIEVAL_METRICS)}")
    excluded = [TEMPLATED_CATEGORY]
    reasons: list[str] = []
    if on.report.golden_sha256 != off.report.golden_sha256 or on.report.golden_filter != off.report.golden_filter:
        reasons.append("manifest_mismatch")
    if population == "real":
        if on_tier != LIVE_TIER or off_tier != LIVE_TIER:
            reasons.append("not_live_run")
        if on.report.gate_population not in REAL_POPULATIONS or off.report.gate_population not in REAL_POPULATIONS:
            reasons.append("not_real_population")

    on_view = RunOutput(report=without_categories(on.report, excluded), traces=on.traces, golden=on.golden)
    off_view = RunOutput(report=without_categories(off.report, excluded), traces=off.traces, golden=off.golden)
    on_value, n_on = _slice_value(on_view, slice_name, metric)
    off_value, n_off = _slice_value(off_view, slice_name, metric)
    if min(n_on, n_off) < min_items or on_value is None or off_value is None:
        reasons.append("slice_too_small")

    target = TargetSlice(slice=slice_name, metric=metric, header_on=on_value, header_off=off_value, n_on=n_on, n_off=n_off)
    result_fields = {
        "population": population,
        "excluded_categories": excluded,
        "noise_floor": noise.floor,
        "gate_population": {"header_on": on.report.gate_population, "header_off": off.report.gate_population},
        "tiers": {"header_on": on_tier, "header_off": off_tier},
        "golden_sha256": on.report.golden_sha256 if "manifest_mismatch" not in reasons else None,
    }
    if reasons:
        return HeaderAbResult(verdict="missing_data", reasons=reasons, target=target, **result_fields)

    baseline, _ = aligned_reference(on_view.report, off_view.report, tag="header-off")
    stat = baseline.slices.get(slice_name, {}).get(metric)
    if stat is not None:
        band = max(noise.k * stat.spread, noise.floor)
        target.threshold = stat.mean - band if noise.metrics.get(metric, "higher") == "higher" else stat.mean + band
    check = no_slice_drop_check(on_view, baseline, noise)
    prefix = f"{slice_name}:{metric} "
    target.dropped = any(line.startswith(prefix) for line in check.detail)
    other = [line for line in check.detail if not line.startswith(prefix)]

    off_items = {item.item_id: item for item in _slice_items(off_view, slice_name)}
    differences: list[float] = []
    worsened_ids: list[str] = []
    for item in _slice_items(on_view, slice_name):
        reference = off_items.get(item.item_id)
        if reference is None:
            continue
        observed, recorded = item_metrics(item)[metric], item_metrics(reference)[metric]
        if observed is None or recorded is None:
            continue
        difference = observed - recorded
        differences.append(difference)
        if difference < 0:
            worsened_ids.append(item.item_id)
        elif difference > 0:
            target.improved += 1
    target.worsened = len(worsened_ids)
    if differences:
        target.paired_mean_difference = math.fsum(differences) / len(differences)
        low, high = _bootstrap_interval(differences)
        target.paired_interval = [low, high]

    if target.dropped:
        reasons.append("target_slice_drop")
    if other:
        reasons.append("other_slice_drop")
    return HeaderAbResult(
        verdict="reopen_d26" if reasons else "holds",
        reasons=reasons,
        target=target,
        other_drops=other,
        worsened_items=sorted(worsened_ids) if population == "fixture" else None,
        **result_fields,
    )


def _num(value: float | None) -> str:
    return "n/a" if value is None else f"{value:.4f}"


def render_markdown(result: HeaderAbResult) -> str:
    target = result.target
    lines = [
        f"# TPL-09 header A/B check: {result.verdict}",
        "",
        f"- Decision: {result.decision}; requirement {result.requirement}; population {result.population}",
        f"- Reasons: {', '.join(result.reasons) or 'none'}",
        f"- Excluded categories: {', '.join(result.excluded_categories)}; noise floor {_num(result.noise_floor)}",
        (
            f"- Tiers: on {result.tiers.get('header_on')}, off {result.tiers.get('header_off')}; gate population: on "
            f"{result.gate_population.get('header_on')}, off {result.gate_population.get('header_off')}"
        ),
        "",
        "| Slice | Metric | Header on | Header off | n on | n off | Threshold | Dropped | Paired mean | 95% interval | Worsened | Improved |",
        "|---|---|---|---|---|---|---|---|---|---|---|---|",
        (
            f"| {target.slice} | {target.metric} | {_num(target.header_on)} | {_num(target.header_off)} | {target.n_on} | {target.n_off} | "
            f"{_num(target.threshold)} | {target.dropped} | {_num(target.paired_mean_difference)} | "
            f"{'n/a' if target.paired_interval is None else ' to '.join(_num(v) for v in target.paired_interval)} | "
            f"{target.worsened} | {target.improved} |"
        ),
        "",
        "## Other slice drops",
        "",
        *([f"- {line}" for line in result.other_drops] or ["- none"]),
        "",
        "Rule: holds keeps D-26 (header in the dense embedding text). reopen_d26 reopens D-26: the header becomes lexical-only, and the",
        "phase gate is re-run. missing_data closes nothing.",
        "",
    ]
    return "\n".join(lines)


def _tier(directory: Path) -> str:
    return load_manifest(directory / "run.json").tier


def _main(argv: list[str] | None) -> int:
    parser = argparse.ArgumentParser(prog="python -m rag_eval.header_ab_check", description=__doc__.splitlines()[0])
    parser.add_argument("--header-on", type=Path, required=True, help="run directory with RAG_ATTRIBUTE_HEADER=true")
    parser.add_argument("--header-off", type=Path, required=True, help="run directory with RAG_ATTRIBUTE_HEADER=false")
    parser.add_argument("--out", type=Path, required=True)
    parser.add_argument("--population", choices=("real", "fixture"), default="real")
    parser.add_argument("--noise", type=Path, default=DEFAULT_NOISE)
    parser.add_argument("--slice", default=DEFAULT_SLICE)
    parser.add_argument("--metric", default=DEFAULT_METRIC)
    parser.add_argument("--min-items", type=int, default=DEFAULT_MIN_ITEMS)
    args = parser.parse_args(argv)
    try:
        on_dir, off_dir = resolve_cli_path(args.header_on), resolve_cli_path(args.header_off)
        on, off = read_run(on_dir.parent, on_dir.name), read_run(off_dir.parent, off_dir.name)
        noise = NoiseConfig.model_validate_json(resolve_cli_path(args.noise).read_text(encoding="utf-8"))
        result = evaluate(
            on, off, on_tier=_tier(on_dir), off_tier=_tier(off_dir), noise=noise, population=args.population,
            slice_name=args.slice, metric=args.metric, min_items=args.min_items,
        )
    except InputError as exc:
        print(f"[Header AB] {exc}", file=sys.stderr)
        return EXIT_MISSING
    out = resolve_cli_path(args.out)
    out.mkdir(parents=True, exist_ok=True)
    (out / JSON_NAME).write_text(result.model_dump_json(indent=2) + "\n", encoding="utf-8")
    (out / MARKDOWN_NAME).write_text(render_markdown(result), encoding="utf-8")
    print(f"[Header AB] {result.verdict}: {result.target.slice} {result.target.metric} on {_num(result.target.header_on)} "
          f"off {_num(result.target.header_off)}; reasons {', '.join(result.reasons) or 'none'}")
    return {"holds": EXIT_HOLDS, "reopen_d26": EXIT_REOPEN, "missing_data": EXIT_MISSING}[result.verdict]


def main(argv: list[str] | None = None) -> int:
    try:
        return _main(argv)
    except Exception as exc:  # noqa: BLE001
        print(f"[Header AB] internal error: {type(exc).__name__}", file=sys.stderr)
        return EXIT_INTERNAL


if __name__ == "__main__":
    sys.exit(main())
