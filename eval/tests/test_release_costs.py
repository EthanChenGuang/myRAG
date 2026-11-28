import json
import math
import re
from pathlib import Path

import pytest
from rag_sidecar.contracts.baseline import NoiseConfig
from rag_sidecar.contracts.eval_run import RagTrace
from rag_sidecar.contracts.latency import LatencyBudgets
from rag_sidecar.contracts.release import DefaultsDecision
from rag_sidecar.contracts.report import EvalReport
from rag_sidecar.contracts.samples import build_samples

from rag_eval import regression
from rag_eval.regression_rules import RuleSettings, RunSummary
from rag_eval.release_costs import (
    NOT_MEASURED,
    NOT_PROVIDED,
    PRICE_TABLE_PATH,
    IngestDocument,
    IngestUsage,
    PriceTableError,
    ingest_cost_per_1000,
    language_quality,
    latency_summary,
    load_price_table,
    query_cost_per_1000,
    read_ingest_outputs,
)

EVAL_DIR = Path(__file__).resolve().parents[1]
REPO = EVAL_DIR.parent
SAMPLES = build_samples()


def _table(tmp_path: Path, entries: list[dict]) -> Path:
    path = tmp_path / "prices.json"
    path.write_text(json.dumps({"schema_version": 1, "entries": entries}), encoding="utf-8")
    return path


def _entry(key: str, usd: float | None, unit: str = "usd_per_million_tokens") -> dict:
    return {"id": key, "kind": key.split(":")[0], "provider": "p", "model": None, "unit": unit, "usd": usd, "as_of": "2026-11-28", "source": "test"}


@pytest.fixture()
def prices(tmp_path):
    return load_price_table(
        _table(
            tmp_path,
            [
                _entry("embedding:profile-a", 0.02),
                _entry("embedding:profile-b", None),
                _entry("parse:fast", 0.001, "usd_per_page"),
                _entry("parse:premium", None, "usd_per_page"),
                _entry("enrichment:tokens", None),
                _entry("store_point:qdrant", 0.0001, "usd_per_point"),
                _entry("store_point:weaviate", None, "usd_per_point"),
                _entry("rerank:cohere", 0.002, "usd_per_call"),
                _entry("rerank:voyage", None, "usd_per_call"),
                _entry("generation:input", 1.0),
                _entry("generation:output", None),
                _entry("store_request:qdrant", None, "usd_per_request"),
            ],
        )
    )


def _trace(**update) -> RagTrace:
    payload = dict(SAMPLES["variants"]["RagTrace:retrieval_backend"]["value"])
    payload.update(update)
    return RagTrace.model_validate(payload)


# ---------------------------------------------------------------- price table


def test_the_committed_price_table_loads_and_copies_only_in_repo_prices():
    table = load_price_table()
    catalog = (REPO / "src" / "lib" / "rag" / "embeddings" / "catalog.ts").read_text(encoding="utf-8")
    listed = {float(value) for value in re.findall(r"usdPerMillionTokens:\s*([0-9.]+)", catalog)}
    routing = json.loads((REPO / "config" / "rag" / "parse-routing.json").read_text(encoding="utf-8"))["costs"]["tier"]
    for key, usd in table.prices.items():
        kind, _, name = key.partition(":")
        if kind == "embedding":
            assert usd in listed, key
        elif kind == "parse":
            assert usd == routing[name]["usd_per_page"], key
        else:
            assert usd is None, f"{key} has no in-repo price source and must stay null"


def test_the_basis_sha_changes_when_the_table_changes(tmp_path):
    first = load_price_table(_table(tmp_path, [_entry("embedding:profile-a", 0.02)]))
    second = load_price_table(_table(tmp_path, [_entry("embedding:profile-a", 0.03)]))
    assert first.sha256 != second.sha256
    assert load_price_table(PRICE_TABLE_PATH).sha256 != first.sha256


@pytest.mark.parametrize("usd", [-1, float("nan"), "0.1", True])
def test_a_bad_price_is_refused(tmp_path, usd):
    with pytest.raises(PriceTableError):
        load_price_table(_table(tmp_path, [_entry("embedding:profile-a", usd)]))


# ---------------------------------------------------------------- ingest cost


