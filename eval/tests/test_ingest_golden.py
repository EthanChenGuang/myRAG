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