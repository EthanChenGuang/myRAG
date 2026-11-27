"""Per-language monitoring contracts (Phase 7 LANG-10, OBS-03 calibration).

Language values use the Phase 5.1.1 LanguageCode (`und` included), never the registry Language literal. Cells and
alerts carry counts, codes and ids only, never query, answer or chunk text.
"""

from typing import Annotated, Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

# eval_run.py imports this module, and cache, monitor and feedback_loop import eval_run through golden.py, so the
# shared patterns are restated here; tests pin each one equal to its source (FBK-01 LanguageCode, the canonical
# tenant key, the monitor id and day patterns).
LANGUAGE_CODE_PATTERN = r"^[a-z]{2,3}(-[A-Za-z0-9]{2,8})?$"
TENANT_KEY_PATTERN = r"^(s:default|[uo]:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$"
CODE_PATTERN = r"^[a-z0-9_]+$"
SHA256_PATTERN = r"^[a-f0-9]{64}$"
DAY_PATTERN = r"^\d{4}-\d{2}-\d{2}$"
TIMESTAMP_PATTERN = r"^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2}(\.\d{1,9})?)?(Z|[+-]\d{2}:\d{2})?)?$"
TRACE_ID_PATTERN = r"^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$"

LanguageCode = Annotated[str, Field(pattern=LANGUAGE_CODE_PATTERN)]
TenantKey = Annotated[str, Field(pattern=TENANT_KEY_PATTERN)]
Code = Annotated[str, Field(pattern=CODE_PATTERN)]
Sha256 = Annotated[str, Field(pattern=SHA256_PATTERN)]
Day = Annotated[str, Field(pattern=DAY_PATTERN)]
Timestamp = Annotated[str, Field(pattern=TIMESTAMP_PATTERN)]
TraceId = Annotated[str, Field(pattern=TRACE_ID_PATTERN)]
Count = Annotated[int, Field(ge=0)]

LengthBucket = Literal["short", "medium", "long"]
ScriptClass = Literal["single", "mixed"]
CalibrationSource = Literal["calibrated", "mapped_fallback"]
LanguageMetric = Literal["refusal_rate", "not_helpful_rate", "kb_unavailable_rate", "low_confidence_rate"]

DETECTOR_PATTERN = r"^[a-z0-9][a-z0-9_.-]{0,63}$"
InputPath = Annotated[str, Field(min_length=1, max_length=512, pattern=r"^[^\s].*$")]

LENGTH_BUCKETS: tuple[str, ...] = ("short", "medium", "long")
SCRIPT_CLASSES: tuple[str, ...] = ("single", "mixed")
MAPPED_CONFIDENCE = {True: 1.0, False: 0.5}
SMOOTHED_TOLERANCE = 1e-4
MAX_SAMPLE_TRACE_IDS = 10


class _Contract(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)


def _no_repeats(values: list, what: str) -> list:
    if len(values) != len(set(values)):
        raise ValueError(f"{what} must not repeat")
    return values


class TraceLanguages(_Contract):
    """LANG-10 trace block: the query language and its confidence, the kept chunks' languages and the answer language."""

    query_language: LanguageCode | None = None
    query_language_confidence: float | None = Field(default=None, ge=0, le=1)
    chunk_languages: list[LanguageCode] = Field(default_factory=list, json_schema_extra={"uniqueItems": True})
    answer_language: LanguageCode | None = None

    @field_validator("chunk_languages")
    @classmethod
    def _distinct(cls, value: list[str]) -> list[str]:
        return _no_repeats(value, "chunk_languages")


class CalibrationInput(_Contract):
    path: InputPath
    sha256: Sha256


class CalibrationLengthBuckets(_Contract):
    """Query length in characters: short up to short_max_chars, medium up to medium_max_chars, long above."""

    short_max_chars: int = Field(ge=1)
    medium_max_chars: int = Field(ge=2)

    @model_validator(mode="after")
    def _ordered(self) -> "CalibrationLengthBuckets":
        if self.short_max_chars >= self.medium_max_chars:
            raise ValueError("short_max_chars must be below medium_max_chars")
        return self


