import datetime as dt
import json
import shutil
from pathlib import Path

import pytest
from rag_sidecar.contracts.golden import GoldenItem
from rag_sidecar.contracts.golden_lifecycle import GoldenSetManifest

from rag_eval import golden_set
from rag_eval.corpus import load_corpus
from rag_eval.golden_io import item_sha256, load_golden
from rag_eval.matching import normalize_text
from rag_eval.paths import REPO_ROOT

FIXTURE_GOLDEN = REPO_ROOT / "eval/fixtures/golden.jsonl"
FIXTURE_MANIFEST = REPO_ROOT / "eval/fixtures/golden.manifest.json"
INGEST_GOLDEN = REPO_ROOT / "eval/fixtures/ingest/golden-ingest.jsonl"
INGEST_MANIFEST = REPO_ROOT / "eval/fixtures/ingest/golden-ingest.manifest.json"
CORPUS_DIR = REPO_ROOT / "eval/fixtures/corpus"

DAY1 = dt.date(2026, 1, 5)
DAY2 = dt.date(2026, 1, 6)
DAY3 = dt.date(2026, 1, 7)


def _item(item_id: str, quote: str = "alpha beta gamma", document: str = "doc-a.md", **extra) -> GoldenItem:
    data = {
        "id": item_id,
        "question": f"What does the synthetic note {item_id} state?",
        "language": "en",
        "category": "general",
        "answerable": True,
        "expected_answer": "a synthetic value",
        "gold_evidence": [{"document": document, "section": "Section one", "quote": quote}],
        "review_status": "approved",
        "provenance": "synthetic_fixture",
        "split": "dev",
    }
    data.update(extra)
    return GoldenItem.model_validate(data)


def _write_jsonl(path: Path, items: list[GoldenItem]) -> None:
    path.write_text("".join(json.dumps(i.model_dump(mode="json"), ensure_ascii=False) + "\n" for i in items), encoding="utf-8")


def _write_manifest(path: Path, manifest: GoldenSetManifest) -> None:
    path.write_text(manifest.model_dump_json(indent=2) + "\n", encoding="utf-8")


@pytest.fixture
def fixture_dir(tmp_path, monkeypatch):
    monkeypatch.setattr(golden_set, "FIXTURE_DIR", tmp_path)
    return tmp_path


# --- item_sha256 -------------------------------------------------------------------------------------------------


def test_item_sha256_ignores_whitespace_and_key_order_in_the_jsonl():
    item = _item("syn-hash-1")
    data = item.model_dump(mode="json")
    compact = json.dumps(data, separators=(",", ":"))
    reordered = json.dumps(dict(reversed(list(data.items()))), indent=4)
    first = GoldenItem.model_validate_json(compact)
    second = GoldenItem.model_validate_json(reordered)
    assert item_sha256(first) == item_sha256(second)
    assert len(item_sha256(first)) == 64


def test_item_sha256_changes_when_any_value_changes():
    base = _item("syn-hash-2")
    assert item_sha256(base) != item_sha256(_item("syn-hash-2", quote="alpha beta delta"))
    assert item_sha256(base) != item_sha256(_item("syn-hash-2", split="test"))


# --- build and verify --------------------------------------------------------------------------------------------


def test_build_manifest_starts_at_version_one_with_every_item_active():
    items = [_item("syn-b"), _item("syn-a")]
    manifest = golden_set.build_manifest("syn", items, today=DAY1)
    assert manifest.version == 1
    assert [entry.id for entry in manifest.items] == ["syn-a", "syn-b"]
    assert all(entry.status == "active" and entry.last_reviewed_at == DAY1 for entry in manifest.items)
    assert manifest.changelog[0].added == ["syn-a", "syn-b"]


def test_verify_passes_for_a_matching_set():
    items = [_item("syn-a"), _item("syn-b")]
    manifest = golden_set.build_manifest("syn", items, today=DAY1)
    assert golden_set.verify_manifest(items, manifest) == []


