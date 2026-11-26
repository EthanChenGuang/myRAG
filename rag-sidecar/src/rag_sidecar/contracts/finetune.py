"""Embedding fine-tuning contracts (Phase 6.1 D-01, D-04 to D-31).

Every file the fine-tune pipeline writes and both LLM tool outputs. Report models (FilterReport, MiningReport,
TrainingRunReport, OfflineEvalReport, DatasetManifest) carry ids, hashes, counts, metrics and enumerated reasons
only, never chunk or query text (D-31). Phase 5.1.1's `TrainingPair` is consumed as is; this module's pair is
`FinetunePair` so the generated Zod file has no name clash (D-08).
"""

import math
import re
from typing import Annotated, Literal
from urllib.parse import urlsplit

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

from rag_sidecar.contracts.cache import EMBEDDING_PROFILE_ID_PATTERN, TENANT_KEY_PATTERN
from rag_sidecar.contracts.golden import UUID_PATTERN
from rag_sidecar.contracts.languages import Language

FINETUNE_SPLIT_RULE = "ft-sha256-first8hex-mod100-80-10-10"
FINETUNE_DIMS = 1024
PROBE_UNIT_TOLERANCE = 1e-3
PROBE_TEXTS: tuple[str, str, str] = (
    "Probe sentence one: a short neutral statement used to verify the embedding endpoint.",
    "探针句二：用于核对向量接口的一句中性短文。",
    "Frase di prova tre: una breve frase neutra per verificare l'endpoint dei vettori.",
)

SHA256_PATTERN = r"^[a-f0-9]{64}$"
REVISION_PATTERN = r"^[a-f0-9]{40}$"
RUN_ID_PATTERN = r"^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$"
OBJECT_ID_PATTERN = r"^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$"
HF_MODEL_ID_PATTERN = r"^[A-Za-z0-9][A-Za-z0-9._-]{0,95}/[A-Za-z0-9][A-Za-z0-9._-]{0,95}$"
LLM_MODEL_ID_PATTERN = r"^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$"
EMBEDDING_MODEL_PATTERN = r"^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,127}$"
MODEL_VERSION_ID_PATTERN = r"^ft-[a-z0-9][a-z0-9.-]{2,58}$"
PROMPT_VERSION_PATTERN = r"^[a-z0-9][a-z0-9._-]{0,31}$"
LICENCE_PATTERN = r"^[A-Za-z0-9][A-Za-z0-9.+-]{0,31}$"
GIT_COMMIT_PATTERN = r"^[a-f0-9]{7,40}$"
LIBRARY_VERSION_PATTERN = r"^[0-9][0-9A-Za-z.+-]{0,63}$"
BUNDLE_FILE_PATTERN = r"^[A-Za-z0-9][A-Za-z0-9._/-]{0,127}$"
CONFIG_PATH_PATTERN = r"^[A-Za-z0-9][A-Za-z0-9._/-]{0,255}$"
ISO_TIMESTAMP_PATTERN = r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,6})?(Z|[+-]\d{2}:\d{2})$"
LANGUAGE_PAIR_PATTERN = r"^[a-z]{2,3}->[a-z]{2,3}$"
SLICE_KEY_PATTERN = r"^(overall|language:[a-z]{2,3}|pair:[a-z]{2,3}->[a-z]{2,3}|source:(synthetic|mined))$"
URI_SCHEME_PATTERN = r"^[a-z][a-z0-9+.-]*$"

