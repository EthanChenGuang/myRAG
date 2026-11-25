import json
from pathlib import Path

import pytest
from pydantic import ValidationError

from rag_sidecar.contracts import eval_run as eval_run_module
from rag_sidecar.contracts import profiles as profiles_module
from rag_sidecar.contracts.eval_run import RagRunOptions
from rag_sidecar.contracts.retrieval import RetrievalLegWeights, RetrievalParams, compute_config_hash
from rag_sidecar.export_schemas import CONTRACTS

REPO_ROOT = Path(__file__).resolve().parents[2]
BINDING_ID = "01234567-0123-4012-8012-0123456789ab"
RUN_ID = "11111111-1111-4111-8111-111111111111"
METRICS = ["recall_at_5", "recall_at_10", "mrr", "correct_refusal_rate", "false_refusal_rate"]
NEW_MODELS = [
    "BindingActivationEvidence",
    "BindingDocTypeSlice",
    "BindingCandidateResult",
    "BindingArm",
    "BindingComparison",
]


def _model(name):
    model = getattr(profiles_module, name, None)
    assert model is not None, f"{name} is not defined in contracts/profiles.py"
    return model


def _slice():
    return {name: {"value": 0.5, "n": 10} for name in METRICS}


def _evidence(**overrides):
    base = {
        "binding_id": BINDING_ID,
        "target_profile": "voyage-law-2-1024",
        "doc_type": "contract_legal",
        "tenant_key": None,
        "baseline_global_profile": "openai-3-small-1536",
        "baseline_binding_profile": None,
        "gate_passed": True,
        "doc_type_slice": {"n": 40, "real_n": 30, "passed": True, "by_language": {"zh": True, "en": True, "it": True}},
        "other_slices_passed": True,
        "backfill_run_id": RUN_ID,
        "recorded_at": "2026-11-25T08:00:00.000Z",
    }
    base.update(overrides)
    return base


def _arm(profile_id="openai-3-small-1536"):
    return {
        "profile_id": profile_id,
        "report_path": "eval/out/binding/baseline/report.json",
        "doc_type_slice": _slice(),
        "by_language": {"en": _slice()},
        "by_language_pair": {"en->zh": _slice()},
        "by_doc_type": {"general": _slice(), "contract_legal": _slice()},
        "latency_ms": {"search": 120.0, "embed": None},
    }


def _candidate(**overrides):
    base = {
        "profile_id": "voyage-law-2-1024",
        "model": "voyage-law-2",
        "report_path": "eval/out/binding/voyage-law-2-1024/report.json",
        "doc_type_slice": _slice(),
        "by_language": {"en": _slice()},
        "deltas_vs_baseline": {"recall_at_10": 0.1, "mrr": None},
        "deltas_vs_control": {"recall_at_10": 0.05, "mrr": 0.02},
        "beats_baseline": True,
        "beats_control": True,
        "language_regressions": [],
        "pair_regressions": [],
        "other_slice_regressions": [],
        "refusal_regressions": [],
        "latency_ms": {"search": 140.0},
        "recommended": True,
    }
    base.update(overrides)
    return base


def _comparison(**overrides):
    base = {
        "schema_version": 1,
        "doc_type": "contract_legal",
        "baseline": _arm(),
        "control": _arm(),
        "candidates": [_candidate()],
        "provenance_counts": {"human": 30, "synthetic_fixture": 10},
        "hashes": {
            "corpus_sha256": "a" * 64,
            "golden_sha256": "b" * 64,
            "noise_sha256": "c" * 64,
            "retrieval_params_hash": "d" * 64,
            "catalog_version": 1,
        },
        "reembed_run_ids": {"voyage-law-2-1024": RUN_ID},
        "fixture_embedder": False,
        "gate_passed": True,
        "recommended_profile": "voyage-law-2-1024",
        "notes": [],
    }
    base.update(overrides)
    return base