def test_verify_names_added_removed_and_changed_items():
    items = [_item("syn-a"), _item("syn-b")]
    manifest = golden_set.build_manifest("syn", items, today=DAY1)
    edited = [_item("syn-a", quote="alpha beta delta"), _item("syn-c")]
    problems = golden_set.verify_manifest(edited, manifest)
    assert any("syn-a" in p and "changed" in p for p in problems)
    assert any("syn-b" in p and "removed" in p for p in problems)
    assert any("syn-c" in p and "added" in p for p in problems)


def test_verify_flags_a_wrong_manifest_hash():
    items = [_item("syn-a")]
    raw = golden_set.build_manifest("syn", items, today=DAY1).model_dump(mode="json")
    raw["manifest_sha256"] = "0" * 64
    problems = golden_set.verify_manifest(items, raw)
    assert any("manifest_sha256" in p for p in problems)


def test_verify_cli_exits_2_on_mismatch_and_0_on_match(fixture_dir, capsys):
    golden = fixture_dir / "golden.jsonl"
    manifest_path = fixture_dir / "golden.manifest.json"
    items = [_item("syn-a"), _item("syn-b")]
    _write_jsonl(golden, items)
    _write_manifest(manifest_path, golden_set.build_manifest("syn", items, today=DAY1))
    assert golden_set.main(["verify", "--golden", str(golden), "--manifest", str(manifest_path)]) == 0
    _write_jsonl(golden, [_item("syn-a", quote="alpha beta delta"), _item("syn-b")])
    assert golden_set.main(["verify", "--golden", str(golden), "--manifest", str(manifest_path)]) == 2
    assert "syn-a" in capsys.readouterr().out


def test_verify_cli_reports_a_tampered_manifest_hash(fixture_dir, capsys):
    golden = fixture_dir / "golden.jsonl"
    manifest_path = fixture_dir / "golden.manifest.json"
    items = [_item("syn-a")]
    _write_jsonl(golden, items)
    raw = golden_set.build_manifest("syn", items, today=DAY1).model_dump(mode="json")
    raw["manifest_sha256"] = "f" * 64
    manifest_path.write_text(json.dumps(raw), encoding="utf-8")
    assert golden_set.main(["verify", "--golden", str(golden), "--manifest", str(manifest_path)]) == 2
    assert "manifest_sha256" in capsys.readouterr().out


def test_jsonl_whitespace_does_not_break_verify(fixture_dir):
    golden = fixture_dir / "golden.jsonl"
    manifest_path = fixture_dir / "golden.manifest.json"
    items = [_item("syn-a")]
    _write_manifest(manifest_path, golden_set.build_manifest("syn", items, today=DAY1))
    data = items[0].model_dump(mode="json")
    golden.write_text("\n" + json.dumps(dict(sorted(data.items(), reverse=True)), indent=None, separators=(" , ", " : ")) + "\n\n", encoding="utf-8")
    assert golden_set.main(["verify", "--golden", str(golden), "--manifest", str(manifest_path)]) == 0


# --- bump --------------------------------------------------------------------------------------------------------


def test_bump_adds_new_items_under_a_new_version():
    items = [_item("syn-a")]
    manifest = golden_set.build_manifest("syn", items, today=DAY1)
    grown = items + [_item("syn-b"), _item("syn-c")]
    bumped = golden_set.bump(grown, manifest, today=DAY2)
    assert bumped is not None
    assert bumped.version == 2
    assert bumped.changelog[-1].added == ["syn-b", "syn-c"]
    assert bumped.changelog[-1].date == DAY2
    assert golden_set.verify_manifest(grown, bumped) == []
    assert golden_set.bump(grown, bumped, today=DAY3) is None


def test_bump_records_changed_items():
    manifest = golden_set.build_manifest("syn", [_item("syn-a")], today=DAY1)
    edited = [_item("syn-a", quote="alpha beta delta")]
    bumped = golden_set.bump(edited, manifest, today=DAY2)
    assert bumped is not None and bumped.changelog[-1].changed == ["syn-a"]
    assert golden_set.verify_manifest(edited, bumped) == []