TenantKey = Annotated[str, Field(pattern=TENANT_KEY_PATTERN)]
UuidStr = Annotated[str, Field(pattern=UUID_PATTERN)]
Sha256 = Annotated[str, Field(pattern=SHA256_PATTERN)]
Revision = Annotated[str, Field(pattern=REVISION_PATTERN)]
RunId = Annotated[str, Field(pattern=RUN_ID_PATTERN)]
ObjectId = Annotated[str, Field(pattern=OBJECT_ID_PATTERN)]
HfModelId = Annotated[str, Field(pattern=HF_MODEL_ID_PATTERN)]
LlmModelId = Annotated[str, Field(pattern=LLM_MODEL_ID_PATTERN)]
EmbeddingModelName = Annotated[str, Field(pattern=EMBEDDING_MODEL_PATTERN)]
ProfileId = Annotated[str, Field(pattern=EMBEDDING_PROFILE_ID_PATTERN)]
ModelVersionId = Annotated[str, Field(pattern=MODEL_VERSION_ID_PATTERN)]
PromptVersion = Annotated[str, Field(pattern=PROMPT_VERSION_PATTERN)]
Licence = Annotated[str, Field(pattern=LICENCE_PATTERN)]
GitCommit = Annotated[str, Field(pattern=GIT_COMMIT_PATTERN)]
LibraryVersion = Annotated[str, Field(pattern=LIBRARY_VERSION_PATTERN)]
BundleFile = Annotated[str, Field(pattern=BUNDLE_FILE_PATTERN)]
ConfigPath = Annotated[str, Field(pattern=CONFIG_PATH_PATTERN)]
Timestamp = Annotated[str, Field(pattern=ISO_TIMESTAMP_PATTERN)]
LanguagePair = Annotated[str, Field(pattern=LANGUAGE_PAIR_PATTERN)]
SliceKey = Annotated[str, Field(pattern=SLICE_KEY_PATTERN)]
Count = Annotated[int, Field(ge=0)]
Rate = Annotated[float, Field(ge=0, le=1)]
OptionalPrice = Annotated[float | None, Field(default=None, ge=0)]

FinetuneSplit = Literal["train", "dev", "test"]
PairSource = Literal["synthetic", "mined"]
NegativeSource = Literal["expert", "mined"]
QueryStyle = Literal["keyword", "question", "colloquial", "cross_language"]
DatasetPurpose = Literal["private", "deployment"]
ModelScope = Literal["deployment", "tenant"]
CardStatus = Literal["candidate", "rejected_offline"]
MinerKind = Literal["vectors", "st"]
SamplingStrategy = Literal["top", "random"]
IrMetricName = Literal["recall_at_10", "mrr_at_10", "ndcg_at_10"]
DropReason = Literal[
    "shape",
    "language",
    "verbatim_copy",
    "near_duplicate",
    "not_answerable",
    "low_confidence",
    "golden_overlap",
    "unknown_chunk_ref",
]
OfflineRejectReason = Literal[
    "below_production_overall",
    "language_slice_below_production",
    "below_base",
    "empty_test_split",
]
DeltaComparison = Literal["finetuned_vs_production", "finetuned_vs_base"]


class _Contract(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)


def _unique_sorted(values: list[str], what: str) -> list[str]:
    if len(values) != len(set(values)):
        raise ValueError(f"{what} must not repeat")
    if values != sorted(values):
        raise ValueError(f"{what} must be sorted")
    return values


# --- config (eval/config/finetune.json) ----------------------------------------------------------------------


class PromptVersions(_Contract):
    generate: PromptVersion
    judge: PromptVersion


class GenerationConfig(_Contract):
    queries_per_chunk: int = Field(ge=1, le=10)
    styles: list[Literal["keyword", "question", "colloquial"]] = Field(min_length=1, max_length=10)
    cross_language_share: Rate
    min_chunk_tokens: int = Field(ge=0)
    batch_chars: int = Field(ge=1000)
    max_tokens: int = Field(ge=256)

    @model_validator(mode="after")
    def _styles_per_query(self) -> "GenerationConfig":
        if len(self.styles) != self.queries_per_chunk:
            raise ValueError("styles must list one style per query of a chunk")
        return self


class FilterConfig(_Contract):
    min_query_chars: dict[Language, int]
    max_query_chars: dict[Language, int]
    containment_ngram: int = Field(ge=1, le=10)
    verbatim_containment: Rate
    lcs_ratio: Rate
    near_dup_ngram: int = Field(ge=1, le=10)
    near_dup_jaccard: Rate
    judge_min_confidence: Rate
    golden_overlap_jaccard: Rate

    @model_validator(mode="after")
    def _bounds(self) -> "FilterConfig":
        if set(self.min_query_chars) != set(self.max_query_chars):
            raise ValueError("min_query_chars and max_query_chars must cover the same languages")
        for language, low in self.min_query_chars.items():
            high = self.max_query_chars[language]
            if not 1 <= low <= high <= 400:
                raise ValueError(f"query length bounds for {language} must satisfy 1 <= min <= max <= 400")
        return self


