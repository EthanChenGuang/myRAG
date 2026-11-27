"""Phase 4.1.1 on/off comparison (plan 04.1.1-14, D-29): one entry per terminology run pair.

Run from eval/: uv run python ../eval/reports/phase-04.1.1/compare_terminology.py --pair <off_dir> <on_dir> [--pair ...] --out <comparison.json>
Every bound is read from eval/config/noise.json and eval/config/latency-budgets.json when this runs.
"""

import argparse
import hashlib
import json
import math
import sys
from pathlib import Path

from rag_sidecar.contracts.baseline import NoiseConfig
from rag_sidecar.contracts.report import EvalReport, ItemResult

from rag_eval.metrics import report_gate_items
from rag_eval.paired import _stat, item_metrics

REPO = Path(__file__).resolve().parents[3]
NOISE = "eval/config/noise.json"
BUDGETS = "eval/config/latency-budgets.json"
TERM_STAGES = ("terminology", "search")
SLICE_METRICS = ("recall_at_5", "recall_at_10", "mrr")


def _sha(relpath: str) -> str:
    return hashlib.sha256((REPO / relpath).read_bytes()).hexdigest()


def _load(run_dir: Path) -> tuple[EvalReport, set[str]]:
    report = EvalReport.model_validate_json((run_dir / "report.json").read_text(encoding="utf-8"))
    hashes: set[str] = set()
    for line in (run_dir / "traces.jsonl").read_text(encoding="utf-8").splitlines():
        if line.strip():
            value = json.loads(line).get("retrieval_config_hash")
            if value:
                hashes.add(value)
    return report, hashes


def _mean(values: list[float]) -> float | None:
    return math.fsum(values) / len(values) if values else None


def _paired(off: dict[str, ItemResult], on: dict[str, ItemResult], ids: list[str], metric: str) -> dict:
    diffs, off_vals, on_vals = [], [], []
    for item_id in ids:
        a = item_metrics(off[item_id])[metric]
        b = item_metrics(on[item_id])[metric]
        if a is None or b is None:
            continue
        off_vals.append(a)
        on_vals.append(b)
        diffs.append(b - a)
    stat = _stat(diffs)
    return {"off": _mean(off_vals), "on": _mean(on_vals), **stat.model_dump()}


def _slices(items: list[ItemResult]) -> dict[str, list[str]]:
    out: dict[str, list[str]] = {"overall": [i.item_id for i in items]}
    for item in items:
        out.setdefault(f"language:{item.language}", []).append(item.item_id)
        out.setdefault(f"category:{item.category}", []).append(item.item_id)
    return dict(sorted(out.items()))


