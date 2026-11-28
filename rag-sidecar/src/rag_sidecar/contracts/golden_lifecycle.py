"""Golden-set manifest and lifecycle (Phase 5.3 D-46): versions, per-item hashes and stale or retired status."""

import datetime as dt
import hashlib
import json
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field, model_validator

from .golden import ITEM_ID_PATTERN

SHA256_PATTERN = r"^[a-f0-9]{64}$"
CODE_PATTERN = r"^[a-z0-9_]+$"
SET_ID_PATTERN = r"^[a-z0-9][a-z0-9._-]{0,127}$"

GoldenItemStatus = Literal["active", "stale", "retired"]


class _Contract(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)


class GoldenSetManifestItem(_Contract):
    id: str = Field(pattern=ITEM_ID_PATTERN)
    item_sha256: str = Field(pattern=SHA256_PATTERN)
    status: GoldenItemStatus = "active"
    stale_reason: str | None = Field(default=None, pattern=CODE_PATTERN)
    stale_since: dt.date | None = None
    retire_reason: str | None = Field(default=None, pattern=CODE_PATTERN)
    last_reviewed_at: dt.date | None = None

    @model_validator(mode="after")
    def _status_needs_reason(self) -> "GoldenSetManifestItem":
        if self.status == "stale" and self.stale_reason is None:
            raise ValueError("a stale item needs a stale_reason")
        if self.status == "retired" and self.retire_reason is None:
            raise ValueError("a retired item needs a retire_reason")
        if self.status == "active" and (self.stale_reason is not None or self.retire_reason is not None):
            raise ValueError("an active item carries no stale_reason or retire_reason")
        if self.status != "retired" and self.retire_reason is not None:
            raise ValueError("retire_reason exists only on retired items")
        return self


class GoldenSetChangelogEntry(_Contract):
    version: int = Field(ge=1)
    date: dt.date
    added: list[str] = Field(default_factory=list)
    changed: list[str] = Field(default_factory=list)
    retired: list[str] = Field(default_factory=list)
    stale: list[str] = Field(default_factory=list)


def manifest_hash(data: "dict[str, Any] | GoldenSetManifest") -> str:
    """sha256 of the canonical JSON of a manifest, defaults filled in, without its own manifest_sha256."""

    raw = data.model_dump(mode="json") if isinstance(data, BaseModel) else data
    payload: dict[str, Any] = {key: value for key, value in raw.items() if key != "manifest_sha256"}
    payload.setdefault("schema_version", 1)
    payload["items"] = [_dump(GoldenSetManifestItem, item) for item in payload.get("items", [])]
    payload["changelog"] = [_dump(GoldenSetChangelogEntry, entry) for entry in payload.get("changelog", [])]
    text = json.dumps(payload, sort_keys=True, separators=(",", ":"), ensure_ascii=False)
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def _dump(model: type[BaseModel], value: Any) -> Any:
    if isinstance(value, BaseModel):
        return value.model_dump(mode="json")
    return model.model_validate(value).model_dump(mode="json")


class GoldenSetManifest(_Contract):
    schema_version: Literal[1] = 1
    set_id: str = Field(pattern=SET_ID_PATTERN)
    version: int = Field(ge=1)
    items: list[GoldenSetManifestItem]
    changelog: list[GoldenSetChangelogEntry] = Field(min_length=1)
    manifest_sha256: str = Field(pattern=SHA256_PATTERN)

    @model_validator(mode="after")
    def _consistent(self) -> "GoldenSetManifest":
        ids = [item.id for item in self.items]
        if len(ids) != len(set(ids)):
            raise ValueError("duplicate item ids in manifest")
        versions = [entry.version for entry in self.changelog]
        if len(versions) != len(set(versions)):
            raise ValueError("changelog versions must not repeat")
        if max(versions) != self.version:
            raise ValueError("the highest changelog version must equal version")
        if manifest_hash(self.model_dump(mode="json")) != self.manifest_sha256:
            raise ValueError("manifest_sha256 does not match the manifest content")
        return self
