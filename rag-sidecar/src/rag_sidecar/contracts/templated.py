"""Tenant rule data, document attribute and numbers-only config contracts of Phase 3.3 (D-04, D-12, D-13, D-16, D-22 to D-30).

Contracts hold structure and limits only. Pattern safety checks and pattern execution live in the TypeScript worker
wrapper (plan 03.3-04); no chunker or SQL function sees a pattern.
"""

from __future__ import annotations

from typing import Annotated, Literal, Union

from pydantic import AfterValidator, BaseModel, ConfigDict, Field, StrictInt, StrictStr, model_validator

from .ingest import (
    SECTION_HIT_LINE_MAX_LENGTH,
    SECTION_HITS_MAX,
    DocType,
    ResolvedSectionRules,
    RuleRowId,
    SectionHeadingHit,
    SectionLevel,
    SectionName,
    has_backreference,
)
from .omit import omit_none_schema

__all__ = [
    "ATTRIBUTE_KEY_PATTERN",
    "MAX_ATTRIBUTE_DEFINITIONS",
    "MAX_ATTRIBUTE_LIST_VALUES",
    "MAX_ATTRIBUTE_VALUE_LENGTH",
    "MAX_BOILERPLATE_RULES",
    "MAX_HEADER_TEMPLATE_LENGTH",
    "MAX_HEADING_PATTERNS",
    "MAX_SECTION_RULE_SETS",
    "SECTION_HITS_MAX",
    "SECTION_HIT_LINE_MAX_LENGTH",
    "AttributeDefinition",
    "AttributeFilter",
    "AttributeFilterConfig",
    "AttributeHeaderTemplate",
    "AttributeImportRow",
    "AttributeKey",
    "AttributeSchema",
    "AttributeType",
    "AttributeValue",
    "AttributeValues",
    "BindingSource",
    "BoilerplateReport",
    "BoilerplateRule",
    "BoilerplateRulesConfig",
    "HeadingPattern",
    "PatternFlags",
    "ResolvedSectionRules",
    "RuleRowId",
    "SectionHeadingHit",
    "SectionRuleSet",
    "TenantRulesFile",
]

MAX_SECTION_RULE_SETS = 10
MAX_BOILERPLATE_RULES = 40
MAX_HEADING_PATTERNS = 60
MAX_ATTRIBUTE_DEFINITIONS = 30
MAX_ATTRIBUTE_VALUE_LENGTH = 200
MAX_ATTRIBUTE_LIST_VALUES = 50
MAX_HEADER_TEMPLATE_LENGTH = 200
_TENANT_PATTERN_MAX_LENGTH = 200
ATTRIBUTE_KEY_PATTERN = r"^[a-z][a-z0-9_]{0,39}$"

PatternFlags = Literal["u", "iu"]
BindingSource = Annotated[str, Field(pattern=r"^[a-z0-9][a-z0-9_.:-]{0,63}$")]
RuleName = SectionName
TenantPattern = Annotated[str, Field(min_length=1, max_length=_TENANT_PATTERN_MAX_LENGTH)]
Share = Annotated[float, Field(gt=0, le=1, strict=True)]
PositiveInt = Annotated[StrictInt, Field(ge=1)]
Count = Annotated[StrictInt, Field(ge=0)]


class _Contract(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)


def _omit_unset(value: object) -> bool:
    return value is None


def _unique(values: list[str]) -> list[str]:
    if len(set(values)) != len(values):
        raise ValueError("values must not repeat")
    return values


def _require_unique(values: list[str], what: str) -> None:
    if len(set(values)) != len(values):
        raise ValueError(f"{what} must not repeat a value")


def _no_backreference(pattern: str | None) -> None:
    if pattern is not None and has_backreference(pattern):
        raise ValueError("tenant patterns must not use back-references")


# --- Attribute keys and values (D-12, D-22, D-23)

AttributeKey = Annotated[str, Field(pattern=ATTRIBUTE_KEY_PATTERN)]
AttributeType = Literal["text", "text_list", "code"]
AttributeText = Annotated[StrictStr, Field(min_length=1, max_length=MAX_ATTRIBUTE_VALUE_LENGTH)]
AttributeTextList = Annotated[
    list[AttributeText], Field(min_length=1, max_length=MAX_ATTRIBUTE_LIST_VALUES), AfterValidator(_unique)
]
AttributeValue = Union[AttributeText, AttributeTextList]
AttributeValues = Annotated[dict[AttributeKey, AttributeValue], Field(max_length=MAX_ATTRIBUTE_DEFINITIONS)]
# Retrieval filter (DATA-08 extension): any of the values within a key, every named key.
AttributeFilter = Annotated[
    dict[AttributeKey, AttributeTextList], Field(min_length=1, max_length=MAX_ATTRIBUTE_DEFINITIONS)
]


# --- Section rule sets (D-17 to D-19)


class HeadingPattern(_Contract):
    pattern: TenantPattern
    flags: PatternFlags = "u"
    name: RuleName
    level: SectionLevel
    required: bool = False
    restart: bool = False

    @model_validator(mode="after")
    def _pattern_is_plain(self) -> HeadingPattern:
        _no_backreference(self.pattern)
        return self


