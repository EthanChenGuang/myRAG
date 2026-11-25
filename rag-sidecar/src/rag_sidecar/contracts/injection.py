from typing import Annotated, Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

MAX_CLASSIFY_ITEMS = 32
MAX_CLASSIFY_TEXT_CHARS = 20_000
PROMPT_GUARD_MAX_WINDOW_TOKENS = 512

ClassifyLabel = Literal["BENIGN", "MALICIOUS"]
# Llama Prompt Guard 2 model card languages; zh is not covered (A-12).
PromptGuardLanguage = Literal["en", "fr", "de", "hi", "it", "pt", "es", "th"]
# Voice and media profiles are rules only, so they are not valid in an ML detector list (D-09, A-11).
MlDetectorProfile = Literal["chat", "embed", "eval"]
LakeraLevel = Literal["l1_confident", "l2_very_likely", "l3_likely", "l4_less_likely", "l5_unlikely"]

_UNIQUE = {"uniqueItems": True}

DetectorType = Annotated[str, Field(pattern=r"^[a-z][a-z0-9_]{0,63}$")]


class _Contract(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)


def _require_unique(values: list, field: str) -> None:
    if len(values) != len(set(values)):
        raise ValueError(f"{field} must not repeat")


class InjectionClassifyItem(_Contract):
    id: str = Field(min_length=1, max_length=64)
    text: str = Field(min_length=1, max_length=MAX_CLASSIFY_TEXT_CHARS)


class InjectionClassifyRequest(_Contract):
    items: list[InjectionClassifyItem] = Field(min_length=1, max_length=MAX_CLASSIFY_ITEMS)

    @model_validator(mode="after")
    def _ids_are_unique(self) -> "InjectionClassifyRequest":
        _require_unique([item.id for item in self.items], "item ids")
        return self


class InjectionClassifyResult(_Contract):
    id: str = Field(min_length=1, max_length=64)
    score: float = Field(ge=0, le=1)
    label: ClassifyLabel
    windows: int = Field(ge=1)


class InjectionClassifyResponse(_Contract):
    model_id: str = Field(min_length=1, max_length=200)
    revision: str = Field(min_length=1, max_length=64)
    results: list[InjectionClassifyResult] = Field(max_length=MAX_CLASSIFY_ITEMS)

    @model_validator(mode="after")
    def _ids_are_unique(self) -> "InjectionClassifyResponse":
        _require_unique([result.id for result in self.results], "result ids")
        return self


class PromptGuardConfig(_Contract):
    model_id: str = Field(pattern=r"^[A-Za-z0-9][A-Za-z0-9._-]*/[A-Za-z0-9][A-Za-z0-9._-]*$", max_length=200)
    revision: str = Field(pattern=r"^[0-9a-f]{40}$")
    threshold: float = Field(ge=0, le=1)
    languages: list[PromptGuardLanguage] = Field(min_length=1, json_schema_extra=_UNIQUE)
    window_tokens: int = Field(ge=16, le=PROMPT_GUARD_MAX_WINDOW_TOKENS)
    stride_tokens: int = Field(ge=0, lt=PROMPT_GUARD_MAX_WINDOW_TOKENS)
    max_items: int = Field(ge=1, le=MAX_CLASSIFY_ITEMS)
    inline_profiles: list[MlDetectorProfile] = Field(json_schema_extra=_UNIQUE)
    warm_profiles: list[MlDetectorProfile] = Field(json_schema_extra=_UNIQUE)

    @field_validator("languages", "inline_profiles", "warm_profiles")
    @classmethod
    def _no_repeats(cls, value: list[str], info) -> list[str]:
        _require_unique(value, info.field_name)
        return value

    @model_validator(mode="after")
    def _consistent(self) -> "PromptGuardConfig":
        if self.stride_tokens >= self.window_tokens:
            raise ValueError("stride_tokens must be smaller than window_tokens")
        overlap = set(self.inline_profiles) & set(self.warm_profiles)
        if overlap:
            raise ValueError(f"profiles cannot be both inline and warm: {sorted(overlap)}")
        return self


class LakeraConfig(_Contract):
    detector_types: list[DetectorType] = Field(min_length=1, json_schema_extra=_UNIQUE)
    min_level: LakeraLevel | None = None
    concurrency: int = Field(ge=1, le=8)
    max_chars: int = Field(ge=1, le=100_000)
    profiles: list[MlDetectorProfile] = Field(json_schema_extra=_UNIQUE)

    @field_validator("detector_types", "profiles")
    @classmethod
    def _no_repeats(cls, value: list[str], info) -> list[str]:
        _require_unique(value, info.field_name)
        return value


class VerdictCacheConfig(_Contract):
    max_entries: int = Field(ge=1, le=1_000_000)


class InjectionDetectorConfig(_Contract):
    schema_version: Literal[1] = 1
    version: str = Field(pattern=r"^\d{4}-\d{2}-\d{2}\.[1-9][0-9]*$")
    prompt_guard: PromptGuardConfig
    lakera: LakeraConfig
    cache: VerdictCacheConfig
    inner_reserve_ms: int = Field(ge=0, le=1000)
