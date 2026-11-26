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


# --- Document-group rule (Phase 5.1.1 D-21, D-29) ---

from rag_eval.split import (  # noqa: E402
    DOCGROUP_SPLIT_RULE,
    assign_group_split,
    document_groups,
    freeze_group_splits,
    group_id,
    load_group_manifest,
)

DOC_A = "aaaaaaaa-0000-4000-8000-000000000001"
DOC_B = "bbbbbbbb-0000-4000-8000-000000000002"
DOC_C = "cccccccc-0000-4000-8000-000000000003"


def _span(document: str, document_id: str | None = None, quote: str = "the widget accepts three inputs") -> dict:
    span = {"document": document, "section": "s", "quote": quote}
    if document_id is not None:
        span["document_id"] = document_id
    return span


def _answerable(item_id: str, *spans: dict, split: str = "dev", tags: list[str] | None = None) -> GoldenItem:
    return GoldenItem(
        id=item_id,
        question=f"synthetic question {item_id}",
        language="en",
        category="general",
        answerable=True,
        expected_answer="a synthetic answer",
        gold_evidence=list(spans),
        review_status="approved",
        provenance="production",
        split=split,
        tags=tags or [],
    )


def _bucket(key: str) -> str:
    return "dev" if int(hashlib.sha256(key.encode()).hexdigest()[:8], 16) % 100 < 70 else "test"


def _document_id_with(split: str, start: int = 0x100) -> str:
    n = start
    while True:
        candidate = f"{n:08x}-0000-4000-8000-000000000000"
        if _bucket(candidate) == split:
            return candidate
        n += 1


def test_docgroup_rule_name_pinned():
    assert DOCGROUP_SPLIT_RULE == "docgroup-sha256-first8hex-mod100-lt70-dev"


def test_group_split_and_id_follow_the_sha256_of_the_min_document_key():
    for key in (DOC_A, DOC_B, "name:handbook.md"):
        assert assign_group_split(key) == _bucket(key)
        assert group_id(key) == hashlib.sha256(key.encode()).hexdigest()


def test_items_citing_one_document_share_a_group_and_a_split(tmp_path: Path):
    path = tmp_path / "split-manifest.json"
    items = [
        _answerable("prod-en-aaa001", _span("a.md", DOC_A)),
        _answerable("prod-en-aaa002", _span("a.md", DOC_A), _span("b.md", DOC_B)),
        _answerable("prod-en-bbb003", _span("b.md", DOC_B)),
        _answerable("prod-en-ccc004", _span("c.md", DOC_C)),
    ]
    frozen = freeze_group_splits(items, path)
    splits = {item.id: item.split for item in frozen}
    assert splits["prod-en-aaa001"] == splits["prod-en-aaa002"] == splits["prod-en-bbb003"] == _bucket(min(DOC_A, DOC_B))
    assert splits["prod-en-ccc004"] == _bucket(DOC_C)
    manifest = load_group_manifest(path)
    assert manifest.rule == DOCGROUP_SPLIT_RULE
    assert dict(manifest.assignments) == splits
    assert manifest.group_assignments == {group_id(min(DOC_A, DOC_B)): splits["prod-en-aaa001"], group_id(DOC_C): splits["prod-en-ccc004"]}


def test_grouping_uses_document_id_before_the_document_name():
    same_id = document_groups(
        [_answerable("prod-en-x00001", _span("old-name.md", DOC_A)), _answerable("prod-en-x00002", _span("new-name.md", DOC_A))]
    )
    assert same_id["prod-en-x00001"] == same_id["prod-en-x00002"] == group_id(DOC_A)
    same_name = document_groups(
        [_answerable("prod-en-y00001", _span("same.md", DOC_A)), _answerable("prod-en-y00002", _span("same.md", DOC_B))]
    )
    assert same_name["prod-en-y00001"] != same_name["prod-en-y00002"]
    by_name = document_groups(
        [_answerable("prod-en-z00001", _span("Shared.md")), _answerable("prod-en-z00002", _span("shared.md"))]
    )
    assert by_name["prod-en-z00001"] == by_name["prod-en-z00002"] == group_id("name:shared.md")


def test_confirmed_near_duplicate_tags_join_groups():
    groups = document_groups(
        [
            _answerable("prod-en-n00001", _span("a.md", DOC_A)),
            _answerable("prod-en-n00002", _span("b.md", DOC_B), tags=["near_duplicate_confirmed:prod-en-n00001"]),
        ]
    )
    assert groups["prod-en-n00001"] == groups["prod-en-n00002"]