def test_four_ingest_entries_for_two_profiles_and_two_backends(prices):
    docs = [IngestDocument(pages=2, tier="fast", attempt_costs=(0.002, 0.004)), IngestDocument(pages=1, tier="fast", attempt_costs=(0.001,))]
    rows = [
        ingest_cost_per_1000(profile, backend, docs, IngestUsage(embedding_tokens=1000, stored_points=10), prices).row
        for profile in ("profile-a", "profile-b")
        for backend in ("pgvector", "qdrant")
    ]
    assert {(row.embedding_profile, row.backend) for row in rows} == {
        ("profile-a", "pgvector"), ("profile-a", "qdrant"), ("profile-b", "pgvector"), ("profile-b", "qdrant")
    }
    first = rows[0].documents
    assert math.isclose(first.parse.usd, (0.002 + 0.004 + 0.001) * 1000 / 2)
    assert math.isclose(first.embedding.usd, 1000 * 0.02 / 1_000_000 * 1000 / 2)
    assert first.external_store.usd == 0.0
    assert math.isclose(rows[1].documents.external_store.usd, 10 * 0.0001 * 1000 / 2)


def test_ledger_parse_cost_is_measured_and_tier_estimates_are_estimated(prices):
    measured = ingest_cost_per_1000("profile-a", "pgvector", [IngestDocument(pages=3, tier="fast", attempt_costs=(0.5,))], IngestUsage(), prices)
    assert measured.estimated is False and math.isclose(measured.row.documents.parse.usd, 500.0)
    estimated = ingest_cost_per_1000("profile-a", "pgvector", [IngestDocument(pages=4, tier="fast")], IngestUsage(), prices)
    assert estimated.estimated is True and math.isclose(estimated.row.documents.parse.usd, 4 * 0.001 * 1000)


def test_a_null_price_is_not_provided_never_zero(prices):
    cost = ingest_cost_per_1000(
        "profile-b", "weaviate", [IngestDocument(pages=4, tier="premium")], IngestUsage(embedding_tokens=50, enrichment_tokens=9, stored_points=3), prices
    ).row.documents
    for part in (cost.parse, cost.embedding, cost.enrichment, cost.external_store):
        assert part.usd is None and part.reason == NOT_PROVIDED


def test_a_component_never_recorded_is_not_measured(prices):
    cost = ingest_cost_per_1000("profile-a", "qdrant", [IngestDocument()], IngestUsage(), prices).row.documents
    for part in (cost.parse, cost.embedding, cost.enrichment, cost.external_store):
        assert part.usd is None and part.reason == NOT_MEASURED
    empty = ingest_cost_per_1000("profile-a", "pgvector", [], IngestUsage(), prices).row.documents
    assert empty.parse.reason == NOT_MEASURED and empty.embedding.reason == NOT_MEASURED


@pytest.mark.parametrize("bad", [IngestUsage(embedding_tokens=-1), IngestUsage(stored_points=float("nan"))])
def test_negative_or_nan_inputs_raise(prices, bad):
    with pytest.raises(ValueError):
        ingest_cost_per_1000("profile-a", "qdrant", [IngestDocument(pages=1, tier="fast")], bad, prices)
    with pytest.raises(ValueError):
        ingest_cost_per_1000("profile-a", "pgvector", [IngestDocument(pages=-2, tier="fast")], IngestUsage(), prices)


def test_the_ingest_ledger_file_feeds_the_documents(tmp_path):
    ledger = {"jobs": [{"pages": 2, "tier": "fast", "attempts": [{"est_cost": 0.01}, {"est_cost": 0.02}]}, {"pages": 1, "tier": "fast", "attempts": []}]}
    (tmp_path / "ingest-ledger.json").write_text(json.dumps(ledger), encoding="utf-8")
    documents, usage = read_ingest_outputs(tmp_path)
    assert documents == [IngestDocument(pages=2, tier="fast", attempt_costs=(0.01, 0.02)), IngestDocument(pages=1, tier="fast", attempt_costs=None)]
    assert usage == IngestUsage()
    assert read_ingest_outputs(tmp_path / "missing") == (None, IngestUsage())


# ---------------------------------------------------------------- query cost


def test_per_1000_queries_scales_the_mean_and_keeps_the_parts_separate(prices):
    traces = [
        _trace(stage_latency_ms={"rerank": 10.0}, usage={"input_tokens": 300, "output_tokens": 0}),
        _trace(stage_latency_ms={"rerank": 12.0}, usage={"input_tokens": 100, "output_tokens": 0}),
        _trace(stage_latency_ms={}, usage={"input_tokens": 0, "output_tokens": 0}),
        _trace(stage_latency_ms={"rerank": 9.0}, stage_status={"rerank": "skipped"}),
    ]
    row = query_cost_per_1000("cfg", {"RAG_RERANKER": "cohere"}, "pgvector", traces, prices, query_embedding_tokens=40, embedding_profile="profile-a")
    parts = row.queries
    assert math.isclose(parts.rerank.usd, 2 * 0.002 * 1000 / 4)
    assert math.isclose(parts.generation.usd, 400 * 1.0 / 1_000_000 * 1000 / 4)
    assert math.isclose(parts.query_embedding.usd, 40 * 0.02 / 1_000_000 * 1000 / 4)
    assert parts.external_store.usd == 0.0


