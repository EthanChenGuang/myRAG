from pydantic import BaseModel


class InjectionClassifyItem(BaseModel):
    id: str
    text: str


class InjectionClassifyRequest(BaseModel):
    items: list[InjectionClassifyItem]


class InjectionClassifyResult(BaseModel):
    id: str
    score: float
    label: str
    windows: int


class InjectionClassifyResponse(BaseModel):
    model_id: str
    revision: str
    results: list[InjectionClassifyResult]


class PromptGuardConfig(BaseModel):
    model_id: str
    revision: str
    threshold: float
    languages: list[str]
    window_tokens: int
    stride_tokens: int
    max_items: int
    inline_profiles: list[str]
    warm_profiles: list[str]


class LakeraConfig(BaseModel):
    detector_types: list[str]
    min_level: str | None = None
    concurrency: int
    max_chars: int
    profiles: list[str]


class VerdictCacheConfig(BaseModel):
    max_entries: int


class InjectionDetectorConfig(BaseModel):
    schema_version: int
    version: str
    prompt_guard: PromptGuardConfig
    lakera: LakeraConfig
    cache: VerdictCacheConfig
    inner_reserve_ms: int