def test_bump_refuses_an_item_removed_from_the_jsonl():
    manifest = golden_set.build_manifest("syn", [_item("syn-a"), _item("syn-b")], today=DAY1)
    with pytest.raises(golden_set.LifecycleError, match="syn-b"):
        golden_set.bump([_item("syn-a")], manifest, today=DAY2)


def test_bump_cli_says_nothing_changed_and_writes_nothing(fixture_dir, capsys):
    golden = fixture_dir / "golden.jsonl"
    manifest_path = fixture_dir / "golden.manifest.json"
    _write_jsonl(golden, [_item("syn-a")])
    assert golden_set.main(["bump", "--golden", str(golden), "--manifest", str(manifest_path), "--set-id", "syn"]) == 0
    first = manifest_path.read_bytes()
    capsys.readouterr()
    assert golden_set.main(["bump", "--golden", str(golden), "--manifest", str(manifest_path)]) == 0
    assert "nothing to bump" in capsys.readouterr().out
    assert manifest_path.read_bytes() == first


# --- retire and relabel ------------------------------------------------------------------------------------------


def test_retire_sets_the_reason_and_bumps_the_version():
    items = [_item("syn-a"), _item("syn-b")]
    manifest = golden_set.build_manifest("syn", items, today=DAY1)
    retired = golden_set.retire(manifest, "syn-b", "superseded_policy", today=DAY2)
    entry = {e.id: e for e in retired.items}["syn-b"]
    assert entry.status == "retired" and entry.retire_reason == "superseded_policy"
    assert retired.version == 2 and retired.changelog[-1].retired == ["syn-b"]
    assert len(retired.items) == 2
    assert golden_set.verify_manifest(items, retired) == []


def test_retire_cli_needs_a_reason_and_a_known_id(fixture_dir):
    golden = fixture_dir / "golden.jsonl"
    manifest_path = fixture_dir / "golden.manifest.json"
    items = [_item("syn-a")]
    _write_jsonl(golden, items)
    _write_manifest(manifest_path, golden_set.build_manifest("syn", items, today=DAY1))
    base = ["retire", "--golden", str(golden), "--manifest", str(manifest_path)]
    assert golden_set.main(base + ["--id", "syn-a"]) == 2
    assert golden_set.main(base + ["--id", "syn-zzz", "--reason", "obsolete"]) == 2
    assert golden_set.main(base + ["--id", "syn-a", "--reason", "Not A Code"]) == 2
    assert json.loads(manifest_path.read_text())["version"] == 1
    assert golden_set.main(base + ["--id", "syn-a", "--reason", "obsolete"]) == 0
    assert json.loads(manifest_path.read_text())["items"][0]["status"] == "retired"


def test_relabel_stores_the_new_hash_and_returns_a_stale_item_to_active():
    items = [_item("syn-a"), _item("syn-b")]
    manifest = golden_set.build_manifest("syn", items, today=DAY1)
    documents = {"doc-a.md": "Section one\nalpha beta gamma"}
    stale, _ = golden_set.stale_scan_fixture(
        [_item("syn-a", document="doc-gone.md"), items[1]], manifest, documents, today=DAY2
    )
    assert stale is not None
    fixed = [_item("syn-a", quote="alpha beta"), items[1]]
    relabelled = golden_set.relabel(fixed, stale, "syn-a", today=DAY3)
    entry = {e.id: e for e in relabelled.items}["syn-a"]
    assert entry.status == "active"
    assert entry.stale_reason is None and entry.stale_since is None
    assert entry.last_reviewed_at == DAY3
    assert entry.item_sha256 == item_sha256(fixed[0])
    assert relabelled.version == stale.version + 1
    assert relabelled.changelog[-1].changed == ["syn-a"]
    assert golden_set.verify_manifest(fixed, relabelled) == []


def test_nothing_is_ever_deleted_from_a_manifest():
    items = [_item("syn-a"), _item("syn-b")]
    manifest = golden_set.build_manifest("syn", items, today=DAY1)
    manifest = golden_set.retire(manifest, "syn-a", "obsolete", today=DAY2)
    manifest = golden_set.bump(items + [_item("syn-c")], manifest, today=DAY3)
    assert manifest is not None
    assert [e.id for e in manifest.items] == ["syn-a", "syn-b", "syn-c"]
    assert [e.version for e in manifest.changelog] == [1, 2, 3]


