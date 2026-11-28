from typing import Annotated

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

from .languages import Language

Uuid = Annotated[str, Field(pattern=r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$")]

MAX_TRANSLATION_CHARS = 50_000


class _Contract(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)


class ChunkTranslation(_Contract):
    """Structured model output of one chunk translation (D-29)."""

    content: str = Field(min_length=1, max_length=MAX_TRANSLATION_CHARS)

    @field_validator("content", mode="after")
    @classmethod
    def _not_blank(cls, value: str) -> str:
        if not value.strip():
            raise ValueError("content must not be blank")
        return value


class TranslationSettings(_Contract):
    """Per-tenant translation targets (D-31); the subset check against the supported languages is the route's job."""

    target_languages: list[Language] = Field(default_factory=list)
    enabled: bool = False
    updated_by: Uuid | None = None

    @model_validator(mode="after")
    def _check_targets(self) -> "TranslationSettings":
        if len(set(self.target_languages)) != len(self.target_languages):
            raise ValueError("target_languages must not repeat")
        if self.enabled and not self.target_languages:
            raise ValueError("enabled translation needs at least one target language")
        return self
