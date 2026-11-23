import hashlib
import json
from pathlib import Path

import pytest
from rag_sidecar.contracts.eval_run import RunManifest
from rag_sidecar.contracts.golden import GoldenItem

from rag_eval.golden_io import golden_sha256, load_golden, write_golden
from rag_eval.traces import load_manifest, load_traces


def _item(item_id: str, *, quote: str = "The refund window is 45 days.") -> GoldenItem:
    return GoldenItem(
        id=item_id,
        question="What is the refund window?",
        language="en",
        category="general",
        answerable=True,
        expected_answer="45 days",
        gold_evidence=[{"document": "refund-policy.en.md", "section": "Annual plans", "quote": quote}],
        review_status="approved",
        provenance="synthetic_fixture",
        split="dev",
    )


def _line(item: GoldenItem) -> str:
    return json.dumps(item.model_dump(mode="json"), ensure_ascii=False, sort_keys=True)


def _trace_dict(item_id: str | None = "en-general-001") -> dict:
    return {
        "schema_version": 1,
        "item_id": item_id,
        "query": "q",
        "query_context": {
            "is_temporal_query": False,
            "is_financial_query": False,
            "required_precision": "low",
            "suggested_threshold": 0.3,
            "search_strategy": "semantic_only",
        },
        "retrieval_strategy": "standard",
        "query_transforms": [],
        "candidates": [],
        "kept": [],
        "used_documents": [],
        "context": "",
        "refused": True,
        "refusal_reason": "no_relevant_context",
        "answer": None,
        "citations": [],
        "stage_latency_ms": {},
        "effective_config": {
            "rag_env": {},
            "rag_prompt_sha256": {},
            "deployment_mode": "single",
            "embedding_model": "fixture",
            "endpoint_version": "1",
        },
        "config_hash": "0" * 64,
    }


def _manifest_dict() -> dict:
    return {
        "schema_version": 1,
        "run_id": "run-1",
        "tier": "smoke",
        "created_at": "2025-01-15T00:00:00.000Z",
        "deployment_mode": "single",
        "golden_path": "eval/fixtures/golden.jsonl",
        "golden_sha256": "0" * 64,
        "sql_sha256": {},
        "request_options": {},
        "effective_config_hash": "1" * 64,
        "run_config_hash": "2" * 64,
        "item_count": 1,
        "edge_errors": 0,
    }


def test_load_golden_preserves_file_order(tmp_path: Path):
    path = tmp_path / "golden.jsonl"
    path.write_text("\n".join(_line(_item(i)) for i in ("en-b-002", "en-a-001", "en-c-003")) + "\n", encoding="utf-8")
    assert [i.id for i in load_golden(path)] == ["en-b-002", "en-a-001", "en-c-003"]


def test_load_golden_rejects_duplicate_id_naming_the_line(tmp_path: Path):
    path = tmp_path / "golden.jsonl"
    path.write_text("\n".join(_line(_item(i)) for i in ("en-a-001", "en-b-002", "en-a-001")) + "\n", encoding="utf-8")
    with pytest.raises(ValueError, match=r"line 3.*en-a-001"):
        load_golden(path)


def test_load_golden_rejects_invalid_line_naming_the_line(tmp_path: Path):
    path = tmp_path / "golden.jsonl"
    path.write_text(_line(_item("en-a-001")) + "\n" + '{"id": "en-b-002"}\n', encoding="utf-8")
    with pytest.raises(ValueError, match=r"line 2"):
        load_golden(path)


def test_load_golden_rejects_malformed_json_naming_the_line(tmp_path: Path):
    path = tmp_path / "golden.jsonl"
    path.write_text(_line(_item("en-a-001")) + "\n{not json\n", encoding="utf-8")
    with pytest.raises(ValueError, match=r"line 2"):
        load_golden(path)


def test_load_golden_skips_blank_lines_but_counts_them(tmp_path: Path):
    path = tmp_path / "golden.jsonl"
    path.write_text(_line(_item("en-a-001")) + "\n\n" + "oops\n", encoding="utf-8")
    with pytest.raises(ValueError, match=r"line 3"):
        load_golden(path)


def test_write_golden_sorts_by_id_with_sorted_keys_and_is_byte_stable(tmp_path: Path):
    items = [_item("en-c-003"), _item("en-a-001"), _item("en-b-002")]
    first = tmp_path / "first.jsonl"
    second = tmp_path / "second.jsonl"
    write_golden(first, items)
    write_golden(second, list(reversed(items)))
    assert first.read_bytes() == second.read_bytes()
    lines = first.read_text(encoding="utf-8").splitlines()
    assert [json.loads(line)["id"] for line in lines] == ["en-a-001", "en-b-002", "en-c-003"]
    for line in lines:
        keys = list(json.loads(line))
        assert keys == sorted(keys)
    assert first.read_text(encoding="utf-8").endswith("\n")
    assert [i.id for i in load_golden(first)] == ["en-a-001", "en-b-002", "en-c-003"]


def test_write_golden_keeps_non_ascii_text_unescaped(tmp_path: Path):
    path = tmp_path / "golden.jsonl"
    write_golden(path, [_item("zh-a-001", quote="退款期限为四十五天。")])
    assert "退款期限为四十五天。" in path.read_text(encoding="utf-8")


def test_golden_sha256_hashes_file_bytes(tmp_path: Path):
    path = tmp_path / "golden.jsonl"
    write_golden(path, [_item("en-a-001")])
    assert golden_sha256(path) == hashlib.sha256(path.read_bytes()).hexdigest()
    before = golden_sha256(path)
    write_golden(path, [_item("en-a-001", quote="The refund window is 30 days.")])
    assert golden_sha256(path) != before


def test_load_traces_validates_each_line_and_names_the_failing_line(tmp_path: Path):
    good = tmp_path / "traces.jsonl"
    good.write_text(json.dumps(_trace_dict("en-a-001")) + "\n" + json.dumps(_trace_dict("en-b-002")) + "\n")
    assert [t.item_id for t in load_traces(good)] == ["en-a-001", "en-b-002"]

    bad = tmp_path / "bad.jsonl"
    extra = {**_trace_dict("en-b-002"), "surprise": 1}
    bad.write_text(json.dumps(_trace_dict("en-a-001")) + "\n" + json.dumps(extra) + "\n")
    with pytest.raises(ValueError, match=r"line 2"):
        load_traces(bad)


def test_load_manifest_validates_with_run_manifest(tmp_path: Path):
    path = tmp_path / "manifest.json"
    path.write_text(json.dumps(_manifest_dict()), encoding="utf-8")
    manifest = load_manifest(path)
    assert isinstance(manifest, RunManifest)
    assert manifest.run_id == "run-1"

    broken = tmp_path / "broken.json"
    broken.write_text(json.dumps({**_manifest_dict(), "tier": "bogus"}), encoding="utf-8")
    with pytest.raises(ValueError):
        load_manifest(broken)
