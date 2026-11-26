from typing import Literal

from pydantic import BaseModel, ConfigDict, Field

from rag_sidecar.contracts.cache import TENANT_KEY_PATTERN
from rag_sidecar.contracts.eval_run import BindingProfileId
from rag_sidecar.contracts.retrieval import ExternalVectorBackend

VectorSyncMode = Literal["drain", "reconcile"]
ReconcileState = Literal["building", "ready", "stale", "failed"]


class _Contract(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)


class VectorSyncSliceReport(_Contract):
    mode: VectorSyncMode
    claimed: int = Field(ge=0)
    upserted: int = Field(ge=0)
    deleted: int = Field(ge=0)
    failed: int = Field(ge=0)
    dead: int = Field(ge=0)
    lag_seconds: float = Field(ge=0)
    elapsed_ms: int = Field(ge=0)
    budget_ms: int = Field(ge=0)
    more_pending: bool


class ReconcileReport(_Contract):
    target: ExternalVectorBackend
    profile_id: BindingProfileId
    tenant_key: str = Field(pattern=TENANT_KEY_PATTERN)
    supabase_count: int = Field(ge=0)
    backend_count: int = Field(ge=0)
    mismatched_buckets: int = Field(ge=0)
    missing: int = Field(ge=0)
    extra: int = Field(ge=0)
    stale: int = Field(ge=0)
    repairs_enqueued: int = Field(ge=0)
    state: ReconcileState
