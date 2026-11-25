import json
from pathlib import Path

import pytest
from rag_sidecar.contracts.eval_run import RagTrace
from rag_sidecar.contracts.golden import GoldenItem
from rag_sidecar.contracts.latency import LatencyBudgets

from rag_eval.metrics import score_items
from rag_eval.report import build_report, load_latency_budgets, write_report
from test_report_runner import QUOTE, _item, _manifest, _trace

BUDGETS_PATH = Path(__file__).resolve().parents[2] / "eval" / "config" / "latency-budgets.json"
PRIVATE_TEXT = "synthetic private wording that must never reach a report"


def _plan(reasons: list[str], *, skipped: list[dict] | None = None, lang: str = "en") -> dict:
    return {
        "original": PRIVATE_TEXT,
        "standalone": PRIVATE_TEXT,
        "language": lang,
        "gate": {
            "rewrite": bool(reasons),
            "transforms": [],
            "reasons": reasons,
            "lang": lang,
            "protected_tokens": [],
        },
        "skipped": skipped or [],
        "framework": "llamaindex",
    }


def _transform(transform: str, status: str, reason: str | None = None, kind: str = "none") -> dict:
    return {"kind": kind, "text": PRIVATE_TEXT, "transform": transform, "status": status, "reason": reason}


def _with(trace: RagTrace, **update) -> RagTrace:
    return RagTrace.model_validate({**trace.model_dump(mode="json"), **update})


def _golden_item(item_id: str, language: str, category: str = "general") -> GoldenItem:
    item = _item(item_id, language, answerable=True)
    return item.model_copy(update={"category": category})


def _query_fixture() -> tuple[list[GoldenItem], list[RagTrace]]:
    golden = [
        _golden_item("en-general-001", "en"),
        _golden_item("en-multi_turn-001", "en", "multi_turn"),
        _golden_item("it-general-001", "it"),
        _golden_item("zh-general-001", "zh"),
        _golden_item("en-general-002", "en"),
        _golden_item("it-general-002", "it"),
    ]
    hit = [("doc.en.md", f"intro {QUOTE} outro")]
    rows = [
        (
            _plan(["R1_PRONOUN"]),
            [_transform("condense", "ok", kind="condensed"), _transform("hyde", "disabled", "disabled")],
            {"query_gate": 1.0, "condense": 400.0},
        ),
        (
            _plan(["R1_PRONOUN"], skipped=[{"transform": "expand", "reason": "timeout"}]),
            [
                _transform("condense", "ok", kind="condensed"),
                _transform("hyde", "disabled", "disabled"),
                _transform("expand", "skipped", "timeout"),
            ],
            {"query_gate": 1.0, "condense": 500.0, "expand": 700.0, "normalize_dates": 2.0},
        ),
        (
            _plan(["R1_PRONOUN"], skipped=[{"transform": "translate", "reason": "protected_token_lost"}], lang="it"),
            [
                _transform("condense", "ok", kind="condensed"),
                _transform("condense", "ok", kind="condensed"),
                _transform("hyde", "disabled", "disabled"),
                _transform("translate", "skipped", "protected_token_lost"),
            ],
            {"query_gate": 1.0, "condense": 300.0, "translate": 200.0},
        ),
        (
            _plan(["R9_KEYWORDS"], lang="zh"),
            [_transform("hyde", "disabled", "disabled")],
            {"query_gate": 1.0},
        ),
        (_plan(["R12_SMALL_TALK"]), [], {"query_gate": 1.0}),
        (_plan(["R12_SMALL_TALK"], lang="it"), [], {"query_gate": 1.0}),
    ]
    traces = []
    for item, (plan, transforms, latency) in zip(golden, rows):
        base = _trace(item.id, hit)
        traces.append(
            _with(
                base,
                query_plan=plan,
                query_transforms=transforms,
                stage_latency_ms={**latency, "embed": 50.0, "search": 100.0},
            )
        )
    return golden, traces


def _build(golden: list[GoldenItem], traces: list[RagTrace], **kwargs):
    return build_report(_manifest(), score_items(traces, golden), golden, traces, **kwargs)


