"""Language setting, settings classification and ingestion fingerprint contracts of Phase 3.2 (D-01, D-09 to D-11, D-49)."""

from __future__ import annotations

from typing import Annotated, Literal, Union

from pydantic import BaseModel, ConfigDict, Field, StrictInt, field_validator, model_validator

from .ingest import DocType
from .languages import Language

Side = Literal["ingestion", "query", "both"]
RebuildMechanism = Literal["reparse", "rechunk", "relex", "reembed", "recaption", "retranslate", "rescan"]
REBUILD_MECHANISMS: tuple[str, ...] = ("reparse", "rechunk", "relex", "reembed", "recaption", "retranslate", "rescan")
# rescan belongs to the two security checks (D-47): it is reported, never started as a rebuild by itself.
AUTOMATIC_REBUILD_MECHANISMS: tuple[str, ...] = tuple(m for m in REBUILD_MECHANISMS if m != "rescan")

SettingName = Annotated[str, Field(pattern=r"^[A-Z][A-Z0-9_]{0,127}$")]
PartText = Annotated[str, Field(min_length=1, max_length=128)]
Version = Annotated[StrictInt, Field(ge=1)]
Count = Annotated[StrictInt, Field(ge=0)]
LanguageCodeKey = Annotated[str, Field(pattern=r"^[a-z]{2,3}$")]

FingerprintPartName = Literal[
    "parser_used",
    "parser_version",
    "processing_profile_id",
    "processing_profile_version",
    "ocr_engine_codes",
    "chunking_profile_id",
    "lexical_version",
    "embedding_text_version",
    "embedding_profile_id",
    "embedding_profile_version",
    "language_pack_versions",
    "switches",
]


class _Contract(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)


def _require_unique(values: list, what: str) -> None:
    if len(values) != len(set(values)):
        raise ValueError(f"{what} must not repeat a value")


class LanguageSettings(_Contract):
    """Deployment language setting as returned by `getLanguageSettings()` (D-01)."""

    configured: bool
    languages: list[Language] = Field(default_factory=list)
    primary: Language | None = None
    monolingual: bool

    @model_validator(mode="after")
    def _consistent(self) -> LanguageSettings:
        _require_unique(self.languages, "languages")
        if not self.configured:
            if self.languages or self.primary is not None or self.monolingual:
                raise ValueError("an unconfigured setting has no languages, no primary and is not monolingual")
            return self
        if not self.languages:
            raise ValueError("a configured setting needs at least one language")
        if self.primary is not None and self.primary not in self.languages:
            raise ValueError("primary must be one of languages")
        if self.monolingual != (len(self.languages) == 1):
            raise ValueError("monolingual is true exactly when one language is configured")
        return self


class IngestionSettingEntry(_Contract):
    name: SettingName
    side: Literal["ingestion", "both"]
    mechanism: RebuildMechanism


class QuerySettingEntry(_Contract):
    name: SettingName
    side: Literal["query"]


SettingsClassificationEntry = Annotated[
    Union[IngestionSettingEntry, QuerySettingEntry],
    Field(discriminator="side"),
]


class SettingsClassification(_Contract):
    """`config/rag/settings-classification.json` (D-09): one entry per variable, ingestion entries name a mechanism."""

    schema_version: Literal[1] = 1
    entries: list[SettingsClassificationEntry] = Field(min_length=1)

    @field_validator("entries")
    @classmethod
    def _names_unique(cls, entries: list) -> list:
        _require_unique([entry.name for entry in entries], "entry names")
        return entries


class FingerprintSwitches(_Contract):
    """State of this phase's ingestion-side switches, as the raw variable values (D-13, D-19, D-21, D-23)."""

    language_aware_ingest: Literal["off", "on"]
    table_header_repeat: Literal["profile", "always"]
    table_row_serialization: Literal["false", "true"]
    caption_language: Literal["en", "document"]


class IngestFingerprintParts(_Contract):
    """Parts hashed into `documents.ingest_fingerprint` (D-10); strings and integers only, so canonical JSON is stable."""

    parser_used: PartText
    parser_version: PartText
    processing_profile_id: PartText
    processing_profile_version: Version
    ocr_engine_codes: list[PartText] = Field(max_length=64)
    chunking_profile_id: PartText
    lexical_version: Count
    embedding_text_version: Count
    embedding_profile_id: PartText
    embedding_profile_version: Version
    language_pack_versions: dict[LanguageCodeKey, Version]
    switches: FingerprintSwitches
    # Parts never stored for documents published before this phase; the backfill records that it assumed defaults.
    assumed_defaults: list[FingerprintPartName] = Field(default_factory=list)

    @field_validator("ocr_engine_codes", "assumed_defaults")
    @classmethod
    def _unique(cls, value: list[str], info) -> list[str]:
        _require_unique(value, info.field_name)
        return value


class FingerprintImpactRow(_Contract):
    mechanism: RebuildMechanism
    doc_type: DocType
    affected: Count


class FingerprintImpact(_Contract):
    """Response of `POST /api/rag/admin/ingest-fingerprint/impact` (D-11): aggregates only, no document ids."""

    ingestion_keys: list[SettingName]
    by_mechanism: list[FingerprintImpactRow]
    without_fingerprint: Count
    total_current: Count

    @model_validator(mode="after")
    def _unique_rows(self) -> FingerprintImpact:
        _require_unique(self.ingestion_keys, "ingestion_keys")
        _require_unique([(row.mechanism, row.doc_type) for row in self.by_mechanism], "mechanism and doc_type pairs")
        return self