class MinedConfig(_Contract):
    mined_weight: int = Field(ge=1, le=10)


class MiningParams(_Contract):
    relative_margin: float | None = Field(default=None, ge=0, le=1)
    absolute_margin: float | None = Field(default=None, ge=0, le=2)
    range_min: int = Field(ge=0)
    range_max: int = Field(ge=1)
    max_score: float | None = Field(default=None, ge=-1, le=1)
    min_score: float | None = Field(default=None, ge=-1, le=1)
    num_negatives: int = Field(ge=1, le=32)
    sampling_strategy: SamplingStrategy
    neighbour_window: int = Field(ge=0, le=10)
    fn_audit_sample: int = Field(ge=0)
    fn_audit_max_upper: Rate
    round_trip_k: int | None = Field(default=None, ge=1)

    @model_validator(mode="after")
    def _range(self) -> "MiningParams":
        if self.range_min >= self.range_max:
            raise ValueError("range_min must be below range_max")
        if self.num_negatives > self.range_max - self.range_min:
            raise ValueError("num_negatives cannot exceed the candidate range")
        if self.min_score is not None and self.max_score is not None and self.min_score > self.max_score:
            raise ValueError("min_score must not exceed max_score")
        return self


class SplitConfig(_Contract):
    rule: Literal["ft-sha256-first8hex-mod100-80-10-10"]


class BaseModelSpec(_Contract):
    id: HfModelId
    revision: Revision
    dims: Literal[1024]
    licence: Licence
    max_seq_length: int = Field(ge=16)
    default: bool
    query_prompt: str = Field(max_length=1024)
    document_prompt: str = Field(max_length=1024)
    prompt_version: PromptVersion


class GistOptions(_Contract):
    enabled: bool
    cached: bool
    guide: Literal["base_model"]


class MatryoshkaOptions(_Contract):
    enabled: bool
    dims: list[int] = Field(min_length=1, max_length=8)

    @field_validator("dims")
    @classmethod
    def _descending_from_slot(cls, value: list[int]) -> list[int]:
        if value[0] != FINETUNE_DIMS:
            raise ValueError("the first Matryoshka dimension must be the slot dimension 1024")
        if any(b >= a for a, b in zip(value, value[1:])) or value[-1] < 32:
            raise ValueError("Matryoshka dims must be strictly descending and at least 32")
        return value


class TrainingRecipe(_Contract):
    loss: Literal["CachedMultipleNegativesRankingLoss", "MultipleNegativesRankingLoss"]
    mini_batch_size: int = Field(ge=1)
    per_device_train_batch_size: int = Field(ge=2)
    batch_sampler: Literal["no_duplicates"]
    learning_rate: float = Field(gt=0, le=1e-2)
    warmup_ratio: float = Field(ge=0, le=0.5)
    num_train_epochs: int = Field(ge=1, le=20)
    bf16: bool
    seed: int = Field(ge=0)
    eval_steps: int = Field(ge=1)
    metric_for_best_model: Literal["ndcg_at_10"]
    load_best_model_at_end: bool
    gist: GistOptions
    matryoshka: MatryoshkaOptions

    @model_validator(mode="after")
    def _mini_batch(self) -> "TrainingRecipe":
        if self.mini_batch_size > self.per_device_train_batch_size:
            raise ValueError("mini_batch_size cannot exceed per_device_train_batch_size")
        return self


class EvaluationConfig(_Contract):
    k: Literal[10]
    bootstrap_resamples: int = Field(ge=100, le=100_000)
    bootstrap_seed: int = Field(ge=0)
    noise_config: ConfigPath


class RetentionConfig(_Contract):
    retention_days: int = Field(ge=1, le=3650)


class ExportConfig(_Contract):
    batch_rows: int = Field(ge=1, le=10_000)


class TokenPrice(_Contract):
    input_usd_per_mtok: OptionalPrice
    output_usd_per_mtok: OptionalPrice


class PriceTable(_Contract):
    """Null means unknown cost: dry runs report the token projection and no dollar figure (D-06)."""

    generator: TokenPrice
    judge: TokenPrice
    gpu_hour_usd: OptionalPrice
    reembed_usd_per_mtok: OptionalPrice


