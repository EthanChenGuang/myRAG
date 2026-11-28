import importlib.util
import json
import os
import re
import sys
from enum import Enum
from pathlib import Path
from types import SimpleNamespace

import pytest

pytest.importorskip("docling_core.transforms.chunker.hybrid_chunker")
tiktoken = pytest.importorskip("tiktoken")

from docling_core.transforms.chunker.hybrid_chunker import HybridChunker  # noqa: E402
from docling_core.transforms.chunker.tokenizer.openai import OpenAITokenizer  # noqa: E402
from docling_core.types.doc import DoclingDocument  # noqa: E402
from docling_core.types.io import DocumentStream  # noqa: E402

from rag_sidecar.contracts import DoclingOptions, ParseJobRequest, ParseResult  # noqa: E402
from rag_sidecar.parse import docling_adapter, probe  # noqa: E402
from rag_sidecar.parse.converter import ConfigurationError, ConversionError, PageCapExceeded  # noqa: E402
from rag_sidecar.settings import SidecarSettings  # noqa: E402

FIXTURES = Path(__file__).parent / "fixtures" / "docling"
ARTIFACT_NAME = re.compile(r"[a-z0-9_.-]{1,64}")
SEPARATOR_ROW = re.compile(r"^\|[-: |]+\|$")


def _builder():
    spec = importlib.util.spec_from_file_location("build_docling_fixtures", FIXTURES / "build_fixtures.py")
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def _load(name: str) -> DoclingDocument:
    return DoclingDocument.load_from_json(FIXTURES / f"{name}.json")


def _request(**overrides) -> ParseJobRequest:
    values = {
        "profile_id": "general@1",
        "profile_version": 1,
        "docling": DoclingOptions(
            ocr=True,
            force_full_page_ocr=False,
            table_mode="accurate",
            heading_hierarchy=True,
            generate_picture_images=True,
        ),
        "ocr_languages": ["zh", "en", "it"],
        "max_tokens": 200,
        "repeat_table_header": True,
    }
    values.update(overrides)
    return ParseJobRequest(**values)


def _convert(name: str, tmp_path: Path, **overrides) -> ParseResult:
    return docling_adapter.to_parse_result(_load(name), _request(**overrides), tmp_path)


def _token_count(text: str) -> int:
    return len(tiktoken.get_encoding("cl100k_base").encode(text))


def test_committed_fixtures_equal_a_fresh_build():
    fresh = _builder().build_all()
    assert set(fresh) == {"table-report", "headings-zh", "pictures"}
    for name, payload in fresh.items():
        assert (FIXTURES / f"{name}.json").read_bytes() == payload, name


def test_every_table_chunk_starts_with_the_header_row_and_separator(tmp_path):
    result = _convert("table-report", tmp_path)
    tables = [chunk for chunk in result.chunks if chunk.is_table]
    assert len(tables) > 1
    for chunk in tables:
        lines = chunk.text.splitlines()
        assert lines[0].startswith("| Item") and "Quantity" in lines[0]
        assert SEPARATOR_ROW.match(lines[1])


def test_table_header_is_the_header_row_and_separator_of_each_table_chunk(tmp_path):
    result = _convert("table-report", tmp_path)
    tables = [chunk for chunk in result.chunks if chunk.is_table]
    assert len(tables) > 1
    for chunk in tables:
        assert chunk.table_header == "\n".join(chunk.text.splitlines()[:2])
    assert all(chunk.table_header is None for chunk in result.chunks if not chunk.is_table)


def test_a_disabled_header_repeat_leaves_later_table_chunks_without_a_header(tmp_path):
    result = _convert("table-report", tmp_path, repeat_table_header=False)
    tables = [chunk for chunk in result.chunks if chunk.is_table]
    assert len(tables) > 1
    assert "Quantity" in tables[0].text.splitlines()[0]
    assert all("Quantity" not in chunk.text.splitlines()[0] for chunk in tables[1:])


def test_every_contextualized_text_is_within_max_tokens_on_cl100k(tmp_path):
    for name in ("table-report", "headings-zh"):
        result = _convert(name, tmp_path, max_tokens=200)
        assert result.chunks
        for chunk in result.chunks:
            assert 0 < _token_count(chunk.contextualized_text) <= 200


