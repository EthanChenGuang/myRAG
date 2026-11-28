"""Real Docling on the generated ingestion fixture PDFs; run by the nightly job (pytest -m real_docling).

The PDFs come from eval/fixtures/ingest/generate_pdfs.py (RAG_FIXTURE_PDF_DIR, default the committed ones;
the nightly job regenerates the scans with the runner's CJK font). Real conversions are compared with the
expected facts in manifest.json and with the recorded ParseResults next to it. The module is skipped
unless the docling extra is installed and RAG_SIDECAR_DOCLING_ARTIFACTS points to the baked models.

Thresholds, from the first measured run (docling 2.150.1, RapidOCR PP-OCRv6 on onnxruntime):
- digital PDFs: every expected heading is recovered, the 40-row table keeps all 40 ids and every table
  chunk repeats its header row;
- scans, share of key phrases found after folding case, spacing and diacritics: zh 4/4, en 4/4 and it 4/5
  were read; the Italian first paragraph came back partly garbled, so the floors are 0.75 (zh, en) and 0.6 (it);
- RAG_REAL_DOCLING_REPORT, when set, receives the per-fixture measurements as JSON, including the strict
  (diacritics kept) phrase hit rate that the floors do not enforce.
"""

import importlib.util
import json
import os
import re
import unicodedata
from pathlib import Path

import pytest

pytestmark = pytest.mark.real_docling

REPO_ROOT = Path(__file__).resolve().parents[2]
INGEST = REPO_ROOT / "eval" / "fixtures" / "ingest"
PROFILES = REPO_ROOT / "config" / "rag" / "processing-profiles.json"
PDF_DIR = Path(os.environ.get("RAG_FIXTURE_PDF_DIR") or INGEST / "pdf")
REPORT_PATH = os.environ.get("RAG_REAL_DOCLING_REPORT", "")
ARTIFACTS = os.environ.get("RAG_SIDECAR_DOCLING_ARTIFACTS", "")

if importlib.util.find_spec("docling") is None or not ARTIFACTS or not Path(ARTIFACTS).is_dir():
    pytest.skip(
        "real Docling run skipped: needs the docling extra and baked models in RAG_SIDECAR_DOCLING_ARTIFACTS",
        allow_module_level=True,
    )

from rag_sidecar.contracts import ParseJobRequest, ParseResult  # noqa: E402
from rag_sidecar.contracts.ingest import ProcessingProfileSet  # noqa: E402
from rag_sidecar.extract.invoice import extract_invoice  # noqa: E402
from rag_sidecar.parse.docling_adapter import DoclingConverter  # noqa: E402

SEPARATOR_ROW = re.compile(r"^\|[-: |]+\|$")
HEADING_RECALL_FLOOR = {"digital": 1.0, "scanned": 0.5}
OCR_PHRASE_FLOOR = {"zh": 0.75, "en": 0.75, "it": 0.6}
HEADER_CELL_FLOOR = 0.75
TABLE_ID_FLOOR = 0.95
MIN_PICTURE_AREA_SHARE = 0.02

MANIFEST = json.loads((INGEST / "manifest.json").read_text(encoding="utf-8"))
ENTRIES = {entry["id"]: entry for entry in MANIFEST["fixtures"]}
FIXTURE_IDS = sorted(ENTRIES)


def _fold(text: str) -> str:
    """Case, spacing, punctuation and diacritics folded away: what an OCR engine may legitimately change."""
    decomposed = unicodedata.normalize("NFD", unicodedata.normalize("NFKC", text).casefold())
    return "".join(char for char in decomposed if unicodedata.category(char)[0] in {"L", "N"})


def _strict(text: str) -> str:
    return re.sub(r"\s+", "", unicodedata.normalize("NFKC", text).casefold())


def _request(entry: dict) -> ParseJobRequest:
    profiles = ProcessingProfileSet.model_validate_json(PROFILES.read_text(encoding="utf-8"))
    profile = next(item for item in profiles.profiles if item.id == entry["profile_id"])
    return ParseJobRequest(
        profile_id=profile.id,
        profile_version=profile.version,
        docling=profile.parser.docling,
        ocr_languages=list(profile.parser.ocr_languages),
        max_tokens=profile.chunker.max_tokens,
        repeat_table_header=profile.chunker.repeat_table_header,
        input_format="pdf",
    )


def _recorded(entry: dict) -> ParseResult:
    return ParseResult.model_validate_json((INGEST / entry["recorded"]["parse_result"]).read_text(encoding="utf-8"))


def _header_row(text: str) -> list[str] | None:
    lines = text.splitlines()
    for index in range(1, len(lines)):
        if lines[index - 1].startswith("|") and SEPARATOR_ROW.match(lines[index]):
            return [cell.strip() for cell in lines[index - 1].strip("|").split("|")]
    return None


