import hashlib
import json
from pathlib import Path

import pytest
from rag_sidecar.contracts.golden import GoldenItem

from rag_eval.golden_io import load_golden

REPO = Path(__file__).resolve().parents[2]
GOLDEN = REPO / "eval/fixtures/ingest/golden-ingest.jsonl"
MANIFEST = REPO / "eval/fixtures/ingest/manifest.json"
INGEST_ROOT = REPO / "eval/fixtures/ingest"


def _fixture_text(document: str) -> str:
    markdown_path = INGEST_ROOT / "text" / document.replace(".pdf", ".md")
    if markdown_path.exists():
        return markdown_path.read_text(encoding="utf-8")
    parse = INGEST_ROOT / "recorded" / document.replace(".pdf", ".parse.json")
    if parse.exists():
        payload = json.loads(parse.read_text(encoding="utf-8"))
        parts = [str(payload.get("markdown", ""))]
        for chunk in payload.get("chunks", []):
            parts.append(str(chunk.get("text", "")))
        return "\n".join(parts)
    return ""


@pytest.fixture(scope="module")
def manifest_documents() -> dict[str, str]:
    by_file: dict[str, str] = {}
    for item in json.loads(MANIFEST.read_text(encoding="utf-8"))["fixtures"]:
        name = Path(item["path"]).name
        text = item.get("text")
        if isinstance(text, dict) and "path" in text:
            by_file[name] = (INGEST_ROOT / text["path"]).read_text(encoding="utf-8")
        else:
            by_file[name] = _fixture_text(name)
    return by_file


def test_golden_ingest_items_validate_and_quotes_live_in_fixture_text(manifest_documents: dict[str, str]):
    items = load_golden(GOLDEN)
    assert len(items) >= 12
    for item in items:
        GoldenItem.model_validate(item.model_dump(mode="json"))
        if not item.answerable:
            continue
        for span in item.gold_evidence:
            haystack = manifest_documents.get(span.document, "")
            assert span.quote in haystack, f"{item.id}: quote missing from {span.document}"

PRE_CLAUSE_COUNT = 12
PRE_CLAUSE_SHA256 = "8ca6eb7929e73453b9dfdfb986759f31687f1292981c55c0355aca4562e57011"
CONTRACT_DOCUMENT = "contract-zh.pdf"


def _clause_bodies(text: str) -> list[str]:
    parts = text.split("\n### ")[1:]
    return [part.split("\n", 1)[1] for part in parts]


def test_clause_items_cover_zh_en_it_with_quotes_inside_one_clause(manifest_documents: dict[str, str]):
    clause_items = [item for item in load_golden(GOLDEN) if "clause" in item.tags]
    assert len(clause_items) >= 4
    assert len([item for item in clause_items if item.language == "zh"]) >= 2
    assert len([item for item in clause_items if item.language == "en"]) >= 1
    assert len([item for item in clause_items if item.language == "it"]) >= 1
    bodies = _clause_bodies(manifest_documents[CONTRACT_DOCUMENT])
    assert len(bodies) == 3
    for item in clause_items:
        assert item.answerable and item.review_status == "approved" and item.provenance == "synthetic_fixture", item.id
        if item.language != "zh":
            assert item.category == "cross_lingual" and item.evidence_language == "zh", item.id
        for span in item.gold_evidence:
            assert span.document == CONTRACT_DOCUMENT, item.id
            holders = [body for body in bodies if span.quote in body]
            assert len(holders) == 1, f"{item.id}: quote must lie inside exactly one clause"


def test_existing_ingest_golden_items_are_unchanged():
    lines = [line for line in GOLDEN.read_text(encoding="utf-8").split("\n") if line.strip()]
    rows = [json.loads(line) for line in lines]
    old = sorted((row for row in rows if "clause" not in row.get("tags", [])), key=lambda row: row["id"])
    assert len(old) == PRE_CLAUSE_COUNT
    payload = "\n".join(json.dumps(row, sort_keys=True, ensure_ascii=False) for row in old)
    assert hashlib.sha256(payload.encode("utf-8")).hexdigest() == PRE_CLAUSE_SHA256