def test_contextualized_text_carries_the_heading_path(tmp_path):
    result = _convert("table-report", tmp_path)
    tables = [chunk for chunk in result.chunks if chunk.is_table]
    assert tables
    for chunk in tables:
        assert chunk.contextualized_text.splitlines()[:3] == ["Quarterly stock report", "Line items", chunk.text.splitlines()[0]]


def test_chinese_headings_come_outermost_first_with_their_pages(tmp_path):
    result = _convert("headings-zh", tmp_path)
    by_headings = {tuple(chunk.headings): chunk for chunk in result.chunks}
    chapter = by_headings.get(("示例股份有限公司 2025 年度报告", "第三章 资产负债表"))
    clause = by_headings.get(("示例股份有限公司 2025 年度报告", "第三章 资产负债表", "第5条 流动资产"))
    assert chapter is not None and clause is not None
    assert chapter.pages == [1]
    assert clause.pages == [2]
    assert "第5条 流动资产" in clause.contextualized_text


def test_pictures_carry_page_bbox_share_and_an_artifact_name(tmp_path):
    result = _convert("pictures", tmp_path)
    assert [picture.page for picture in result.pictures] == [1, 2]
    first, second = result.pictures
    assert first.bbox == pytest.approx([100, 100, 300, 300])
    assert first.page_area_share == pytest.approx(200 * 200 / (600 * 800))
    assert second.bbox == pytest.approx([50, 100, 550, 500])
    assert second.page_area_share == pytest.approx(500 * 400 / (600 * 800))
    assert first.image_ref != second.image_ref
    for picture in result.pictures:
        assert ARTIFACT_NAME.fullmatch(picture.image_ref)
        assert picture.image_ref in result.artifacts
        assert (tmp_path / picture.image_ref).read_bytes().startswith(b"\x89PNG")


def test_the_docling_json_is_written_and_listed_as_an_artifact(tmp_path):
    result = _convert("pictures", tmp_path)
    assert "docling.json" in result.artifacts
    assert all(ARTIFACT_NAME.fullmatch(name) for name in result.artifacts)
    assert all((tmp_path / name).is_file() for name in result.artifacts)
    reloaded = DoclingDocument.load_from_json(tmp_path / "docling.json")
    assert [text.text for text in reloaded.texts] == [text.text for text in _load("pictures").texts]


def test_a_picture_without_image_data_is_skipped_with_a_warning(tmp_path):
    doc = _load("pictures")
    doc.pictures[0].image = None
    result = docling_adapter.to_parse_result(doc, _request(), tmp_path)
    assert [picture.page for picture in result.pictures] == [2]
    assert result.warnings == ["picture_image_unavailable"]


def test_parser_fields_page_count_and_markdown(tmp_path):
    result = _convert("table-report", tmp_path)
    assert result.parser == "docling"
    assert re.fullmatch(r"docling-\d+\.\d+\.\d+", result.parser_version)
    assert result.page_count == 2
    assert result.partial is False
    assert "Quarterly stock report" in result.markdown.splitlines()[0]
    assert "| Item 39" in result.markdown
    assert ParseResult.model_validate_json(result.model_dump_json()) == result


def test_language_is_the_majority_language_of_the_chunks(tmp_path):
    assert _convert("headings-zh", tmp_path).language == "zh"
    assert _convert("table-report", tmp_path).language == "en"


@pytest.mark.parametrize(
    ("text", "expected"),
    [
        ("The invoice must be paid within thirty days of the date of issue.", "en"),
        ("Il pagamento della fattura deve essere effettuato entro trenta giorni dalla data di emissione.", "it"),
        ("本合同自双方签字盖章之日起生效，有效期为三年。", "zh"),
        ("1234 5678 ---", None),
        ("", None),
    ],
)
def test_detect_language(text, expected):
    assert docling_adapter.detect_language(text) == expected


def test_the_chunker_is_configured_with_the_markdown_table_serializer():
    provider = docling_adapter.MarkdownTableProvider()
    serializer = provider.get_serializer(DoclingDocument(name="empty"))
    assert type(serializer.table_serializer).__name__ == "MarkdownTableSerializer"
    tokenizer = OpenAITokenizer(tokenizer=tiktoken.get_encoding("cl100k_base"), max_tokens=200)
    assert isinstance(HybridChunker(tokenizer=tokenizer, serializer_provider=provider), HybridChunker)


