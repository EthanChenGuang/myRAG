import json
from pathlib import Path

from rag_sidecar.contracts.baseline import NoiseConfig
from rag_sidecar.contracts.eval_run import RagTrace
from rag_sidecar.contracts.latency import LatencyBudgets
from rag_sidecar.contracts.report import EvalReport

from rag_eval.gate import evaluate_gate
from rag_eval.metrics import score_items
from rag_eval.report import build_report, compute_latency, load_latency_budgets, nearest_rank, write_report
from test_gate import _baseline
from test_report_runner import QUOTE, _four_items, _item, _manifest, _trace

BUDGETS_PATH = Path(__file__).resolve().parents[1] / "config" / "latency-budgets.json"
NOISE_PATH = Path(__file__).resolve().parents[1] / "config" / "noise.json"


def _with_latency(trace: RagTrace, **stages: float) -> RagTrace:
    return trace.model_copy(update={"stage_latency_ms": dict(stages)})


def _budgets() -> LatencyBudgets:
    return LatencyBudgets.model_validate(
        {
            "profiles": {
                "chat": {
                    "total_p50_ms": 1000,
                    "total_p95_ms": 2000,
                    "stages": {"embed": 25, "search": 400},
                },
                "voice": {"total_p50_ms": 400, "total_p95_ms": 800},
            }
        }
    )


def _traces_with_embed(values: list[float], **extra: float) -> list[RagTrace]:
    return [
        _with_latency(_trace(f"item-{index}", [("doc.en.md", QUOTE)]), embed=value, **extra)
        for index, value in enumerate(values)
    ]


def test_nearest_rank_percentiles():
    assert nearest_rank([10, 20, 30, 40], 0.5) == 20
    assert nearest_rank([10, 20, 30, 40], 0.95) == 40
    assert nearest_rank([40, 10, 30, 20], 0.5) == 20
    assert nearest_rank([7.5], 0.95) == 7.5


def test_stage_percentiles_use_nearest_rank_and_count_traces():
    latency = compute_latency(_traces_with_embed([10, 20, 30, 40]))
    assert latency is not None
    assert (latency["embed"].p50_ms, latency["embed"].p95_ms, latency["embed"].n) == (20, 40, 4)


def test_retrieval_total_sums_stages_without_generation():
    traces = [
        _with_latency(_trace("a", []), embed=10, search=20, generation=500),
        _with_latency(_trace("b", []), embed=30, search=40, generation=900),
    ]
    latency = compute_latency(traces)
    assert latency is not None
    assert latency["retrieval_total"].n == 2
    assert (latency["retrieval_total"].p50_ms, latency["retrieval_total"].p95_ms) == (30, 70)
    assert latency["generation"].p95_ms == 900


def test_traces_without_stage_latencies_give_no_latency_block():
    assert compute_latency([_trace("a", [])]) is None
    assert compute_latency([]) is None


def test_report_json_carries_latency_and_stays_valid(tmp_path: Path):
    golden, traces = _four_items()
    traces = [_with_latency(trace, embed=10.0 * (index + 1), search=5.0) for index, trace in enumerate(traces)]
    report = build_report(_manifest(), score_items(traces, golden), golden, traces)
    json_path, _ = write_report(report, tmp_path, _budgets())
    data = json.loads(json_path.read_text(encoding="utf-8"))
    assert data["latency"]["embed"]["n"] == 4
    assert data["latency"]["embed"]["p50_ms"] == 20
    EvalReport.model_validate(data)


def test_markdown_shows_each_stage_against_the_chat_budget(tmp_path: Path):
    golden, traces = _four_items()
    traces = [_with_latency(trace, embed=value, search=50.0) for trace, value in zip(traces, [10, 20, 30, 40])]
    report = build_report(_manifest(), score_items(traces, golden), golden, traces)
    _, md_path = write_report(report, tmp_path, _budgets())
    md = md_path.read_text(encoding="utf-8")
    assert "## Latency (report-only)" in md
    rows = {line.split("|")[1].strip(): [cell.strip() for cell in line.split("|")[2:-1]] for line in md.splitlines() if line.startswith("| ")}
    assert rows["embed"] == ["20.0", "40.0", "4", "-", "25.0", "over"]
    assert rows["search"] == ["50.0", "50.0", "4", "-", "400.0", "within"]
    assert rows["retrieval_total"][-1] == "within"
    assert rows["retrieval_total"][3:5] == ["1000.0", "2000.0"]


