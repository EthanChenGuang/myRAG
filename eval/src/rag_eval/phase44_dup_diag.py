"""Report-only diagnostic for Phase 4.4 gap G1 (quick-44): why do duplicate_flood and templated_collection miss gate (b) under bm25?

For each fixture mode it runs the gate-(b) pair (v2-default with ts_rank_cd against v2-lexical-bm25-on) three times:

- ``baseline``: the pair as gate (b) runs it;
- ``dup_clusters``: both arms with ``RAG_DUP_CLUSTERS=true``;
- ``collapse``: both arms with ``RAG_DUP_CLUSTERS=true`` and ``RAG_RESULT_DIVERSITY=collapse``.

The bm25 arms also write ``lexical-ties.json`` (harness, ``EVAL_LEXICAL_TIES_CATEGORIES``): score ties and near-duplicate counts in the
lexical top 10 of both scoring modes. The verdict per category reads the two together. Nothing here changes the pre-registered spec, its
noise bands, k1, b or the candidate cap (T-04.4-44); it is not a gate and its exit code is 0 whenever the runs finish.
"""

from __future__ import annotations

import argparse
import json
import sys
from collections.abc import Callable, Mapping
from pathlib import Path
from typing import Any

from rag_sidecar.contracts.baseline import NoiseConfig

from rag_eval.harness_runner import HarnessError
from rag_eval.paired import item_metrics
from rag_eval.paths import repo_relative, resolve_cli_path
from rag_eval.phase42_gate import drop_offenders
from rag_eval.phase44_gate import OFF_ENV
from rag_eval.phase_compare import (
    ComparisonError,
    RunOutput,
    RunRequest,
    _read_model,
    _write_text,
    default_runner,
    materialise_run_config,
)
from rag_eval.phase_compare import RunSpec as CompareRunSpec

Runner = Callable[[RunRequest], RunOutput]

CATEGORIES = ("duplicate_flood", "templated_collection")
MODES = ("prechunked", "ingest")
REFERENCE_BASE = "eval/config/runs/v2-default.json"
BM25_BASE = "eval/config/runs/v2-lexical-bm25-on.json"
NOISE = "eval/config/noise.json"
GROUPS: Mapping[str, Mapping[str, str]] = {
    "baseline": {},
    "dup_clusters": {"RAG_DUP_CLUSTERS": "true"},
    "collapse": {"RAG_DUP_CLUSTERS": "true", "RAG_RESULT_DIVERSITY": "collapse"},
}
METRICS = ("recall_at_5", "recall_at_10", "mrr")
TIES_FILE = "lexical-ties.json"
TIES_ENV = "EVAL_LEXICAL_TIES_CATEGORIES"
JSON_NAME = "dup-diagnostic.json"
MARKDOWN_NAME = "dup-diagnostic.md"
HARNESS = "harness"


def run_name(group: str, arm: str, mode: str) -> str:
    return f"diag-{group.replace('_', '-')}-{arm}-{mode}"


def run_config(group: str, arm: str) -> dict[str, Any]:
    env = {**(dict(OFF_ENV) if arm == "ts_rank_cd" else {}), **GROUPS[group]}
    base = REFERENCE_BASE if arm == "ts_rank_cd" else BM25_BASE
    return materialise_run_config(CompareRunSpec(name=f"diag-{group}-{arm}", base=base, fixture_mode="prechunked", env=env), [])


def category_metrics(output: RunOutput, category: str) -> dict[str, Any]:
    split = output.report.golden_filter.gate_split
    items = [item for item in output.report.items if item.split == split and item.category == category and item.answerable]
    out: dict[str, Any] = {"n": len(items)}
    for metric in METRICS:
        values = [v for v in (item_metrics(item)[metric] for item in items) if v is not None]
        out[metric] = sum(values) / len(values) if values else None
    for extra in ("intent_coverage", "topk_redundancy"):
        values = [float(getattr(item, extra)) for item in items if getattr(item, extra) is not None]
        out[extra] = sum(values) / len(values) if values else None
    return out


def category_offenders(on: RunOutput, reference: RunOutput, noise: NoiseConfig, category: str) -> list[str]:
    prefix = f"category:{category}:"
    return [line for line in drop_offenders(on, reference, noise, reference_name="ts_rank_cd") if line.startswith(prefix)]