class _Status(str, Enum):
    SUCCESS = "success"
    PARTIAL_SUCCESS = "partial_success"
    FAILURE = "failure"


class _FakeDocumentConverter:
    def __init__(self, status, document, page_count=2):
        self.result = SimpleNamespace(status=status, document=document, input=SimpleNamespace(page_count=page_count))
        self.calls = []

    def convert(self, source, **kwargs):
        self.calls.append((source, kwargs))
        return self.result


def _pdf_bytes(page_texts):
    count = len(page_texts)
    kids = " ".join(f"{4 + 2 * index} 0 R" for index in range(count))
    bodies = [
        b"<< /Type /Catalog /Pages 2 0 R >>",
        f"<< /Type /Pages /Kids [{kids}] /Count {count} >>".encode(),
        b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    ]
    for index, text in enumerate(page_texts):
        content = f"BT /F1 18 Tf 72 700 Td ({text}) Tj ET".encode() if text else b""
        bodies.append(
            (
                "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] "
                f"/Resources << /Font << /F1 3 0 R >> >> /Contents {5 + 2 * index} 0 R >>"
            ).encode()
        )
        bodies.append(f"<< /Length {len(content)} >>\nstream\n".encode() + content + b"\nendstream")
    out = bytearray(b"%PDF-1.4\n")
    offsets = []
    for number, body in enumerate(bodies, start=1):
        offsets.append(len(out))
        out += f"{number} 0 obj\n".encode() + body + b"\nendobj\n"
    xref = len(out)
    out += f"xref\n0 {len(bodies) + 1}\n0000000000 65535 f \n".encode()
    for offset in offsets:
        out += f"{offset:010d} 00000 n \n".encode()
    out += f"trailer\n<< /Size {len(bodies) + 1} /Root 1 0 R >>\nstartxref\n{xref}\n%%EOF\n".encode()
    return bytes(out)


def _stage(tmp_path: Path, payload: bytes) -> tuple[Path, Path]:
    input_path = tmp_path / "input.bin"
    input_path.write_bytes(payload)
    out_dir = tmp_path / "out"
    out_dir.mkdir()
    return input_path, out_dir


def _converter_with(fake, **kwargs):
    return docling_adapter.DoclingConverter(converter_factory=lambda _request: fake, **kwargs)


def _scanned_request(**overrides) -> ParseJobRequest:
    docling = DoclingOptions(
        ocr=True, force_full_page_ocr=True, table_mode="fast", heading_hierarchy=True, generate_picture_images=True
    )
    return _request(docling=docling, **overrides)


def test_to_ppocr_code_gives_the_one_pp_ocr_code_for_the_profile_languages():
    assert docling_adapter.to_ppocr_code(["zh", "en", "it"]) == ["ch"]
    assert docling_adapter.to_ppocr_code(["en", "it"]) == ["en"]
    assert docling_adapter.to_ppocr_code(["it"]) == ["it"]


def test_to_ppocr_code_keeps_its_outputs_for_every_language_order():
    assert docling_adapter.to_ppocr_code(["zh"]) == ["ch"]
    assert docling_adapter.to_ppocr_code(["it", "zh"]) == ["it"]
    assert docling_adapter.to_ppocr_code(["zh", "it"]) == ["ch"]
    assert docling_adapter.to_ppocr_code(["de"]) == ["de"]


def test_to_ppocr_code_reads_the_rapidocr_code_from_the_registry(monkeypatch):
    from rag_sidecar.contracts.languages import LanguageRegistry

    raw = json.loads((Path(__file__).resolve().parents[2] / "config" / "rag" / "language-packs.json").read_text())
    next(pack for pack in raw["packs"] if pack["code"] == "zh")["ocr_codes"]["docling"]["rapidocr"] = "chinese_cht"
    registry = LanguageRegistry.model_validate(raw)
    monkeypatch.setattr(
        docling_adapter,
        "get_language_pack",
        lambda code: next((pack for pack in registry.packs if pack.code == code), None),
        raising=False,
    )
    assert docling_adapter.to_ppocr_code(["zh"]) == ["chinese_cht"]