# --- private paths -----------------------------------------------------------------------------------------------


def test_a_manifest_outside_the_fixtures_must_be_private(tmp_path, monkeypatch, capsys):
    monkeypatch.setattr(golden_set, "FIXTURE_DIR", tmp_path / "fixtures")
    golden = tmp_path / "golden.jsonl"
    _write_jsonl(golden, [_item("syn-a")])
    manifest_path = tmp_path / "elsewhere" / "golden.manifest.json"
    code = golden_set.main(["bump", "--golden", str(golden), "--manifest", str(manifest_path), "--set-id", "syn"])
    assert code == 2
    assert not manifest_path.exists()
    assert "eval/golden/private" in capsys.readouterr().err


# --- stale scan --------------------------------------------------------------------------------------------------


def test_stale_scan_marks_missing_documents_and_missing_quotes_without_touching_the_jsonl():
    items = [_item("syn-a"), _item("syn-b", document="doc-b.md", quote="delta epsilon"), _item("syn-c", document="doc-b.md", quote="zeta eta")]
    manifest = golden_set.build_manifest("syn", items, today=DAY1)
    documents = {"doc-b.md": "Section one\nDelta, epsilon! and more text"}
    scanned, findings = golden_set.stale_scan_fixture(items, manifest, documents, today=DAY2)
    assert scanned is not None
    by_id = {e.id: e for e in scanned.items}
    assert by_id["syn-a"].status == "stale" and by_id["syn-a"].stale_reason == "document_missing"
    assert by_id["syn-a"].stale_since == DAY2
    assert by_id["syn-b"].status == "active"
    assert by_id["syn-c"].stale_reason == "quote_not_found"
    assert scanned.version == 2 and scanned.changelog[-1].stale == ["syn-a", "syn-c"]
    assert {f["id"] for f in findings} == {"syn-a", "syn-c"}
    assert golden_set.verify_manifest(items, scanned) == []


def test_an_item_already_stale_keeps_its_first_stale_since():
    items = [_item("syn-a")]
    manifest = golden_set.build_manifest("syn", items, today=DAY1)
    first, _ = golden_set.stale_scan_fixture(items, manifest, {}, today=DAY2)
    assert first is not None
    second, findings = golden_set.stale_scan_fixture(items, first, {}, today=DAY3)
    assert second is None
    assert findings == []
    assert {e.id: e for e in first.items}["syn-a"].stale_since == DAY2


def test_stale_scan_on_a_temp_corpus_changes_only_the_manifest(fixture_dir):
    corpus = fixture_dir / "corpus"
    shutil.copytree(CORPUS_DIR, corpus)
    golden = fixture_dir / "golden.jsonl"
    shutil.copyfile(FIXTURE_GOLDEN, golden)
    manifest_path = fixture_dir / "golden.manifest.json"
    items = load_golden(golden)
    _write_manifest(manifest_path, golden_set.build_manifest("fixture", items, today=DAY1))

    target = next(item for item in items if item.gold_evidence)
    span = target.gold_evidence[0]
    doc = next(d for d in load_corpus(corpus) if d.filename == span.document)
    (corpus / doc.relpath).unlink()
    quote_item = next(
        item for item in items if item.gold_evidence and all(s.document != span.document for s in item.gold_evidence)
    )
    quote_span = quote_item.gold_evidence[0]
    quote_doc = next(d for d in load_corpus(corpus) if d.filename == quote_span.document)
    path = corpus / quote_doc.relpath
    text = path.read_text(encoding="utf-8")
    assert quote_span.quote in text
    path.write_text(text.replace(quote_span.quote, "removed synthetic words"), encoding="utf-8")

    before = golden.read_bytes()
    args = ["stale-scan", "--golden", str(golden), "--manifest", str(manifest_path), "--corpus", str(corpus)]
    assert golden_set.main(args) == 0
    assert golden.read_bytes() == before
    by_id = {e["id"]: e for e in json.loads(manifest_path.read_text())["items"]}
    assert by_id[target.id]["status"] == "stale" and by_id[target.id]["stale_reason"] == "document_missing"
    assert by_id[target.id]["stale_since"] is not None
    assert by_id[quote_item.id]["status"] == "stale" and by_id[quote_item.id]["stale_reason"] == "quote_not_found"