def tie_summary(report: Mapping[str, Any] | None, category: str) -> dict[str, Any] | None:
    if report is None:
        return None
    rows = [row for row in report.get("items", []) if row.get("category") == category]
    if not rows:
        return {"items": 0}
    out: dict[str, Any] = {"items": len(rows)}
    for arm in ("bm25", "ts_rank_cd"):
        stats = [row["arms"][arm] for row in rows]
        gaps = [s["mean_duplicate_gap"] for s in stats if s["mean_duplicate_gap"] is not None]
        out[arm] = {
            "items_with_tie": sum(1 for s in stats if s["tie_groups"] > 0),
            "items_with_duplicate_tie": sum(1 for s in stats if s["duplicate_tie_groups"] > 0),
            "items_with_tie_at_cut_5": sum(1 for s in stats if s["tie_at_cut_5"]),
            "items_with_tie_at_cut_10": sum(1 for s in stats if s["tie_at_cut_10"]),
            "mean_tied_hits": sum(s["tied_hits"] for s in stats) / len(stats),
            "mean_duplicate_pairs": sum(s["duplicate_pairs"] for s in stats) / len(stats),
            "mean_distinct_documents": sum(s["distinct_documents"] for s in stats) / len(stats),
            "mean_duplicate_gap": sum(gaps) / len(gaps) if gaps else None,
        }
    return out


def verdict(offenders: Mapping[str, list[str]], ties: Mapping[str, Any] | None) -> dict[str, Any]:
    """Classify one category in one mode from the offenders per group and the baseline tie summary."""
    base = bool(offenders.get("baseline"))
    if not base:
        return {"cause": "no_drop", "explanation": "no slice of this category drops beyond the noise band in the baseline pair"}
    fixed_by = [group for group in ("dup_clusters", "collapse") if group in offenders and not offenders[group]]
    excess_ties = False
    if ties and ties.get("items"):
        bm, ts = ties["bm25"], ties["ts_rank_cd"]
        excess_ties = (bm["items_with_duplicate_tie"] + bm["items_with_tie_at_cut_10"]) > (ts["items_with_duplicate_tie"] + ts["items_with_tie_at_cut_10"])
    if fixed_by and excess_ties:
        cause = "score_ties_among_duplicates"
        text = "bm25 ties duplicate chunks more often than ts_rank_cd, and de-duplication removes the drop"
    elif fixed_by:
        cause = "missing_deduplication"
        text = "de-duplication removes the drop, but bm25 does not tie duplicates more than ts_rank_cd: duplicates crowd the list"
    elif excess_ties:
        cause = "bm25_ranking_with_ties"
        text = "the drop stays with de-duplication on; bm25 ties more, but removing duplicates does not restore coverage"
    else:
        cause = "bm25_ranking"
        text = "the drop stays with de-duplication on and bm25 shows no excess ties: the bm25 order itself ranks other spans lower"
    return {"cause": cause, "fixed_by": fixed_by, "excess_bm25_ties": excess_ties, "explanation": text}


def load_ties(directory: Path) -> dict[str, Any] | None:
    path = directory / TIES_FILE
    if not path.is_file():
        return None
    return json.loads(path.read_text(encoding="utf-8"))


def run_diagnostic(out: Path, runner: Runner = default_runner, *, modes: tuple[str, ...] = MODES, reuse: bool = False) -> dict[str, Any]:
    noise = _read_model(NoiseConfig, NOISE, "noise config")
    root = Path(out) / HARNESS
    process_env = {TIES_ENV: ",".join(CATEGORIES)}
    result: dict[str, Any] = {
        "schema_version": 1,
        "plan": "quick-44 (Phase 4.4 G1, option B)",
        "report_only": True,
        "categories": list(CATEGORIES),
        "groups": {name: dict(env) for name, env in GROUPS.items()},
        "noise": NOISE,
        "modes": {},
    }
    for mode in modes:
        outputs: dict[tuple[str, str], RunOutput] = {}
        ties: dict[str, dict[str, Any] | None] = {}
        for group in GROUPS:
            for arm in ("ts_rank_cd", "bm25"):
                name = run_name(group, arm, mode)
                directory = root / name
                if reuse and (directory / "report.json").is_file():
                    from rag_eval.phase42_gate import load_run

                    outputs[(group, arm)] = load_run(directory)
                else:
                    print(f"[Phase 4.4 Diagnostic] run {name}", file=sys.stderr)
                    config = run_config(group, arm)
                    config["name"] = name
                    outputs[(group, arm)] = runner(RunRequest(name=name, run_config=config, fixture_mode=mode, out_dir=directory, process_env=process_env))
                if arm == "bm25":
                    ties[group] = load_ties(directory)
        per_category: dict[str, Any] = {}
        for category in CATEGORIES:
            groups_out: dict[str, Any] = {}
            offenders: dict[str, list[str]] = {}
            for group in GROUPS:
                on, ref = outputs[(group, "bm25")], outputs[(group, "ts_rank_cd")]
                offenders[group] = category_offenders(on, ref, noise, category)
                groups_out[group] = {
                    "ts_rank_cd": category_metrics(ref, category),
                    "bm25": category_metrics(on, category),
                    "offenders": offenders[group],
                    "ties": tie_summary(ties.get(group), category),
                }
            per_category[category] = {"groups": groups_out, "verdict": verdict(offenders, groups_out["baseline"]["ties"])}
        result["modes"][mode] = per_category
    return result