def test_the_default_ocr_language_list_is_the_registry_code_list(monkeypatch, tmp_path):
    from rag_sidecar.contracts.languages import language_codes
    from rag_sidecar.parse import presets

    assert list(language_codes()) == ["zh", "en", "it"]
    seen: list[list[str]] = []
    monkeypatch.setattr(
        docling_adapter, "_preset_document_converter", lambda _preset, languages, **_kw: seen.append(languages)
    )
    monkeypatch.setattr(docling_adapter, "_conversion_document", lambda *_args, **_kw: None)
    docling_adapter.convert_range(tmp_path / "a.pdf", "fast", 1, 2)
    docling_adapter.convert_whole(tmp_path / "a.docx", "fast")
    assert seen == [["zh", "en", "it"], ["zh", "en", "it"]]
    assert presets.preset_option_dict("fast")["ocr_languages"] == ["ch"]


@pytest.mark.parametrize("languages", [["xx"], ["zh", "klingon"], []])
def test_to_ppocr_code_rejects_a_language_outside_the_pp_ocr_v6_set(languages):
    with pytest.raises(ConfigurationError) as raised:
        docling_adapter.to_ppocr_code(languages)
    assert raised.value.error_class == "configuration_error"


def test_the_pipeline_options_builder_validates_languages_before_building_anything():
    bad = _request().model_copy(update={"ocr_languages": ["xx"]})
    with pytest.raises(ConfigurationError):
        docling_adapter.DoclingConverter().pipeline_options(bad)


def test_the_supported_language_set_is_a_subset_of_the_installed_pp_ocr_v6_codes():
    rapidocr = pytest.importorskip("rapidocr")
    from rapidocr.main import list_supported_langs
    from rapidocr.utils.typings import TaskType

    installed = set(list_supported_langs(TaskType.REC, rapidocr.OCRVersion.PPOCRV6))
    assert docling_adapter.PP_OCR_V6_CODES
    assert docling_adapter.PP_OCR_V6_CODES <= installed
    assert {"ch", "en", "it"} <= docling_adapter.PP_OCR_V6_CODES


def test_scanned_requests_use_rapidocr_on_onnxruntime_with_full_page_ocr_and_the_baked_models():
    pipeline_options = pytest.importorskip("docling.datamodel.pipeline_options")
    converter = docling_adapter.DoclingConverter(settings=SidecarSettings(docling_artifacts="/opt/docling-models"))
    options = converter.pipeline_options(_scanned_request())
    assert isinstance(options.ocr_options, pipeline_options.RapidOcrOptions)
    assert options.ocr_options.backend == "onnxruntime"
    assert options.ocr_options.lang == ["ch"]
    assert options.ocr_options.mode == pipeline_options.OcrMode.FULL_PAGE
    assert options.do_ocr is True
    assert options.heading_hierarchy_options.enabled is True
    assert options.generate_picture_images is True
    assert options.document_timeout == 120
    assert str(options.artifacts_path) == "/opt/docling-models"


def test_unforced_requests_leave_the_ocr_mode_at_its_default_and_table_modes_map_one_to_one():
    pipeline_options = pytest.importorskip("docling.datamodel.pipeline_options")
    converter = docling_adapter.DoclingConverter(settings=SidecarSettings())

    def options_for(table_mode):
        docling = DoclingOptions(
            ocr=False,
            force_full_page_ocr=False,
            table_mode=table_mode,
            heading_hierarchy=False,
            generate_picture_images=False,
        )
        return converter.pipeline_options(_request(docling=docling))

    accurate = options_for("accurate")
    assert accurate.do_table_structure is True
    assert accurate.table_structure_options.mode == pipeline_options.TableFormerMode.ACCURATE
    assert accurate.ocr_options.mode != pipeline_options.OcrMode.FULL_PAGE
    assert accurate.do_ocr is False
    assert accurate.heading_hierarchy_options.enabled is False
    assert accurate.generate_picture_images is False
    assert accurate.artifacts_path is None
    fast = options_for("fast")
    assert fast.do_table_structure is True
    assert fast.table_structure_options.mode == pipeline_options.TableFormerMode.FAST
    assert options_for("off").do_table_structure is False


def test_image_requests_share_the_pdf_pipeline_options_so_ocr_runs_on_the_full_page():
    pytest.importorskip("docling.document_converter")
    from docling.datamodel.base_models import InputFormat

    converter = docling_adapter.DoclingConverter(settings=SidecarSettings())
    options = converter.pipeline_options(_scanned_request(input_format="image"))
    document_converter = docling_adapter.build_document_converter(options)
    by_format = document_converter.format_to_options
    assert by_format[InputFormat.IMAGE].pipeline_options is options
    assert by_format[InputFormat.PDF].pipeline_options is options