def compare_pair(off_dir: Path, on_dir: Path, noise: NoiseConfig, budgets: dict) -> dict:
    off_report, off_hashes = _load(off_dir)
    on_report, on_hashes = _load(on_dir)
    off = {i.item_id: i for i in off_report.items}
    on = {i.item_id: i for i in on_report.items}
    failures: list[str] = []
    if sorted(off) != sorted(on):
        failures.append("item sets differ between the off and on runs")
    term_ids = sorted(i for i in on if "-colloquial-term-" in i)
    no_answer_ids = sorted(i for i in on if "-no_answer-term-" in i)
    if not term_ids or not no_answer_ids:
        failures.append("the run holds no colloquial-term or no_answer-term items")

    colloquial = {m: _paired(off, on, term_ids, m) for m in SLICE_METRICS}
    deltas = [colloquial[m]["mean_d"] for m in SLICE_METRICS if colloquial[m]["mean_d"] is not None]
    colloquial_rises = bool(deltas) and all(d >= 0 for d in deltas) and any(d > 0 for d in deltas)
    if not colloquial_rises:
        failures.append("colloquial-term Recall@k and MRR did not rise (a metric fell or none rose)")

    excluded = set(term_ids) | set(no_answer_ids)
    gated = [i for i in report_gate_items(on_report.items, on_report.golden_filter.gate_split, on_report.gate_population) if i.item_id not in excluded]
    band = noise.floor
    other: dict[str, dict] = {}
    for name, ids in _slices(gated).items():
        cells = {}
        for metric, direction in noise.metrics.items():
            cell = _paired(off, on, ids, metric)
            d = cell["mean_d"]
            within = d is None or (d >= -band if direction == "higher" else d <= band)
            cell.update({"direction": direction, "band": band, "within_noise": within})
            if not within:
                failures.append(f"{name} {metric} moved {d:+.4f} beyond the noise band {band}")
            cells[metric] = cell
        other[name] = cells

    def refusal_rate(items: dict[str, ItemResult]) -> float | None:
        return _mean([1.0 if items[i].refused else 0.0 for i in no_answer_ids])

    refusal = {"items": len(no_answer_ids), "off": refusal_rate(off), "on": refusal_rate(on)}
    refusal["unchanged"] = refusal["off"] == refusal["on"] and all(off[i].refused == on[i].refused for i in no_answer_ids)
    if not refusal["unchanged"]:
        failures.append("the no_answer-term refusal rate changed")

    chat = budgets["profiles"]["chat"]
    latency: dict[str, dict] = {}
    for stage in TERM_STAGES:
        observed = (on_report.latency or {}).get(stage)
        reference = (off_report.latency or {}).get(stage)
        budget = chat["stages"].get(stage)
        row = {
            "budget_p95_ms": budget,
            "on": observed.model_dump() if observed else None,
            "off": reference.model_dump() if reference else None,
        }
        row["within_budget"] = observed is not None and budget is not None and observed.p95_ms <= budget
        if not row["within_budget"]:
            failures.append(f"{stage} p95 is missing or above its chat budget")
        latency[stage] = row
    total_on = (on_report.pre_generation or {}).get("chat")
    total_off = (off_report.pre_generation or {}).get("chat")
    total = {
        "budget_p50_ms": chat["total_p50_ms"],
        "budget_p95_ms": chat["total_p95_ms"],
        "on": total_on.model_dump() if total_on else None,
        "off": total_off.model_dump() if total_off else None,
    }
    total["within_budget"] = total_on is not None and total_on.p95_ms <= chat["total_p95_ms"] and total_on.p50_ms <= chat["total_p50_ms"]
    if not total["within_budget"]:
        failures.append("the pre-generation total is missing or above its chat budget")
    latency["total"] = total

    config_hash = {"off": sorted(off_hashes), "on": sorted(on_hashes)}
    config_hash["differs"] = bool(off_hashes) and bool(on_hashes) and not (off_hashes & on_hashes)
    if not config_hash["differs"]:
        failures.append("the retrievalConfigHash does not differ between off and on")

    return {
        "off": {"dir": str(off_dir.relative_to(REPO)), "run_config_hash": off_report.run_config_hash},
        "on": {"dir": str(on_dir.relative_to(REPO)), "run_config_hash": on_report.run_config_hash},
        "colloquial_term": {"items": len(term_ids), "rises": colloquial_rises, "metrics": colloquial},
        "other_slices": {"gate_split": on_report.golden_filter.gate_split, "items": len(gated), "slices": other},
        "no_answer_term_refusal": refusal,
        "latency": latency,
        "retrieval_config_hash": config_hash,
        "failures": failures,
        "passed": not failures,
    }


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--pair", nargs=3, action="append", metavar=("NAME", "OFF_DIR", "ON_DIR"), required=True)
    parser.add_argument("--out", required=True, type=Path)
    args = parser.parse_args(argv)
    noise = NoiseConfig.model_validate_json((REPO / NOISE).read_text(encoding="utf-8"))
    budgets = json.loads((REPO / BUDGETS).read_text(encoding="utf-8"))
    pairs = []
    for name, off_dir, on_dir in args.pair:
        entry = compare_pair((REPO / off_dir).resolve(), (REPO / on_dir).resolve(), noise, budgets)
        pairs.append({"name": name, **entry})
    result = {
        "phase": "04.1.1",
        "plan": "04.1.1-14",
        "sources": {NOISE: _sha(NOISE), BUDGETS: _sha(BUDGETS)},
        "rules": {
            "colloquial_term": "items whose id holds -colloquial-term- (both splits, report-only per EVAL-14): no Recall@5, Recall@10 or MRR paired mean falls and at least one rises",
            "other_slices": "gated items without the term items: every overall, language and category slice stays within noise.floor (one run per side, so k x spread is 0) for every noise.metrics metric",
            "no_answer_term_refusal": "items whose id holds -no_answer-term-: every item refused on exactly when refused off",
            "latency": "on-run p95 of terminology and search within the chat stage budgets; the pre-generation chat total within total_p50_ms and total_p95_ms",
            "retrieval_config_hash": "the off and on runs share no retrieval_config_hash",
        },
        "pairs": pairs,
        "decision": "stays off",
        "passed": all(p["passed"] for p in pairs),
    }
    args.out = args.out if args.out.is_absolute() else REPO / args.out
    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(json.dumps(result, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    for p in pairs:
        print(f"{p['name']}: {'PASS' if p['passed'] else 'FAIL'} {p['failures']}")
    return 0 if result["passed"] else 1


if __name__ == "__main__":
    sys.exit(main())
