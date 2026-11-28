"""Phase 3.2 query-side, admin and model-output contracts (plan 03.2-06, D-38, D-39, D-49, research F-13b).

Models are looked up by name in the exported CONTRACTS list, so a missing model fails an assertion.
"""

import json
from pathlib import Path
from typing import Any

from pydantic import BaseModel, ValidationError

from rag_sidecar.contracts.retrieval import RetrievalFilters, RetrievalLegWeights, RetrievalParams, compute_config_hash
from rag_sidecar.contracts.samples import build_samples
from rag_sidecar.export_schemas import CONTRACTS

REPO_ROOT = Path(__file__).resolve().parents[2]
COMMITTED_PARAMS = REPO_ROOT / "eval" / "config" / "retrieval-params.json"


def _model(name: str) -> type[BaseModel]:
    by_name = {model.__name__: model for model, _ in CONTRACTS}
    assert name in by_name, f"{name} is not exported in CONTRACTS"
    return by_name[name]


def _accepts(model: type[BaseModel], value: Any) -> bool:
    try:
        model.model_validate(value)
    except ValidationError:
        return False
    return True


# --- scopes (D-38, D-39) ---------------------------------------------------------------------------


def test_scope_vocabulary_entry_validates_a_slug_value():
    model = _model("ScopeVocabularyEntry")
    entry = {"dimension": "legal_entity", "value": "unit-a2", "label": "Unit A2", "aliases": ["UA2"], "active": True}
    assert _accepts(model, entry)
    assert model.model_validate({k: v for k, v in entry.items() if k not in {"aliases", "active"}}).model_dump(
        mode="json"
    ) == {**entry, "aliases": [], "active": True}


def test_scope_vocabulary_entry_rejects_bad_dimension_and_slug():
    model = _model("ScopeVocabularyEntry")
    base = {"dimension": "region", "value": "north", "label": "North"}
    assert _accepts(model, base)
    assert not _accepts(model, {**base, "dimension": "project"})
    for bad in ("North", "north east", "north_east", "-north", "north-", "", "a" * 65):
        assert not _accepts(model, {**base, "value": bad}), bad
    assert not _accepts(model, {**base, "label": ""})
    assert not _accepts(model, {**base, "aliases": ["same", "same"]})
    assert not _accepts(model, {**base, "rogue": 1})


def test_scope_tag_suggestion_limits_source_and_repeats():
    model = _model("ScopeTagSuggestion")
    good = {
        "suggestions": [
            {"dimension": "region", "value": "north", "source": "rule"},
            {"dimension": "department", "value": "unit-b", "source": "model"},
        ]
    }
    assert _accepts(model, good)
    assert _accepts(model, {"suggestions": []})
    assert not _accepts(model, {"suggestions": [{"dimension": "region", "value": "north", "source": "admin"}]})
    assert not _accepts(model, {"suggestions": [good["suggestions"][0], good["suggestions"][0]]})
    assert not _accepts(model, {"suggestions": [{"dimension": "team", "value": "north", "source": "rule"}]})
    assert not _accepts(model, {**good, "confidence": 0.9})


def test_retrieval_filters_accept_scopes_and_include_untagged():
    value = {"scopes": {"region": ["north", "south"], "legal_entity": ["unit-a"]}, "include_untagged": True}
    assert _accepts(RetrievalFilters, value)
    dumped = RetrievalFilters.model_validate(value).model_dump(mode="json")
    assert dumped["scopes"] == {"region": ["north", "south"], "legal_entity": ["unit-a"]}
    assert dumped["include_untagged"] is True
    assert _accepts(RetrievalFilters, {"scopes": {"department": ["unit-c"]}})
    assert RetrievalFilters.model_validate({"scopes": {"department": ["unit-c"]}}).include_untagged is False


def test_retrieval_filters_reject_a_fourth_dimension_and_bad_values():
    assert not _accepts(RetrievalFilters, {"scopes": {"project": ["north"]}})
    assert not _accepts(RetrievalFilters, {"scopes": {}})
    assert not _accepts(RetrievalFilters, {"scopes": {"region": []}})
    assert not _accepts(RetrievalFilters, {"scopes": {"region": ["North"]}})
    assert not _accepts(RetrievalFilters, {"scopes": {"region": ["north", "north"]}})
    assert not _accepts(RetrievalFilters, {"include_untagged": True})