@pytest.mark.parametrize(
    ("head", "expected"),
    [
        (b"%PDF-1.7\n", "pdf"),
        (b"\x89PNG\r\n\x1a\n", "image"),
        (b"\xff\xd8\xff\xe0", "image"),
        (b"II*\x00", "image"),
        (b"RIFF\x00\x00\x00\x00WEBP", "image"),
        (b'{"schema_name": "DoclingDocument"}', "json_docling"),
        (b"PK\x03\x04", "docx"),
        (b"<!DOCTYPE html><html>", "html"),
        (b"  <html lang='it'>", "html"),
    ],
)
def test_the_input_format_is_sniffed_from_the_leading_bytes(head, expected):
    assert docling_adapter.sniff_input_format(head) == expected


def test_an_unrecognised_input_is_a_classified_failure():
    with pytest.raises(ConversionError) as raised:
        docling_adapter.sniff_input_format(b"\x00\x01\x02\x03 not a document")
    assert raised.value.error_class == "unsupported_input"


def test_a_pdf_is_converted_through_a_named_stream_with_the_page_cap_and_no_raise(tmp_path):
    fake = _FakeDocumentConverter(_Status.SUCCESS, _load("headings-zh"))
    input_path, out_dir = _stage(tmp_path, _pdf_bytes(["Quarterly stock report 2025", None]))
    result = _converter_with(fake).convert(input_path, _request(page_cap=50), out_dir)
    (source, kwargs), = fake.calls
    assert isinstance(source, DocumentStream)
    assert source.name == "input.pdf"
    assert kwargs == {"raises_on_error": False, "max_num_pages": 50}
    assert result.parser == "docling"
    assert result.chunks
    assert result.partial is False
    assert "docling.json" in result.artifacts
    assert (out_dir / "docling.json").is_file()


def test_an_explicit_input_format_wins_over_the_sniffed_one(tmp_path):
    fake = _FakeDocumentConverter(_Status.SUCCESS, _load("headings-zh"))
    input_path, out_dir = _stage(tmp_path, b"\x89PNG\r\n\x1a\n" + b"\x00" * 16)
    _converter_with(fake).convert(input_path, _scanned_request(input_format="image"), out_dir)
    assert fake.calls[0][0].name == "input.png"


def test_a_partial_conversion_is_reported_as_partial_with_a_warning(tmp_path):
    fake = _FakeDocumentConverter(_Status.PARTIAL_SUCCESS, _load("headings-zh"))
    input_path, out_dir = _stage(tmp_path, _pdf_bytes(["Quarterly stock report 2025"]))
    result = _converter_with(fake).convert(input_path, _request(), out_dir)
    assert result.partial is True
    assert "docling_partial_success" in result.warnings
    assert result.chunks


def test_a_failed_conversion_raises_a_classified_error_without_document_text(tmp_path):
    fake = _FakeDocumentConverter(_Status.FAILURE, _load("headings-zh"), page_count=1)
    input_path, out_dir = _stage(tmp_path, _pdf_bytes(["Quarterly stock report 2025"]))
    with pytest.raises(ConversionError) as raised:
        _converter_with(fake).convert(input_path, _request(page_cap=10), out_dir)
    assert raised.value.error_class == "conversion_failed"
    assert "Quarterly" not in str(raised.value)


def test_a_document_over_the_page_cap_fails_as_page_cap(tmp_path):
    fake = _FakeDocumentConverter(_Status.FAILURE, _load("headings-zh"), page_count=5)
    input_path, out_dir = _stage(tmp_path, _pdf_bytes(["Quarterly stock report 2025"]))
    with pytest.raises(PageCapExceeded):
        _converter_with(fake).convert(input_path, _request(page_cap=2), out_dir)


def _must_not_build(_request):
    raise AssertionError("no layout or OCR pipeline may be built for a json_docling input")


