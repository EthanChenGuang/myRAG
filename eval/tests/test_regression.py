import json
from pathlib import Path

import pytest
from rag_sidecar.contracts.eval_run import RagTrace
from rag_sidecar.contracts.release import DefaultsDecision, RegressionPlan, RegressionRunConfig
from rag_sidecar.contracts.report import EvalReport
from rag_sidecar.contracts.samples import build_samples

from rag_eval import regression
from rag_eval.regression import (
    ABLATIONS,
    CONFIRM_CONFIG,
    INCUMBENT_CONFIG,
    LEGACY_PROFILE,
    RunArtifacts,
    markdown_path,
    read_ledger,
)

SAMPLES = build_samples()
EVAL_DIR = Path(__file__).resolve().parents[1]
INCUMBENT_FILE = EVAL_DIR / "decisions" / "04.1-retrieval-defaults.json"
CLOCK = "2026-11-27T12:00:00Z"
ANSWERABLE = 60
UNANSWERABLE = 12
TABLE_ITEMS = 4


def _clock() -> str:
    return CLOCK


def _metric(value: float, n: int) -> dict:
    return {"value": value, "n": n}


def _slice() -> dict:
    return {name: _metric(0.5, 1) for name in ("recall_at_5", "recall_at_10", "mrr", "correct_refusal_rate", "false_refusal_rate")}


def _hits(config: RegressionRunConfig) -> int:
    env, overrides = config.env, config.overrides
    hits = 20
    if overrides.get("embedding_profile") == "bge-m3-1024":
        hits += 4
    if env.get("RAG_RERANKER") == "local_bm25":
        hits += 2
    if env.get("RAG_PARENT_CHILD") == "true":
        hits += 8
    if env.get("RAG_CONTEXT_EDGE_ORDER") == "true":
        hits += 8
    return hits