def test_query_cost_null_rules(prices):
    traces = [
        _trace(
            stage_latency_ms={"rerank": 1.0},
            usage={"input_tokens": 1, "output_tokens": 5},
            retrieval_backend={"backend": "qdrant", "fallback_reason": None, "tenant_validation_dropped": 0},
        )
    ]
    parts = query_cost_per_1000("cfg", {"RAG_RERANKER": "voyage"}, "qdrant", traces, prices, embedding_profile="profile-a").queries
    assert parts.query_embedding.reason == NOT_MEASURED
    assert parts.rerank.reason == NOT_PROVIDED
    assert parts.generation.reason == NOT_PROVIDED
    assert parts.external_store.reason == NOT_PROVIDED
    no_usage = query_cost_per_1000("cfg", {"RAG_RERANKER": "auto"}, "pgvector", [_trace(stage_latency_ms={"rerank": 1.0})], prices).queries
    assert no_usage.generation.reason == NOT_MEASURED
    assert no_usage.rerank.usd == 0.0


# ---------------------------------------------------------------- latency


def _budgets() -> LatencyBudgets:
    return LatencyBudgets.model_validate(
        {
            "profiles": {
                "chat": {"total_p50_ms": 500, "total_p95_ms": 1000, "stages": {"embed": 100, "rerank": 200, "condense": 50}},
                "voice": {"total_p50_ms": 200, "total_p95_ms": 400},
            },
            "pre_generation": {"chat": {"p95_ms": 900}, "voice": {"p95_ms": 400}},
        }
    )


def _report(latency: dict | None, pre: dict | None, items: list[dict] | None = None) -> EvalReport:
    slice_ = {name: {"value": 0.5, "n": 1} for name in ("recall_at_5", "recall_at_10", "mrr", "correct_refusal_rate", "false_refusal_rate")}
    payload = {
        "run_id": "r",
        "tier": "smoke",
        "run_config_hash": "r" * 64,
        "golden_sha256": "g" * 64,
        "golden_filter": {"review_statuses": ["approved"], "gate_split": "dev"},
        "deployment_mode": "single-tenant",
        "request_options": {},
        "k_values": [5, 10],
        "overall": slice_,
        "by_language": {},
        "by_category": {},
        "by_language_category": {},
        "by_split": {},
        "items": items or [],
    }
    if latency is not None:
        payload["latency"] = latency
    if pre is not None:
        payload["pre_generation"] = pre
    return EvalReport.model_validate(payload)


def test_latency_matches_the_report_and_flags_values_over_budget():
    report = _report(
        {
            "embed": {"p50_ms": 40.0, "p95_ms": 90.0, "n": 10},
            "rerank": {"p50_ms": 150.0, "p95_ms": 250.0, "n": 10},
            "condense": {"p50_ms": 30.0, "p95_ms": 70.0, "n": 10},
            "retrieval_total": {"p50_ms": 300.0, "p95_ms": 700.0, "n": 10},
        },
        {"chat": {"p50_ms": 320.0, "p95_ms": 950.0, "n": 10}},
    )
    summary = latency_summary({"cfg": report}, _budgets(), "b" * 64)
    chat = next(entry for entry in summary.entries if entry.channel == "chat")
    values = {value.stage: value for value in chat.values}
    assert values["total"].p50_ms == 320.0 and values["total"].p95_ms == 950.0
    assert values["total"].budget_p50_ms == 500 and values["total"].budget_p95_ms == 900
    assert values["total"].within_budget is False
    assert values["embed"].within_budget is True and values["embed"].budget_p95_ms == 100
    assert values["rerank"].within_budget is False
    assert values["condense"].report_only is True and values["condense"].within_budget is False
    assert values["embed"].report_only is False
    assert "retrieval_total" not in values
    voice = next(entry for entry in summary.entries if entry.channel == "voice")
    assert [value.stage for value in voice.values] == ["total"] and voice.values[0].within_budget is None


