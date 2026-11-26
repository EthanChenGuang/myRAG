import importlib
import importlib.util
import uuid

import pytest
from pydantic import ValidationError

from rag_sidecar.contracts.eval_run import RagTrace
from rag_sidecar.contracts.retrieval import RetrievalOverrides
from rag_sidecar.contracts.samples import build_samples


def _vector_sync():
    spec = importlib.util.find_spec("rag_sidecar.contracts.vector_sync")
    assert spec is not None, "rag_sidecar.contracts.vector_sync is missing"
    return importlib.import_module("rag_sidecar.contracts.vector_sync")


def _slice(**overrides):
    base = {
        "mode": "drain",
        "claimed": 4,
        "upserted": 3,
        "deleted": 1,
        "failed": 0,
        "dead": 0,
        "lag_seconds": 2.5,
        "elapsed_ms": 120,
        "budget_ms": 5000,
        "more_pending": False,
    }
    base.update(overrides)
    return base


def _reconcile(**overrides):
    base = {
        "target": "qdrant",
        "profile_id": "openai-3-small",
        "tenant_key": "s:default",
        "supabase_count": 10,
        "backend_count": 9,
        "mismatched_buckets": 1,
        "missing": 1,
        "extra": 0,
        "stale": 0,
        "repairs_enqueued": 1,
        "state": "ready",
    }
    base.update(overrides)
    return base


def test_slice_report_accepts_both_modes():
    vs = _vector_sync()
    assert vs.VectorSyncSliceReport(**_slice()).mode == "drain"
    assert vs.VectorSyncSliceReport(**_slice(mode="reconcile", more_pending=True)).more_pending is True


@pytest.mark.parametrize(
    "field", ["claimed", "upserted", "deleted", "failed", "dead", "lag_seconds", "elapsed_ms", "budget_ms"]
)
def test_slice_report_rejects_negative_counts(field):
    vs = _vector_sync()
    with pytest.raises(ValidationError):
        vs.VectorSyncSliceReport(**_slice(**{field: -1}))


def test_slice_report_rejects_unknown_mode_and_extra_keys():
    vs = _vector_sync()
    with pytest.raises(ValidationError):
        vs.VectorSyncSliceReport(**_slice(mode="replay"))
    with pytest.raises(ValidationError):
        vs.VectorSyncSliceReport(**_slice(last_error="text must not travel in reports"))


@pytest.mark.parametrize("state", ["building", "ready", "stale", "failed"])
def test_reconcile_report_accepts_states(state):
    vs = _vector_sync()
    assert vs.ReconcileReport(**_reconcile(state=state)).state == state


def test_reconcile_report_tenant_key_pattern():
    vs = _vector_sync()
    tenant = str(uuid.UUID(int=7))
    assert vs.ReconcileReport(**_reconcile(tenant_key=f"u:{tenant}")).tenant_key == f"u:{tenant}"
    assert vs.ReconcileReport(**_reconcile(tenant_key=f"o:{tenant}")).tenant_key == f"o:{tenant}"
    for bad in ["S:default", f"u:{tenant.upper().replace('0', 'A')}", "x:default", f"u:{tenant}0", "default"]:
        with pytest.raises(ValidationError):
            vs.ReconcileReport(**_reconcile(tenant_key=bad))


def test_reconcile_report_rejects_unknown_state_target_negative_and_extra():
    vs = _vector_sync()
    with pytest.raises(ValidationError):
        vs.ReconcileReport(**_reconcile(state="active"))
    with pytest.raises(ValidationError):
        vs.ReconcileReport(**_reconcile(target="milvus"))
    with pytest.raises(ValidationError):
        vs.ReconcileReport(**_reconcile(missing=-1))
    with pytest.raises(ValidationError):
        vs.ReconcileReport(**_reconcile(note="free text"))


def test_retrieval_overrides_backend():
    assert RetrievalOverrides(backend="qdrant").backend == "qdrant"
    assert RetrievalOverrides(backend="weaviate").backend == "weaviate"
    assert RetrievalOverrides(backend="pgvector").backend == "pgvector"
    assert RetrievalOverrides(final_top_k=5).backend is None
    with pytest.raises(ValidationError):
        RetrievalOverrides(backend="milvus")


def _trace_payload():
    return dict(build_samples()["samples"]["RagTrace"])


def test_rag_trace_retrieval_backend_optional_and_validated():
    payload = _trace_payload()
    payload.pop("retrieval_backend", None)
    assert RagTrace.model_validate(payload).retrieval_backend is None

    block = {"backend": "weaviate", "fallback_reason": "backend_not_ready", "tenant_validation_dropped": 0}
    trace = RagTrace.model_validate({**payload, "retrieval_backend": block})
    assert trace.retrieval_backend is not None
    assert trace.retrieval_backend.fallback_reason == "backend_not_ready"

    for reason in ["backend_error", "backend_slow", "filter_unsupported", None]:
        ok = RagTrace.model_validate({**payload, "retrieval_backend": {**block, "fallback_reason": reason}})
        assert ok.retrieval_backend.fallback_reason == reason

    for bad in [
        {**block, "tenant_validation_dropped": -1},
        {**block, "fallback_reason": "timeout"},
        {**block, "backend": "milvus"},
        {**block, "detail": "text"},
    ]:
        with pytest.raises(ValidationError):
            RagTrace.model_validate({**payload, "retrieval_backend": bad})