class CalibrationBin(_Contract):
    confident: bool
    length_bucket: LengthBucket
    script_class: ScriptClass
    n: Count
    correct: Count
    value: float = Field(ge=0, le=1)
    source: CalibrationSource

    @model_validator(mode="after")
    def _consistent(self) -> "CalibrationBin":
        if self.correct > self.n:
            raise ValueError("correct must not exceed n")
        if self.source == "mapped_fallback":
            if self.n != 0:
                raise ValueError("a mapped_fallback bin must be empty")
            if self.value != MAPPED_CONFIDENCE[self.confident]:
                raise ValueError("a mapped_fallback bin must hold the mapped confidence")
        else:
            if self.n == 0:
                raise ValueError("an empty bin must be marked mapped_fallback")
            smoothed = (self.correct + 1) / (self.n + 2)
            if abs(self.value - smoothed) > SMOOTHED_TOLERANCE:
                raise ValueError("a calibrated bin must hold the Laplace-smoothed accuracy")
        return self

    @property
    def key(self) -> tuple[bool, str, str]:
        return (self.confident, self.length_bucket, self.script_class)


class LanguageConfidenceCalibration(_Contract):
    """eval/config/language-confidence-calibration.json, written only by the calibration tool (plan 07-41)."""

    schema_version: Literal[1] = 1
    detector: str = Field(pattern=DETECTOR_PATTERN)
    generated_at: Timestamp
    smoothing: Literal["laplace"] = "laplace"
    length_buckets: CalibrationLengthBuckets
    inputs: list[CalibrationInput] = Field(min_length=1)
    bins: list[CalibrationBin] = Field(
        min_length=len(LENGTH_BUCKETS) * len(SCRIPT_CLASSES) * 2,
        max_length=len(LENGTH_BUCKETS) * len(SCRIPT_CLASSES) * 2,
    )

    @model_validator(mode="after")
    def _grid(self) -> "LanguageConfidenceCalibration":
        _no_repeats([item.path for item in self.inputs], "input paths")
        keys = [item.key for item in self.bins]
        _no_repeats(keys, "bin keys")
        expected = {(flag, bucket, script) for flag in (True, False) for bucket in LENGTH_BUCKETS for script in SCRIPT_CLASSES}
        if set(keys) != expected:
            raise ValueError("bins must cover every confident flag, length bucket and script class once")
        return self


class LanguageWindow(_Contract):
    since: Day
    until: Day

    @model_validator(mode="after")
    def _ordered(self) -> "LanguageWindow":
        if self.since > self.until:
            raise ValueError("since must not be after until")
        return self


class LanguageQualityCell(_Contract):
    """One per-language row of rag_language_quality_cells (plan 07-46); tenant_key None means all tenants."""

    tenant_key: TenantKey | None = None
    language: LanguageCode
    window: LanguageWindow
    retrievals: Count
    refused: Count
    kb_unavailable: Count
    votes_up: Count
    votes_down: Count
    low_confidence: Count

    @model_validator(mode="after")
    def _bounded(self) -> "LanguageQualityCell":
        if self.refused + self.kb_unavailable > self.retrievals:
            raise ValueError("refused plus kb_unavailable must not exceed retrievals")
        if self.votes_up + self.votes_down > self.retrievals:
            raise ValueError("votes must not exceed retrievals")
        if self.low_confidence > self.retrievals:
            raise ValueError("low_confidence must not exceed retrievals")
        return self


class LanguageDropAlert(_Contract):
    """LANG-10 alert: one language drops while the overall average holds; ids and counts only."""

    rule_id: Code
    metric: LanguageMetric
    language: LanguageCode
    tenant_key: TenantKey | None = None
    events: Count
    total: Count
    baseline_events: Count
    baseline_total: Count
    window: LanguageWindow
    sample_trace_ids: list[TraceId] = Field(
        default_factory=list, max_length=MAX_SAMPLE_TRACE_IDS, json_schema_extra={"uniqueItems": True}
    )

    @model_validator(mode="after")
    def _bounded(self) -> "LanguageDropAlert":
        if self.events > self.total:
            raise ValueError("events must not exceed total")
        if self.baseline_events > self.baseline_total:
            raise ValueError("baseline_events must not exceed baseline_total")
        _no_repeats(self.sample_trace_ids, "sample_trace_ids")
        return self