def test_latency_reads_the_committed_budgets_file():
    budgets = LatencyBudgets.model_validate_json((EVAL_DIR / "config" / "latency-budgets.json").read_text(encoding="utf-8"))
    report = _report({"retrieval_total": {"p50_ms": 100.0, "p95_ms": 300.0, "n": 3}, "search": {"p50_ms": 50.0, "p95_ms": 500.0, "n": 3}}, None)
    chat = latency_summary({"cfg": report}, budgets, "c" * 64).entries[0]
    values = {value.stage: value for value in chat.values}
    assert values["total"].budget_p95_ms == budgets.pre_generation["chat"].p95_ms
    assert values["search"].budget_p95_ms == budgets.profiles["chat"].stages["search"]
    assert values["search"].within_budget is False


# ---------------------------------------------------------------- per-language quality


def _settings(min_gate_n: int = 10) -> RuleSettings:
    noise = NoiseConfig.model_validate(json.loads((EVAL_DIR / "config" / "noise.json").read_text(encoding="utf-8")))
    return RuleSettings.build(noise, None, gated_slice_prefixes=("overall", "language:"), min_gate_n=min_gate_n, alpha=0.05)


def _summary(name: str, hits: dict[str, int], sizes: dict[str, int]) -> RunSummary:
    metrics: dict = {}
    slices: dict = {}
    for language, size in sizes.items():
        for index in range(size):
            item = f"{language}{index:03d}"
            metrics[item] = {"recall_at_10": 1.0 if index < hits[language] else 0.0, "correct_refusal_rate": None}
            slices[item] = ("overall", f"language:{language}")
    return RunSummary(config_name=name, metrics=metrics, slices=slices)


def test_language_quality_against_the_incumbent_with_too_small_languages():
    sizes = {"en": 20, "it": 20, "zh": 4}
    incumbent = _summary("inc", {"en": 10, "it": 10, "zh": 2}, sizes)
    adopted = _summary("ado", {"en": 12, "it": 6, "zh": 0}, sizes)
    rows = {row.language: row for row in language_quality(adopted, incumbent, ["en", "it", "zh"], _settings())}
    assert rows["en"].below_baseline is False and math.isclose(rows["en"].difference, 0.1)
    assert rows["it"].below_baseline is True and math.isclose(rows["it"].baseline, 0.5)
    assert rows["zh"].below_baseline is None and rows["zh"].reason == "too_small" and rows["zh"].n == 4
    assert rows["en"].band == 0.02 and rows["en"].metric == "recall_at_10+correct_refusal_rate"


# ---------------------------------------------------------------- decide and annotate (synthetic harness)


@pytest.fixture()
def harness_world(tmp_path):
    from test_regression import FakeHarness

    return tmp_path, FakeHarness


def _run_fixture_b(tmp_path, harness, *extra):
    import test_regression as tr

    world = {"dir": tmp_path, "ledger": tmp_path / "decisions" / "test-split-ledger.jsonl", "decisions": tmp_path / "decisions", "record": tmp_path / "config" / "release-defaults.json"}
    plan_path = tr._plan_b(world, harness)
    assert tr._run_b(world, plan_path, harness) == 0
    return world, plan_path


def test_decide_writes_the_three_blocks_and_annotate_check_agrees(harness_world):
    import test_regression as tr

    tmp_path, FakeHarness = harness_world
    world, plan_path = _run_fixture_b(tmp_path, FakeHarness())
    assert tr._decide_b(world, plan_path, "--fixtures") == 0
    decision = DefaultsDecision.model_validate_json(world["record"].read_text(encoding="utf-8"))
    assert decision.cost and decision.latency and decision.per_language and decision.provisional == "fixtures"
    assert decision.cost.basis.price_table_sha256 == load_price_table().sha256
    markdown = (world["decisions"] / "defaults-fixtures.md").read_text(encoding="utf-8")
    assert "Cost per 1,000 documents ingested" in markdown and "Per-language quality" in markdown
    argv = ["annotate", "--record", world["record"], "--plan", plan_path, "--runs-dir", world["dir"] / "runs-b", "--decisions-dir", world["decisions"], "--check"]
    assert tr._main(argv) == 0
    stale = decision.model_copy(update={"per_language": None})
    world["record"].write_text(stale.model_dump_json(indent=2) + "\n", encoding="utf-8")
    assert tr._main(argv) == 1
    assert DefaultsDecision.model_validate_json(world["record"].read_text(encoding="utf-8")).per_language is None
    assert tr._main(argv[:-1]) == 0
    rewritten = DefaultsDecision.model_validate_json(world["record"].read_text(encoding="utf-8"))
    assert rewritten.per_language == decision.per_language
    assert tr._main(argv) == 0


