import hashlib
import importlib.util
import json
import os
import re
import sys
from pathlib import Path

import pytest

from rag_eval.paths import REPO_ROOT
from rag_sidecar.contracts import ParseResult
from rag_sidecar.extract.invoice import extract_invoice
from test_fixture_pii import phone_violations

INGEST = REPO_ROOT / "eval/fixtures/ingest"
PDF_DIR = INGEST / "pdf"
TEXT_DIR = INGEST / "text"
FONT_CANDIDATES = (
    "/usr/share/fonts/truetype/wqy/wqy-zenhei.ttc",
    "/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc",
)
DIGITAL_IDS = {
    "report-zh-table",
    "invoice-zh",
    "invoice-en",
    "invoice-it",
    "images-en",
    "contract-zh",
    "injection-zh",
    "injection-en",
    "injection-it",
}
SCANNED_IDS = {"scan-zh", "scan-en", "scan-it"}
TEXT_IDS = {"contract-zh", "injection-zh", "injection-en", "injection-it"}


def _load(name: str):
    spec = importlib.util.spec_from_file_location(f"ingest_fixture_{name}", INGEST / f"{name}.py")
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


specs = _load("specs")
generate = _load("generate_pdfs")
requires_reportlab = pytest.mark.skipif(
    importlib.util.find_spec("reportlab") is None or importlib.util.find_spec("PIL") is None,
    reason="notice: the eval fixtures extra (reportlab, Pillow) is not installed, generator tests skipped",
)


