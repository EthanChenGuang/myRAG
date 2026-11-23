import argparse
import json
import math
import os
import sys
from pathlib import Path
from typing import Any

from rag_sidecar.contracts.eval_run import RagTrace
from rag_sidecar.contracts.golden import GoldenItem
from rag_sidecar.contracts.judge import JudgeConfig, JudgeItemScore, JudgeReport
from rag_sidecar.contracts.report import MetricValue

import rag_eval.judge  # noqa: F401  (applies the telemetry opt-out before the judge libraries load)
from rag_eval.golden_io import load_golden, select_golden
from rag_eval.judge.config import (
    DEFAULT_CONFIG_PATH,
    JudgeCase,
    JudgeFamilyError,
    JudgeFatalError,
    assert_judge_family_differs,
    generator_family,
    load_judge_config,
)
from rag_eval.judge.telemetry import check_no_results_upload
from rag_eval.paths import resolve_cli_path
from rag_eval.runner import _cross_check
from rag_eval.traces import load_manifest, load_traces

LIBRARIES = ("deepeval", "ragas")
METRICS = ("faithfulness", "answer_relevance", "context_recall")

EXIT_OK = 0
EXIT_INPUT = 2
EXIT_KEY = 3
EXIT_PROVIDER = 4
EXIT_FAMILY = 5

MISSING_KEY_NOTICE = "judge key not configured"


def generator_model_of(traces: list[RagTrace]) -> str:
    models = {trace.effective_config.generator_model for trace in traces}
    if not models or None in models:
        raise ValueError("traces do not all record effective_config.generator_model; cannot verify judge independence")
    if len(models) > 1:
        raise ValueError(f"traces disagree on the generator model: {sorted(m for m in models if m)}")
    (model,) = models
    assert model is not None
    return model


def _plan_item(item: GoldenItem, trace: RagTrace) -> tuple[JudgeCase | None, dict[str, str]]:
    skips: dict[str, str] = {}
    if trace.refused:
        return None, {metric: "refused" for metric in METRICS}
    if trace.answer is None or not trace.answer.strip():
        return None, {metric: "no_answer_text" for metric in METRICS}
    contexts = [chunk.content for chunk in trace.kept]
    reference = item.expected_answer if item.answerable else None
    if not contexts:
        skips["faithfulness"] = "no_context"
    if reference is None:
        skips["context_recall"] = "no_reference"
    elif not contexts:
        skips["context_recall"] = "no_context"
    case = JudgeCase(
        item_id=item.id, question=item.question, answer=trace.answer, contexts=contexts, reference=reference
    )
    return case, skips


def _mean(values: list[float]) -> MetricValue:
    if not values:
        return MetricValue(value=None, n=0)
    return MetricValue(value=math.fsum(values) / len(values), n=len(values))


def _aggregate(scores: list[JudgeItemScore]) -> dict[str, MetricValue]:
    grouped: dict[str, list[float]] = {f"{library}.{metric}": [] for library in LIBRARIES for metric in METRICS}
    for score in scores:
        if score.score is not None:
            grouped[f"{score.library}.{score.metric}"].append(score.score)
    return {key: _mean(values) for key, values in grouped.items()}


def run_judge(
    traces: list[RagTrace],
    golden: list[GoldenItem],
    deepeval_llm: Any,
    ragas_llm: Any,
    ragas_embeddings: Any,
    config: JudgeConfig,
    *,
    run_id: str,
    run_config_hash: str,
) -> JudgeReport:
    from rag_eval.judge.deepeval_judge import score_deepeval
    from rag_eval.judge.ragas_judge import score_ragas

    generator_model = generator_model_of(traces)
    assert_judge_family_differs(config, generator_model)

    by_id = {trace.item_id: trace for trace in traces}
    ordered = sorted(golden, key=lambda item: item.id)
    cases: list[JudgeCase] = []
    skips: dict[str, dict[str, str]] = {}
    for item in ordered:
        trace = by_id.get(item.id)
        if trace is None:
            raise ValueError(f"golden item {item.id!r} has no trace")
        case, item_skips = _plan_item(item, trace)
        skips[item.id] = item_skips
        if case is not None:
            cases.append(case)

    outcomes = {
        "deepeval": score_deepeval(cases, deepeval_llm, config.max_concurrency),
        "ragas": score_ragas(cases, ragas_llm, ragas_embeddings, config.max_concurrency),
    }

    scores: list[JudgeItemScore] = []
    for item in ordered:
        for library in LIBRARIES:
            for metric in METRICS:
                if metric in skips[item.id]:
                    value, reason = None, skips[item.id][metric]
                else:
                    value, reason = outcomes[library].get((item.id, metric), (None, "judge_error"))
                scores.append(
                    JudgeItemScore(
                        item_id=item.id,
                        language=item.language,
                        category=item.category,
                        library=library,
                        metric=metric,
                        score=value,
                        skipped_reason=reason,
                    )
                )

    languages = sorted({item.language for item in ordered})
    categories = sorted({item.category for item in ordered})
    return JudgeReport(
        run_id=run_id,
        run_config_hash=run_config_hash,
        judge_model=config.judge_model,
        judge_family=config.judge_family,
        generator_model=generator_model,
        generator_family=generator_family(generator_model),
        items=scores,
        overall=_aggregate(scores),
        by_language={lang: _aggregate([s for s in scores if s.language == lang]) for lang in languages},
        by_category={cat: _aggregate([s for s in scores if s.category == cat]) for cat in categories},
    )


def _cell(value: MetricValue) -> str:
    shown = "n/a" if value.value is None else f"{round(value.value, 3):.3f}"
    return f"{shown} (n={value.n})"


