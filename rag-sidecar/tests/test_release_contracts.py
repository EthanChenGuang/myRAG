import pytest
from pydantic import ValidationError

from rag_sidecar.contracts.feedback_loop import ShipCheckResult
from rag_sidecar.contracts.release import (
    CostSummary,
    DefaultsDecision,
    LanguageQuality,
    RegressionPlan,
    SwitchVerdict,
    TestSplitUse,
    VendorDataFlow,
)

SHA_A = "a" * 64
SHA_B = "b" * 64
SHA_C = "c" * 64


def _plan(**overrides):
    base = {
        "stage": "b",
        "split": "test",
        "primary_metric": "recall_at_10+correct_refusal_rate",
        "configs": [
            {"name": "incumbent", "env": {"RAG_PIPELINE": "legacy"}},
            {"name": "ablate-tagging", "env": {"RAG_CONTEXT_TAGGING": "true"}, "overrides": {"judge_runs": 3}},
        ],
        "incumbent_config": "incumbent",
        "gated_slice_prefixes": ["overall", "language:"],
        "test_split_budget": 3,
        "created_at": "2026-11-27T10:00:00Z",
    }
    base.update(overrides)
    return base


def _verdict(**overrides):
    base = {
        "switch": "RAG_CONTEXT_TAGGING",
        "value": "true",
        "delta": 0.0,
        "ci_low": -0.01,
        "ci_high": 0.01,
        "band": 0.02,
        "p_value": 0.4,
        "p_holm": 0.8,
        "gated_slices_ok": True,
        "too_small_slices": ["category:table"],
        "latency_ok": True,
        "injection_asr": 0.0,
        "decision": "adopt",
        "reason": "security_wins_ties",
    }
    base.update(overrides)
    return base


def _amount(usd=0.5):
    return {"usd": usd} if usd is not None else {"usd": None, "reason": "not_provided"}


def _cost():
    return {
        "per_1000_documents": [
            {
                "embedding_profile": "openai-3-small-1536",
                "backend": "pgvector",
                "documents": {
                    "parse": _amount(1.2),
                    "embedding": _amount(0.02),
                    "enrichment": _amount(None),
                    "external_store": _amount(0.0),
                },
            }
        ],
        "per_1000_queries": [
            {
                "config_name": "incumbent",
                "queries": {
                    "query_embedding": _amount(0.001),
                    "rerank": _amount(0.0),
                    "generation": _amount(1.5),
                    "external_store": {"usd": None, "reason": "not_measured"},
                },
            }
        ],
        "basis": {"price_table_sha256": SHA_C, "document_sample": 20, "query_sample": 20, "kind": "estimated"},
    }


def _latency():
    return {
        "budgets_sha256": SHA_C,
        "entries": [
            {
                "config_name": "incumbent",
                "channel": "chat",
                "values": [
                    {
                        "stage": "total",
                        "p50_ms": 800,
                        "p95_ms": 1600,
                        "budget_p50_ms": 1500,
                        "budget_p95_ms": 3000,
                        "within_budget": True,
                    }
                ],
            },
            {
                "config_name": "incumbent",
                "channel": "voice",
                "values": [{"stage": "total", "p50_ms": 400, "p95_ms": 900, "within_budget": None, "report_only": True}],
            },
        ],
    }


def _language(code="en", below=False, **overrides):
    base = {
        "language": code,
        "metric": "recall_at_10",
        "n": 12,
        "value": 0.8,
        "baseline": 0.8,
        "difference": 0.0,
        "band": 0.02,
        "below_baseline": below,
    }
    base.update(overrides)
    return base


