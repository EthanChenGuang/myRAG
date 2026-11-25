import json
from pathlib import Path

import pytest
from pydantic import ValidationError

from rag_sidecar.contracts import SettingsClassification

REPO_ROOT = Path(__file__).resolve().parents[2]
CLASSIFICATION_PATH = REPO_ROOT / "config" / "rag" / "settings-classification.json"
MANIFEST_PATH = REPO_ROOT / "scripts" / "rag" / "env-manifest.json"

# D-47: the eighteen variables of Phase 3.2 and their sides; ingestion entries name the mechanism of D-09 and D-11.
D47 = {
    "RAG_SUPPORTED_LANGUAGES": ("ingestion", "reparse"),
    "RAG_PRIMARY_LANGUAGE": ("query", None),
    "RAG_LANGUAGE_AWARE_INGEST": ("ingestion", "rechunk"),
    "RAG_TABLE_HEADER_REPEAT": ("ingestion", "rechunk"),
    "RAG_TABLE_ROW_SERIALIZATION": ("ingestion", "rechunk"),
    "RAG_CAPTION_LANGUAGE": ("ingestion", "recaption"),
    "RAG_BGE_M3_SERVING": ("query", None),
    "RAG_DOC_TRANSLATION": ("ingestion", "retranslate"),
    "RAG_DOC_TRANSLATION_MODEL": ("ingestion", "retranslate"),
    "RAG_HIDDEN_TEXT_CHECK": ("ingestion", "rescan"),
    "RAG_INGEST_LINK_CHECK": ("ingestion", "rescan"),
    "RAG_OUTPUT_LINK_ALLOWLIST": ("both", "rescan"),
    "RAG_UPLOAD_APPROVAL": ("query", None),
    "RAG_SCOPE_TAGS": ("query", None),
    "RAG_SCOPE_TAG_SUGGEST": ("query", None),
    "RAG_SUPERSESSION_DETECT": ("query", None),
    "RAG_EFFECTIVE_DATES": ("query", None),
    "RAG_EFFECTIVE_DATE_LLM_EXTRACT": ("query", None),
}


def _raw() -> dict:
    return json.loads(CLASSIFICATION_PATH.read_text(encoding="utf-8"))


def _entries() -> dict[str, dict]:
    return {entry["name"]: entry for entry in _raw()["entries"]}


def test_file_validates_against_the_pydantic_model():
    parsed = SettingsClassification.model_validate(_raw())
    assert parsed.schema_version == 1
    assert len(parsed.entries) == len(_raw()["entries"])


def test_entries_are_sorted_by_name():
    names = [entry["name"] for entry in _raw()["entries"]]
    assert names == sorted(names)


def test_every_rag_variable_of_the_manifest_is_classified_and_nothing_else():
    manifest = json.loads(MANIFEST_PATH.read_text(encoding="utf-8"))
    rag_names = {var["name"] for var in manifest["vars"] if var["name"].startswith("RAG_")}
    assert set(_entries()) == rag_names


@pytest.mark.parametrize("name", sorted(D47))
def test_phase_32_variables_follow_d47(name):
    side, mechanism = D47[name]
    entry = _entries()[name]
    assert entry["side"] == side
    assert entry.get("mechanism") == mechanism


def test_the_two_security_checks_are_rescan_only():
    entries = _entries()
    rescan = sorted(name for name, entry in entries.items() if entry.get("mechanism") == "rescan")
    assert {"RAG_HIDDEN_TEXT_CHECK", "RAG_INGEST_LINK_CHECK"} <= set(rescan)


def test_an_ingestion_entry_without_a_mechanism_is_refused():
    raw = _raw()
    raw["entries"] = [{"name": "RAG_NEW_THING", "side": "ingestion"}]
    with pytest.raises(ValidationError):
        SettingsClassification.model_validate(raw)


def test_a_query_entry_with_a_mechanism_is_refused():
    raw = _raw()
    raw["entries"] = [{"name": "RAG_NEW_THING", "side": "query", "mechanism": "reparse"}]
    with pytest.raises(ValidationError):
        SettingsClassification.model_validate(raw)