def _table(label: str, rows: dict[str, dict[str, MetricValue]]) -> list[str]:
    keys = [f"{library}.{metric}" for library in LIBRARIES for metric in METRICS]
    lines = [f"| {label} | " + " | ".join(keys) + " |", "|" + "---|" * (len(keys) + 1)]
    for name in sorted(rows):
        lines.append(f"| {name} | " + " | ".join(_cell(rows[name][key]) for key in keys) + " |")
    return lines


def render_markdown(report: JudgeReport) -> str:
    skipped: dict[str, int] = {}
    for score in report.items:
        if score.skipped_reason is not None:
            skipped[score.skipped_reason] = skipped.get(score.skipped_reason, 0) + 1
    lines = [
        f"# Judge report: {report.run_id}",
        "",
        f"- Judge: {report.judge_model} (family {report.judge_family}), temperature 0",
        f"- Generator: {report.generator_model} (family {report.generator_family})",
        f"- Run config hash: {report.run_config_hash}",
        "",
        "Scores are means over scored items, rounded to 3 decimals for display; judge.json holds the unrounded "
        "values. n is the number of scored items; skipped items are not counted. Judge metrics are report-only "
        "and do not gate in Phase 1.",
        "",
        "## Overall",
        "",
        *_table("Slice", {"overall": report.overall}),
        "",
        "## By language",
        "",
        *_table("Language", report.by_language),
        "",
        "## By category",
        "",
        *_table("Category", report.by_category),
        "",
        "## Skipped",
        "",
    ]
    if skipped:
        lines.extend(f"- {reason}: {count}" for reason, count in sorted(skipped.items()))
    else:
        lines.append("- none")
    lines.append("")
    return "\n".join(lines)


def _atomic_write(path: Path, text: str) -> None:
    tmp = path.with_name(path.name + ".tmp")
    tmp.write_bytes(text.encode("utf-8"))
    os.replace(tmp, path)


def write_judge_report(report: JudgeReport, out_dir: Path) -> tuple[Path, Path]:
    out_dir = Path(out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    json_path = out_dir / "judge.json"
    md_path = out_dir / "judge.md"
    payload = json.dumps(report.model_dump(mode="json"), sort_keys=True, ensure_ascii=False, indent=2) + "\n"
    _atomic_write(json_path, payload)
    _atomic_write(md_path, render_markdown(report))
    return json_path, md_path


def _fail(message: str, code: int) -> int:
    print(f"error: {message}", file=sys.stderr)
    return code


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="rag_eval.judge.run", description="myRAG judge tier (DeepEval and Ragas)")
    parser.add_argument("--traces", required=True, type=Path)
    parser.add_argument("--golden", required=True, type=Path)
    parser.add_argument("--manifest", required=True, type=Path)
    parser.add_argument("--out", required=True, type=Path)
    parser.add_argument("--config", type=Path, default=DEFAULT_CONFIG_PATH)
    args = parser.parse_args(argv)

    try:
        check_no_results_upload()
    except RuntimeError as exc:
        return _fail(str(exc), EXIT_INPUT)

    try:
        config = load_judge_config(resolve_cli_path(args.config))
        golden = load_golden(resolve_cli_path(args.golden))
        traces = load_traces(resolve_cli_path(args.traces))
        manifest = load_manifest(resolve_cli_path(args.manifest))
        generator_model = generator_model_of(traces)
    except (OSError, ValueError) as exc:
        return _fail(str(exc), EXIT_INPUT)
    golden = select_golden(golden, manifest.golden_filter)

    problems = _cross_check([item.id for item in golden], [trace.item_id for trace in traces])
    if problems:
        print("error: golden items and traces do not match:", file=sys.stderr)
        for problem in problems:
            print(f"  {problem}", file=sys.stderr)
        return EXIT_INPUT

    try:
        assert_judge_family_differs(config, generator_model)
    except JudgeFamilyError as exc:
        return _fail(str(exc), EXIT_FAMILY)

    openrouter_key = os.environ.get("OPENROUTER_API_KEY") or None
    openai_key = os.environ.get("OPENAI_API_KEY") or None
    for name, value in (("OPENROUTER_API_KEY", openrouter_key), ("OPENAI_API_KEY", openai_key)):
        if value is None:
            print(f"{MISSING_KEY_NOTICE}: {name} is not set", file=sys.stderr)
            return EXIT_KEY
    assert openrouter_key is not None and openai_key is not None

    try:
        from rag_eval.judge.deepeval_judge import OpenRouterDeepEvalLLM
        from rag_eval.judge.ragas_judge import build_ragas_live

        deepeval_llm = OpenRouterDeepEvalLLM(config, openrouter_key)
        ragas_llm, ragas_embeddings = build_ragas_live(config, openrouter_key, openai_key)
        report = run_judge(
            traces,
            golden,
            deepeval_llm,
            ragas_llm,
            ragas_embeddings,
            config,
            run_id=manifest.run_id,
            run_config_hash=manifest.run_config_hash,
        )
    except JudgeFatalError as exc:
        return _fail(str(exc), EXIT_PROVIDER)
    except JudgeFamilyError as exc:
        return _fail(str(exc), EXIT_FAMILY)
    except ValueError as exc:
        return _fail(str(exc), EXIT_INPUT)

    write_judge_report(report, resolve_cli_path(args.out))
    scored = {key: value for key, value in report.overall.items()}
    print("overall: " + " ".join(f"{key}={_cell(value)}" for key, value in sorted(scored.items())))
    return EXIT_OK


if __name__ == "__main__":
    raise SystemExit(main())