def _table_chunks(result: ParseResult):
    return [chunk for chunk in result.chunks if chunk.is_table]


def _hit_rate(phrases: list[str], text: str, normalize) -> float:
    haystack = normalize(text)
    return sum(1 for phrase in phrases if normalize(phrase) in haystack) / len(phrases)


@pytest.fixture(scope="module")
def conversions(tmp_path_factory):
    converter = DoclingConverter()
    results: dict[str, ParseResult] = {}
    for spec_id in FIXTURE_IDS:
        out_dir = tmp_path_factory.mktemp(spec_id)
        results[spec_id] = converter.convert(PDF_DIR / f"{spec_id}.pdf", _request(ENTRIES[spec_id]), out_dir)
    yield results
    if REPORT_PATH:
        Path(REPORT_PATH).write_text(json.dumps(_report(results), ensure_ascii=False, indent=2, sort_keys=True) + "\n", encoding="utf-8")


def _report(results: dict[str, ParseResult]) -> dict:
    report: dict[str, dict] = {}
    for spec_id, result in results.items():
        entry = ENTRIES[spec_id]
        facts = entry["expected"]
        row: dict = {
            "language_detected": result.language,
            "chunks": len(result.chunks),
            "table_chunks": len(_table_chunks(result)),
            "picture_pages": sorted(picture.page for picture in result.pictures),
            "text_layer_page_share": result.text_layer_page_share,
            "warnings": result.warnings,
        }
        if "ocr_phrases" in facts:
            row["ocr_phrase_hit_rate_strict"] = _hit_rate(facts["ocr_phrases"], result.markdown, _strict)
            row["ocr_phrase_hit_rate_folded"] = _hit_rate(facts["ocr_phrases"], result.markdown, _fold)
        if "invoice" in facts:
            fields = extract_invoice(result.markdown)
            row["invoice_extraction"] = {"confidence": fields.confidence, "errors": fields.errors, "invoice_number_found": fields.invoice_number == facts["invoice"]["invoice_number"]}
        report[spec_id] = row
    return {"fixtures": report, "pdf_dir": str(PDF_DIR.name)}


@pytest.mark.parametrize("spec_id", FIXTURE_IDS)
def test_real_docling_converts_the_fixture_with_the_expected_pages_and_text_layer(conversions, spec_id):
    result, entry = conversions[spec_id], ENTRIES[spec_id]
    assert result.parser == "docling"
    assert not result.partial
    assert result.page_count == entry["expected"]["page_count"]
    assert result.chunks
    assert result.text_layer_page_share == (0.0 if entry["text_layer"] == "scanned" else 1.0)


@pytest.mark.parametrize("spec_id", FIXTURE_IDS)
def test_real_docling_recovers_the_section_headings(conversions, spec_id):
    entry = ENTRIES[spec_id]
    headings = {_strict(heading) for chunk in conversions[spec_id].chunks for heading in chunk.headings}
    expected = [_strict(item["text"]) for item in entry["expected"]["headings"]]
    recall = sum(1 for heading in expected if heading in headings) / len(expected)
    assert recall >= HEADING_RECALL_FLOOR[entry["text_layer"]], (spec_id, sorted(headings))


def test_real_docling_keeps_the_clause_heading_path_and_the_whole_exception_list_together(conversions):
    clause = ENTRIES["contract-zh"]["expected"]["clause"]
    holders = [chunk for chunk in conversions["contract-zh"].chunks if clause["lead_in"] in chunk.text]
    assert len(holders) == 1
    assert holders[0].headings == clause["section_path"]
    flat = _strict(holders[0].text)
    assert all(_strict(item) in flat for item in clause["items"])


def test_real_docling_repeats_the_header_row_on_every_chunk_of_the_report_table(conversions):
    table = ENTRIES["report-zh-table"]["expected"]["table"]
    chunks = _table_chunks(conversions["report-zh-table"])
    assert len(chunks) >= 2
    ids: list[str] = []
    for chunk in chunks:
        lines = chunk.text.splitlines()
        assert lines[0].startswith("|") and SEPARATOR_ROW.match(lines[1]), "a table chunk does not start with its header and separator rows"
        assert _header_row(chunk.text) == _header_row(chunks[0].text)
        assert chunk.headings[-1] == table["section_path"][-1]
        ids += re.findall(r"EXP-\d{3}", chunk.text)
    header = _header_row(chunks[0].text) or []
    assert sum(1 for cell in table["header"] if _strict(cell) in {_strict(found) for found in header}) / len(table["header"]) >= HEADER_CELL_FLOOR
    wanted = {f"EXP-{index:03d}" for index in range(1, table["body_rows"] + 1)}
    assert len(wanted & set(ids)) / len(wanted) >= TABLE_ID_FLOOR