class FinetuneConfig(_Contract):
    schema_version: Literal[1] = 1
    generator_model: LlmModelId
    judge_model: LlmModelId
    prompts: PromptVersions
    generation: GenerationConfig
    filters: FilterConfig
    mined: MinedConfig
    mining: MiningParams
    split: SplitConfig
    base_models: list[BaseModelSpec] = Field(min_length=1)
    training: TrainingRecipe
    evaluation: EvaluationConfig
    retention: RetentionConfig
    export: ExportConfig
    prices: PriceTable

    @model_validator(mode="after")
    def _one_default_base(self) -> "FinetuneConfig":
        ids = [model.id for model in self.base_models]
        if len(ids) != len(set(ids)):
            raise ValueError("base_models must not repeat a model id")
        if sum(1 for model in self.base_models if model.default) != 1:
            raise ValueError("exactly one base model must be the default")
        return self


# --- export --------------------------------------------------------------------------------------------------


class ExportedChunk(_Contract):
    tenant_key: TenantKey
    document_id: UuidStr
    chunk_id: ObjectId
    chunk_index: int = Field(ge=0)
    content_hash: Sha256
    document_content_hash: Sha256 | None = None
    language: Language
    split: FinetuneSplit
    text: str = Field(min_length=1)
    token_count: int = Field(ge=0)
    is_golden_test_evidence: bool

    @model_validator(mode="after")
    def _golden_evidence_is_test(self) -> "ExportedChunk":
        if self.is_golden_test_evidence and self.split != "test":
            raise ValueError("a document holding golden test evidence must be in the test split (D-09)")
        return self


class DatasetManifest(_Contract):
    run_id: RunId
    purpose: DatasetPurpose
    split_rule: Literal["ft-sha256-first8hex-mod100-80-10-10"]
    tenant_keys: list[TenantKey] = Field(min_length=1)
    chunks: dict[FinetuneSplit, Count] = Field(default_factory=dict)
    counts: dict[FinetuneSplit, dict[PairSource, Count]]
    files: dict[BundleFile, Sha256]
    created_at: Timestamp

    @field_validator("tenant_keys")
    @classmethod
    def _keys(cls, value: list[str]) -> list[str]:
        return _unique_sorted(value, "tenant_keys")

    @model_validator(mode="after")
    def _private_is_one_tenant(self) -> "DatasetManifest":
        if self.purpose == "private" and len(self.tenant_keys) != 1:
            raise ValueError("a private dataset holds exactly one tenant (D-27)")
        return self


# --- generation (LLM tool outputs) ---------------------------------------------------------------------------


class SyntheticQuery(_Contract):
    chunk_ref: int = Field(ge=0)
    language: Language
    style: QueryStyle
    query: str = Field(min_length=1, max_length=400)


class SyntheticQueryBatch(_Contract):
    items: list[SyntheticQuery] = Field(max_length=2000)


class AnswerabilityVerdict(_Contract):
    answerable: bool
    confidence: Rate


# --- filtering -----------------------------------------------------------------------------------------------


class LanguageFilterCounts(_Contract):
    kept: Count
    dropped: Count


class FilterReport(_Contract):
    kept: Count
    dropped: dict[DropReason, Count]
    by_language: dict[Language, LanguageFilterCounts]
    round_trip: Literal["not_applied"]
    judge_skipped: bool


# --- pairs and mining ----------------------------------------------------------------------------------------


class FinetuneNegative(_Contract):
    chunk_id: ObjectId
    text: str = Field(min_length=1)
    negative_source: NegativeSource


class FinetunePair(_Contract):
    pair_id: ObjectId
    tenant_key: TenantKey
    language: Language
    positive_language: Language
    anchor: str = Field(min_length=1, max_length=2000)
    positive_chunk_id: ObjectId
    positive: str = Field(min_length=1)
    negatives: list[FinetuneNegative] = Field(default_factory=list, max_length=32)
    source: PairSource
    split: FinetuneSplit
    weight: int = Field(ge=1)

    @model_validator(mode="after")
    def _negatives(self) -> "FinetunePair":
        ids = [negative.chunk_id for negative in self.negatives]
        if len(ids) != len(set(ids)):
            raise ValueError("negatives must not repeat a chunk")
        if self.positive_chunk_id in ids:
            raise ValueError("the positive chunk cannot be a negative")
        return self