def test_a_stored_docling_json_is_rechunked_without_a_pipeline_and_keeps_its_parser_fields(tmp_path):
    source_dir = tmp_path / "stored"
    source_dir.mkdir()
    docling_adapter.write_docling_json(_load("table-report"), source_dir, "docling", "docling-9.9.9")
    out_dir = tmp_path / "out"
    out_dir.mkdir()
    converter = docling_adapter.DoclingConverter(converter_factory=_must_not_build)
    result = converter.convert(source_dir / "docling.json", _request(input_format="json_docling"), out_dir)
    assert result.parser == "docling"
    assert result.parser_version == "docling-9.9.9"
    assert len([chunk for chunk in result.chunks if chunk.is_table]) > 1
    assert result.text_layer_page_share is None
    assert json.loads((out_dir / "docling.json").read_text(encoding="utf-8"))["x_rag_sidecar"] == {
        "parser": "docling",
        "parser_version": "docling-9.9.9",
    }


def test_a_docling_json_without_stored_metadata_falls_back_to_the_current_parser_version(tmp_path):
    payload = _load("pictures").export_to_dict()
    input_path, out_dir = _stage(tmp_path, json.dumps(payload).encode())
    converter = docling_adapter.DoclingConverter(converter_factory=_must_not_build)
    result = converter.convert(input_path, _request(), out_dir)
    assert result.parser == "docling"
    assert result.parser_version == docling_adapter.parser_version()


def test_an_unreadable_docling_json_is_a_classified_failure(tmp_path):
    input_path, out_dir = _stage(tmp_path, b'{"not": "a docling document"}')
    converter = docling_adapter.DoclingConverter(converter_factory=_must_not_build)
    with pytest.raises(ConversionError) as raised:
        converter.convert(input_path, _request(input_format="json_docling"), out_dir)
    assert raised.value.error_class == "invalid_docling_json"


def test_the_text_layer_probe_counts_pages_with_text_and_ignores_the_rest(tmp_path):
    pytest.importorskip("pypdfium2")
    path = tmp_path / "two-pages.pdf"
    path.write_bytes(_pdf_bytes(["Quarterly stock report 2025", None]))
    assert probe.text_layer_page_share(path) == 0.5
    path.write_bytes(_pdf_bytes([None, None, None]))
    assert probe.text_layer_page_share(path) == 0.0
    path.write_bytes(_pdf_bytes(["Quarterly stock report 2025"] * 3))
    assert probe.text_layer_page_share(path) == 1.0


def test_the_text_layer_probe_skips_documents_over_the_page_cap_and_unreadable_files(tmp_path):
    pytest.importorskip("pypdfium2")
    path = tmp_path / "three-pages.pdf"
    path.write_bytes(_pdf_bytes(["Quarterly stock report 2025"] * 3))
    assert probe.text_layer_page_share(path, max_pages=2) is None
    path.write_bytes(b"not a pdf at all")
    assert probe.text_layer_page_share(path) is None


def test_the_text_layer_probe_is_none_when_pypdfium2_is_not_installed(tmp_path, monkeypatch):
    monkeypatch.setitem(sys.modules, "pypdfium2", None)
    path = tmp_path / "one-page.pdf"
    path.write_bytes(_pdf_bytes(["Quarterly stock report 2025"]))
    assert probe.text_layer_page_share(path) is None


def test_a_pdf_conversion_reports_the_text_layer_share_measured_before_conversion(tmp_path):
    pytest.importorskip("pypdfium2")
    fake = _FakeDocumentConverter(_Status.SUCCESS, _load("headings-zh"))
    input_path, out_dir = _stage(tmp_path, _pdf_bytes(["Quarterly stock report 2025", None]))
    result = _converter_with(fake).convert(input_path, _request(), out_dir)
    assert result.text_layer_page_share == 0.5


_ARTIFACTS_DIR = os.environ.get("RAG_SIDECAR_DOCLING_ARTIFACTS", "")
_REAL_READY = importlib.util.find_spec("docling") is not None and bool(_ARTIFACTS_DIR) and Path(_ARTIFACTS_DIR).is_dir()


def real_docling(test):
    reason = "real Docling run skipped: needs the docling extra and baked models in RAG_SIDECAR_DOCLING_ARTIFACTS"
    return pytest.mark.real_docling(pytest.mark.skipif(not _REAL_READY, reason=reason)(test))


@real_docling
def test_real_docling_converts_a_text_pdf(tmp_path):
    input_path, out_dir = _stage(tmp_path, _pdf_bytes(["Quarterly stock report 2025"]))
    result = docling_adapter.DoclingConverter().convert(input_path, _request(input_format="pdf"), out_dir)
    assert result.parser == "docling"
    assert result.page_count == 1
    assert "Quarterly stock report" in result.markdown
    assert result.text_layer_page_share == 1.0