def test_gate_rule_counts_and_transform_statuses():
    golden, traces = _query_fixture()
    layer = _build(golden, traces).query_layer
    assert layer is not None
    assert (layer.items, layer.items_with_plan) == (6, 6)
    assert layer.gate_rules == {"R1_PRONOUN": 3, "R9_KEYWORDS": 1, "R12_SMALL_TALK": 2}
    assert (layer.transforms["condense"].run, layer.transforms["condense"].skipped) == (3, 0)
    assert layer.transforms["hyde"].disabled == 4 and layer.transforms["hyde"].run == 0
    assert (layer.transforms["expand"].skipped, layer.transforms["expand"].skip_reasons) == (1, {"timeout": 1})
    assert layer.transforms["translate"].skip_reasons == {"protected_token_lost": 1}


def test_llm_share_and_protected_token_losses():
    golden, traces = _query_fixture()
    layer = _build(golden, traces).query_layer
    assert (layer.llm_transform_share.value, layer.llm_transform_share.n) == (0.5, 6)
    assert layer.protected_token_losses == 1


def test_query_stage_latency_against_the_query_budget_per_language_and_category():
    golden, traces = _query_fixture()
    layer = _build(golden, traces, budgets=load_latency_budgets(BUDGETS_PATH)).query_layer
    assert layer.budget_profile == "chat"
    assert (layer.query_budget.p50_ms, layer.query_budget.p95_ms) == (600, 1200)
    # Sequential gate + condense + cache plus the slowest parallel transform: 401, 1201, 501, 1, 1, 1.
    assert layer.query_latency.latency.p95_ms == 1201.0
    assert layer.query_latency.status == "over"
    assert layer.query_latency_by_language["en"].latency.p95_ms == 1201.0
    assert layer.query_latency_by_language["en"].status == "over"
    assert layer.query_latency_by_language["it"].latency.p95_ms == 501.0
    assert layer.query_latency_by_language["it"].status == "within"
    assert layer.query_latency_by_category["multi_turn"].status == "over"
    assert layer.query_latency_by_category["general"].latency.n == 5


def _cache(trace: RagTrace, status: str | None, counts: dict[str, float] | None, latency: dict[str, float]) -> RagTrace:
    update: dict = {"stage_latency_ms": latency}
    if status is not None:
        update["stage_status"] = {"semantic_cache": status}
    if counts is not None:
        update["stage_counts"] = {"semantic_cache": counts}
    return _with(trace, **update)


def _pair(item_id: str, category: str, pair_of: str) -> GoldenItem:
    return _item(item_id, "en", answerable=True).model_copy(update={"category": category, "pair_of": pair_of})


def _cache_fixture() -> tuple[list[GoldenItem], list[RagTrace]]:
    golden = [
        _golden_item("en-general-001", "en"),
        _golden_item("en-general-002", "en"),
        _golden_item("en-general-003", "en"),
        _golden_item("en-general-004", "en"),
        _pair("en-cache_near_miss-001", "cache_near_miss", "en-general-001"),
        _pair("en-cache_near_miss-002", "cache_near_miss", "en-general-002"),
        _pair("en-cache_near_miss-003", "cache_near_miss", "en-general-003"),
        _golden_item("en-general-005", "en"),
    ]
    rows = [
        ("ok", {"hit": 1, "distance": 0.02}, {"semantic_cache": 10.0}),
        ("ok", {"hit": 0}, {"semantic_cache": 20.0, "embed": 100.0, "search": 300.0}),
        ("timeout", None, {"semantic_cache": 150.0, "search": 300.0}),
        ("ok", {"bypass_protected_tokens": 1}, {"embed": 100.0, "search": 300.0}),
        ("ok", {"hit": 1, "distance": 0.04}, {"semantic_cache": 30.0}),
        ("ok", {"hit": 0}, {"semantic_cache": 20.0, "embed": 100.0, "search": 500.0}),
        ("ok", {"bypass_protected_tokens": 1}, {"embed": 100.0, "search": 300.0}),
        (None, None, {"embed": 100.0, "search": 300.0}),
    ]
    traces = [
        _cache(_trace(item.id, [("doc.en.md", QUOTE)]), status, counts, latency)
        for item, (status, counts, latency) in zip(golden, rows)
    ]
    return golden, traces


def test_cache_hits_misses_bypasses_and_latency():
    golden, traces = _cache_fixture()
    cache = _build(golden, traces).semantic_cache
    assert cache is not None
    assert (cache.checks, cache.hits, cache.misses, cache.failures) == (5, 2, 3, 1)
    assert cache.bypasses == {"protected_tokens": 2}
    assert (cache.hit_rate.value, cache.hit_rate.n) == (pytest.approx(0.4), 5)
    assert (cache.hit_latency.p50_ms, cache.hit_latency.p95_ms, cache.hit_latency.n) == (10.0, 30.0, 2)
    assert (cache.miss_latency.p50_ms, cache.miss_latency.p95_ms, cache.miss_latency.n) == (450.0, 620.0, 3)