def _decision(**overrides):
    base = {
        "provisional": "fixtures",
        "decided_at": "2026-11-27T10:00:00Z",
        "plan_sha256": SHA_A,
        "primary_metric": "recall_at_10+correct_refusal_rate",
        "incumbent_source": {"path": "eval/decisions/04.1-retrieval-defaults.json", "sha256": SHA_B},
        "incumbent": {"RAG_PIPELINE": "v2", "RAG_CONTEXT_TAGGING": "false"},
        "defaults": {"RAG_PIPELINE": "v2", "RAG_CONTEXT_TAGGING": "true"},
        "embedding_profile": "openai-3-small-1536",
        "reranker": "none",
        "backend": "pgvector",
        "verdicts": [_verdict()],
        "backend_comparison": {
            "results": [
                {
                    "backend": "qdrant",
                    "config_name": "qdrant-best",
                    "valid": False,
                    "invalid_reason": "backend_impl_fake",
                    "cost_note": "self-hosted node, one replica",
                    "operational_note": "second store to operate and reconcile",
                }
            ],
            "winner": "pgvector",
            "reason": "no_backend_beyond_ci",
        },
        "config_hashes": {"incumbent": SHA_A, "ablate-tagging": SHA_B},
        "test_split_uses": [
            {
                "run_id": "run-0001",
                "config_name": "incumbent",
                "plan_sha256": SHA_A,
                "used_at": "2026-11-27T09:00:00Z",
                "registered": True,
            }
        ],
    }
    base.update(overrides)
    return base


def _live(**overrides):
    base = {"provisional": None, "cost": _cost(), "latency": _latency(), "per_language": [_language("en"), _language("it")]}
    base.update(overrides)
    return _decision(**base)


def _ship_check():
    return ShipCheckResult(
        passed=True,
        target_metric="recall_at_10",
        baseline_hash=SHA_A,
        candidate_hash=SHA_B,
        gate_population="real",
    ).model_dump(mode="json")


def _vendor(**overrides):
    base = {
        "vendor": "example-reranker",
        "name": "Example reranker",
        "hosts": ["api.example.com"],
        "content": ["query", "chunk_text"],
        "switch": "RAG_RERANKER",
        "opt_in": True,
        "multi_tenant": "allowed",
        "retention": "to_verify",
        "training": "to_verify",
        "providers": ["example"],
    }
    base.update(overrides)
    return base