def _sha256(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def _read(path: Path) -> bytes:
    assert path.is_file(), f"{path.relative_to(REPO_ROOT)} is missing"
    return path.read_bytes()


def _text_operator_count(pdf: bytes) -> int:
    """Counts text-showing blocks in page content streams, skipping image objects; streams are uncompressed."""
    total = 0
    for match in re.finditer(rb"\d+ 0 obj(.*?)endobj", pdf, re.DOTALL):
        body = match.group(1)
        if b"/Subtype /Image" in body or b"/DCTDecode" in body:
            continue
        total += len(re.findall(rb"(?m)^BT\b", body))
    return total


def _recorded_font() -> Path | None:
    """A font whose sha256 equals the one the committed scans were rendered with, if this machine has it."""
    build_info = PDF_DIR / "build-info.json"
    if not build_info.exists():
        return None
    wanted = json.loads(build_info.read_text(encoding="utf-8"))["scan_font"]["sha256"]
    candidates = [os.environ.get("RAG_FIXTURE_CJK_FONT", ""), *FONT_CANDIDATES]
    for candidate in candidates:
        path = Path(candidate) if candidate else None
        if path is not None and path.is_file() and _sha256(path.read_bytes()) == wanted:
            return path
    return None


def test_specs_define_every_typed_fixture_once():
    ids = [spec.id for spec in specs.all_specs()]
    assert len(ids) == len(set(ids)) == 12
    assert set(ids) == DIGITAL_IDS | SCANNED_IDS
    by_id = {spec.id: spec for spec in specs.all_specs()}
    for spec_id in SCANNED_IDS:
        assert by_id[spec_id].layer == "scanned"
        assert by_id[spec_id].doc_type == "scanned_image"
    assert {by_id[i].language for i in ("scan-zh", "scan-en", "scan-it")} == {"zh", "en", "it"}
    assert {by_id[i].language for i in ("invoice-zh", "invoice-en", "invoice-it")} == {"zh", "en", "it"}
    assert {by_id[i].language for i in ("injection-zh", "injection-en", "injection-it")} == {"zh", "en", "it"}
    assert all(by_id[i].doc_type == "invoice_receipt" for i in ("invoice-zh", "invoice-en", "invoice-it"))


def test_specs_carry_the_planned_content():
    by_id = {spec.id: spec for spec in specs.all_specs()}
    tables = [block for block in by_id["report-zh-table"].blocks if isinstance(block, specs.Table)]
    assert len(tables) == 1 and len(tables[0].rows) == specs.TABLE_BODY_ROWS + 1 == 41
    pictures = [block for block in by_id["images-en"].blocks if isinstance(block, specs.Picture)]
    assert [picture.page for picture in pictures] == [1, 2]
    contract = by_id["contract-zh"]
    texts = [block.text for block in contract.blocks if isinstance(block, specs.Paragraph)]
    assert any(text.endswith("但以下情况除外：") for text in texts)
    assert sum(isinstance(block, specs.ListItem) for block in contract.blocks) == 4
    for spec_id in ("injection-zh", "injection-en", "injection-it"):
        phrase = by_id[spec_id].facts["injection"]["phrase"]
        joined = "\n".join(block.text for block in by_id[spec_id].blocks if isinstance(block, specs.Paragraph))
        assert joined.count(phrase) == 1
        assert len([block for block in by_id[spec_id].blocks if isinstance(block, specs.Paragraph)]) >= 2


def test_no_spec_text_matches_a_phone_pattern():
    for spec in specs.all_specs():
        text = specs.render_markdown(spec) + repr(spec.facts)
        assert phone_violations(text) == [], spec.id


def test_the_generator_runs_reportlab_in_invariant_mode():
    source = (INGEST / "generate_pdfs.py").read_text(encoding="utf-8")
    assert "invariant" in source


@requires_reportlab
def test_digital_pdfs_are_written_for_every_digital_fixture(tmp_path):
    written = generate.generate(tmp_path / "pdf", tmp_path / "text", cjk_font=None)
    assert set(written) == DIGITAL_IDS
    for spec_id in DIGITAL_IDS:
        data = (tmp_path / "pdf" / f"{spec_id}.pdf").read_bytes()
        assert data.startswith(b"%PDF-")
        assert _text_operator_count(data) > 0, spec_id


@requires_reportlab
def test_regenerating_the_digital_pdfs_gives_identical_bytes(tmp_path):
    first = generate.generate(tmp_path / "a" / "pdf", tmp_path / "a" / "text", cjk_font=None)
    second = generate.generate(tmp_path / "b" / "pdf", tmp_path / "b" / "text", cjk_font=None)
    assert first == second and len(first) == len(DIGITAL_IDS)
    for spec_id in DIGITAL_IDS:
        left = (tmp_path / "a" / "pdf" / f"{spec_id}.pdf").read_bytes()
        right = (tmp_path / "b" / "pdf" / f"{spec_id}.pdf").read_bytes()
        assert _sha256(left) == _sha256(right), spec_id


@requires_reportlab
def test_committed_digital_pdfs_equal_a_fresh_build(tmp_path):
    fresh = generate.generate(tmp_path / "pdf", tmp_path / "text", cjk_font=None)
    assert set(fresh) == DIGITAL_IDS
    for spec_id, digest in fresh.items():
        assert _sha256(_read(PDF_DIR / f"{spec_id}.pdf")) == digest, f"{spec_id}.pdf differs from the generator output"


def test_every_fixture_has_a_committed_pdf_and_digital_ones_have_a_text_layer():
    committed = {path.stem for path in PDF_DIR.glob("*.pdf")}
    assert committed == DIGITAL_IDS | SCANNED_IDS
    assert len(committed) >= 9
    for spec_id in DIGITAL_IDS:
        assert _text_operator_count(_read(PDF_DIR / f"{spec_id}.pdf")) > 0, spec_id


def test_committed_scans_are_image_only():
    for spec_id in SCANNED_IDS:
        data = _read(PDF_DIR / f"{spec_id}.pdf")
        assert data.startswith(b"%PDF-"), spec_id
        assert b"/DCTDecode" in data, spec_id
        assert _text_operator_count(data) == 0, spec_id


@requires_reportlab
def test_scans_regenerate_byte_for_byte_when_the_recorded_font_is_present(tmp_path):
    font = _recorded_font()
    if font is None:
        pytest.skip("notice: the CJK font recorded in pdf/build-info.json is not on this machine, scan bytes not compared")
    info = json.loads((PDF_DIR / "build-info.json").read_text(encoding="utf-8"))
    written = generate.generate(tmp_path / "pdf", tmp_path / "text", cjk_font=font, font_index=info["scan_font"]["index"])
    assert SCANNED_IDS <= set(written)
    for spec_id in SCANNED_IDS:
        fresh = (tmp_path / "pdf" / f"{spec_id}.pdf").read_bytes()
        assert _text_operator_count(fresh) == 0, spec_id
        assert _sha256(fresh) == _sha256(_read(PDF_DIR / f"{spec_id}.pdf")), spec_id


def test_build_info_records_the_scan_font_hash():
    info = json.loads(_read(PDF_DIR / "build-info.json"))
    assert re.fullmatch(r"[0-9a-f]{64}", info["scan_font"]["sha256"])
    assert info["scan_font"]["family"]
    assert {"reportlab", "pillow"} <= set(info["generator"])


def test_contract_and_injection_fixtures_are_also_written_as_markdown():
    committed = {path.stem for path in TEXT_DIR.glob("*.md")}
    assert committed == TEXT_IDS
    for spec_id in TEXT_IDS:
        expected = specs.render_markdown(specs.spec_by_id(spec_id))
        assert _read(TEXT_DIR / f"{spec_id}.md").decode("utf-8") == expected


@requires_reportlab
def test_the_generator_writes_the_markdown_next_to_the_pdfs(tmp_path):
    generate.generate(tmp_path / "pdf", tmp_path / "text", cjk_font=None)
    assert {path.stem for path in (tmp_path / "text").glob("*.md")} == TEXT_IDS


MANIFEST = INGEST / "manifest.json"
RECORDED = INGEST / "recorded"
SEPARATOR_ROW = re.compile(r"^\|[-: |]+\|$")
PROFILE_BY_TYPE = {
    "financial_report": "financial_report@1",
    "contract_legal": "contract_legal@1",
    "invoice_receipt": "invoice_receipt@1",
    "product_technical": "product_technical@1",
    "scanned_image": "scanned_image@1",
    "general": "general@1",
}


def _manifest() -> dict:
    return json.loads(_read(MANIFEST))


def _entry(spec_id: str) -> dict:
    entries = {entry["id"]: entry for entry in _manifest()["fixtures"]}
    assert spec_id in entries, f"{spec_id} is not in the manifest"
    return entries[spec_id]


def _result(spec_id: str) -> ParseResult:
    return ParseResult.model_validate_json(_read(INGEST / _entry(spec_id)["recorded"]["parse_result"]))


def _table_chunks(result: ParseResult):
    return [chunk for chunk in result.chunks if chunk.is_table]


def _normalized(text: str) -> str:
    return re.sub(r"\s+", "", text)


def test_the_manifest_registers_every_fixture_with_its_hash_type_and_recordings():
    manifest = _manifest()
    assert manifest["schema_version"] == 1
    assert len(manifest["fixtures"]) >= 12
    assert {entry["id"] for entry in manifest["fixtures"]} == DIGITAL_IDS | SCANNED_IDS
    for spec in specs.all_specs():
        entry = _entry(spec.id)
        assert entry["path"] == f"pdf/{spec.id}.pdf"
        assert entry["mime"] == "application/pdf"
        assert entry["language"] == spec.language
        assert entry["doc_type"] == spec.doc_type
        assert entry["profile_id"] == PROFILE_BY_TYPE[spec.doc_type]
        assert entry["text_layer"] == spec.layer
        assert entry["file_sha256"] == _sha256(_read(INGEST / entry["path"])), spec.id
        assert (INGEST / entry["recorded"]["parse_result"]).is_file()
        assert (INGEST / entry["recorded"]["docling"]).is_file()
        for name, relative in entry["recorded"]["artifacts"].items():
            assert (INGEST / relative).is_file(), f"{spec.id}: artifact {name}"


def test_manifest_hashes_are_unique_per_fixture():
    hashes = [entry["file_sha256"] for entry in _manifest()["fixtures"]]
    assert len(set(hashes)) == len(hashes)


def test_manifest_expected_facts_equal_the_specs():
    for spec in specs.all_specs():
        assert _entry(spec.id)["expected"] == json.loads(json.dumps(spec.facts)), spec.id


def test_manifest_records_the_scan_font_and_generator_versions():
    info = json.loads(_read(PDF_DIR / "build-info.json"))
    manifest = _manifest()
    assert manifest["scan_font"] == info["scan_font"]
    assert manifest["generator"] == info["generator"]


def test_manifest_lists_the_markdown_files_of_the_text_path_with_their_hashes():
    entries = {entry["id"]: entry for entry in _manifest()["fixtures"]}
    assert {spec_id for spec_id, entry in entries.items() if entry.get("text")} == TEXT_IDS
    for spec_id in TEXT_IDS:
        text = entries[spec_id]["text"]
        assert text["mime"] == "text/markdown"
        assert text["sha256"] == _sha256(_read(INGEST / text["path"]))


def test_every_recorded_parse_result_validates_against_the_contract():
    for spec in specs.all_specs():
        result = _result(spec.id)
        assert result.parser == "docling", spec.id
        assert result.page_count == spec.facts["page_count"], spec.id
        assert result.chunks, spec.id
        assert result.language == spec.language, spec.id
        assert result.text_layer_page_share == (0.0 if spec.layer == "scanned" else 1.0), spec.id


def _header_and_separator_index(lines: list[str]) -> int | None:
    for index in range(1, len(lines)):
        if lines[index - 1].startswith("|") and SEPARATOR_ROW.match(lines[index]):
            return index
    return None


def test_every_table_chunk_starts_with_its_header_and_separator_rows():
    pure = 0
    for spec in specs.all_specs():
        for chunk in _table_chunks(_result(spec.id)):
            lines = chunk.text.splitlines()
            separator = _header_and_separator_index(lines)
            assert separator is not None, f"{spec.id}: a table chunk without a header and separator row"
            if lines[0].startswith("|"):
                assert separator == 1, spec.id
                assert chunk.table_header == "\n".join(lines[:2]), spec.id
                pure += 1
    assert pure >= 3


def test_an_invoice_chunk_keeps_its_header_block_and_the_line_item_table_together():
    for spec_id in ("invoice-zh", "invoice-en", "invoice-it"):
        chunks = _table_chunks(_result(spec_id))
        assert len(chunks) == 1, spec_id
        lines = chunks[0].text.splitlines()
        assert not lines[0].startswith("|"), spec_id
        assert _header_and_separator_index(lines) is not None, spec_id
        assert specs.spec_by_id(spec_id).facts["invoice"]["invoice_number"] in chunks[0].text


def test_the_report_table_is_split_into_chunks_that_each_repeat_the_header():
    chunks = _table_chunks(_result("report-zh-table"))
    expected = specs.spec_by_id("report-zh-table").facts["table"]
    assert len(chunks) >= 2
    header_cells = [cell.strip() for cell in chunks[0].text.splitlines()[0].strip("|").split("|")]
    assert header_cells == expected["header"]
    body_rows: list[list[str]] = []
    for chunk in chunks:
        lines = chunk.text.splitlines()
        assert lines[0] == chunks[0].text.splitlines()[0]
        assert chunk.pages == [expected["page"]]
        assert chunk.headings == expected["section_path"]
        body_rows += [[cell.strip() for cell in line.strip("|").split("|")] for line in lines[2:] if line.startswith("|")]
    assert len(body_rows) == expected["body_rows"]
    assert [row[1] for row in body_rows] == [f"EXP-{index:03d}" for index in range(1, 41)]
    for probe in expected["probe_rows"]:
        assert probe in body_rows


def test_scans_record_the_ocr_text_with_no_text_layer():
    for spec_id in SCANNED_IDS:
        result = _result(spec_id)
        facts = specs.spec_by_id(spec_id).facts
        assert result.text_layer_page_share == 0.0
        flat = _normalized(result.markdown)
        for phrase in facts["ocr_phrases"]:
            assert _normalized(phrase) in flat, (spec_id, phrase)
        for heading in facts["headings"]:
            assert heading["text"] in result.markdown, (spec_id, heading["text"])


def test_recorded_headings_follow_the_specs():
    for spec in specs.all_specs():
        result = _result(spec.id)
        seen = {heading for chunk in result.chunks for heading in chunk.headings}
        for heading in spec.facts["headings"]:
            assert heading["text"] in seen, (spec.id, heading["text"])


def test_invoice_recordings_yield_the_expected_fields_through_the_extractor():
    for spec_id in ("invoice-zh", "invoice-en", "invoice-it"):
        expected = specs.spec_by_id(spec_id).facts["invoice"]
        fields = extract_invoice(_result(spec_id).markdown)
        assert fields.errors == [] and fields.confidence == 1.0, spec_id
        assert fields.invoice_number == expected["invoice_number"]
        assert fields.issue_date.isoformat() == expected["issue_date"]
        assert (fields.due_date.isoformat() if fields.due_date else None) == expected["due_date"]
        for role in ("supplier", "buyer"):
            party = getattr(fields, role)
            assert (party.name, party.tax_id, party.tax_id_scheme) == (
                expected[role]["name"],
                expected[role]["tax_id"],
                expected[role]["tax_id_scheme"],
            )
        assert fields.currency == expected["currency"]
        assert (fields.net_total, fields.tax_total, fields.gross_total) == (
            expected["net_total"],
            expected["tax_total"],
            expected["gross_total"],
        )
        assert len(fields.line_items) == expected["line_item_count"]


def test_the_images_fixture_lists_pictures_on_pages_one_and_two_with_artifact_names():
    result = _result("images-en")
    expected = specs.spec_by_id("images-en").facts["pictures"]
    assert [picture.page for picture in result.pictures] == [item["page"] for item in expected] == [1, 2]
    assert [picture.image_ref for picture in result.pictures] == [item["image_ref"] for item in expected]
    assert all(picture.page_area_share >= 0.02 for picture in result.pictures)
    artifacts = _entry("images-en")["recorded"]["artifacts"]
    assert set(artifacts) == {"docling.json", "picture-1.png", "picture-2.png"}
    assert set(result.artifacts) == set(artifacts)
    for name in ("picture-1.png", "picture-2.png"):
        assert _read(INGEST / artifacts[name]).startswith(b"\x89PNG\r\n\x1a\n")


def test_fixtures_without_pictures_record_none():
    for spec in specs.all_specs():
        if spec.id != "images-en":
            assert _result(spec.id).pictures == [], spec.id


def test_the_contract_recording_keeps_the_exception_lead_in_and_its_list_in_one_chunk():
    result = _result("contract-zh")
    clause = specs.spec_by_id("contract-zh").facts["clause"]
    holders = [chunk for chunk in result.chunks if clause["lead_in"] in chunk.text]
    assert len(holders) == 1
    chunk = holders[0]
    assert chunk.headings == clause["section_path"]
    position = chunk.text.index(clause["lead_in"])
    for item in clause["items"]:
        found = chunk.text.index(_marker_free(item), position) if _marker_free(item) in chunk.text else -1
        assert found >= position, item
        position = found


def _marker_free(item: str) -> str:
    return re.sub(r"^（[一二三四]）", "", item)


def test_injection_recordings_hold_the_phrase_once_inside_normal_text():
    for spec_id in ("injection-zh", "injection-en", "injection-it"):
        facts = specs.spec_by_id(spec_id).facts
        markdown = _result(spec_id).markdown
        assert markdown.count(facts["injection"]["phrase"]) == 1, spec_id
        assert facts["normal_fact"] in markdown, spec_id


def test_recorded_docling_json_is_valid_and_tagged_with_the_parser():
    for spec in specs.all_specs():
        entry = _entry(spec.id)
        payload = json.loads(_read(INGEST / entry["recorded"]["docling"]))
        assert payload["x_rag_sidecar"]["parser"] == "docling", spec.id
        assert payload["x_rag_sidecar"]["parser_version"].startswith("docling-"), spec.id
        assert payload["name"] == spec.id
        assert len(payload["pages"]) == spec.facts["page_count"]
        assert entry["recorded"]["artifacts"]["docling.json"] == entry["recorded"]["docling"]


def test_the_recorded_directory_holds_only_files_the_manifest_names():
    named = set()
    for entry in _manifest()["fixtures"]:
        named |= {Path(entry["recorded"]["parse_result"]).name, Path(entry["recorded"]["docling"]).name}
        named |= {Path(path).name for path in entry["recorded"]["artifacts"].values()}
    on_disk = {path.name for path in RECORDED.iterdir()} if RECORDED.is_dir() else set()
    assert on_disk == named and len(named) >= 24


LONG_TABLE_PLAIN = ["long-table-en"]
LONG_TABLE_CONTINUED: list[str] = []
LONG_TABLE_IDS = LONG_TABLE_PLAIN + LONG_TABLE_CONTINUED
LONG_TABLE_BODY_ROWS = 60
PROFILES = REPO_ROOT / "config/rag/processing-profiles.json"
OFF_SUBJECT_WORDS = (
    "hotel", "lodging", "travel", "trip", "per diem", "salary", "leave day", "vacation", "restaurant", "meal", "vpn", "password",
    "branch", "albergo", "trasferta", "viaggio", "stipendio", "ferie", "ristorante", "酒店", "住宿", "差旅", "出差", "工资", "薪资", "年假", "餐", "密码", "分行",
)


def _long_specs() -> dict:
    return {spec.id: spec for spec in getattr(specs, "long_table_specs", lambda: ())()}


def _long_spec(spec_id: str):
    found = _long_specs()
    assert spec_id in found, f"{spec_id} has no spec"
    return found[spec_id]


def _long_entry(spec_id: str) -> dict:
    entries = {entry["id"]: entry for entry in _manifest().get("long_table_fixtures", [])}
    assert spec_id in entries, f"{spec_id} is not in the manifest's long_table_fixtures"
    return entries[spec_id]


def _long_tables(spec) -> list:
    return [block for block in spec.blocks if isinstance(block, specs.Table)]


def _long_header_and_body(spec) -> tuple[tuple[str, ...], list[tuple[str, ...]]]:
    tables = _long_tables(spec)
    header = tables[0].rows[0]
    body = list(tables[0].rows[1:])
    for table in tables[1:]:
        body += list(table.rows if not table.header else table.rows[1:])
    return header, body


def _number(cell: str) -> float:
    assert re.fullmatch(r"\d+[.,]\d+", cell), cell
    return float(cell.replace(",", "."))


def _roles(spec) -> dict:
    return spec.facts["long_table"]


def _markdown_row(row) -> str:
    return "| " + " | ".join(row) + " |"


@pytest.mark.parametrize("spec_id", LONG_TABLE_IDS)
def test_long_tables_are_in_the_manifest_but_not_among_the_loaded_fixtures(spec_id):
    entry = _long_entry(spec_id)
    assert spec_id not in {item["id"] for item in _manifest()["fixtures"]}
    spec = _long_spec(spec_id)
    assert entry["language"] == spec.language and entry["doc_type"] == spec.doc_type
    assert entry["profile_id"] == PROFILE_BY_TYPE[spec.doc_type]
    assert entry["file_sha256"] == _sha256(_read(INGEST / entry["path"]))
    assert entry["expected"] == json.loads(json.dumps(spec.facts))
    assert entry["text"]["sha256"] == _sha256(_read(INGEST / entry["text"]["path"]))


@pytest.mark.parametrize("spec_id", LONG_TABLE_IDS)
def test_long_table_specs_declare_two_keys_two_values_and_one_category(spec_id):
    spec = _long_spec(spec_id)
    roles = _roles(spec)
    header, body = _long_header_and_body(spec)
    assert len(header) == 5 and list(header) == roles["header"]
    assert len(roles["key_columns"]) == 2 and len(roles["value_columns"]) == 2
    named = [*roles["key_columns"], *roles["value_columns"], roles["category_column"]]
    assert sorted(named) == sorted(header)
    assert len(body) == roles["body_rows"] == LONG_TABLE_BODY_ROWS
    keys = [tuple(row[header.index(name)] for name in roles["key_columns"]) for row in body]
    assert len(set(keys)) == LONG_TABLE_BODY_ROWS, "the two key columns must identify a row"
    for row in body:
        for name in roles["value_columns"]:
            _number(row[header.index(name)])
    categories = {row[header.index(roles["category_column"])] for row in body}
    assert 2 <= len(categories) <= 6
    assert not any(re.fullmatch(r"[\d.,]+", value) for value in categories)


@pytest.mark.parametrize("spec_id", LONG_TABLE_IDS)
def test_the_target_row_lies_late_and_its_values_are_unambiguous(spec_id):
    spec = _long_spec(spec_id)
    roles = _roles(spec)
    header, body = _long_header_and_body(spec)
    target = roles["target_row"]
    assert 30 <= target < LONG_TABLE_BODY_ROWS - 1
    assert roles["target_values"] == list(body[target])
    columns = [header.index(name) for name in roles["value_columns"]]
    values = [_number(body[target][column]) for column in columns]
    assert values[0] != values[1]
    neighbours = {_number(body[index][column]) for index in (target - 1, target + 1) for column in columns}
    assert not set(values) & neighbours


@pytest.mark.parametrize("spec_id", LONG_TABLE_IDS)
def test_the_target_row_lies_beyond_the_first_chunk_of_every_profile(spec_id, monkeypatch):
    monkeypatch.setenv("TIKTOKEN_CACHE_DIR", os.environ.get("TIKTOKEN_CACHE_DIR") or str(REPO_ROOT / ".cache" / "tiktoken"))
    tiktoken = pytest.importorskip("tiktoken")
    encoding = tiktoken.get_encoding("cl100k_base")
    largest = max(profile["chunker"]["max_tokens"] for profile in json.loads(_read(PROFILES))["profiles"])
    assert len(json.loads(_read(PROFILES))["profiles"]) == 6
    spec = _long_spec(spec_id)
    header, body = _long_header_and_body(spec)
    before = [_markdown_row(header), "| " + " | ".join("---" for _ in header) + " |"]
    before += [_markdown_row(row) for row in body[: _roles(spec)["target_row"]]]
    assert len(encoding.encode("\n".join(before))) > largest


@pytest.mark.parametrize("spec_id", LONG_TABLE_IDS)
def test_long_table_text_reuses_no_off_subject_wording(spec_id):
    text = (specs.render_markdown(_long_spec(spec_id)) + json.dumps(_long_spec(spec_id).facts, ensure_ascii=False)).lower()
    assert [word for word in OFF_SUBJECT_WORDS if word in text] == []
    assert phone_violations(text) == []


def test_each_language_has_its_own_subject():
    subjects = {}
    for spec_id in LONG_TABLE_PLAIN:
        spec = _long_spec(spec_id)
        subjects[spec.language] = _roles(spec)["subject"]
    assert len(set(subjects.values())) == len(subjects)


@requires_reportlab
def test_long_table_pdfs_regenerate_to_the_committed_bytes(tmp_path):
    written = generate.generate(tmp_path / "pdf", tmp_path / "text", cjk_font=None)
    for spec_id in LONG_TABLE_IDS:
        assert spec_id in written, spec_id
        assert _sha256(_read(PDF_DIR / f"{spec_id}.pdf")) == written[spec_id], f"{spec_id}.pdf differs from the generator output"
        assert _text_operator_count(_read(PDF_DIR / f"{spec_id}.pdf")) > 0
        assert (tmp_path / "text" / f"{spec_id}.md").read_text(encoding="utf-8") == _read(TEXT_DIR / f"{spec_id}.md").decode("utf-8")


@pytest.mark.parametrize("spec_id", LONG_TABLE_IDS)
def test_long_table_text_artifacts_equal_the_rendered_specs(spec_id):
    assert _read(TEXT_DIR / f"{spec_id}.md").decode("utf-8") == specs.render_markdown(_long_spec(spec_id))


@pytest.mark.parametrize("spec_id", LONG_TABLE_PLAIN)
def test_the_plain_long_table_is_recorded_as_one_table_of_61_rows_starting_with_its_header(spec_id):
    entry = _long_entry(spec_id)
    spec = _long_spec(spec_id)
    docling = json.loads(_read(INGEST / entry["recorded"]["docling"]))
    assert len(docling["tables"]) == 1
    table = docling["tables"][0]
    assert table["data"]["num_rows"] == LONG_TABLE_BODY_ROWS + 1
    assert sorted({prov["page_no"] for prov in table["prov"]}) == list(range(1, spec.page_count + 1))
    header_cells = [cell for cell in table["data"]["table_cells"] if cell["start_row_offset_idx"] == 0]
    assert all(cell["column_header"] for cell in header_cells)
    result = ParseResult.model_validate_json(_read(INGEST / entry["recorded"]["parse_result"]))
    assert result.page_count == spec.page_count == 2
    assert result.language == spec.language
    table_lines = [line for line in result.markdown.splitlines() if line.startswith("|")]
    assert _normalized(table_lines[0]) == _normalized(_markdown_row(_roles(spec)["header"]))
    assert SEPARATOR_ROW.match(table_lines[1])
    assert len(table_lines) == LONG_TABLE_BODY_ROWS + 2
