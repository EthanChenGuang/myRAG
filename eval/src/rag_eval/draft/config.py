from pathlib import Path
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, model_validator
from rag_sidecar.contracts.languages import Language

from rag_eval.paths import REPO_ROOT

DEFAULT_CONFIG_PATH = REPO_ROOT / "eval" / "config" / "draft.json"


class _Config(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)


class DraftPersona(_Config):
    name: str = Field(min_length=1)
    role_description: str = Field(min_length=1)


class DraftConfig(_Config):
    claude_model: str
    max_tokens: int = Field(ge=1)
    min_items: int = Field(ge=1)
    max_items: int = Field(ge=1)
    languages: list[Language] = Field(min_length=1)
    claude_share: float = Field(ge=0.0, le=1.0)
    batch_chars: int = Field(ge=1000)
    ragas_styles: list[Literal["PERFECT_GRAMMAR", "POOR_GRAMMAR", "WEB_SEARCH_LIKE", "MISSPELLED"]] = Field(min_length=1)
    ragas_lengths: list[Literal["SHORT", "MEDIUM", "LONG"]] = Field(min_length=1)
    personas: list[DraftPersona] = Field(min_length=1)

    @model_validator(mode="after")
    def _check_range(self) -> "DraftConfig":
        if self.min_items > self.max_items:
            raise ValueError("min_items must not exceed max_items")
        return self


def load_draft_config(path: Path | None = None) -> DraftConfig:
    target = Path(path) if path is not None else DEFAULT_CONFIG_PATH
    return DraftConfig.model_validate_json(target.read_text(encoding="utf-8"))