class FnAudit(_Contract):
    sampled: Count
    answerable: Count
    upper_95: Rate | None = None
    passed: bool
    skipped: bool

    @model_validator(mode="after")
    def _consistent(self) -> "FnAudit":
        if self.answerable > self.sampled:
            raise ValueError("answerable cannot exceed sampled")
        if self.skipped and self.upper_95 is not None:
            raise ValueError("a skipped audit has no bound")
        if not self.skipped and self.upper_95 is None:
            raise ValueError("an audit that ran must report its bound")
        return self


class MiningReport(_Contract):
    miner: MinerKind
    pairs: Count
    with_full_negatives: Count
    pairs_only: Count
    mean_negatives: float = Field(ge=0)
    round_trip_k: int | None = Field(default=None, ge=1)
    round_trip_miss: Count
    fn_audit: FnAudit
    params: MiningParams

    @model_validator(mode="after")
    def _totals(self) -> "MiningReport":
        if self.with_full_negatives + self.pairs_only != self.pairs:
            raise ValueError("with_full_negatives + pairs_only must equal pairs")
        return self


# --- training ------------------------------------------------------------------------------------------------


class LibraryVersions(_Contract):
    torch: LibraryVersion
    transformers: LibraryVersion
    sentence_transformers: LibraryVersion
    datasets: LibraryVersion


class TrainingRunConfig(_Contract):
    run_id: RunId
    base_model: HfModelId
    base_revision: Revision
    dataset_manifest_sha256: Sha256
    config_sha256: Sha256
    seed: int = Field(ge=0)
    git_commit: GitCommit
    library_versions: LibraryVersions
    recipe: TrainingRecipe


class TrainingRunReport(_Contract):
    run_id: RunId
    training_config_sha256: Sha256
    examples: dict[Literal["ntuple", "pairs"], Count]
    steps: Count
    final_train_loss: float | None = Field(default=None, ge=0)
    best_step: int | None = Field(default=None, ge=0)
    best_dev_ndcg_at_10: Rate | None = None
    duration_seconds: float = Field(ge=0)
    device: Literal["cpu", "cuda", "mps"]


# --- offline evaluation --------------------------------------------------------------------------------------


class IrMetrics(_Contract):
    n: Count
    recall_at_10: Rate
    mrr_at_10: Rate
    ndcg_at_10: Rate


class ModelMetricsBlock(_Contract):
    overall: IrMetrics
    by_language: dict[Language, IrMetrics]
    by_pair: dict[LanguagePair, IrMetrics]
    by_source: dict[PairSource, IrMetrics]


class OfflineModels(_Contract):
    base: ModelMetricsBlock
    finetuned: ModelMetricsBlock
    production: ModelMetricsBlock


class MetricDelta(_Contract):
    comparison: DeltaComparison
    metric: IrMetricName
    slice: SliceKey
    delta: float = Field(ge=-1, le=1)
    ci_low: float = Field(ge=-1, le=1)
    ci_high: float = Field(ge=-1, le=1)

    @model_validator(mode="after")
    def _interval(self) -> "MetricDelta":
        if self.ci_low > self.ci_high:
            raise ValueError("ci_low must not exceed ci_high")
        return self


class OfflineEvalReport(_Contract):
    models: OfflineModels
    deltas: list[MetricDelta]
    noise_band: float = Field(ge=0, le=1)
    passed: bool
    reasons: list[OfflineRejectReason]

    @model_validator(mode="after")
    def _verdict(self) -> "OfflineEvalReport":
        if len(self.reasons) != len(set(self.reasons)):
            raise ValueError("reasons must not repeat")
        if self.passed == bool(self.reasons):
            raise ValueError("a passing report has no reasons and a failing report names at least one")
        return self


# --- model card ----------------------------------------------------------------------------------------------