def test_stage_without_a_budget_shows_dashes(tmp_path: Path):
    golden, traces = _four_items()
    traces = [_with_latency(trace, analyze=3.0) for trace in traces]
    report = build_report(_manifest(), score_items(traces, golden), golden, traces)
    _, md_path = write_report(report, tmp_path, _budgets())
    md = md_path.read_text(encoding="utf-8")
    row = next(line for line in md.splitlines() if line.startswith("| analyze "))
    assert [cell.strip() for cell in row.split("|")[2:-1]] == ["3.0", "3.0", "4", "-", "-", "-"]


def test_report_without_traces_has_no_latency_section(tmp_path: Path):
    golden, traces = _four_items()
    report = build_report(_manifest(), score_items(traces, golden), golden)
    assert report.latency is None
    _, md_path = write_report(report, tmp_path, _budgets())
    assert "Latency" not in md_path.read_text(encoding="utf-8")


def test_committed_budgets_load_as_the_validated_contract():
    budgets = load_latency_budgets(BUDGETS_PATH)
    assert budgets.profiles["chat"].stages["search"] == 400


def test_gate_result_is_identical_with_and_without_latency():
    golden = [_item("en-general-001", "en", answerable=True)]
    traces = [_with_latency(_trace("en-general-001", [("doc.en.md", QUOTE)]), embed=10.0, search=20.0)]
    results = score_items(traces, golden)
    plain = build_report(_manifest(), results, golden)
    timed = build_report(_manifest(), results, golden, traces)
    assert plain.latency is None and timed.latency is not None
    baseline = _baseline(
        deployment_mode="single",
        embedder_version=3,
        corpus_sha256="c" * 64,
        golden_sha256="g" * 64,
        run_config_hash="r" * 64,
        embedder_id="fixture-embedder",
    )
    noise = NoiseConfig.model_validate_json(NOISE_PATH.read_text(encoding="utf-8"))
    assert evaluate_gate(timed, baseline, noise) == evaluate_gate(plain, baseline, noise)


V2_CHAT_STAGES = {
    "translate": 5,
    "embed": 200,
    "search": 400,
    "fuse": 5,
    "dedupe": 5,
    "rerank": 600,
    "refusal": 1,
    "expand_parents": 100,
    "assemble": 100,
    "compress": 50,
    "injection_check": 400,
}
V2_VOICE_STAGES = {
    "translate": 5,
    "embed": 200,
    "search": 300,
    "fuse": 5,
    "dedupe": 5,
    "rerank": 250,
    "refusal": 1,
    "assemble": 50,
    "injection_check": 10,
}
# D-29: per-transform p95 equal to the D-27 timeouts; chat and embed translate moves from the Phase 4 table
# lookup's 5 ms to the query-layer translate timeout, voice keeps 5 ms because voice translate has no D-27 timeout.
QUERY_CHAT_STAGES = {"condense": 600, "translate": 600, "expand": 700, "decompose": 800, "hyde": 900, "semantic_cache": 150}
QUERY_VOICE_STAGES = {"condense": 300}
TERMINOLOGY_CHAT_STAGES = {"terminology": 5}
TERMINOLOGY_VOICE_STAGES = {"terminology": 3}


def test_committed_budgets_carry_the_v2_stage_p95_targets():
    profiles = load_latency_budgets(BUDGETS_PATH).profiles
    assert profiles["chat"].stages == {**V2_CHAT_STAGES, **QUERY_CHAT_STAGES, **TERMINOLOGY_CHAT_STAGES}
    assert profiles["embed"].stages == {**V2_CHAT_STAGES, **QUERY_CHAT_STAGES, **TERMINOLOGY_CHAT_STAGES}
    assert profiles["voice"].stages == {**V2_VOICE_STAGES, **QUERY_VOICE_STAGES, **TERMINOLOGY_VOICE_STAGES}
    assert profiles["chat"].stages["rerank"] == 600 and profiles["voice"].stages["rerank"] == 250


def test_committed_budget_totals_are_unchanged():
    profiles = load_latency_budgets(BUDGETS_PATH).profiles
    assert (profiles["chat"].total_p50_ms, profiles["chat"].total_p95_ms) == (1000, 2000)
    assert (profiles["voice"].total_p50_ms, profiles["voice"].total_p95_ms) == (400, 800)


