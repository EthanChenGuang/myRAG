from typing import Annotated, Literal

from pydantic import BaseModel, ConfigDict, Field, model_validator

from rag_sidecar.contracts.answers import AnswerGroundedness, CitationRecord
from rag_sidecar.contracts.groundedness import ThresholdSource
from rag_sidecar.contracts.query import Lang

TENANT_KEY_PATTERN = r"^(s:default|[uo]:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$"
KEY_HASH_PATTERN = r"^[0-9a-f]{64}$"
EMBEDDING_PROFILE_ID_PATTERN = r"^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$"
CACHE_MAX_DISTANCE = 0.2
CACHE_MAX_TTL_SECONDS = 86400

CacheTenantKey = Annotated[str, Field(pattern=TENANT_KEY_PATTERN)]
CacheKeyHash = Annotated[str, Field(pattern=KEY_HASH_PATTERN)]
EmbeddingProfileId = Annotated[str, Field(pattern=EMBEDDING_PROFILE_ID_PATTERN)]
CacheVector = Annotated[list[Annotated[float, Field(allow_inf_nan=False)]], Field(min_length=1, max_length=4096)]
CacheDistance = Annotated[float, Field(ge=0, le=CACHE_MAX_DISTANCE)]
CacheRagMode = Literal["strict", "balanced"]
DocumentId = Annotated[str, Field(min_length=1)]
Rate = Annotated[float, Field(ge=0, le=1)]


class _Contract(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)


class CachedSource(_Contract):
    document_id: DocumentId
    name: str
    version: int = Field(ge=1)


class CachedSourceVersion(_Contract):
    document_id: DocumentId
    version: int = Field(ge=1)


class CachedAnswer(_Contract):
    answer_text: str = Field(min_length=1)
    citations: list[CitationRecord] = Field(default_factory=list)
    sources: list[CachedSource] = Field(default_factory=list)
    source_versions: list[CachedSourceVersion] = Field(default_factory=list)
    answer_language: Lang
    rag_mode: CacheRagMode
    is_refusal: bool
    groundedness: AnswerGroundedness
    trace_id: str = Field(min_length=1)
    created_at: str = Field(min_length=1)

    @model_validator(mode="after")
    def _storable(self) -> "CachedAnswer":
        status, label = self.groundedness.status, self.groundedness.label
        if not ((status == "scored" and label == "verified") or status == "not_checked"):
            raise ValueError("a cached answer carries a scored verified or a not_checked groundedness only")
        versioned = [entry.document_id for entry in self.source_versions]
        if len(versioned) != len(set(versioned)):
            raise ValueError("source_versions lists a document more than once")
        known = set(versioned)
        if any(citation.documentId not in known for citation in self.citations):
            raise ValueError("every cited document needs a source_versions entry")
        if any(source.document_id not in known for source in self.sources):
            raise ValueError("every shown source needs a source_versions entry")
        if self.is_refusal and self.citations:
            raise ValueError("a refusal carries no citations")
        return self


class CacheCheckRequest(_Contract):
    tenant_key: CacheTenantKey
    key_hash: CacheKeyHash
    embedding_profile_id: EmbeddingProfileId
    vector: CacheVector
    max_distance: CacheDistance


class CacheCheckResponse(_Contract):
    hit: bool
    entry_id: str | None = Field(default=None, min_length=1)
    distance: float | None = Field(default=None, ge=0, le=2)
    answer: CachedAnswer | None = None

    @model_validator(mode="after")
    def _hit_rules(self) -> "CacheCheckResponse":
        present = [self.entry_id is not None, self.distance is not None, self.answer is not None]
        if self.hit and not all(present):
            raise ValueError("a hit carries entry_id, distance and answer")
        if not self.hit and any(present):
            raise ValueError("a miss carries no entry_id, distance or answer")
        return self


class CacheStoreRequest(_Contract):
    tenant_key: CacheTenantKey
    key_hash: CacheKeyHash
    embedding_profile_id: EmbeddingProfileId
    query_text_masked: str = Field(min_length=1, max_length=8000)
    vector: CacheVector
    answer: CachedAnswer
    ttl_seconds: int = Field(ge=1, le=CACHE_MAX_TTL_SECONDS)


class CacheInvalidateRequest(_Contract):
    tenant_key: CacheTenantKey
    document_ids: list[DocumentId] | None = Field(default=None, min_length=1)


class CacheInvalidateResponse(_Contract):
    deleted: int = Field(ge=0)


class CacheSplitMetrics(_Contract):
    paraphrase_pairs: int = Field(ge=0)
    near_miss_pairs: int = Field(ge=0)
    paraphrase_hit_rate: Rate
    near_miss_wrong_hit_rate: Rate


class SemanticCacheProfileCalibration(_Contract):
    embedding_profile_id: EmbeddingProfileId
    max_distance: CacheDistance
    source: ThresholdSource
    fitted_at: str | None = None
    dev: CacheSplitMetrics | None = None
    test: CacheSplitMetrics | None = None

    @model_validator(mode="after")
    def _calibrated_rules(self) -> "SemanticCacheProfileCalibration":
        if self.source != "calibrated":
            return self
        if self.dev is None or self.test is None or not self.fitted_at:
            raise ValueError("a calibrated profile needs dev and test metrics and fitted_at")
        for split in (self.dev, self.test):
            if split.paraphrase_pairs == 0 or split.near_miss_pairs == 0:
                raise ValueError("a calibrated profile needs paraphrase and near-miss pairs on both splits")
            if split.near_miss_wrong_hit_rate > 0:
                raise ValueError("a calibrated profile has a near-miss wrong-hit rate of 0 on both splits")
        return self


class SemanticCacheCalibration(_Contract):
    schema_version: Literal[1] = 1
    profiles: list[SemanticCacheProfileCalibration] = Field(default_factory=list)

    @model_validator(mode="after")
    def _unique_profiles(self) -> "SemanticCacheCalibration":
        ids = [profile.embedding_profile_id for profile in self.profiles]
        if len(ids) != len(set(ids)):
            raise ValueError("duplicate embedding profile in the cache calibration")
        return self
