import hashlib
import importlib.util
import os
import re
import sys
from pathlib import Path

import pytest

from rag_eval.paths import REPO_ROOT
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
    import json

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


def test_digital_pdfs_are_written_for_every_digital_fixture(tmp_path):
    written = generate.generate(tmp_path / "pdf", tmp_path / "text", cjk_font=None)
    assert set(written) == DIGITAL_IDS
    for spec_id in DIGITAL_IDS:
        data = (tmp_path / "pdf" / f"{spec_id}.pdf").read_bytes()
        assert data.startswith(b"%PDF-")
        assert _text_operator_count(data) > 0, spec_id


def test_regenerating_the_digital_pdfs_gives_identical_bytes(tmp_path):
    first = generate.generate(tmp_path / "a" / "pdf", tmp_path / "a" / "text", cjk_font=None)
    second = generate.generate(tmp_path / "b" / "pdf", tmp_path / "b" / "text", cjk_font=None)
    assert first == second and len(first) == len(DIGITAL_IDS)
    for spec_id in DIGITAL_IDS:
        left = (tmp_path / "a" / "pdf" / f"{spec_id}.pdf").read_bytes()
        right = (tmp_path / "b" / "pdf" / f"{spec_id}.pdf").read_bytes()
        assert _sha256(left) == _sha256(right), spec_id


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


def test_scans_regenerate_byte_for_byte_when_the_recorded_font_is_present(tmp_path):
    font = _recorded_font()
    if font is None:
        pytest.skip("notice: the CJK font recorded in pdf/build-info.json is not on this machine, scan bytes not compared")
    import json

    info = json.loads((PDF_DIR / "build-info.json").read_text(encoding="utf-8"))
    written = generate.generate(tmp_path / "pdf", tmp_path / "text", cjk_font=font, font_index=info["scan_font"]["index"])
    assert SCANNED_IDS <= set(written)
    for spec_id in SCANNED_IDS:
        fresh = (tmp_path / "pdf" / f"{spec_id}.pdf").read_bytes()
        assert _text_operator_count(fresh) == 0, spec_id
        assert _sha256(fresh) == _sha256(_read(PDF_DIR / f"{spec_id}.pdf")), spec_id


def test_build_info_records_the_scan_font_hash():
    import json

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


def test_the_generator_writes_the_markdown_next_to_the_pdfs(tmp_path):
    generate.generate(tmp_path / "pdf", tmp_path / "text", cjk_font=None)
    assert {path.stem for path in (tmp_path / "text").glob("*.md")} == TEXT_IDS
