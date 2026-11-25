import hashlib
import json
from pathlib import Path

from rag_sidecar.contracts.baseline import NoiseConfig
from rag_sidecar.contracts.judge import JudgeItemScore, JudgeReport
from rag_sidecar.contracts.latency import LatencyBudgets
from rag_sidecar.contracts.report import EvalReport, MetricValue

from rag_eval.gate import evaluate_gate
from rag_eval.metrics import score_items
from rag_eval.report import build_report, load_latency_budgets, write_report
from test_citation_metrics import GOLD_QUOTE, NOT_CHECKED, _citation, _item, _scored, _trace
from test_gate import _baseline
from test_latency_report import _budgets as _plain_budgets
from test_latency_report import _with_latency
from test_report_runner import _four_items, _manifest

EVAL_ROOT = Path(__file__).resolve().parents[1]
BUDGETS_PATH = EVAL_ROOT / "config" / "latency-budgets.json"
NOISE_PATH = EVAL_ROOT / "config" / "noise.json"


def _budgets() -> LatencyBudgets:
    data = _plain_budgets().model_dump(mode="json")
    data["groundedness"] = {
        "hhem_2_1_open": {"p50_ms": 2500, "p95_ms": 5000},
        "hhem_2_3_vectara": {"p50_ms": 4000, "p95_ms": 8000},
        "report_only": True,
    }
    return LatencyBudgets.model_validate(data)


def _citation_manifest():
    manifest = _manifest()
    options = manifest.request_options.model_copy(update={"citations": True, "include_answer": True})
    return manifest.model_copy(update={"request_options": options})


def _two_strategy_run():
    golden = [_item("a1"), _item("a2"), _item("c1"), _item("c2"), _item("r1")]
    traces = [
        _with_latency(
            _trace("a1", citations=[_citation("S1", "c1", GOLD_QUOTE)], invalid=1, groundedness=_scored("verified")),
            embed=10.0,
            generation=1000.0,
        ),
        _with_latency(
            _trace("a2", citations=[], groundedness=_scored("possibly_unreliable", latency=7000)),
            embed=10.0,
            generation=3000.0,
        ),
        _with_latency(
            _trace(
                "c1",
                strategy="claude-citations",
                citations=[_citation("S2", "c2", "chunk 2 text", strategy="claude-citations")],
                groundedness=NOT_CHECKED,
            ),
            embed=10.0,
            generation=2000.0,
        ),
        _with_latency(
            _trace(
                "c2",
                strategy="claude-citations",
                citations=[_citation("S1", "c1", GOLD_QUOTE, strategy="claude-citations")],
            ),
            embed=10.0,
            generation=4000.0,
        ),
        _with_latency(_trace("r1", refused=True), embed=10.0),
    ]
    return golden, traces


def _judge(scores: dict[str, tuple[float | None, float | None]]) -> JudgeReport:
    items = []
    for item_id, pair in scores.items():
        for library, value in zip(("deepeval", "ragas"), pair):
            items.append(
                JudgeItemScore(
                    item_id=f"item-{item_id}",
                    language="en",
                    category="general",
                    library=library,
                    metric="faithfulness",
                    score=value,
                    skipped_reason=None if value is not None else "judge_error",
                )
            )
    return JudgeReport(
        run_id="run-test",
        run_config_hash="r" * 64,
        judge_model="openai/gpt-5-mini",
        judge_family="openai",
        generator_model="google/gemini-x",
        generator_family="google",
        items=items,
        overall={},
        by_language={},
        by_category={},
    )


def _report(judge: JudgeReport | None = None) -> EvalReport:
    golden, traces = _two_strategy_run()
    return build_report(_citation_manifest(), score_items(traces, golden), golden, traces, judge=judge)


def test_report_carries_overall_citation_metrics_and_groundedness_counts():
    report = _report()
    assert report.citation_coverage == MetricValue(value=0.75, n=4)
    assert report.invalid_citation_rate == MetricValue(value=0.0, n=3)
    assert report.cited_gold_hit == MetricValue(value=0.5, n=4)
    assert report.raw_invalid_markers == 1
    assert report.groundedness_labels["hhem_2_1_open"]["en"].verified == 1
    assert report.groundedness_labels["hhem_2_1_open"]["en"].possibly_unreliable == 1
    assert report.groundedness_labels["none"]["en"].not_checked == 1
    latency = report.groundedness_latency["hhem_2_1_open"]
    assert (latency.p50_ms, latency.p95_ms, latency.n) == (900, 7000, 2)


def test_by_strategy_slices_count_items_and_carry_citation_metrics_and_generation_latency():
    report = _report()
    assert set(report.by_strategy) == {"chunk-alias", "claude-citations", "none"}
    alias = report.by_strategy["chunk-alias"]
    assert alias.items == 2
    assert alias.citation_coverage == MetricValue(value=0.5, n=2)
    assert alias.raw_invalid_markers == 1
    assert alias.generation_latency is not None
    assert (alias.generation_latency.p50_ms, alias.generation_latency.p95_ms) == (1000, 3000)
    claude = report.by_strategy["claude-citations"]
    assert claude.items == 2
    assert claude.citation_coverage == MetricValue(value=1.0, n=2)
    assert claude.cited_gold_hit == MetricValue(value=0.5, n=2)
    assert claude.generation_latency is not None
    assert (claude.generation_latency.p50_ms, claude.generation_latency.p95_ms) == (2000, 4000)
    refused = report.by_strategy["none"]
    assert refused.items == 1
    assert refused.citation_coverage == MetricValue(value=None, n=0)
    assert refused.generation_latency is None
    assert alias.faithfulness is None and claude.faithfulness is None


