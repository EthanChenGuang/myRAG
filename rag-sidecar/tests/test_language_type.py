"""The contracts' Language type comes from the language-pack registry (Phase 3.2 D-06)."""

from __future__ import annotations

import json
from pathlib import Path

import pytest
from pydantic import BaseModel, ConfigDict, TypeAdapter, ValidationError

from rag_sidecar.contracts.golden import GoldenItem
from rag_sidecar.contracts.languages import (
    LANGUAGE_CODES,
    Language,
    build_language_type,
    language_codes,
    load_language_registry,
)

REPO_ROOT = Path(__file__).resolve().parents[2]
REGISTRY_PATH = REPO_ROOT / "config" / "rag" / "language-packs.json"
GOLDEN_FILES = (
    REPO_ROOT / "eval" / "fixtures" / "golden.jsonl",
    REPO_ROOT / "eval" / "fixtures" / "ingest" / "golden-ingest.jsonl",
)


def _registry_codes() -> list[str]:
    return [pack["code"] for pack in json.loads(REGISTRY_PATH.read_text(encoding="utf-8"))["packs"]]


def _four_pack_registry(tmp_path: Path) -> Path:
    raw = json.loads(REGISTRY_PATH.read_text(encoding="utf-8"))
    fourth = json.loads(json.dumps(raw["packs"][-1]))
    fourth.update(code="qx", name="Synthetic", native_name="Synthetic")
    raw["packs"].append(fourth)
    path = tmp_path / "language-packs.json"
    path.write_text(json.dumps(raw), encoding="utf-8")
    return path


def test_language_codes_follow_the_registry_order():
    assert list(LANGUAGE_CODES) == _registry_codes()
    assert language_codes() == LANGUAGE_CODES


def test_golden_item_schema_shows_language_as_a_registry_enum():
    language = GoldenItem.model_json_schema()["properties"]["language"]
    assert language["type"] == "string"
    assert language["enum"] == _registry_codes()


def test_an_unknown_code_is_rejected():
    adapter = TypeAdapter(Language)
    for code in _registry_codes():
        assert adapter.validate_python(code) == code
    with pytest.raises(ValidationError, match="unknown language code"):
        adapter.validate_python("xx")


def test_every_golden_line_validates():
    count = 0
    for path in GOLDEN_FILES:
        for line in path.read_text(encoding="utf-8").splitlines():
            if line.strip():
                GoldenItem.model_validate_json(line)
                count += 1
    assert count >= 192


def test_a_golden_item_with_an_unknown_language_is_rejected():
    line = next(
        line for line in GOLDEN_FILES[0].read_text(encoding="utf-8").splitlines() if line.strip()
    )
    item = json.loads(line)
    item["language"] = "xx"
    with pytest.raises(ValidationError):
        GoldenItem.model_validate(item)


def test_a_type_built_from_a_four_pack_registry_accepts_the_fourth_code(tmp_path: Path):
    registry = load_language_registry(_four_pack_registry(tmp_path))
    codes = language_codes(registry)
    assert codes == (*_registry_codes(), "qx")

    four = build_language_type(codes)

    class Item(BaseModel):
        model_config = ConfigDict(extra="forbid")
        language: four

    assert Item(language="qx").language == "qx"
    assert Item.model_json_schema()["properties"]["language"]["enum"] == list(codes)
    with pytest.raises(ValidationError):
        TypeAdapter(Language).validate_python("qx")


def test_extra_values_follow_the_codes_in_the_schema():
    rule = build_language_type(["aa", "bb"], extra=["any"])
    adapter = TypeAdapter(rule)
    assert adapter.json_schema() == {"type": "string", "enum": ["aa", "bb", "any"]}
    assert adapter.validate_python("any") == "any"
    with pytest.raises(ValidationError):
        adapter.validate_python("cc")


def test_an_empty_code_list_is_refused():
    with pytest.raises(ValueError):
        build_language_type([])