def test_annotate_without_run_outputs_stops(harness_world, capsys):
    import test_regression as tr

    tmp_path, FakeHarness = harness_world
    world, plan_path = _run_fixture_b(tmp_path, FakeHarness())
    assert tr._decide_b(world, plan_path, "--fixtures") == 0
    argv = ["annotate", "--record", world["record"], "--plan", plan_path, "--runs-dir", tmp_path / "empty", "--decisions-dir", world["decisions"], "--check"]
    assert tr._main(argv) == 2
    assert "needs the stage-B runs" in capsys.readouterr().err


class LanguageDropHarness:
    """FakeHarness plus 20 Italian items. The stage-B combinations lose every Italian hit (so the incumbent stays the
    winner); the context-tagging ablation loses one, which keeps the overall primary inside the band and drops Italian
    beyond it."""

    def __init__(self, base):
        self.base = base

    def __call__(self, config, *, split, golden, out_dir):
        artifacts = self.base(config, split=split, golden=golden, out_dir=out_dir)
        report = artifacts.report.model_dump(mode="json")
        combo = config.name.startswith("b.") and config.name != regression.INCUMBENT_CONFIG
        tagging = config.name == "ablate.rag_context_tagging" and config.env.get("RAG_CONTEXT_TAGGING") == "true"
        for index in range(20):
            hits = 0 if combo else (14 if tagging else 15)
            hit = 1 if index < hits else 0
            report["items"].append(
                {
                    "item_id": f"it{index:03d}",
                    "language": "it",
                    "category": "general",
                    "split": split,
                    "provenance": "synthetic_fixture",
                    "answerable": True,
                    "refused": False,
                    "span_count": 1,
                    "spans_hit_at_5": hit,
                    "spans_hit_at_10": hit,
                    "first_hit_rank": 1 if hit else None,
                }
            )
        (out_dir / "report.json").write_text(EvalReport.model_validate(report).model_dump_json(), encoding="utf-8")
        return regression.load_artifacts(out_dir)


def test_language_below_baseline_keeps_the_incumbent_for_that_switch(monkeypatch, harness_world):
    import test_regression as tr

    tmp_path, FakeHarness = harness_world
    harness = LanguageDropHarness(FakeHarness())
    world, plan_path = _run_fixture_b(tmp_path, harness)
    # The language slice would stop the switch at the slice gate; take language slices out of the gate so the
    # ADM-02 language rule is what decides.
    original = regression._settings_for

    def settings_without_language_gate(plan, noise, budgets):
        built = original(plan, noise, budgets)
        return RuleSettings(**{**built.__dict__, "gated_slice_prefixes": ("overall",)})

    monkeypatch.setattr(regression, "_settings_for", settings_without_language_gate)
    assert tr._decide_b(world, plan_path, "--fixtures") == 0
    decision = DefaultsDecision.model_validate_json(world["record"].read_text(encoding="utf-8"))
    tagging = next(verdict for verdict in decision.verdicts if verdict.switch == "RAG_CONTEXT_TAGGING")
    assert tagging.decision == "keep_incumbent" and tagging.reason == "language_below_baseline"
    assert decision.defaults["RAG_CONTEXT_TAGGING"] == decision.incumbent["RAG_CONTEXT_TAGGING"]
    assert all(row.below_baseline is not True for row in decision.per_language)
    assert "language_below_baseline" in (world["decisions"] / "defaults-fixtures.md").read_text(encoding="utf-8")


def test_an_incumbent_run_that_is_not_the_phase41_decision_makes_decide_exit_2(harness_world, capsys):
    import test_regression as tr

    tmp_path, FakeHarness = harness_world
    world, plan_path = _run_fixture_b(tmp_path, FakeHarness())
    index_path = world["dir"] / "runs-b" / regression.RUN_INDEX
    index = json.loads(index_path.read_text(encoding="utf-8"))
    index["entries"][regression.INCUMBENT_CONFIG]["config"]["env"]["RAG_RERANKER"] = "voyage"
    index_path.write_text(json.dumps(index), encoding="utf-8")
    assert tr._decide_b(world, plan_path, "--fixtures") == 2
    assert "not the Phase 4.1 decision" in capsys.readouterr().err
    assert not world["record"].exists()