def test_faithfulness_per_strategy_comes_from_judge_results():
    report = _report(_judge({"a1": (0.8, 0.6), "a2": (0.4, None), "c1": (None, None), "c2": (1.0, 0.8)}))
    alias = report.by_strategy["chunk-alias"].faithfulness
    claude = report.by_strategy["claude-citations"].faithfulness
    assert alias is not None and alias.n == 2 and abs(alias.value - 0.55) < 1e-9
    assert claude is not None and claude.n == 1 and abs(claude.value - 0.9) < 1e-9


def test_markdown_shows_strategy_table_and_skipped_faithfulness_without_judge(tmp_path: Path):
    _, md_path = write_report(_report(), tmp_path, _budgets())
    md = md_path.read_text(encoding="utf-8")
    assert "## By citation strategy (report-only)" in md
    row = next(line for line in md.splitlines() if line.startswith("| claude-citations "))
    cells = [cell.strip() for cell in row.split("|")[2:-1]]
    assert cells[0] == "2"
    assert cells[2] == "1.000 (n=2)"
    assert cells[-3:] == ["2000.0", "4000.0", "skipped"]
    assert "judge key not configured" in md


def test_markdown_shows_faithfulness_when_judge_results_exist(tmp_path: Path):
    report = _report(_judge({"c2": (1.0, 0.8)}))
    _, md_path = write_report(report, tmp_path, _budgets())
    md = md_path.read_text(encoding="utf-8")
    row = next(line for line in md.splitlines() if line.startswith("| claude-citations "))
    assert row.split("|")[-2].strip() == "0.900 (n=1)"
    assert "judge key not configured" not in md


def test_groundedness_latency_is_reported_against_report_only_budgets(tmp_path: Path):
    _, md_path = write_report(_report(), tmp_path, _budgets())
    md = md_path.read_text(encoding="utf-8")
    assert "## Groundedness (report-only)" in md
    row = next(line for line in md.splitlines() if line.startswith("| hhem_2_1_open | 900.0"))
    assert [cell.strip() for cell in row.split("|")[2:-1]] == ["900.0", "7000.0", "2", "2500.0", "5000.0", "over"]
    assert "| Scorer | Language | verified | possibly_unreliable | not_checked |" in md
    assert "| none | en | 0 | 0 | 1 |" in md


def test_groundedness_budgets_never_change_the_gate_or_the_chat_total():
    golden, traces = _two_strategy_run()
    results = score_items(traces, golden)
    with_citations = build_report(_citation_manifest(), results, golden, traces)
    plain_traces = [trace.model_copy(update={"groundedness": None}) for trace in traces]
    plain = build_report(_citation_manifest(), results, golden, plain_traces)
    assert with_citations.groundedness_latency["hhem_2_1_open"].p95_ms > 5000
    baseline = _baseline(
        deployment_mode="single",
        embedder_version=3,
        corpus_sha256="c" * 64,
        golden_sha256="g" * 64,
        run_config_hash="r" * 64,
        embedder_id="fixture-embedder",
    )
    noise = NoiseConfig.model_validate_json(NOISE_PATH.read_text(encoding="utf-8"))
    assert evaluate_gate(with_citations, baseline, noise) == evaluate_gate(plain, baseline, noise)
    assert with_citations.latency == plain.latency


def test_committed_budgets_have_report_only_groundedness_entries_and_unchanged_chat_total():
    budgets = load_latency_budgets(BUDGETS_PATH)
    assert budgets.groundedness is not None
    assert budgets.groundedness.report_only is True
    assert budgets.groundedness.hhem_2_1_open is not None
    assert (budgets.groundedness.hhem_2_1_open.p50_ms, budgets.groundedness.hhem_2_1_open.p95_ms) == (2500, 5000)
    assert budgets.groundedness.hhem_2_3_vectara is not None
    assert (budgets.groundedness.hhem_2_3_vectara.p50_ms, budgets.groundedness.hhem_2_3_vectara.p95_ms) == (4000, 8000)
    chat = budgets.profiles["chat"]
    assert (chat.total_p50_ms, chat.total_p95_ms) == (1000, 2000)
    assert "groundedness" not in chat.stages


def test_report_without_citation_data_is_byte_identical_to_before(tmp_path: Path):
    golden, traces = _four_items()
    traces = [_with_latency(t, embed=10.0 + i, search=100.0, generation=900.0 + i) for i, t in enumerate(traces)]
    report = build_report(_manifest(), score_items(traces, golden), golden, traces)
    json_path, md_path = write_report(report, tmp_path, _budgets())
    assert report.by_strategy == {} and report.citation_coverage is None and report.groundedness_labels == {}
    assert hashlib.sha256(json_path.read_bytes()).hexdigest() == (
        "5a04c4577ccaf3bcb548bcf2186b0becb6785ee6f37cbc3367c586163f785d96"
    )
    assert hashlib.sha256(md_path.read_bytes()).hexdigest() == (
        "8764e48576ea708a72344dfb96193ef347af84313589f6f232421d606377e053"
    )


def test_report_json_with_citations_validates(tmp_path: Path):
    json_path, _ = write_report(_report(), tmp_path, _budgets())
    EvalReport.model_validate(json.loads(json_path.read_text(encoding="utf-8")))