@real_docling
def test_real_docling_converts_a_scanned_png_through_the_image_option(tmp_path):
    from PIL import Image, ImageDraw, ImageFont

    image = Image.new("RGB", (900, 300), "white")
    ImageDraw.Draw(image).text((40, 100), "Quarterly stock report", fill="black", font=ImageFont.load_default(size=48))
    input_path = tmp_path / "input.bin"
    image.save(input_path, format="PNG")
    out_dir = tmp_path / "out"
    out_dir.mkdir()
    result = docling_adapter.DoclingConverter().convert(input_path, _scanned_request(input_format="image"), out_dir)
    assert result.parser == "docling"
    assert result.page_count == 1
    assert result.text_layer_page_share is None


def test_table_header_is_found_when_the_table_starts_after_the_first_six_lines_of_the_chunk():
    lead = "\n".join(f"Invoice field {index}: value {index}" for index in range(8))
    text = f"{lead}\n| Description | Amount |\n| --- | --- |\n| Probe | 800.00 |"
    assert docling_adapter._table_header(text) == "| Description | Amount |\n| --- | --- |"


def test_table_header_still_reads_a_table_at_the_start_and_returns_none_without_one():
    assert docling_adapter._table_header("| a | b |\n| --- | --- |\n| 1 | 2 |") == "| a | b |\n| --- | --- |"
    assert docling_adapter._table_header("a\n\nb\n| not a table row\nc") is None


def test_table_header_of_a_chunk_with_two_tables_is_the_first_one():
    text = "x\n" * 9 + "| a | b |\n| --- | --- |\n| 1 | 2 |\ny\n| c | d |\n| --- | --- |"
    assert docling_adapter._table_header(text) == "| a | b |\n| --- | --- |"


# Phase 3.2 plan 23 (D-15, D-55): language-aware segment() override on the Docling path.

_ZH_ENDS = "。！？"
_ZH_NUMBERS = "一二三四五六七八九十"
_ZH_PARAGRAPH = "".join(
    f"第{_ZH_NUMBERS[index % 10]}个部分说明了这个系统怎样读取输入的数据并且按照顺序给出清楚的结果{_ZH_ENDS[index % 3]}"
    for index in range(18)
)
_EN_PARAGRAPH = " ".join(
    f"Part {index} explains how the system reads its input data; it then returns a clear result in order."
    for index in range(14)
)


def _language_request(**overrides) -> ParseJobRequest:
    values = {
        "docling": DoclingOptions(
            ocr=False,
            force_full_page_ocr=False,
            table_mode="off",
            heading_hierarchy=False,
            generate_picture_images=False,
        ),
        "ocr_languages": ["zh"],
        "max_tokens": 64,
    }
    values.update(overrides)
    return _request(**values)


_LANGUAGE_AWARE = {"language_aware": True, "languages": ["zh", "en"], "primary_language": "zh"}


def _paragraph_document(*paragraphs: str, heading: str | None = None) -> DoclingDocument:
    from docling_core.types.doc import DocItemLabel

    doc = DoclingDocument(name="paragraphs")
    if heading is not None:
        doc.add_heading(text=heading, level=1)
    for paragraph in paragraphs:
        doc.add_text(label=DocItemLabel.TEXT, text=paragraph)
    return doc


def _trunk_chunks(doc: DoclingDocument, request: ParseJobRequest) -> list[str]:
    tokenizer = OpenAITokenizer(tokenizer=tiktoken.get_encoding("cl100k_base"), max_tokens=request.max_tokens)
    chunker = HybridChunker(
        tokenizer=tokenizer,
        repeat_table_header=request.repeat_table_header,
        serializer_provider=docling_adapter.MarkdownTableProvider(),
    )
    return [chunk.text for chunk in chunker.chunk(dl_doc=doc) if chunk.text.strip()]


