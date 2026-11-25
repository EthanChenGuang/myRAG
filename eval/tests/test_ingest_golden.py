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
    manifest = json.loads(MANIFEST.read_text(encoding="utf-8"))
    for item in [*manifest["fixtures"], *manifest.get("long_table_fixtures", [])]:
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

PRE_CLAUSE_COUNT = 12
PRE_CLAUSE_SHA256 = "81ee2f95622c19d83e9b94034954237e5133c1d061eef4056f30ae74d9aac747"
# 2026-11-25 merge train 2: re-pinned after the 03-gaps fix to the gold_evidence quotes of ingest-scan-en/it/zh (no other pre-clause item changed).
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
    old = sorted(
        (
            row
            for row in rows
            if not {"clause", "parse_fixtures"} & set(row.get("tags", [])) and row["category"] != TABLE_SPLIT
        ),
        key=lambda row: row["id"],
    )
    assert len(old) == PRE_CLAUSE_COUNT
    payload = "\n".join(json.dumps(row, sort_keys=True, ensure_ascii=False) for row in old)
    assert hashlib.sha256(payload.encode("utf-8")).hexdigest() == PRE_CLAUSE_SHA256


TABLE_SPLIT = "table_split"


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
    table_ids = {item.id for item in items if item.category == TABLE_SPLIT}
    for item in items:
        if item.id in parse_ids | table_ids:
            assert manifest.get(item.id) == item.split == assign_split(item.id), item.id
        else:
            assert item.id not in manifest, f"{item.id} keeps the split it was written with"
    golden_ids = {item.id for item in load_golden(REPO / "eval/fixtures/golden.jsonl")}
    assert set(manifest) == golden_ids | parse_ids | table_ids


# table_split (03.2-30, D-45, EVAL-18): long-table items answered from the isolated table tenants of the ingest fixture mode.
TABLE_SPLIT_ID_RE = r"^ingest-table-split-(zh|en|it)-\d{2}$"
TABLE_LANGUAGES = ("zh", "en", "it")
MIN_TABLE_ROW = 30


def _long_table_entries() -> dict[str, dict]:
    manifest = json.loads(MANIFEST.read_text(encoding="utf-8"))
    return {entry["id"]: entry for entry in manifest.get("long_table_fixtures", [])}


def _table_items() -> list:
    return [item for item in load_golden(GOLDEN) if item.category == TABLE_SPLIT]


def _long_table_rows(language: str):
    import importlib.util

    spec = importlib.util.spec_from_file_location("ingest_specs", INGEST_ROOT / "specs.py")
    module = importlib.util.module_from_spec(spec)
    assert spec.loader is not None
    import sys

    sys.modules.setdefault("ingest_specs", module)
    spec.loader.exec_module(module)
    return module.long_table_rows(language)


def _fixture_of(item) -> dict:
    fixture_id = _tag(item, "long_table_fixture")
    entries = _long_table_entries()
    assert fixture_id in entries, item.id
    return entries[fixture_id]


def _row_of(item) -> int:
    return int(_tag(item, "table_row") or "-1")


def test_each_language_has_at_least_four_table_split_items():
    items = _table_items()
    for language in TABLE_LANGUAGES:
        assert len([item for item in items if item.language == language]) >= 4, language


def test_table_split_items_follow_the_id_pattern_and_keep_synthetic_provenance():
    import re

    for item in _table_items():
        assert re.match(TABLE_SPLIT_ID_RE, item.id), item.id
        assert item.id.split("-")[3] == item.language, item.id
        assert item.provenance == "synthetic_fixture", item.id
        assert item.review_status == "approved" and item.answerable, item.id
        assert item.evidence_language is None, item.id


def test_each_language_asks_on_its_target_row_varies_the_column_and_uses_the_continued_variant():
    items = _table_items()
    for language in TABLE_LANGUAGES:
        own = [item for item in items if item.language == language]
        target = _long_table_entries()[f"long-table-{language}"]["expected"]["long_table"]["target_row"]
        assert any(_row_of(item) == target for item in own), language
        assert {_tag(item, "table_column") for item in own} >= {"value_1", "value_2", "category"}, language
        assert any(_tag(item, "long_table_fixture") == f"long-table-{language}-continued" for item in own), language
        assert any(_row_of(item) == 59 for item in own), f"{language}: no item on the last row"


def test_every_table_split_answer_row_lies_late_in_the_table():
    for item in _table_items():
        assert _row_of(item) >= MIN_TABLE_ROW, item.id


def test_table_split_evidence_is_the_row_and_the_header_each_once_in_the_fixture_text(manifest_documents):
    from rag_eval.matching import normalize_text

    for item in _table_items():
        entry = _fixture_of(item)
        document = Path(entry["path"]).name
        assert item.language == entry["language"], item.id
        header, body = _long_table_rows(item.language)
        assert [span.quote for span in item.gold_evidence] == [" | ".join(body[_row_of(item)]), " | ".join(header)], item.id
        text = (INGEST_ROOT / entry["text"]["path"]).read_text(encoding="utf-8")
        for span in item.gold_evidence:
            assert span.document == document, item.id
            assert text.count(span.quote) == 1, f"{item.id}: {span.quote!r}"
            assert normalize_text(text).count(normalize_text(span.quote)) == 1, f"{item.id}: {span.quote!r}"


def test_table_split_quotes_match_a_chunk_of_the_recorded_parse():
    from rag_eval.matching import chunk_matches_span

    for item in _table_items():
        entry = _fixture_of(item)
        document = Path(entry["path"]).name
        chunks = json.loads((INGEST_ROOT / entry["recorded"]["parse_result"]).read_text(encoding="utf-8"))["chunks"]
        for span in item.gold_evidence:
            assert any(chunk_matches_span(document, chunk["text"], span) for chunk in chunks), f"{item.id}: {span.quote!r}"


def test_table_answer_is_the_asked_cell_and_a_distractor_is_another_cell_of_the_row():
    columns = {"value_1": 2, "value_2": 3, "category": 4}
    for item in _table_items():
        header, body = _long_table_rows(item.language)
        row = body[_row_of(item)]
        column = columns[_tag(item, "table_column")]
        answer = item.table_answer
        assert answer is not None, item.id
        assert answer.column == header[column], item.id
        assert answer.value == row[column], item.id
        assert answer.value in (item.expected_answer or ""), item.id
        others = {cell for index, cell in enumerate(row) if index in (2, 3, 4) and index != column}
        assert set(answer.distractor_values) & others, item.id
        if column in (2, 3):
            assert row[5 - column] in answer.distractor_values, f"{item.id}: the other value column of the row"
        assert all(row[index] not in item.question for index in (2, 3, 4)), f"{item.id}: the question gives a value away"
        question = item.question.casefold()
        assert row[0].casefold() in question and row[1].casefold() in question, f"{item.id}: the question names the row by its keys"


def test_zh_and_it_table_items_are_llm_drafted_pending_review_and_en_items_have_no_review():
    for item in _table_items():
        if item.language == "en":
            assert item.native_review is None, item.id
        else:
            assert item.native_review is not None, item.id
            assert item.native_review.origin == "llm_drafted", item.id
            assert item.native_review.status == "pending", item.id
            assert item.native_review.reviewer is None and item.native_review.reviewed_at is None, item.id


def test_table_answer_value_and_distractors_never_contain_each_other():
    from rag_eval.matching import normalize_text

    for item in _table_items():
        value = normalize_text(item.table_answer.value)
        for distractor in item.table_answer.distractor_values:
            other = normalize_text(distractor)
            assert value not in other and other not in value, f"{item.id}: {distractor!r}"