def _num(value: Any) -> str:
    if value is None:
        return "—"
    if isinstance(value, float):
        return f"{value:.4f}"
    return str(value)


def render_markdown(result: Mapping[str, Any]) -> str:
    lines = [
        "# Phase 4.4 G1 diagnostic: duplicate_flood and templated_collection under bm25",
        "",
        "Report only (quick-44, option B). The pre-registered spec, its noise bands, k1, b and the candidate cap are unchanged; nothing here is a gate.",
        "Each group runs the gate-(b) pair (v2-default with ts_rank_cd against v2-lexical-bm25-on) with the group's extra switches on both arms.",
        "",
    ]
    for mode, categories in result["modes"].items():
        lines += [f"## {mode}", ""]
        for category, body in categories.items():
            lines += [f"### {category}", "", "| group | arm | n | R@5 | R@10 | MRR | intent coverage | top-k redundancy |", "| --- | --- | --- | --- | --- | --- | --- | --- |"]
            for group, g in body["groups"].items():
                for arm in ("ts_rank_cd", "bm25"):
                    m = g[arm]
                    lines.append(
                        f"| {group} | {arm} | {m['n']} | {_num(m['recall_at_5'])} | {_num(m['recall_at_10'])} | {_num(m['mrr'])} | {_num(m['intent_coverage'])} | {_num(m['topk_redundancy'])} |"
                    )
            lines += ["", "Offenders beyond the noise band (bm25 against ts_rank_cd):", ""]
            for group, g in body["groups"].items():
                lines.append(f"- {group}: " + ("; ".join(g["offenders"]) if g["offenders"] else "none"))
            ties = body["groups"]["baseline"]["ties"]
            if ties and ties.get("items"):
                lines += [
                    "",
                    f"Lexical top-10 ties, baseline group ({ties['items']} items):",
                    "",
                    "| arm | items with a tie | with a duplicate tie | tie across rank 5 | tie across rank 10 | mean tied hits | mean near-duplicate pairs | mean distinct documents | mean duplicate score gap |",
                    "| --- | --- | --- | --- | --- | --- | --- | --- | --- |",
                ]
                for arm in ("bm25", "ts_rank_cd"):
                    t = ties[arm]
                    lines.append(
                        f"| {arm} | {t['items_with_tie']} | {t['items_with_duplicate_tie']} | {t['items_with_tie_at_cut_5']} | {t['items_with_tie_at_cut_10']} | {_num(t['mean_tied_hits'])} | {_num(t['mean_duplicate_pairs'])} | {_num(t['mean_distinct_documents'])} | {_num(t['mean_duplicate_gap'])} |"
                    )
            v = body["verdict"]
            lines += ["", f"**Verdict: `{v['cause']}`.** {v['explanation']}.", ""]
    return "\n".join(lines) + "\n"


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="python -m rag_eval.phase44_dup_diag", description=__doc__.splitlines()[0])
    parser.add_argument("--out", required=True, help="output directory (harness runs go under <out>/harness, which is git-ignored)")
    parser.add_argument("--mode", choices=MODES, action="append", help="fixture mode(s); default both")
    parser.add_argument("--reuse", action="store_true", help="reuse finished harness runs under <out>/harness")
    args = parser.parse_args(argv)
    out = resolve_cli_path(args.out)
    try:
        result = run_diagnostic(out, modes=tuple(args.mode or MODES), reuse=args.reuse)
    except (ComparisonError, HarnessError) as exc:
        print(f"[Phase 4.4 Diagnostic] {exc}", file=sys.stderr)
        return 3
    _write_text(out / JSON_NAME, json.dumps(result, indent=2, sort_keys=True) + "\n")
    _write_text(out / MARKDOWN_NAME, render_markdown(result))
    print(f"[Phase 4.4 Diagnostic] wrote {repo_relative(out / JSON_NAME)} and {MARKDOWN_NAME}", file=sys.stderr)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