def test_a_language_aware_request_cuts_an_over_long_chinese_paragraph_only_at_sentence_ends(tmp_path):
    assert _token_count(_ZH_PARAGRAPH) > 4 * 64
    request = _language_request(**_LANGUAGE_AWARE)
    result = docling_adapter.to_parse_result(_paragraph_document(_ZH_PARAGRAPH), request, tmp_path)
    texts = [chunk.text for chunk in result.chunks]
    assert len(texts) > 1
    for text in texts[:-1]:
        assert text[-1] in _ZH_ENDS, text
    for chunk in result.chunks:
        assert _token_count(chunk.text) <= 64
        assert _token_count(chunk.contextualized_text) <= 64
    assert "".join(texts) == _ZH_PARAGRAPH


def test_the_language_aware_chunker_is_chosen_only_for_a_language_aware_request():
    from rag_sidecar.parse.language_chunker import LanguageAwareHybridChunker

    plain = docling_adapter.build_chunker(_language_request())
    aware = docling_adapter.build_chunker(_language_request(**_LANGUAGE_AWARE))
    assert type(plain) is HybridChunker
    assert isinstance(aware, LanguageAwareHybridChunker)
    assert aware.languages == ["zh", "en"] and aware.primary_language == "zh"


def test_a_request_without_language_aware_gives_exactly_the_trunk_chunks(tmp_path):
    doc = _paragraph_document(_ZH_PARAGRAPH, _EN_PARAGRAPH, heading="说明")
    request = _language_request()
    result = docling_adapter.to_parse_result(doc, request, tmp_path)
    assert [chunk.text for chunk in result.chunks] == _trunk_chunks(doc, request)


def test_language_aware_chunks_keep_source_order_under_a_heading(tmp_path):
    doc = _paragraph_document(_ZH_PARAGRAPH, _EN_PARAGRAPH, heading="说明")
    result = docling_adapter.to_parse_result(doc, _language_request(**_LANGUAGE_AWARE), tmp_path)
    texts = [chunk.text for chunk in result.chunks]
    zh = [text for text in texts if "部分" in text]
    en = [text for text in texts if "Part" in text]
    assert len(zh) + len(en) == len(texts)
    assert texts == zh + en
    assert "".join(zh) == _ZH_PARAGRAPH
    for text in en[:-1]:
        assert text.endswith("."), text
    assert " ".join(en) == _EN_PARAGRAPH
    for chunk in result.chunks:
        assert chunk.headings == ["说明"]
        assert _token_count(chunk.contextualized_text) <= 64


def test_an_english_paragraph_is_never_cut_at_a_semicolon(tmp_path):
    result = docling_adapter.to_parse_result(
        _paragraph_document(_EN_PARAGRAPH), _language_request(**_LANGUAGE_AWARE), tmp_path
    )
    texts = [chunk.text for chunk in result.chunks]
    assert len(texts) > 1
    for text in texts[:-1]:
        assert text.endswith("."), text
        assert not text.endswith(";")


def test_a_single_over_long_sentence_is_hard_split_within_the_budget(tmp_path):
    sentence = "这个句子没有结束的标点并且一直在重复同样的内容" * 12 + "。"
    result = docling_adapter.to_parse_result(
        _paragraph_document(sentence), _language_request(**_LANGUAGE_AWARE), tmp_path
    )
    texts = [chunk.text for chunk in result.chunks]
    assert len(texts) > 1
    assert "".join(texts) == sentence
    for chunk in result.chunks:
        assert _token_count(chunk.contextualized_text) <= 64


def test_a_language_aware_request_without_a_primary_language_keeps_the_trunk_chunks(tmp_path):
    doc = _paragraph_document(_ZH_PARAGRAPH)
    request = _language_request(language_aware=True)
    result = docling_adapter.to_parse_result(doc, request, tmp_path)
    assert [chunk.text for chunk in result.chunks] == _trunk_chunks(doc, request)


def test_table_chunks_go_through_the_parent_table_branch_with_their_header(tmp_path):
    doc = _load("table-report")
    (tmp_path / "plain").mkdir()
    (tmp_path / "aware").mkdir()
    plain = _convert("table-report", tmp_path / "plain")
    aware = docling_adapter.to_parse_result(doc, _request(**_LANGUAGE_AWARE), tmp_path / "aware")
    plain_tables = [(chunk.text, chunk.table_header) for chunk in plain.chunks if chunk.is_table]
    aware_tables = [(chunk.text, chunk.table_header) for chunk in aware.chunks if chunk.is_table]
    assert len(aware_tables) > 1
    assert aware_tables == plain_tables
    for text, header in aware_tables:
        assert header is not None and text.find(header) >= 0