class TestBindingActivationEvidence:
    def test_valid_evidence_carries_every_field_the_sql_gate_reads(self):
        evidence = _model("BindingActivationEvidence").model_validate(_evidence())
        dumped = evidence.model_dump(mode="json")
        assert set(dumped) == {
            "binding_id",
            "target_profile",
            "doc_type",
            "tenant_key",
            "baseline_global_profile",
            "baseline_binding_profile",
            "gate_passed",
            "doc_type_slice",
            "other_slices_passed",
            "backfill_run_id",
            "recorded_at",
        }
        assert set(dumped["doc_type_slice"]) == {"n", "real_n", "passed", "by_language"}
        assert dumped["tenant_key"] is None and dumped["baseline_binding_profile"] is None

    def test_tenant_binding_accepts_a_tenant_key(self):
        evidence = _model("BindingActivationEvidence").model_validate(
            _evidence(tenant_key="o:01234567-0123-4012-8012-0123456789ab", baseline_binding_profile="voyage-law-2-1024")
        )
        assert evidence.tenant_key == "o:01234567-0123-4012-8012-0123456789ab"

    @pytest.mark.parametrize(
        "overrides",
        [
            {"extra": 1},
            {"doc_type": "memo"},
            {"doc_type_slice": {"n": -1, "real_n": 0, "passed": True, "by_language": {}}},
            {"doc_type_slice": {"n": 10, "real_n": -1, "passed": True, "by_language": {}}},
            {"doc_type_slice": {"n": 10, "real_n": 11, "passed": True, "by_language": {}}},
            {"doc_type_slice": {"n": 10, "real_n": 5, "passed": True, "by_language": {}, "extra": 1}},
            {"recorded_at": "yesterday"},
            {"recorded_at": "2026-13-40T00:00:00Z"},
            {"recorded_at": "2026-11-25T08:00:00"},
            {"binding_id": "not-a-uuid"},
            {"tenant_key": "x:bad"},
            {"target_profile": "Bad Profile"},
        ],
    )
    def test_rejects_invalid_evidence(self, overrides):
        with pytest.raises(ValidationError):
            _model("BindingActivationEvidence").model_validate(_evidence(**overrides))

    def test_missing_field_is_rejected(self):
        payload = _evidence()
        del payload["baseline_global_profile"]
        with pytest.raises(ValidationError):
            _model("BindingActivationEvidence").model_validate(payload)


class TestBindingComparison:
    def test_valid_comparison_round_trips(self):
        comparison = _model("BindingComparison").model_validate(_comparison())
        dumped = comparison.model_dump(mode="json")
        assert dumped["recommended_profile"] == "voyage-law-2-1024"
        assert _model("BindingComparison").model_validate(dumped) == comparison
        assert isinstance(comparison.baseline, _model("BindingArm"))
        assert isinstance(comparison.candidates[0], _model("BindingCandidateResult"))

    def test_no_recommendation_when_the_gate_fails(self):
        comparison = _model("BindingComparison").model_validate(
            _comparison(
                candidates=[_candidate(recommended=False, beats_control=False)],
                gate_passed=False,
                recommended_profile=None,
            )
        )
        assert comparison.recommended_profile is None

    @pytest.mark.parametrize(
        "overrides",
        [
            {"schema_version": 2},
            {"candidates": []},
            {"extra": True},
            {"doc_type": "memo"},
            {"provenance_counts": {"human": -1}},
            {"hashes": {"corpus_sha256": "a" * 64}},
            {"recommended_profile": "voyage-4-large-1024-domain"},
            {"gate_passed": False},
            {"candidates": [_candidate(), _candidate()]},
            {"candidates": [_candidate(recommended=False)]},
        ],
    )
    def test_rejects_invalid_comparison(self, overrides):
        with pytest.raises(ValidationError):
            _model("BindingComparison").model_validate(_comparison(**overrides))

    def test_missing_required_field_is_rejected(self):
        for field in ["doc_type", "baseline", "control", "candidates", "provenance_counts", "hashes", "fixture_embedder"]:
            payload = _comparison()
            del payload[field]
            with pytest.raises(ValidationError):
                _model("BindingComparison").model_validate(payload)

    @pytest.mark.parametrize(
        "overrides",
        [
            {"language_regressions": ["it"]},
            {"beats_control": False},
            {"refusal_regressions": ["overall"]},
        ],
    )
    def test_a_recommended_candidate_has_no_regression(self, overrides):
        with pytest.raises(ValidationError):
            _model("BindingCandidateResult").model_validate(_candidate(**overrides))

    def test_unknown_delta_metric_is_rejected(self):
        with pytest.raises(ValidationError):
            _model("BindingCandidateResult").model_validate(_candidate(deltas_vs_baseline={"ndcg": 0.1}))