@pytest.mark.parametrize("spec_id", ["invoice-zh", "invoice-en", "invoice-it"])
def test_real_docling_reads_the_invoice_table_header_like_the_recording(conversions, spec_id):
    real = _header_row("\n".join(chunk.text for chunk in _table_chunks(conversions[spec_id])))
    recorded = _header_row("\n".join(chunk.text for chunk in _table_chunks(_recorded(ENTRIES[spec_id]))))
    assert real and recorded
    matched = sum(1 for cell in recorded if _strict(cell) in {_strict(found) for found in real})
    assert matched / len(recorded) >= HEADER_CELL_FLOOR


@pytest.mark.parametrize("spec_id", ["invoice-zh", "invoice-en", "invoice-it"])
def test_real_docling_keeps_the_invoice_identifiers_in_the_text(conversions, spec_id):
    invoice = ENTRIES[spec_id]["expected"]["invoice"]
    flat = _strict(conversions[spec_id].markdown)
    for needle in (invoice["invoice_number"], invoice["supplier"]["tax_id"], invoice["buyer"]["tax_id"]):
        assert _strict(needle) in flat, (spec_id, needle)


def test_real_docling_finds_the_pictures_on_pages_one_and_two(conversions):
    recorded = _recorded(ENTRIES["images-en"])
    real = conversions["images-en"]
    assert sorted(picture.page for picture in real.pictures) == sorted(picture.page for picture in recorded.pictures) == [1, 2]
    assert all(picture.page_area_share >= MIN_PICTURE_AREA_SHARE for picture in real.pictures)


@pytest.mark.parametrize("spec_id", ["scan-zh", "scan-en", "scan-it"])
def test_real_docling_ocr_reads_the_key_phrases_of_the_scans(conversions, spec_id):
    entry = ENTRIES[spec_id]
    rate = _hit_rate(entry["expected"]["ocr_phrases"], conversions[spec_id].markdown, _fold)
    assert rate >= OCR_PHRASE_FLOOR[entry["language"]], (spec_id, rate)


@pytest.mark.parametrize("spec_id", ["injection-zh", "injection-en", "injection-it"])
def test_real_docling_keeps_the_injection_phrase_once(conversions, spec_id):
    phrase = ENTRIES[spec_id]["expected"]["injection"]["phrase"]
    assert _strict(conversions[spec_id].markdown).count(_strict(phrase)) == 1


# scan_zh_it (03.2-25, D-18): real OCR on the character-exact zh/it parse fixture, with the registry OCR codes the app sends
# for RAG_SUPPORTED_LANGUAGES=zh,it. CI only checks the recordings (eval/tests/test_parse_fixtures.py); this is the nightly check.
# The encoding properties are hard assertions; the text similarity floor is provisional until the first measured nightly run.
PARSE = REPO_ROOT / "eval" / "fixtures" / "parse"
SCAN_ZH_IT_SIMILARITY_FLOOR = 0.9
_COMBINING_AFTER_LETTER = re.compile(r"[A-Za-z][̀-ͯ]")
_HALF_WIDTH_AFTER_HAN = re.compile(r"[一-鿿][.,;:]")


def _blocks(markdown: str) -> str:
    lines = [re.sub(r"^#+\s+", "", line.strip()) for line in markdown.splitlines()]
    return "\n".join(line for line in lines if line) + "\n"


def test_real_docling_reads_the_zh_it_scan_without_decomposed_accents_or_half_width_punctuation(tmp_path):
    import difflib

    expected = (PARSE / "expected" / "scan-zh-it.txt").read_text(encoding="utf-8")
    profiles = ProcessingProfileSet.model_validate_json(PROFILES.read_text(encoding="utf-8"))
    profile = next(item for item in profiles.profiles if item.doc_type == "scanned_image")
    request = ParseJobRequest(
        profile_id=profile.id,
        profile_version=profile.version,
        docling=profile.parser.docling,
        ocr_languages=["zh", "it"],
        max_tokens=profile.chunker.max_tokens,
        repeat_table_header=profile.chunker.repeat_table_header,
        input_format="pdf",
    )
    result = DoclingConverter().convert(PARSE / "pdf" / "scan-zh-it.pdf", request, tmp_path)
    assert not _COMBINING_AFTER_LETTER.search(result.markdown), "an accented vowel came back as a base letter and a combining mark"
    assert not _HALF_WIDTH_AFTER_HAN.search(result.markdown), "Chinese punctuation came back in half-width form"
    actual = _blocks(unicodedata.normalize("NFC", result.markdown))
    ratio = difflib.SequenceMatcher(None, re.sub(r"\s+", "", actual), re.sub(r"\s+", "", expected)).ratio()
    if REPORT_PATH:
        report = Path(REPORT_PATH).with_name("real-docling-scan-zh-it.json")
        report.write_text(json.dumps({"exact": actual == expected, "similarity": ratio, "text": actual}, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    assert ratio >= SCAN_ZH_IT_SIMILARITY_FLOOR, (ratio, actual)
