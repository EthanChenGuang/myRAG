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
    for row in json.loads((REPO / "eval/fixtures/parse/manifest.json").read_text(encoding="utf-8"))["fixtures"]:
        chain = REPO / "eval/fixtures/parse/chain" / f"{row['id']}.parse.json"
        if chain.exists():
            by_file.setdefault(f"{row['id']}.pdf", _fixture_text_from_parse(chain))
    return by_file


def _fixture_text_from_parse(path: Path) -> str:
    payload = json.loads(path.read_text(encoding="utf-8"))
    return "\n".join([str(payload.get("markdown", "")), *(str(chunk.get("text", "")) for chunk in payload.get("chunks", []))])


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

# Parse fixtures (03.1-47, D-40/D-41): at least three approved items per class link to the fixture document by name.
PARSE_ROOT = REPO / "eval/fixtures/parse"
SPLIT_MANIFEST = REPO / "eval/fixtures/split-manifest.json"
PARSE_TAG = "parse_fixtures"
EXCLUDED_PARSE_CLASSES = {"bench"}


def _parse_rows() -> list[dict]:
    rows = json.loads((PARSE_ROOT / "manifest.json").read_text(encoding="utf-8"))["fixtures"]
    return [row for row in rows if row["class"] not in EXCLUDED_PARSE_CLASSES]


def _chain_text(fixture_id: str) -> str:
    payload = json.loads((PARSE_ROOT / "chain" / f"{fixture_id}.parse.json").read_text(encoding="utf-8"))
    return "\n".join([payload["markdown"], *(chunk["text"] for chunk in payload["chunks"])])


def _expected(fixture_id: str) -> dict:
    return json.loads((PARSE_ROOT / "expected" / f"{fixture_id}.json").read_text(encoding="utf-8"))


def _recorded_texts(row: dict, preset: str, page: int) -> str:
    payload = json.loads((PARSE_ROOT / "recorded" / row["sha256"] / preset / f"page-{page}.json").read_text(encoding="utf-8"))
    return "\n".join(item.get("text", "") for item in payload.get("texts", []))


def _parse_items() -> list:
    return [item for item in load_golden(GOLDEN) if PARSE_TAG in item.tags]


def _tag(item, prefix: str) -> str | None:
    return next((tag.split(":", 1)[1] for tag in item.tags if tag.startswith(prefix + ":")), None)


def test_every_parse_fixture_class_has_three_approved_linked_items():
    by_class: dict[str, list] = {}
    for item in _parse_items():
        if item.answerable:
            by_class.setdefault(_tag(item, "parse_class") or "", []).append(item)
    for row in _parse_rows():
        linked = [
            item
            for item in by_class.get(row["class"], [])
            if item.review_status == "approved" and _tag(item, "parse_fixture") == row["id"]
            and all(span.document == f"{row['id']}.pdf" for span in item.gold_evidence)
        ]
        assert len(linked) >= 3, f"{row['class']} ({row['id']}) has {len(linked)} linked approved items"


def test_parse_item_quotes_are_verbatim_in_their_fixture():
    rows = {row["id"]: row for row in _parse_rows()}
    for item in _parse_items():
        if not item.answerable:
            continue
        fixture_id = _tag(item, "parse_fixture")
        assert fixture_id in rows, item.id
        text = _chain_text(fixture_id)
        for span in item.gold_evidence:
            assert span.quote in text, f"{item.id}: {span.quote!r} is not in {fixture_id}"


def test_parse_table_items_quote_a_cell_of_the_expected_grid():
    for item in _parse_items():
        if item.category != "table":
            continue
        cells = {cell["text"] for cell in _expected(_tag(item, "parse_fixture"))["table_cells"]}
        for span in item.gold_evidence:
            assert span.quote in cells, f"{item.id}: {span.quote!r} is not a cell of the expected grid"


def test_parse_scanned_items_quote_text_ocr_recovers():
    rows = {row["id"]: row for row in _parse_rows()}
    for item in _parse_items():
        if item.category != "scanned":
            continue
        row = rows[_tag(item, "parse_fixture")]
        ocr = "\n".join(_recorded_texts(row, "structured_ocr", page) for page in range(1, row["page_count"] + 1))
        for span in item.gold_evidence:
            assert span.quote in ocr, f"{item.id}: {span.quote!r} is not in the OCR recording"


def test_parse_items_have_a_no_answer_item_per_language():
    no_answer = [item for item in _parse_items() if not item.answerable]
    assert {item.language for item in no_answer} >= {"zh", "en", "it"}
    assert all(item.category == "no_answer" and item.review_status == "approved" for item in no_answer)


def test_new_items_take_their_split_from_the_rule_and_the_manifest_keeps_the_old_ones():
    from rag_eval.split import assign_split, load_manifest

    manifest = load_manifest(SPLIT_MANIFEST)
    items = load_golden(GOLDEN)
    parse_ids = {item.id for item in items if PARSE_TAG in item.tags}
    assert parse_ids, "no parse fixture items"
    for item in items:
        if item.id in parse_ids:
            assert manifest.get(item.id) == item.split == assign_split(item.id), item.id
        else:
            assert item.id not in manifest, f"{item.id} keeps the split it was written with"
    golden_ids = {item.id for item in load_golden(REPO / "eval/fixtures/golden.jsonl")}
    assert set(manifest) == golden_ids | parse_ids
