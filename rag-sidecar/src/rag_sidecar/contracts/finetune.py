"""Embedding fine-tuning contracts (Phase 6.1): RED stub, replaced by the implementation."""

from pydantic import BaseModel, ConfigDict

PROBE_TEXTS: tuple[str, str, str] = ("", "", "")
Language = str


class _Contract(BaseModel):
    model_config = ConfigDict(extra="allow", frozen=False)


class PromptVersions(_Contract):
    pass


class GenerationConfig(_Contract):
    pass


class FilterConfig(_Contract):
    pass


class MinedConfig(_Contract):
    pass


class MiningParams(_Contract):
    pass


class SplitConfig(_Contract):
    pass


class BaseModelSpec(_Contract):
    pass


class GistOptions(_Contract):
    pass


class MatryoshkaOptions(_Contract):
    pass


class TrainingRecipe(_Contract):
    pass


class EvaluationConfig(_Contract):
    pass


class RetentionConfig(_Contract):
    pass


class ExportConfig(_Contract):
    pass


class TokenPrice(_Contract):
    pass


class PriceTable(_Contract):
    pass


class FinetuneConfig(_Contract):
    pass


class ExportedChunk(_Contract):
    pass


class DatasetManifest(_Contract):
    pass


class SyntheticQuery(_Contract):
    pass


class SyntheticQueryBatch(_Contract):
    pass


class AnswerabilityVerdict(_Contract):
    pass


class LanguageFilterCounts(_Contract):
    pass


class FilterReport(_Contract):
    pass


class FinetuneNegative(_Contract):
    pass


class FinetunePair(_Contract):
    pass


class FnAudit(_Contract):
    pass


class MiningReport(_Contract):
    pass


class LibraryVersions(_Contract):
    pass


class TrainingRunConfig(_Contract):
    pass


class TrainingRunReport(_Contract):
    pass


class IrMetrics(_Contract):
    pass


class ModelMetricsBlock(_Contract):
    pass


class OfflineModels(_Contract):
    pass


class MetricDelta(_Contract):
    pass


class OfflineEvalReport(_Contract):
    pass


class ProbeSet(_Contract):
    pass


class ModelVersionCard(_Contract):
    pass


class QueryVectorRow(_Contract):
    pass


class ChunkVectorRow(_Contract):
    pass


class VectorFileHeader(_Contract):
    pass
