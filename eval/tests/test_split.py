import hashlib
import json
from pathlib import Path

import pytest
from pydantic import ValidationError
from rag_sidecar.contracts.golden import GoldenItem

from rag_eval.split import SPLIT_RULE, assign_split, freeze_splits, load_manifest, write_manifest


def _expected(item_id: str) -> str:
    return "dev" if int(hashlib.sha256(item_id.encode()).hexdigest()[:8], 16) % 100 < 70 else "test"


def _item(item_id: str, split: str = "dev") -> GoldenItem:
    return GoldenItem(
        id=item_id,
        question="What is the refund window?",
        language="en",
        category="no_answer",
        answerable=False,
        review_status="approved",
        provenance="synthetic_fixture",
        split=split,
    )


def _find_ids(split: str, count: int) -> list[str]:
    found: list[str] = []
    n = 0
    while len(found) < count:
        candidate = f"en-general-{n:03d}"
        if _expected(candidate) == split:
            found.append(candidate)
        n += 1
    return found


def test_rule_name_pinned():
    assert SPLIT_RULE == "sha256-first8hex-mod100-lt70-dev"


def test_assign_split_follows_sha256_rule():
    assert assign_split("en-general-001") == _expected("en-general-001")
    for i in range(200):
        item_id = f"it-exact-{i:03d}"
        assert assign_split(item_id) == _expected(item_id)
    splits = {assign_split(f"x-{i:04d}") for i in range(200)}
    assert splits == {"dev", "test"}


def test_missing_manifest_is_empty(tmp_path: Path):
    assert load_manifest(tmp_path / "absent.json") == {}


def test_freeze_keeps_existing_assignment_even_if_rule_differs(tmp_path: Path):
    path = tmp_path / "split-manifest.json"
    item_id = _find_ids("dev", 1)[0]
    write_manifest(path, {item_id: "test"})
    frozen = freeze_splits([_item(item_id, "test")], path)
    assert frozen[0].split == "test"
    assert load_manifest(path) == {item_id: "test"}


def test_freeze_adds_new_ids_with_rule_split(tmp_path: Path):
    path = tmp_path / "split-manifest.json"
    dev_id = _find_ids("dev", 1)[0]
    test_id = _find_ids("test", 1)[0]
    existing = "zz-existing-001"
    write_manifest(path, {existing: "test"})
    frozen = freeze_splits([_item(existing, "test"), _item(dev_id, "test"), _item(test_id, "dev")], path)
    assert [i.split for i in frozen] == ["test", "dev", "test"]
    assert load_manifest(path) == {existing: "test", dev_id: "dev", test_id: "test"}


def test_freeze_raises_when_item_split_disagrees_with_manifest(tmp_path: Path):
    path = tmp_path / "split-manifest.json"
    write_manifest(path, {"zz-existing-001": "test"})
    with pytest.raises(ValueError):
        freeze_splits([_item("zz-existing-001", "dev")], path)
    assert load_manifest(path) == {"zz-existing-001": "test"}


def test_freeze_rejects_duplicate_ids(tmp_path: Path):
    with pytest.raises(ValueError):
        freeze_splits([_item("dup-item-001"), _item("dup-item-001")], tmp_path / "m.json")


def test_manifest_written_sorted_atomically_and_byte_identical(tmp_path: Path):
    a = tmp_path / "a.json"
    b = tmp_path / "b.json"
    write_manifest(a, {"b-item-002": "test", "a-item-001": "dev"})
    write_manifest(b, {"a-item-001": "dev", "b-item-002": "test"})
    assert a.read_bytes() == b.read_bytes()
    data = json.loads(a.read_text())
    assert list(data["assignments"]) == ["a-item-001", "b-item-002"]
    assert data["rule"] == SPLIT_RULE
    assert data["schema_version"] == 1
    assert [p.name for p in tmp_path.iterdir() if p.name.endswith(".tmp")] == []
    write_manifest(a, {"b-item-002": "test", "a-item-001": "dev"})
    assert a.read_bytes() == b.read_bytes()


def test_manifest_with_other_rule_rejected(tmp_path: Path):
    path = tmp_path / "m.json"
    path.write_text(json.dumps({"schema_version": 1, "rule": "md5-whatever", "assignments": {}}))
    with pytest.raises(ValidationError):
        load_manifest(path)
    with pytest.raises(ValidationError):
        freeze_splits([_item("a-item-001")], path)
