from typing import Annotated, Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

ScopeDimension = Literal["region", "legal_entity", "department"]
SCOPE_DIMENSIONS: tuple[ScopeDimension, ...] = ("region", "legal_entity", "department")
ScopeSource = Literal["rule", "model"]

MAX_SCOPE_VALUES_PER_DIMENSION = 50
MAX_SCOPE_ALIASES = 50
MAX_SCOPE_SUGGESTIONS = 30

ScopeSlug = Annotated[str, Field(min_length=1, max_length=64, pattern=r"^[a-z0-9]+(?:-[a-z0-9]+)*$")]
ScopeText = Annotated[str, Field(min_length=1, max_length=200)]


class _Contract(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)


def _require_unique(values: list, field: str) -> None:
    if len(values) != len(set(values)):
        raise ValueError(f"{field} must not repeat")


def _drop_null_default(schema: dict) -> None:
    schema.pop("default", None)
    branches = schema.pop("anyOf", None) or []
    for branch in branches:
        if branch.get("type") != "null":
            schema.update(branch)


ScopeValues = Annotated[
    list[ScopeSlug] | None,
    Field(
        min_length=1,
        max_length=MAX_SCOPE_VALUES_PER_DIMENSION,
        exclude_if=lambda value: value is None,
        json_schema_extra=_drop_null_default,
    ),
]


class ScopeFilter(_Contract):
    """DATA-08 scope filter (D-39): OR within a dimension, AND across dimensions; only the three fixed dimensions."""

    region: ScopeValues = None
    legal_entity: ScopeValues = None
    department: ScopeValues = None

    @model_validator(mode="after")
    def _check_values(self) -> "ScopeFilter":
        named = [(dimension, getattr(self, dimension)) for dimension in SCOPE_DIMENSIONS]
        present = [(dimension, values) for dimension, values in named if values is not None]
        if not present:
            raise ValueError("scopes must name at least one dimension")
        for dimension, values in present:
            _require_unique(values, f"scopes.{dimension}")
        return self


class ScopeVocabularyEntry(_Contract):
    """One tenant vocabulary value (D-38); stored as `dimension:value` on documents and chunks."""

    dimension: ScopeDimension
    value: ScopeSlug
    label: ScopeText
    aliases: list[ScopeText] = Field(default_factory=list, max_length=MAX_SCOPE_ALIASES)
    active: bool = True

    @field_validator("aliases", mode="after")
    @classmethod
    def _unique_aliases(cls, value: list[str]) -> list[str]:
        _require_unique(value, "aliases")
        return value


class ScopeTagSuggestionItem(_Contract):
    dimension: ScopeDimension
    value: ScopeSlug
    source: ScopeSource


class ScopeTagSuggestion(_Contract):
    """Suggested tags (D-40): structured model output and rule matches; consumers keep only vocabulary values."""

    suggestions: list[ScopeTagSuggestionItem] = Field(max_length=MAX_SCOPE_SUGGESTIONS)

    @model_validator(mode="after")
    def _unique_tags(self) -> "ScopeTagSuggestion":
        _require_unique([(item.dimension, item.value) for item in self.suggestions], "suggestions")
        return self