def test_retrieval_filters_without_scopes_serialize_as_before():
    dumped = RetrievalFilters(sources=["manual"], languages=["en"]).model_dump(mode="json")
    assert "scopes" not in dumped
    assert "include_untagged" not in dumped
    assert set(dumped) == {"date_range", "sources", "document_ids", "doc_types", "languages", "invoice", "current_only"}


# --- translation leg weight (F-13b) -----------------------------------------------------------------


def test_leg_weights_accept_an_optional_translation_weight():
    weights = RetrievalLegWeights.model_validate({"dense": 1, "lexical": 1, "exact_id": 1, "translation": 0.5})
    assert weights.model_dump(mode="json")["translation"] == 0.5
    assert not _accepts(RetrievalLegWeights, {"translation": 0})


def test_params_without_translation_serialize_and_hash_unchanged():
    committed = json.loads(COMMITTED_PARAMS.read_text(encoding="utf-8"))
    params = RetrievalParams.model_validate(committed)
    assert params.model_dump(mode="json") == committed
    assert "translation" not in params.model_dump(mode="json")["leg_weights"]
    assert set(RetrievalParams().model_dump(mode="json")["leg_weights"]) == {"dense", "lexical", "exact_id"}
    if committed.get("config_hash"):
        assert compute_config_hash(params) == committed["config_hash"]


def test_scope_samples_are_exported():
    samples = build_samples()
    assert "ScopeVocabularyEntry" in samples["samples"]
    assert "ScopeTagSuggestion" in samples["samples"]
    assert "RetrievalFilters:scopes" in samples["variants"]


# --- supersession and effective dates (D-41, D-43) ---------------------------------------------------

_DOC_A = "00000000-0000-4000-8000-0000000000a1"
_DOC_B = "00000000-0000-4000-8000-0000000000b1"
_CANDIDATE_ID = "00000000-0000-4000-8000-0000000000d1"
_ADMIN = "00000000-0000-4000-8000-0000000000e1"


def _candidate(**overrides: Any) -> dict[str, Any]:
    value: dict[str, Any] = {
        "id": _CANDIDATE_ID,
        "document_id": _DOC_A,
        "candidate_document_id": _DOC_B,
        "signals": {"title_match": True, "content_overlap_percent": 82, "conflicting_numbers": 3},
        "direction": None,
        "status": "pending",
        "origin": "detected",
        "decided_by": None,
        "decided_at": None,
    }
    value.update(overrides)
    return value


def test_supersession_candidate_pending_and_confirmed():
    model = _model("SupersessionCandidate")
    assert _accepts(model, _candidate())
    confirmed = _candidate(
        status="confirmed", direction="document_is_newer", decided_by=_ADMIN, decided_at="2026-01-02T00:00:00Z"
    )
    assert _accepts(model, confirmed)
    for origin in ("uploader", "answer_conflict"):
        assert _accepts(model, _candidate(origin=origin))


def test_supersession_candidate_rejects_inconsistent_values():
    model = _model("SupersessionCandidate")
    assert not _accepts(model, _candidate(candidate_document_id=_DOC_A))
    assert not _accepts(model, _candidate(status="archived"))
    assert not _accepts(model, _candidate(origin="manual"))
    assert not _accepts(model, _candidate(direction="sideways"))
    assert not _accepts(model, _candidate(signals={"title_match": True, "content_overlap_percent": 101, "conflicting_numbers": 0}))
    assert not _accepts(model, _candidate(signals={"title_match": True, "content_overlap_percent": 10, "conflicting_numbers": -1}))
    assert not _accepts(model, _candidate(decided_by=_ADMIN, decided_at="2026-01-02T00:00:00Z"))
    assert not _accepts(model, _candidate(status="dismissed"))
    assert not _accepts(
        model, _candidate(status="confirmed", decided_by=_ADMIN, decided_at="2026-01-02T00:00:00Z")
    )
    assert not _accepts(model, _candidate(note="x"))