class TestRunOptions:
    def test_embedding_bindings_and_control_leg_default_none(self):
        options = RagRunOptions()
        assert getattr(options, "embedding_bindings", "missing") is None
        assert getattr(options, "domain_control_leg", "missing") is None

    def test_accepts_a_binding_map(self):
        options = RagRunOptions.model_validate({"embedding_bindings": {"contract_legal": "voyage-law-2-1024"}})
        assert options.embedding_bindings == {"contract_legal": "voyage-law-2-1024"}

    def test_accepts_one_control_doc_type(self):
        options = RagRunOptions.model_validate({"domain_control_leg": "contract_legal"})
        assert options.domain_control_leg == "contract_legal"

    @pytest.mark.parametrize(
        "payload",
        [
            {"embedding_bindings": {"memo": "voyage-law-2-1024"}},
            {
                "embedding_bindings": {
                    "general": "a",
                    "financial_report": "b",
                    "contract_legal": "c",
                    "invoice_receipt": "d",
                    "product_technical": "e",
                    "scanned_image": "f",
                    "memo": "g",
                }
            },
            {"embedding_bindings": {"contract_legal": "Bad Profile"}},
            {"domain_control_leg": "memo"},
            {"domain_control_leg": ["contract_legal"]},
        ],
    )
    def test_rejects_invalid_binding_options(self, payload):
        assert "embedding_bindings" in RagRunOptions.model_fields
        assert "domain_control_leg" in RagRunOptions.model_fields
        with pytest.raises(ValidationError):
            RagRunOptions.model_validate(payload)

    def test_options_without_bindings_dump_as_before(self):
        dumped = RagRunOptions(max_results=5).model_dump(mode="json", exclude_none=True)
        assert dumped == {"max_results": 5, "citations": False, "groundedness": False}


class TestDomainLegWeight:
    def test_default_weights_dump_without_domain(self):
        assert RetrievalLegWeights().model_dump(mode="json") == {"dense": 1.0, "lexical": 1.0, "exact_id": 1.0}

    def test_domain_weight_is_dumped_when_set(self):
        dumped = RetrievalLegWeights.model_validate({"domain": 0.5}).model_dump(mode="json")
        assert dumped == {"dense": 1.0, "lexical": 1.0, "exact_id": 1.0, "domain": 0.5}

    @pytest.mark.parametrize("value", [0, -1])
    def test_domain_weight_must_be_positive(self, value):
        assert "domain" in RetrievalLegWeights.model_fields
        with pytest.raises(ValidationError):
            RetrievalLegWeights.model_validate({"domain": value})

    def test_committed_retrieval_params_hash_is_unchanged(self):
        raw = json.loads((REPO_ROOT / "eval" / "config" / "retrieval-params.json").read_text(encoding="utf-8"))
        params = RetrievalParams.model_validate(raw)
        assert compute_config_hash(params) == raw["config_hash"]
        assert "domain" not in params.model_dump(mode="json")["leg_weights"]


def test_new_models_are_exported_with_samples():
    registered = {model.__name__ for model, _ in CONTRACTS}
    from rag_sidecar.contracts.samples import build_samples

    samples = build_samples()["samples"]
    for name in NEW_MODELS:
        assert name in registered, f"{name} missing from export_schemas.CONTRACTS"
        assert name in samples, f"{name} has no sample"


def test_profile_id_pattern_is_shared():
    assert getattr(eval_run_module, "BINDING_PROFILE_ID_PATTERN", None) == r"^[a-z0-9][a-z0-9._-]{0,63}$"