class FakeHarness:
    """Writes report.json, traces.jsonl and run.json from a synthetic model of each switch."""

    def __init__(self, *, interaction_slow: bool = False, fallback: str | None = None) -> None:
        self.calls: list[str] = []
        self.interaction_slow = interaction_slow
        self.fallback = fallback

    def __call__(self, config, *, split, golden, out_dir) -> RunArtifacts:
        self.calls.append(config.name)
        hits = _hits(config)
        items = []
        for index in range(ANSWERABLE):
            hit = 1 if index < hits else 0
            items.append(
                {
                    "item_id": f"a{index:03d}",
                    "language": "en",
                    "category": "table" if index >= ANSWERABLE - TABLE_ITEMS else "general",
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
        for index in range(UNANSWERABLE):
            items.append(
                {
                    "item_id": f"u{index:03d}",
                    "language": "en",
                    "category": "no_answer",
                    "split": split,
                    "provenance": "synthetic_fixture",
                    "answerable": False,
                    "refused": True,
                    "span_count": 0,
                    "spans_hit_at_5": 0,
                    "spans_hit_at_10": 0,
                }
            )
        slow = self.interaction_slow and config.env.get("RAG_PARENT_CHILD") == "true" and config.env.get("RAG_CONTEXT_EDGE_ORDER") == "true"
        report = EvalReport.model_validate(
            {
                "run_id": f"run-{config.name}",
                "tier": "smoke",
                "run_config_hash": "r" * 64,
                "golden_sha256": "g" * 64,
                "golden_filter": {"review_statuses": ["approved"], "gate_split": "dev"},
                "deployment_mode": "single-tenant",
                "request_options": {},
                "k_values": [5, 10],
                "overall": _slice(),
                "by_language": {"en": _slice()},
                "by_category": {"general": _slice()},
                "by_language_category": {},
                "by_split": {},
                "items": items,
                "pre_generation": {"chat": {"p50_ms": 400.0, "p95_ms": 2600.0 if slow else 900.0, "n": len(items)}},
                "injection": {
                    "config_label": "other",
                    "items": 12,
                    "attack_success_rate": {"category:injection": _metric(0.0, 12)},
                    "rules_false_positive_count": 0,
                    "gate": "report_only",
                },
            }
        )
        out_dir.mkdir(parents=True, exist_ok=True)
        (out_dir / "report.json").write_text(report.model_dump_json(), encoding="utf-8")
        backend = config.overrides.get("backend", "pgvector")
        trace = dict(SAMPLES["variants"]["RagTrace:retrieval_backend"]["value"])
        fallback = self.fallback if backend != "pgvector" else None
        trace["retrieval_backend"] = {"backend": backend, "fallback_reason": fallback, "tenant_validation_dropped": 0}
        (out_dir / "traces.jsonl").write_text(RagTrace.model_validate(trace).model_dump_json() + "\n", encoding="utf-8")
        impl = "fake" if backend != "pgvector" else None
        (out_dir / "run.json").write_text(json.dumps({"backend_impl": impl} if impl else {}), encoding="utf-8")
        return regression.load_artifacts(out_dir)


@pytest.fixture()
def world(tmp_path):
    return {
        "dir": tmp_path,
        "ledger": tmp_path / "decisions" / "test-split-ledger.jsonl",
        "decisions": tmp_path / "decisions",
        "record": tmp_path / "config" / "release-defaults.json",
    }


def _main(argv, runner=None):
    return regression.main([str(part) for part in argv], clock=_clock, runner=runner)


def _plan_a(world) -> Path:
    out = world["dir"] / "plan-a.json"
    assert _main(["plan", "--stage", "a", "--split", "dev", "--fixtures", "--out", out, "--incumbent", INCUMBENT_FILE]) == 0
    return out


def _stage_a(world, harness) -> Path:
    plan = _plan_a(world)
    runs = world["dir"] / "runs-a"
    assert _main(["run", "--plan", plan, "--fixtures", "--runs-dir", runs, "--ledger", world["ledger"], "--incumbent", INCUMBENT_FILE], harness) == 0
    out = world["dir"] / "plan-a.decision.json"
    assert _main(["decide", "--plan", plan, "--fixtures", "--runs-dir", runs, "--out", out]) == 0
    return out


def _plan_b(world, harness) -> Path:
    decision = _stage_a(world, harness)
    out = world["dir"] / "plan-b.json"
    args = ["plan", "--stage", "b", "--split", "test", "--fixtures", "--out", out, "--stage-a-decision", decision, "--incumbent", INCUMBENT_FILE]
    assert _main(args) == 0
    return out


def _run_b(world, plan, harness, *extra):
    args = ["run", "--plan", plan, "--fixtures", "--runs-dir", world["dir"] / "runs-b", "--ledger", world["ledger"], "--incumbent", INCUMBENT_FILE, *extra]
    return _main(args, harness)


def _decide_b(world, plan, *extra):
    args = [
        "decide", "--plan", plan, "--runs-dir", world["dir"] / "runs-b", "--ledger", world["ledger"], "--incumbent", INCUMBENT_FILE,
        "--out", world["record"], "--decisions-dir", world["decisions"], *extra,
    ]
    return _main(args)


def test_plan_stage_a_lists_every_profile_and_reranker_on_pgvector(world):
    plan = RegressionPlan.model_validate_json(_plan_a(world).read_text())
    assert plan.stage == "a" and plan.split == "dev" and plan.test_split_budget == 0
    profiles = {config.overrides["embedding_profile"] for config in plan.configs}
    rerankers = {config.env["RAG_RERANKER"] for config in plan.configs}
    assert profiles == {LEGACY_PROFILE, "bge-m3-1024"}
    assert rerankers == {"none", "local_bm25", "auto", "cohere"}
    assert len(plan.configs) == 2 * 4
    assert {config.overrides["backend"] for config in plan.configs} == {"pgvector"}
    assert plan.incumbent_config == "a.openai-3-small-1536.auto"
    for config in plan.configs:
        if config.overrides["embedding_profile"] != LEGACY_PROFILE:
            assert config.env["RAG_EMBEDDING_PROFILES"] == "on"
        assert config.env["RAG_CONTEXT_TAGGING"] == "true" and config.env["RAG_INJECTION_CHECK"] == "drop"


def test_plan_stage_a_refuses_the_test_split_and_stage_b_the_dev_split(world, capsys):
    out = world["dir"] / "p.json"
    assert _main(["plan", "--stage", "a", "--split", "test", "--fixtures", "--out", out]) == 2
    assert _main(["plan", "--stage", "b", "--split", "dev", "--fixtures", "--out", out]) == 2
    assert _main(["plan", "--stage", "b", "--split", "test", "--fixtures", "--out", out]) == 2
    assert "stage-a-decision" in capsys.readouterr().err
    assert not out.exists()


def test_a_missing_incumbent_decision_stops_before_any_plan(world):
    out = world["dir"] / "p.json"
    assert _main(["plan", "--stage", "a", "--split", "dev", "--fixtures", "--out", out, "--incumbent", world["dir"] / "missing.json"]) == 2
    assert not out.exists()


def test_stage_a_on_dev_writes_no_ledger_line_and_ranks_the_top_two(world):
    harness = FakeHarness()
    decision = json.loads(_stage_a(world, harness).read_text())
    assert not world["ledger"].exists()
    assert [config["name"] for config in decision["top"]] == ["a.bge-m3-1024.local_bm25", "a.bge-m3-1024.auto"]
    assert len(harness.calls) == 8


def test_plan_stage_b_registers_backends_ablations_and_one_confirmatory_run(world):
    plan = RegressionPlan.model_validate_json(_plan_b(world, FakeHarness()).read_text())
    names = [config.name for config in plan.configs]
    assert plan.stage == "b" and plan.split == "test"
    assert plan.incumbent_config == INCUMBENT_CONFIG
    assert [name for name in names if name.startswith("b.") and name != INCUMBENT_CONFIG] == [
        f"b.{backend}.c{index}" for index in (1, 2) for backend in ("pgvector", "weaviate", "qdrant")
    ]
    assert [name for name in names if name.startswith("ablate.")] == [f"ablate.{ablation.switch.lower()}" for ablation in ABLATIONS]
    assert names[-1] == CONFIRM_CONFIG and names.count(CONFIRM_CONFIG) == 1
    assert plan.test_split_budget == len(plan.configs)
    incumbent = next(config for config in plan.configs if config.name == INCUMBENT_CONFIG)
    assert incumbent.env["RAG_PIPELINE"] == "v2" and incumbent.env["RAG_CONTEXT_TAGGING"] == "false"
    assert "COHERE_API_KEY" not in incumbent.env


def test_stage_b_run_records_every_test_split_use_and_decide_writes_a_valid_provisional_record(world):
    harness = FakeHarness()
    plan_path = _plan_b(world, harness)
    plan = RegressionPlan.model_validate_json(plan_path.read_text())
    harness.calls.clear()
    assert _run_b(world, plan_path, harness) == 0
    lines = read_ledger(world["ledger"])
    assert [line.config_name for line in lines] == harness.calls
    assert {line.plan_sha256 for line in lines} == {plan.canonical_sha256()}
    assert {(line.golden_set, line.split, line.registered) for line in lines} == {("fixtures", "test", True)}
    assert len(lines) <= plan.test_split_budget
    assert CONFIRM_CONFIG in harness.calls

    assert _decide_b(world, plan_path, "--fixtures") == 0
    decision = DefaultsDecision.model_validate_json(world["record"].read_text())
    assert decision.provisional == "fixtures" and decision.backend == "pgvector"
    assert decision.plan_sha256 == plan.canonical_sha256()
    assert decision.embedding_profile == "bge-m3-1024" and decision.reranker == "local_bm25"
    assert len(decision.test_split_uses) == len(lines)
    assert {result.invalid_reason for result in decision.backend_comparison.results} == {"backend_impl_fake"}
    verdicts = {verdict.switch: verdict for verdict in decision.verdicts}
    assert verdicts["RAG_PARENT_CHILD"].decision == "adopt"
    assert verdicts["RAG_CONTEXT_EDGE_ORDER"].decision == "adopt"
    assert verdicts["RAG_CONTEXT_TAGGING"].reason == "security_wins_ties"
    assert verdicts["RAG_CONTEXT_COMPRESSION"].decision == "keep_incumbent"
    assert "category:table" in verdicts["RAG_PARENT_CHILD"].too_small_slices
    assert decision.defaults["RAG_PARENT_CHILD"] == "true" and decision.defaults["RAG_CONTEXT_TAGGING"] == "true"
    assert decision.defaults["RAG_CONTEXT_COMPRESSION"] == "false"
    assert decision.defaults["RAG_EMBEDDING_PROFILES"] == "on"
    assert set(decision.defaults) <= set(decision.incumbent)
    assert "COHERE_API_KEY" not in decision.defaults
    assert set(decision.config_hashes) >= {INCUMBENT_CONFIG, CONFIRM_CONFIG, "ablate.rag_parent_child"}

    markdown = (world["decisions"] / "defaults-fixtures.md").read_text()
    assert f"Test-split uses: {len(lines)}" in markdown
    assert decision.plan_sha256 in markdown
    assert "category:table" in markdown and "too small" in markdown.lower()
    assert "backend_impl_fake" in markdown
    assert "| RAG_PARENT_CHILD | false | true | ablation verdict adopt (gain_beyond_band) |" in markdown
    for name, sha in decision.config_hashes.items():
        assert f"| {name} | `{sha}` |" in markdown
    assert not list(world["decisions"].glob("defaults-2*.md"))


def test_a_second_run_reuses_the_outputs_and_records_no_new_use(world):
    harness = FakeHarness()
    plan_path = _plan_b(world, harness)
    assert _run_b(world, plan_path, harness) == 0
    count = len(read_ledger(world["ledger"]))
    harness.calls.clear()
    assert _run_b(world, plan_path, harness) == 0
    assert harness.calls == [] and len(read_ledger(world["ledger"])) == count


def test_an_unregistered_test_split_config_is_refused_without_a_reason(world, capsys):
    harness = FakeHarness()
    plan_path = _plan_b(world, harness)
    extra = world["dir"] / "extra.json"
    extra.write_text(RegressionRunConfig(name="b.extra", env={"RAG_PARENT_CHILD": "true"}).model_dump_json())
    harness.calls.clear()
    assert _run_b(world, plan_path, harness, "--extra-config", extra) == 2
    assert "--reason" in capsys.readouterr().err
    assert harness.calls == [] and not world["ledger"].exists()


def test_an_unregistered_test_split_config_with_a_reason_is_recorded(world):
    harness = FakeHarness()
    plan_path = _plan_b(world, harness)
    extra = world["dir"] / "extra.json"
    extra.write_text(RegressionRunConfig(name="b.extra", env={"RAG_PARENT_CHILD": "true"}).model_dump_json())
    reason = "operator check of one extra configuration"
    assert _run_b(world, plan_path, harness, "--extra-config", extra, "--reason", reason) == 0
    lines = read_ledger(world["ledger"])
    unregistered = [line for line in lines if not line.registered]
    assert [(line.config_name, line.reason) for line in unregistered] == [("b.extra", reason)]


def test_rerunning_a_used_test_split_config_needs_a_reason(world):
    harness = FakeHarness()
    plan_path = _plan_b(world, harness)
    assert _run_b(world, plan_path, harness) == 0
    count = len(read_ledger(world["ledger"]))
    assert _run_b(world, plan_path, harness, "--rerun", INCUMBENT_CONFIG) == 2
    assert len(read_ledger(world["ledger"])) == count
    assert _run_b(world, plan_path, harness, "--rerun", INCUMBENT_CONFIG, "--reason", "the first incumbent run hit a flaky host") == 0
    rerun = read_ledger(world["ledger"])[count:]
    assert [(line.config_name, line.registered) for line in rerun] == [(INCUMBENT_CONFIG, False)]


def test_a_backend_fallback_marks_the_external_runs_invalid(world):
    harness = FakeHarness(fallback="backend_not_ready")
    plan_path = _plan_b(world, harness)
    assert _run_b(world, plan_path, harness) == 0
    assert _decide_b(world, plan_path, "--fixtures") == 0
    decision = DefaultsDecision.model_validate_json(world["record"].read_text())
    assert {result.invalid_reason for result in decision.backend_comparison.results} == {"backend_fallback"}
    assert decision.backend == "pgvector"


def test_a_failed_confirmatory_run_falls_back_to_the_incumbent_for_the_adopted_switches(world):
    harness = FakeHarness(interaction_slow=True)
    plan_path = _plan_b(world, harness)
    assert _run_b(world, plan_path, harness) == 0
    assert _decide_b(world, plan_path, "--fixtures") == 0
    decision = DefaultsDecision.model_validate_json(world["record"].read_text())
    verdicts = {verdict.switch: verdict for verdict in decision.verdicts}
    assert verdicts["RAG_PARENT_CHILD"].reason == "confirmatory_failed"
    assert decision.defaults["RAG_PARENT_CHILD"] == "false" and decision.defaults["RAG_CONTEXT_EDGE_ORDER"] == "false"
    assert "Confirmatory run: failed (latency_over_budget)" in (world["decisions"] / "defaults-fixtures.md").read_text()


def test_a_live_decide_without_the_adm02_blocks_writes_nothing(world, capsys):
    harness = FakeHarness()
    plan_path = _plan_b(world, harness)
    assert _run_b(world, plan_path, harness) == 0
    assert _decide_b(world, plan_path) == 2
    assert "cost, latency and per-language" in capsys.readouterr().err
    assert not world["record"].exists() and not list(world["decisions"].glob("defaults-*.md"))


def test_the_dated_markdown_name_is_reserved_for_live_records(tmp_path):
    live = DefaultsDecision.model_validate(SAMPLES["samples"]["DefaultsDecision"])
    fixture = DefaultsDecision.model_validate(SAMPLES["variants"]["DefaultsDecision:provisional_fixtures"]["value"])
    assert markdown_path(tmp_path, live).name == f"defaults-{live.decided_at[:10]}.md"
    assert markdown_path(tmp_path, fixture).name == "defaults-fixtures.md"


def test_a_live_run_with_env_overlays_needs_interactive_env(world, capsys):
    harness = FakeHarness()
    plan_path = _plan_a(world)
    args = ["run", "--plan", plan_path, "--runs-dir", world["dir"] / "live", "--golden", world["dir"] / "g.jsonl", "--base-url", "https://example.invalid"]
    assert _main(args, harness) == 2
    assert "--interactive-env" in capsys.readouterr().err
    assert harness.calls == []