def test_supersession_rules_thresholds():
    model = _model("SupersessionRules")
    good = {
        "schema_version": 1,
        "rules_version": "supersession@1",
        "title_similarity_min": 0.9,
        "content_overlap_min_percent": 70,
        "min_conflicting_numbers": 1,
    }
    assert _accepts(model, good)
    assert not _accepts(model, {**good, "title_similarity_min": 1.5})
    assert not _accepts(model, {**good, "content_overlap_min_percent": 0})
    assert not _accepts(model, {**good, "min_conflicting_numbers": 0})
    assert not _accepts(model, {**good, "schema_version": 2})


def test_effective_date_extraction_order_and_confidence():
    model = _model("EffectiveDateExtraction")
    good = {
        "effective_from": "2026-01-01",
        "effective_to": "2026-12-31",
        "confidence": 0.85,
        "evidence_quote": "Valid from 1 January 2026 until 31 December 2026.",
    }
    assert _accepts(model, good)
    assert _accepts(model, {**good, "effective_to": None})
    assert _accepts(model, {**good, "effective_from": None})
    assert not _accepts(model, {**good, "effective_from": "2027-01-01"})
    assert not _accepts(model, {**good, "effective_from": None, "effective_to": None})
    assert not _accepts(model, {**good, "confidence": 1.01})
    assert not _accepts(model, {**good, "evidence_quote": ""})
    assert not _accepts(model, {**good, "reason": "x"})


# --- translation (D-29, D-31) -------------------------------------------------------------------------


def test_chunk_translation_needs_content():
    model = _model("ChunkTranslation")
    assert _accepts(model, {"content": "A neutral translated sentence."})
    assert not _accepts(model, {"content": ""})
    assert not _accepts(model, {"content": "   "})
    assert not _accepts(model, {"content": "x", "language": "en"})


def test_translation_settings_targets():
    model = _model("TranslationSettings")
    assert _accepts(model, {"target_languages": ["en", "zh"], "enabled": True, "updated_by": _ADMIN})
    assert _accepts(model, {"target_languages": [], "enabled": False, "updated_by": None})
    assert not _accepts(model, {"target_languages": ["en", "en"], "enabled": True, "updated_by": None})
    assert not _accepts(model, {"target_languages": ["xx"], "enabled": True, "updated_by": None})
    assert not _accepts(model, {"target_languages": [], "enabled": True, "updated_by": None})


# --- BGE-M3 embed (D-26) ------------------------------------------------------------------------------


def test_embed_request_limits():
    model = _model("EmbedRequest")
    assert _accepts(model, {"model": "BAAI/bge-m3", "inputs": ["one"]})
    assert _accepts(model, {"model": "BAAI/bge-m3", "inputs": ["x" * 20_000] * 32})
    assert not _accepts(model, {"model": "BAAI/bge-m3", "inputs": []})
    assert not _accepts(model, {"model": "BAAI/bge-m3", "inputs": ["x"] * 33})
    assert not _accepts(model, {"model": "BAAI/bge-m3", "inputs": ["x" * 20_001]})
    assert not _accepts(model, {"model": "BAAI/bge-m3", "inputs": [""]})
    assert not _accepts(model, {"model": "other/model", "inputs": ["one"]})


def test_embed_response_dims_and_vectors():
    model = _model("EmbedResponse")
    vector = [0.0] * 1023 + [1.0]
    good = {"model": "BAAI/bge-m3", "revision": "rev-0001", "dims": 1024, "vectors": [vector, vector]}
    assert _accepts(model, good)
    assert not _accepts(model, {**good, "dims": 768})
    assert not _accepts(model, {**good, "vectors": [vector[:-1]]})
    assert not _accepts(model, {**good, "vectors": []})
    assert not _accepts(model, {**good, "revision": ""})


def test_phase32_model_output_samples_are_exported():
    samples = build_samples()["samples"]
    for name in (
        "SupersessionCandidate",
        "SupersessionRules",
        "EffectiveDateExtraction",
        "ChunkTranslation",
        "TranslationSettings",
        "EmbedRequest",
        "EmbedResponse",
    ):
        assert name in samples, name
