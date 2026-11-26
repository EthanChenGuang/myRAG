import copy

import pytest
from pydantic import ValidationError

from rag_sidecar.contracts.golden_lifecycle import GoldenSetManifest, manifest_hash

SHA_A = "a" * 64
SHA_B = "b" * 64


def _manifest(**overrides):
    base = {
        "schema_version": 1,
        "set_id": "fixture",
        "version": 2,
        "items": [
            {"id": "item-001", "item_sha256": SHA_A, "status": "active", "last_reviewed_at": "2026-11-01"},
            {
                "id": "item-002",
                "item_sha256": SHA_B,
                "status": "stale",
                "stale_reason": "source_document_changed",
                "stale_since": "2026-11-20",
            },
        ],
        "changelog": [
            {"version": 1, "date": "2026-11-01", "added": ["item-001", "item-002"]},
            {"version": 2, "date": "2026-11-20", "stale": ["item-002"]},
        ],
    }
    base.update(overrides)
    base["manifest_sha256"] = manifest_hash(base)
    return base


def test_valid_manifest_round_trips():
    manifest = GoldenSetManifest.model_validate(_manifest())
    assert manifest.version == 2
    assert manifest.items[1].status == "stale"
    assert GoldenSetManifest.model_validate(manifest.model_dump(mode="json")) == manifest


def test_hash_ignores_key_order():
    data = _manifest()
    reordered = {key: data[key] for key in reversed(list(data))}
    assert manifest_hash(reordered) == data["manifest_sha256"]


def test_wrong_manifest_hash_rejected():
    data = _manifest()
    data["manifest_sha256"] = "0" * 64
    with pytest.raises(ValidationError, match="manifest_sha256"):
        GoldenSetManifest.model_validate(data)


def test_edit_after_hashing_rejected():
    data = _manifest()
    data = copy.deepcopy(data)
    data["items"][0]["item_sha256"] = "c" * 64
    with pytest.raises(ValidationError, match="manifest_sha256"):
        GoldenSetManifest.model_validate(data)


def test_duplicate_item_ids_rejected():
    items = [
        {"id": "item-001", "item_sha256": SHA_A, "status": "active"},
        {"id": "item-001", "item_sha256": SHA_B, "status": "active"},
    ]
    with pytest.raises(ValidationError, match="duplicate"):
        GoldenSetManifest.model_validate(_manifest(items=items))


def test_stale_item_needs_a_reason():
    items = [{"id": "item-001", "item_sha256": SHA_A, "status": "stale", "stale_since": "2026-11-20"}]
    with pytest.raises(ValidationError, match="stale_reason"):
        GoldenSetManifest.model_validate(_manifest(items=items))


def test_retired_item_needs_a_reason():
    items = [{"id": "item-001", "item_sha256": SHA_A, "status": "retired"}]
    with pytest.raises(ValidationError, match="retire_reason"):
        GoldenSetManifest.model_validate(_manifest(items=items))


def test_changelog_must_end_at_the_version():
    changelog = [{"version": 1, "date": "2026-11-01", "added": ["item-001", "item-002"]}]
    with pytest.raises(ValidationError, match="changelog"):
        GoldenSetManifest.model_validate(_manifest(changelog=changelog))


def test_reasons_are_codes_not_text():
    items = [
        {
            "id": "item-001",
            "item_sha256": SHA_A,
            "status": "retired",
            "retire_reason": "The quoted paragraph was removed from the handbook",
        }
    ]
    with pytest.raises(ValidationError):
        GoldenSetManifest.model_validate(_manifest(items=items))


def test_item_sha256_must_be_hex():
    items = [{"id": "item-001", "item_sha256": "not-a-hash", "status": "active"}]
    with pytest.raises(ValidationError):
        GoldenSetManifest.model_validate(_manifest(items=items))