def test_corpus_documents_keeps_every_version_of_a_lineage_filename():
    versions = [doc for doc in load_corpus(CORPUS_DIR) if doc.lineage is not None and doc.filename == "versioned-note.en.md"]
    assert len(versions) == 2
    text = golden_set.corpus_documents(versions)["versioned-note.en.md"]
    assert all(doc.content in text for doc in versions)


def test_stale_scan_of_the_committed_fixture_set_finds_nothing(capsys):
    items = load_golden(FIXTURE_GOLDEN)
    manifest = golden_set.load_manifest(FIXTURE_MANIFEST)
    documents = golden_set.corpus_documents(load_corpus(CORPUS_DIR))
    scanned, findings = golden_set.stale_scan_fixture(items, manifest, documents, today=DAY2)
    assert scanned is None
    assert findings == []


def test_real_set_scan_and_register_wait_for_plan_35(fixture_dir, capsys):
    golden = fixture_dir / "golden.jsonl"
    manifest_path = fixture_dir / "golden.manifest.json"
    items = [_item("syn-a")]
    _write_jsonl(golden, items)
    _write_manifest(manifest_path, golden_set.build_manifest("syn", items, today=DAY1))
    base = ["--golden", str(golden), "--manifest", str(manifest_path)]
    assert golden_set.main(["register", *base]) == 2
    assert golden_set.main(["stale-scan", *base, "--base-url", "http://localhost:3000"]) == 2
    assert "needs plan 05.3-35" in capsys.readouterr().err


# --- registration rows -------------------------------------------------------------------------------------------


def test_registration_rows_carry_hashes_and_no_quote_text():
    items = [_item("syn-a", quote="Alpha  beta, gamma"), _item("syn-b", answerable=False, category="no_answer", gold_evidence=[], expected_answer=None)]
    rows = golden_set.registration_rows(items, lambda name: "doc-id-1" if name == "doc-a.md" else None)
    assert len(rows) == 1
    row = rows[0]
    assert row["item_id"] == "syn-a" and row["document_id"] == "doc-id-1"
    import hashlib

    assert row["quote_sha256"] == hashlib.sha256(normalize_text("Alpha  beta, gamma").encode("utf-8")).hexdigest()
    assert "Alpha" not in json.dumps(row) and "gamma" not in json.dumps(row)


# --- committed manifests -----------------------------------------------------------------------------------------


def test_committed_fixture_manifest_verifies():
    manifest = golden_set.load_manifest(FIXTURE_MANIFEST)
    assert manifest.set_id == "fixture"
    assert golden_set.verify_manifest(load_golden(FIXTURE_GOLDEN), manifest) == []


def test_committed_ingest_manifest_verifies_against_the_merged_ingest_set():
    manifest = golden_set.load_manifest(INGEST_MANIFEST)
    assert manifest.set_id == "fixture-ingest"
    merged = golden_set.load_golden_set([FIXTURE_GOLDEN, INGEST_GOLDEN])
    assert golden_set.verify_manifest(merged, manifest) == []


def test_committed_manifests_start_at_version_one_all_active():
    # Version 1 recorded the set when 05.3-06 created the manifests; version 2 (bump, train 30) added only the
    # 36 Phase 4.2 items of plan 04.2-37 (tag phase42). Every item is still active.
    phase42 = sorted(item.id for item in load_golden(FIXTURE_GOLDEN) if "phase42" in item.tags)
    assert len(phase42) == 36
    for path in (FIXTURE_MANIFEST, INGEST_MANIFEST):
        manifest = golden_set.load_manifest(path)
        assert manifest.version == 2
        assert [entry.version for entry in manifest.changelog] == [1, 2]
        assert sorted(manifest.changelog[1].added) == phase42
        assert not manifest.changelog[1].changed
        assert all(entry.status == "active" for entry in manifest.items)