def test_markdown_shows_rerank_against_the_committed_chat_budget(tmp_path: Path):
    golden, traces = _four_items()
    traces = [_with_latency(trace, rerank=value, search=50.0) for trace, value in zip(traces, [100, 200, 300, 700])]
    report = build_report(_manifest(), score_items(traces, golden), golden, traces)
    _, md_path = write_report(report, tmp_path, load_latency_budgets(BUDGETS_PATH))
    rows = {
        line.split("|")[1].strip(): [cell.strip() for cell in line.split("|")[2:-1]]
        for line in md_path.read_text(encoding="utf-8").splitlines()
        if line.startswith("| ")
    }
    assert rows["rerank"] == ["200.0", "700.0", "4", "-", "600.0", "over"]
    assert rows["search"][-1] == "within"


# --- Phase 4.2 plan 12: TTFT by cache state and pre-generation (D-25, D-27) ---


def _budgets_with_ttft() -> LatencyBudgets:
    data = _budgets().model_dump(mode="json")
    data["ttft"] = {
        "chat": {
            "hit": {"p50_ms": 300, "p95_ms": 600},
            "miss": {"p50_ms": 1500, "p95_ms": 3000},
            "bypass": {"p50_ms": 1500, "p95_ms": 3000},
        }
    }
    data["pre_generation"] = {"chat": {"p95_ms": 1200}}
    return LatencyBudgets.model_validate(data)


def _timed(index: int, cache: str | None, ttft: float | None, pre: float | None) -> RagTrace:
    update: dict[str, object] = {}
    if cache is not None:
        update["cache"] = cache
    if ttft is not None:
        update["ttft_ms"] = ttft
    if pre is not None:
        update["pre_generation_ms"] = pre
    return _trace(f"item-{index}", [("doc.en.md", QUOTE)]).model_copy(update=update)


def _timed_report(traces: list[RagTrace]):
    golden = [_item(trace.item_id, "en", answerable=True) for trace in traces]
    return build_report(_manifest(), score_items(traces, golden), golden, traces)


def test_ttft_groups_by_cache_state_with_nearest_rank():
    traces = [
        _timed(0, "hit", 100, 50),
        _timed(1, "hit", 300, 60),
        _timed(2, "miss", 2000, 900),
        _timed(3, "miss", 1000, 800),
        _timed(4, "miss", 4000, 700),
    ]
    report = _timed_report(traces)
    assert report.ttft is not None
    assert (report.ttft["hit"].p50_ms, report.ttft["hit"].p95_ms, report.ttft["hit"].n) == (100, 300, 2)
    assert (report.ttft["miss"].p50_ms, report.ttft["miss"].p95_ms, report.ttft["miss"].n) == (2000, 4000, 3)
    assert "bypass" not in report.ttft
    assert report.pre_generation is not None
    assert (report.pre_generation["chat"].p50_ms, report.pre_generation["chat"].p95_ms) == (700, 900)
    assert report.pre_generation["chat"].n == 5


def test_ttft_rows_render_hit_miss_bypass_and_pre_generation_against_budgets(tmp_path: Path):
    report = _timed_report([_timed(0, "hit", 100, 50), _timed(1, "miss", 3500, 1300)])
    _, md_path = write_report(report, tmp_path, _budgets_with_ttft())
    md = md_path.read_text(encoding="utf-8")
    assert "## Time to first token (report-only)" in md
    block = md.split("## Time to first token (report-only)", 1)[1].split("\n## ", 1)[0]
    assert "| hit | 100.0 | 100.0 | 1 | 300.0 | 600.0 | within |" in block
    assert "| miss | 3500.0 | 3500.0 | 1 | 1500.0 | 3000.0 | over |" in block
    assert "| bypass | - | - | 0 | 1500.0 | 3000.0 | - |" in block
    assert "| pre-generation | 50.0 | 1300.0 | 2 | - | 1200.0 | over |" in block


def test_ttft_rows_without_ttft_budgets_show_dashes(tmp_path: Path):
    report = _timed_report([_timed(0, "bypass", 800, 400)])
    _, md_path = write_report(report, tmp_path, _budgets())
    md = md_path.read_text(encoding="utf-8")
    assert "## Time to first token (report-only)" in md
    block = md.split("## Time to first token (report-only)", 1)[1]
    assert "| bypass | 800.0 | 800.0 | 1 | - | - | - |" in block
    assert "| pre-generation | 400.0 | 400.0 | 1 | - | - | - |" in block


def test_run_without_timing_data_has_no_ttft_block(tmp_path: Path):
    report = _timed_report([_timed(0, None, None, None)])
    assert report.ttft is None and report.pre_generation is None
    _, md_path = write_report(report, tmp_path, _budgets_with_ttft())
    assert "Time to first token" not in md_path.read_text(encoding="utf-8")