class ProbeSet(_Contract):
    texts: list[str] = Field(min_length=3, max_length=3)
    query_prompt: str = Field(max_length=1024)
    document_prompt: str = Field(max_length=1024)
    vectors: list[list[float]] = Field(min_length=3, max_length=3)

    @field_validator("texts")
    @classmethod
    def _fixed_texts(cls, value: list[str]) -> list[str]:
        if tuple(value) != PROBE_TEXTS:
            raise ValueError("probe texts must be the three fixed PROBE_TEXTS strings (D-24)")
        return value

    @field_validator("vectors")
    @classmethod
    def _unit_vectors(cls, value: list[list[float]]) -> list[list[float]]:
        for vector in value:
            if len(vector) != FINETUNE_DIMS:
                raise ValueError(f"probe vectors must have {FINETUNE_DIMS} dimensions")
            norm = math.sqrt(math.fsum(component * component for component in vector))
            if abs(norm - 1.0) > PROBE_UNIT_TOLERANCE:
                raise ValueError("probe vectors must be unit length within 1e-3")
        return value


def _check_artifact_uri(value: str) -> str:
    scheme, sep, rest = value.partition(":")
    if not sep or not scheme or not re.fullmatch(URI_SCHEME_PATTERN, scheme):
        raise ValueError("artifact_uri needs a lowercase scheme")
    if any(mark in rest for mark in "@?#"):
        raise ValueError("artifact_uri must not carry userinfo, a query string or a fragment (D-30)")
    parts = urlsplit(value)
    if parts.username is not None or parts.password is not None or parts.query or parts.fragment:
        raise ValueError("artifact_uri must not carry userinfo, a query string or a fragment (D-30)")
    if not (parts.netloc or parts.path.strip("/")):
        raise ValueError("artifact_uri needs a location")
    return value


class ModelVersionCard(_Contract):
    id: ModelVersionId
    base_model: HfModelId
    base_revision: Revision
    dims: Literal[1024]
    scope: ModelScope
    tenant_keys: list[TenantKey] = Field(min_length=1)
    dataset_manifest_sha256: Sha256
    training_config_sha256: Sha256
    query_prompt: str = Field(max_length=1024)
    document_prompt: str = Field(max_length=1024)
    offline: OfflineEvalReport
    status: CardStatus
    probe: ProbeSet
    artifact_uri: str = Field(min_length=3, max_length=2048)

    @field_validator("tenant_keys")
    @classmethod
    def _keys(cls, value: list[str]) -> list[str]:
        return _unique_sorted(value, "tenant_keys")

    @field_validator("artifact_uri")
    @classmethod
    def _uri(cls, value: str) -> str:
        return _check_artifact_uri(value)

    @model_validator(mode="after")
    def _card_rules(self) -> "ModelVersionCard":
        if self.scope == "tenant" and len(self.tenant_keys) != 1:
            raise ValueError("a tenant-scope model is trained on exactly one tenant (D-28)")
        if (self.status == "candidate") != self.offline.passed:
            raise ValueError("status must be candidate when the offline gate passed, else rejected_offline")
        if self.probe.query_prompt != self.query_prompt or self.probe.document_prompt != self.document_prompt:
            raise ValueError("probe vectors must be computed with the card's prompts")
        return self


# --- vector files --------------------------------------------------------------------------------------------


class QueryVectorRow(_Contract):
    pair_id: ObjectId | None = None
    query_id: ObjectId | None = None
    profile_id: ProfileId
    model: EmbeddingModelName
    dims: int = Field(ge=1)
    vector: list[float] = Field(min_length=1)

    @model_validator(mode="after")
    def _shape(self) -> "QueryVectorRow":
        if (self.pair_id is None) == (self.query_id is None):
            raise ValueError("exactly one of pair_id and query_id is set")
        if len(self.vector) != self.dims:
            raise ValueError("vector length must equal dims")
        return self


class ChunkVectorRow(_Contract):
    tenant_key: TenantKey
    chunk_id: ObjectId
    row_index: int = Field(ge=0)
    profile_id: ProfileId
    model: EmbeddingModelName
    dims: int = Field(ge=1)


class VectorFileHeader(_Contract):
    tenant_key: TenantKey
    profile_id: ProfileId
    model: EmbeddingModelName
    dims: int = Field(ge=1)
    rows: Count
    dtype: Literal["float32-le"]
    sha256: Sha256