class SectionRuleSet(_Contract):
    """Tenant rule set body; the binding `(doc_type | null, source | null)` follows D-18."""

    name: RuleName
    doc_type: DocType | None = Field(default=None, exclude_if=_omit_unset, json_schema_extra=omit_none_schema)
    source: BindingSource | None = Field(default=None, exclude_if=_omit_unset, json_schema_extra=omit_none_schema)
    enabled: bool = True
    headings: list[HeadingPattern] = Field(min_length=1, max_length=MAX_HEADING_PATTERNS)
    require_increasing_numbers: bool = False
    skip_toc: bool = True
    toc_min_run: int = Field(default=3, ge=2, le=20)

    @model_validator(mode="after")
    def _patterns_unique(self) -> SectionRuleSet:
        _require_unique([heading.pattern for heading in self.headings], "heading patterns")
        return self


# --- Page boilerplate (D-13, D-16)


class BoilerplateRule(_Contract):
    """Kind `line` removes lines a pattern matches; kind `fragment` removes short fragments repeated across pages."""

    name: RuleName
    kind: Literal["line", "fragment"]
    doc_type: DocType | None = Field(default=None, exclude_if=_omit_unset, json_schema_extra=omit_none_schema)
    source: BindingSource | None = Field(default=None, exclude_if=_omit_unset, json_schema_extra=omit_none_schema)
    enabled: bool = True
    pattern: TenantPattern | None = Field(default=None, exclude_if=_omit_unset, json_schema_extra=omit_none_schema)
    flags: PatternFlags | None = Field(default=None, exclude_if=_omit_unset, json_schema_extra=omit_none_schema)
    max_length: int | None = Field(
        default=None, ge=1, le=200, exclude_if=_omit_unset, json_schema_extra=omit_none_schema
    )
    min_page_share: float | None = Field(
        default=None, gt=0, le=1, exclude_if=_omit_unset, json_schema_extra=omit_none_schema
    )

    @model_validator(mode="after")
    def _kind_fields(self) -> BoilerplateRule:
        if self.kind == "line":
            if self.pattern is None or self.flags is None:
                raise ValueError("a line rule needs pattern and flags")
            if self.max_length is not None or self.min_page_share is not None:
                raise ValueError("a line rule takes no max_length or min_page_share")
            _no_backreference(self.pattern)
        else:
            if self.pattern is not None or self.flags is not None:
                raise ValueError("a fragment rule takes no pattern or flags")
            if self.max_length is None or self.min_page_share is None:
                raise ValueError("a fragment rule needs max_length and min_page_share")
        return self


class BoilerplateRulesConfig(_Contract):
    """`config/rag/boilerplate-rules.json` (D-13): numbers only."""

    schema_version: Literal[1] = 1
    rules_version: PositiveInt
    page_share: Share
    edge_lines: PositiveInt
    max_line_tokens: PositiveInt
    min_pages: PositiveInt
    fragment_max_length: PositiveInt
    fragment_page_share: Share
    review_share: Share


class BoilerplateReport(_Contract):
    """Per-document cleaning report stored on the document (D-13); counts only, never removed text."""

    cleaner_version: PositiveInt
    rules_version: PositiveInt
    lines_removed: Count
    tokens_removed: Count
    share: float = Field(ge=0, le=1)


# --- Document attributes (D-22 to D-26)


class AttributeDefinition(_Contract):
    key: AttributeKey
    type: AttributeType
    filterable: bool = False
    in_header: bool = False
    in_identifier_index: bool = False
    soft: bool = False

    @model_validator(mode="after")
    def _identifier_index_needs_code(self) -> AttributeDefinition:
        if self.in_identifier_index and self.type != "code":
            raise ValueError("in_identifier_index is allowed only on attributes of type code")
        return self


class AttributeSchema(_Contract):
    definitions: list[AttributeDefinition] = Field(default_factory=list, max_length=MAX_ATTRIBUTE_DEFINITIONS)

    @model_validator(mode="after")
    def _keys_unique(self) -> AttributeSchema:
        _require_unique([definition.key for definition in self.definitions], "attribute keys")
        return self


class AttributeImportRow(_Contract):
    """One row of the `rag:attributes` import file (D-24)."""

    source_key: str = Field(min_length=1, max_length=1024)
    source: BindingSource | None = Field(default=None, exclude_if=_omit_unset, json_schema_extra=omit_none_schema)
    attributes: AttributeValues


class AttributeHeaderTemplate(_Contract):
    template: str = Field(min_length=1, max_length=MAX_HEADER_TEMPLATE_LENGTH)
    version: PositiveInt


class AttributeFilterConfig(_Contract):
    """`config/rag/attribute-filter.json` (D-29, D-30): numbers only."""

    schema_version: Literal[1] = 1
    rules_version: PositiveInt
    soft_weight: Share
    id_cap: PositiveInt


# --- Rule file of `rag:rules` (D-34)


class TenantRulesFile(_Contract):
    schema_version: Literal[1] = 1
    section_rule_sets: list[SectionRuleSet] = Field(default_factory=list, max_length=MAX_SECTION_RULE_SETS)
    boilerplate_rules: list[BoilerplateRule] = Field(default_factory=list, max_length=MAX_BOILERPLATE_RULES)

    @model_validator(mode="after")
    def _names_unique(self) -> TenantRulesFile:
        _require_unique([rule_set.name for rule_set in self.section_rule_sets], "section rule set names")
        _require_unique([rule.name for rule in self.boilerplate_rules], "boilerplate rule names")
        return self