def test_new_item_inherits_the_frozen_split_of_its_group_and_frozen_items_never_move(tmp_path: Path):
    path = tmp_path / "split-manifest.json"
    test_doc = _document_id_with("test")
    dev_doc = _document_id_with("dev")
    first = freeze_group_splits([_answerable("prod-en-f00001", _span("t.md", test_doc))], path)
    assert first[0].split == "test"
    lower = "00000000-0000-4000-8000-00000000000f"
    assert lower < test_doc
    joined = freeze_group_splits(
        [
            *first,
            _answerable("prod-en-f00002", _span("t.md", test_doc), _span("low.md", lower)),
            _answerable("prod-en-f00003", _span("d.md", dev_doc)),
        ],
        path,
    )
    splits = {item.id: item.split for item in joined}
    assert splits == {"prod-en-f00001": "test", "prod-en-f00002": "test", "prod-en-f00003": "dev"}
    manifest = load_group_manifest(path)
    assert manifest.assignments["prod-en-f00001"] == "test"
    assert manifest.group_assignments[group_id(test_doc)] == "test"
    assert manifest.group_assignments[group_id(lower)] == "test"


def test_an_item_bridging_two_frozen_groups_of_different_splits_is_refused(tmp_path: Path):
    path = tmp_path / "split-manifest.json"
    test_doc, dev_doc = _document_id_with("test"), _document_id_with("dev")
    frozen = freeze_group_splits(
        [_answerable("prod-en-b00001", _span("t.md", test_doc)), _answerable("prod-en-b00002", _span("d.md", dev_doc))], path
    )
    before = path.read_bytes()
    with pytest.raises(ValueError, match="dev and test"):
        freeze_group_splits([*frozen, _answerable("prod-en-b00003", _span("t.md", test_doc), _span("d.md", dev_doc))], path)
    assert path.read_bytes() == before


def test_docgroup_freeze_refuses_a_manifest_id_missing_from_the_items(tmp_path: Path):
    path = tmp_path / "split-manifest.json"
    frozen = freeze_group_splits([_answerable("prod-en-m00001", _span("a.md", DOC_A))], path)
    assert frozen
    with pytest.raises(ValueError, match="prod-en-m00001"):
        freeze_group_splits([_answerable("prod-en-m00002", _span("b.md", DOC_B))], path)


def test_docgroup_freeze_raises_when_an_item_split_disagrees_with_the_manifest(tmp_path: Path):
    path = tmp_path / "split-manifest.json"
    (item,) = freeze_group_splits([_answerable("prod-en-d00001", _span("a.md", DOC_A))], path)
    other = "test" if item.split == "dev" else "dev"
    with pytest.raises(ValueError):
        freeze_group_splits([item.model_copy(update={"split": other})], path)


def test_a_manifest_never_switches_rule(tmp_path: Path):
    item_rule = tmp_path / "item.json"
    write_manifest(item_rule, {"prod-en-r00001": "dev"})
    before = item_rule.read_bytes()
    with pytest.raises(ValueError, match="rule"):
        freeze_group_splits([_answerable("prod-en-r00001", _span("a.md", DOC_A))], item_rule)
    assert item_rule.read_bytes() == before
    group_rule = tmp_path / "group.json"
    freeze_group_splits([_answerable("prod-en-r00002", _span("a.md", DOC_A))], group_rule)
    before = group_rule.read_bytes()
    with pytest.raises(ValueError, match="rule"):
        freeze_splits([_item("prod-en-r00003")], group_rule)
    assert group_rule.read_bytes() == before


def test_group_manifest_is_written_sorted_and_byte_identical(tmp_path: Path):
    items = [_answerable("prod-en-s00002", _span("b.md", DOC_B)), _answerable("prod-en-s00001", _span("a.md", DOC_A))]
    a, b = tmp_path / "a.json", tmp_path / "b.json"
    freeze_group_splits(items, a)
    freeze_group_splits(list(reversed(items)), b)
    assert a.read_bytes() == b.read_bytes()
    data = json.loads(a.read_text())
    assert list(data["assignments"]) == sorted(data["assignments"])
    assert data["rule"] == DOCGROUP_SPLIT_RULE
    assert [p.name for p in tmp_path.iterdir() if p.name.endswith(".tmp")] == []
    again = a.read_bytes()
    freeze_group_splits(items, a)
    assert a.read_bytes() == again


def test_unanswerable_items_form_their_own_group():
    item = GoldenItem(
        id="prod-en-u00001",
        question="synthetic question",
        language="en",
        category="no_answer",
        answerable=False,
        review_status="approved",
        provenance="production",
        split="dev",
    )
    assert document_groups([item])["prod-en-u00001"] == group_id("item:prod-en-u00001")