class TestDefaultsDecision:
    def test_fixture_record_validates(self):
        record = DefaultsDecision.model_validate(_decision())
        assert record.provisional == "fixtures"
        assert "ship_check_ref" not in record.model_dump(mode="json")

    def test_provisional_live_fails(self):
        with pytest.raises(ValidationError):
            DefaultsDecision.model_validate(_decision(provisional="live"))

    def test_p_holm_below_p_value_fails(self):
        with pytest.raises(ValidationError, match="p_holm"):
            SwitchVerdict.model_validate(_verdict(p_value=0.4, p_holm=0.1))

    def test_adopted_switch_needs_zero_injection_asr(self):
        with pytest.raises(ValidationError, match="injection"):
            SwitchVerdict.model_validate(_verdict(injection_asr=0.05))
        assert SwitchVerdict.model_validate(_verdict(injection_asr=0.05, decision="keep_incumbent")).decision == (
            "keep_incumbent"
        )

    def test_ship_check_ref_validates(self):
        record = DefaultsDecision.model_validate(_decision(ship_check_ref=_ship_check()))
        assert record.ship_check_ref is not None and record.ship_check_ref.passed

    def test_ship_check_ref_invalid_fails(self):
        bad = {**_ship_check(), "passed": False}
        with pytest.raises(ValidationError):
            DefaultsDecision.model_validate(_decision(ship_check_ref=bad))

    def test_incumbent_source_other_path_fails(self):
        with pytest.raises(ValidationError):
            DefaultsDecision.model_validate(
                _decision(incumbent_source={"path": "eval/decisions/other.json", "sha256": SHA_B})
            )

    def test_incumbent_source_without_sha_fails(self):
        with pytest.raises(ValidationError):
            DefaultsDecision.model_validate(
                _decision(incumbent_source={"path": "eval/decisions/04.1-retrieval-defaults.json"})
            )

    def test_fixture_record_cannot_move_backend(self):
        comparison = _decision()["backend_comparison"]
        with pytest.raises(ValidationError):
            DefaultsDecision.model_validate(_decision(backend="qdrant", backend_comparison=comparison))

    def test_backend_must_equal_winner(self):
        with pytest.raises(ValidationError, match="winner"):
            DefaultsDecision.model_validate(_live(backend="weaviate"))

    def test_backend_wins_only_beyond_ci_and_band(self):
        result = {
            "backend": "qdrant",
            "config_name": "qdrant-best",
            "valid": True,
            "delta": 0.01,
            "ci_low": 0.005,
            "ci_high": 0.02,
            "band": 0.02,
            "cost_note": "managed cluster",
            "operational_note": "second store",
        }
        comparison = {"results": [result], "winner": "qdrant", "reason": "beyond_ci"}
        with pytest.raises(ValidationError, match="band"):
            DefaultsDecision.model_validate(_live(backend="qdrant", backend_comparison=comparison))
        winning = {**comparison, "results": [{**result, "delta": 0.05}]}
        assert DefaultsDecision.model_validate(_live(backend="qdrant", backend_comparison=winning)).backend == "qdrant"

    def test_default_outside_incumbent_map_fails(self):
        with pytest.raises(ValidationError, match="incumbent map"):
            DefaultsDecision.model_validate(_decision(defaults={"RAG_UNKNOWN_SWITCH": "on"}))

    def test_provisional_record_without_blocks_validates(self):
        record = DefaultsDecision.model_validate(_decision())
        assert record.cost is None and record.latency is None and record.per_language is None

    @pytest.mark.parametrize("missing", ["cost", "latency", "per_language"])
    def test_non_provisional_record_needs_every_block(self, missing):
        data = _live()
        del data[missing]
        with pytest.raises(ValidationError, match=missing):
            DefaultsDecision.model_validate(data)

    def test_non_provisional_record_with_blocks_validates(self):
        record = DefaultsDecision.model_validate(_live())
        assert record.provisional is None
        assert record.cost is not None and record.cost.per_1000_documents[0].documents is not None

    def test_cost_amount_none_without_reason_fails(self):
        cost = _cost()
        cost["per_1000_queries"][0]["queries"]["rerank"] = {"usd": None}
        with pytest.raises(ValidationError, match="reason"):
            CostSummary.model_validate(cost)

    def test_cost_amount_negative_fails(self):
        cost = _cost()
        cost["per_1000_documents"][0]["documents"]["parse"] = {"usd": -0.1}
        with pytest.raises(ValidationError):
            CostSummary.model_validate(cost)

    def test_cost_amount_with_number_and_reason_fails(self):
        cost = _cost()
        cost["per_1000_documents"][0]["documents"]["parse"] = {"usd": 0.1, "reason": "not_measured"}
        with pytest.raises(ValidationError):
            CostSummary.model_validate(cost)

    def test_language_below_baseline_blocks_adoption(self):
        languages = [_language("en"), _language("it", below=True, value=0.7, difference=-0.1)]
        with pytest.raises(ValidationError, match="below its baseline"):
            DefaultsDecision.model_validate(_live(per_language=languages))

    def test_language_below_baseline_with_incumbent_kept_validates(self):
        languages = [_language("en"), _language("it", below=True, value=0.7, difference=-0.1)]
        kept = {"RAG_PIPELINE": "v2", "RAG_CONTEXT_TAGGING": "false"}
        verdict = _verdict(decision="keep_incumbent", reason="language_below_baseline")
        record = DefaultsDecision.model_validate(_live(per_language=languages, defaults=kept, verdicts=[verdict]))
        assert not record.adopts_change()

    def test_too_small_language_needs_reason(self):
        with pytest.raises(ValidationError, match="reason"):
            LanguageQuality.model_validate(_language("zh", below=None, n=3))
        assert LanguageQuality.model_validate(_language("zh", below=None, n=3, reason="too_small")).reason == (
            "too_small"
        )

    def test_unknown_field_fails(self):
        with pytest.raises(ValidationError):
            DefaultsDecision.model_validate(_decision(note="free text"))