def test_near_miss_wrong_hits_count_only_near_miss_items_whose_check_hit():
    golden, traces = _cache_fixture()
    cache = _build(golden, traces).semantic_cache
    assert (cache.near_miss_checks, cache.near_miss_wrong_hits) == (2, 1)
    assert (cache.near_miss_wrong_hit_rate.value, cache.near_miss_wrong_hit_rate.n) == (0.5, 2)


def test_near_miss_rate_is_absent_without_pair_items():
    golden, traces = _cache_fixture()
    keep = [index for index, item in enumerate(golden) if item.category != "cache_near_miss"]
    cache = _build([golden[i] for i in keep], [traces[i] for i in keep]).semantic_cache
    assert cache.near_miss_checks == 0 and cache.near_miss_wrong_hit_rate is None


def _layer_off() -> tuple[list[GoldenItem], list[RagTrace]]:
    golden = [_golden_item("en-general-001", "en"), _golden_item("it-general-001", "it")]
    traces = [
        _with(_trace("en-general-001", [("doc.en.md", QUOTE)]), stage_latency_ms={"embed": 40.0, "search": 90.0}),
        _with(_trace("it-general-001", []), stage_latency_ms={"embed": 60.0, "search": 110.0}),
    ]
    return golden, traces


def test_layer_off_traces_give_empty_sections():
    golden, traces = _layer_off()
    report = _build(golden, traces)
    layer, cache = report.query_layer, report.semantic_cache
    assert layer is not None and cache is not None
    assert (layer.items, layer.items_with_plan, layer.gate_rules, layer.transforms) == (2, 0, {}, {})
    assert (layer.llm_transform_share.value, layer.llm_transform_share.n) == (None, 0)
    assert layer.query_latency is None and layer.query_latency_by_language == {}
    assert (cache.checks, cache.hits, cache.misses, cache.bypasses) == (0, 0, 0, {})
    assert cache.hit_rate.value is None and cache.near_miss_wrong_hit_rate is None


def test_query_plans_leave_every_existing_report_number_unchanged():
    golden, traces = _layer_off()
    with_plans = [
        _with(trace, query_plan=_plan(["R1_PRONOUN"]), query_transforms=[_transform("condense", "ok", kind="condensed")])
        for trace in traces
    ]
    before = _build(golden, traces).model_dump(mode="json", exclude={"query_layer", "semantic_cache"})
    after = _build(golden, with_plans).model_dump(mode="json", exclude={"query_layer", "semantic_cache"})
    assert before == after


def test_no_traces_means_no_sections():
    golden, _ = _layer_off()
    report = build_report(_manifest(), [], golden, None)
    assert report.query_layer is None and report.semantic_cache is None


def test_reports_hold_no_query_text_and_render_both_sections(tmp_path: Path):
    golden, traces = _query_fixture()
    cache_golden, cache_traces = _cache_fixture()
    budgets = LatencyBudgets.model_validate(json.loads(BUDGETS_PATH.read_text(encoding="utf-8")))
    report = _build(golden, traces, budgets=budgets)
    report = report.model_copy(update={"semantic_cache": _build(cache_golden, cache_traces).semantic_cache})
    json_path, md_path = write_report(report, tmp_path, budgets)
    assert PRIVATE_TEXT not in json_path.read_text(encoding="utf-8")
    markdown = md_path.read_text(encoding="utf-8")
    assert PRIVATE_TEXT not in markdown
    assert "## Query layer (report-only)" in markdown
    assert "## Semantic cache (report-only)" in markdown
    assert "| R1_PRONOUN | 3 |" in markdown
    assert "| expand | 0 | 0 | 1 | timeout 1 |" in markdown


def test_layer_off_markdown_has_no_new_sections(tmp_path: Path):
    golden, traces = _layer_off()
    _, md_path = write_report(_build(golden, traces), tmp_path, load_latency_budgets(BUDGETS_PATH))
    markdown = md_path.read_text(encoding="utf-8")
    assert "## Query layer" not in markdown and "## Semantic cache" not in markdown