class TestRegressionPlan:
    def test_min_gate_n_defaults_to_ten(self):
        assert RegressionPlan.model_validate(_plan()).min_gate_n == 10

    def test_min_gate_n_must_be_positive(self):
        with pytest.raises(ValidationError):
            RegressionPlan.model_validate(_plan(min_gate_n=0))

    def test_identical_plans_hash_the_same(self):
        first = RegressionPlan.model_validate(_plan())
        second = RegressionPlan.model_validate(_plan())
        assert first.canonical_sha256() == second.canonical_sha256()
        assert len(first.canonical_sha256()) == 64

    def test_hash_ignores_key_order(self):
        reordered = dict(reversed(list(_plan().items())))
        assert (
            RegressionPlan.model_validate(reordered).canonical_sha256()
            == RegressionPlan.model_validate(_plan()).canonical_sha256()
        )

    def test_changed_config_list_changes_hash(self):
        configs = _plan()["configs"] + [{"name": "ablate-check", "env": {"RAG_INJECTION_CHECK": "drop"}}]
        assert (
            RegressionPlan.model_validate(_plan(configs=configs)).canonical_sha256()
            != RegressionPlan.model_validate(_plan()).canonical_sha256()
        )

    def test_repeated_config_name_fails(self):
        configs = [{"name": "incumbent"}, {"name": "incumbent"}]
        with pytest.raises(ValidationError, match="repeat"):
            RegressionPlan.model_validate(_plan(configs=configs))

    def test_incumbent_config_must_be_listed(self):
        with pytest.raises(ValidationError, match="incumbent_config"):
            RegressionPlan.model_validate(_plan(incumbent_config="missing"))

    def test_dev_plan_has_no_test_budget(self):
        with pytest.raises(ValidationError, match="budget"):
            RegressionPlan.model_validate(_plan(stage="a", split="dev"))
        assert RegressionPlan.model_validate(_plan(stage="a", split="dev", test_split_budget=0)).split == "dev"


class TestTestSplitUse:
    def test_unregistered_use_needs_reason(self):
        base = {
            "run_id": "run-0002",
            "config_name": "incumbent",
            "plan_sha256": SHA_A,
            "used_at": "2026-11-27T09:00:00Z",
            "registered": False,
        }
        with pytest.raises(ValidationError, match="reason"):
            TestSplitUse.model_validate(base)
        assert TestSplitUse.model_validate({**base, "reason": "rerun after a harness crash"}).reason


class TestVendorDataFlow:
    def test_inventory_validates_with_to_verify(self):
        inventory = VendorDataFlow.model_validate(
            {
                "vendors": [
                    _vendor(),
                    _vendor(
                        vendor="example-store",
                        name="Example store",
                        hosts=["store.example.net"],
                        content=["vectors", "lexical_text"],
                        switch="RAG_RETRIEVAL_BACKEND",
                        multi_tenant="requires_ack",
                        ack_switch="RAG_EXAMPLE_MULTI_TENANT_ACK",
                        providers=[],
                    ),
                ]
            }
        )
        assert inventory.vendors[0].retention == "to_verify"
        assert "lexical_text" in inventory.vendors[1].content

    def test_unknown_content_kind_fails(self):
        with pytest.raises(ValidationError):
            VendorDataFlow.model_validate({"vendors": [_vendor(content=["query", "passwords"])]})

    def test_vendor_needs_a_host(self):
        with pytest.raises(ValidationError):
            VendorDataFlow.model_validate({"vendors": [_vendor(hosts=[])]})

    def test_host_must_be_a_hostname(self):
        with pytest.raises(ValidationError):
            VendorDataFlow.model_validate({"vendors": [_vendor(hosts=["https://api.example.com/v1"])]})

    def test_requires_ack_names_its_switch(self):
        with pytest.raises(ValidationError, match="ack_switch"):
            VendorDataFlow.model_validate({"vendors": [_vendor(multi_tenant="requires_ack")]})

    def test_repeated_vendor_fails(self):
        with pytest.raises(ValidationError, match="vendors"):
            VendorDataFlow.model_validate({"vendors": [_vendor(), _vendor(hosts=["other.example.com"])]})

    def test_unknown_multi_tenant_value_fails(self):
        with pytest.raises(ValidationError):
            VendorDataFlow.model_validate({"vendors": [_vendor(multi_tenant="maybe")]})
