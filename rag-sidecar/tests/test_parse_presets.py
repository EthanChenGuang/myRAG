"""Preset Docling options and page-range conversion (03.1-23)."""

from __future__ import annotations

import importlib.util
import json
import zipfile
from io import BytesIO
from pathlib import Path

import pytest

pytest.importorskip("docling_core.transforms.chunker.hybrid_chunker")

from docling_core.types.doc import DoclingDocument, Size  # noqa: E402

from rag_sidecar.parse.converter import ConfigurationError  # noqa: E402
from rag_sidecar.preflight.config import load_routing_config  # noqa: E402

REPO_ROOT = Path(__file__).resolve().parents[2]
DOC_ADAPT = Path(__file__).parent / "test_docling_adapter.py"


def _pdf_bytes(page_texts: list[str | None]) -> bytes:
    spec = importlib.util.spec_from_file_location("tda_pdf", DOC_ADAPT)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module._pdf_bytes(page_texts)


def _presets():
    from rag_sidecar.parse import presets

    return presets


@pytest.fixture
def presets_mod():
    return _presets()


def test_preset_option_dict_maps_routing_presets_without_docling(presets_mod):
    cfg = load_routing_config()
    fast = presets_mod.preset_option_dict("fast", cfg, ocr_languages=["zh", "en", "it"])
    assert fast["pdf_backend"] == "pypdfium2"
    assert fast["do_ocr"] is False
    assert fast["do_table_structure"] is False
    assert fast["table_mode"] == "off"

    layout = presets_mod.preset_option_dict("structured_layout", cfg, ocr_languages=["en"])
    assert layout["pdf_backend"] == "docling_parse"
    assert layout["do_ocr"] is False
    assert layout["do_table_structure"] is False
    assert layout["ocr_mode"] == "default"

    full = presets_mod.preset_option_dict("structured_full", cfg, ocr_languages=["en"])
    assert full["pdf_backend"] == "docling_parse"
    assert full["do_table_structure"] is True
    assert full["table_mode"] == "accurate"
    assert full["ocr_mode"] == "default"

    ocr = presets_mod.preset_option_dict("structured_ocr", cfg, ocr_languages=["zh", "en", "it"])
    assert ocr["do_ocr"] is True
    assert ocr["ocr_mode"] == "full_page"
    assert ocr["do_table_structure"] is True


@pytest.mark.parametrize("languages", [["xx"], [], ["klingon"]])
def test_preset_option_dict_rejects_unsupported_ocr_languages(presets_mod, languages):
    cfg = load_routing_config()
    with pytest.raises(ConfigurationError):
        presets_mod.preset_option_dict("fast", cfg, ocr_languages=languages)


def test_pipeline_options_match_truths_when_docling_is_installed(presets_mod):
    if importlib.util.find_spec("docling") is None:
        pytest.skip("docling extra not installed; pure preset table test covers CI")
    pipeline_options = pytest.importorskip("docling.datamodel.pipeline_options")
    from docling.backend.pypdfium2_backend import PyPdfiumDocumentBackend
    from docling.datamodel.base_models import InputFormat
    from docling.pipeline.standard_pdf_pipeline import StandardPdfPipeline

    cfg = load_routing_config()
    opts = presets_mod.pipeline_options("fast", ["en"], cfg, document_timeout_seconds=90.0)
    assert isinstance(opts, pipeline_options.PdfPipelineOptions)
    assert opts.do_ocr is False
    assert opts.do_table_structure is False
    assert opts.document_timeout == 90.0
    converter = presets_mod.build_preset_document_converter("fast", opts)
    pdf_fmt = converter.format_to_options[InputFormat.PDF]
    assert pdf_fmt.backend is PyPdfiumDocumentBackend
    assert pdf_fmt.pipeline_cls is StandardPdfPipeline

    layout_opts = presets_mod.pipeline_options("structured_layout", ["en"], cfg)
    assert layout_opts.do_ocr is False
    assert layout_opts.do_table_structure is False

    full_opts = presets_mod.pipeline_options("structured_full", ["en"], cfg)
    assert full_opts.do_table_structure is True
    assert full_opts.table_structure_options.mode == pipeline_options.TableFormerMode.ACCURATE
    assert full_opts.ocr_options.mode == pipeline_options.OcrMode.DEFAULT

    ocr_opts = presets_mod.pipeline_options("structured_ocr", ["zh", "en", "it"], cfg)
    assert ocr_opts.do_ocr is True
    assert ocr_opts.ocr_options.mode == pipeline_options.OcrMode.FULL_PAGE
    assert ocr_opts.ocr_options.lang == ["ch"]


def test_convert_range_is_defined_on_the_adapter():
    from rag_sidecar.parse import docling_adapter

    assert callable(getattr(docling_adapter, "convert_range", None))
    assert callable(getattr(docling_adapter, "convert_whole", None))


def _minimal_docx_bytes() -> bytes:
    document_xml = (
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">'
        "<w:body><w:p><w:r><w:t>Quarterly stock report</w:t></w:r></w:p></w:body></w:document>"
    )
    content_types = (
        '<?xml version="1.0" encoding="UTF-8"?>'
        '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
        '<Default Extension="xml" ContentType="application/xml"/>'
        '<Override PartName="/word/document.xml" '
        'ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>'
        "</Types>"
    )
    buffer = BytesIO()
    with zipfile.ZipFile(buffer, "w") as archive:
        archive.writestr("[Content_Types].xml", content_types)
        archive.writestr("word/document.xml", document_xml)
    return buffer.getvalue()


@pytest.mark.skipif(importlib.util.find_spec("docling") is None, reason="needs docling extra")
def test_convert_whole_delegates_to_the_whole_document_converter(tmp_path, monkeypatch):
    from rag_sidecar.parse import docling_adapter

    captured: list[dict] = []

    class _Success:
        value = "success"

    class _FakeConverter:
        def convert(self, _source, **kwargs):
            captured.append(kwargs)
            doc = DoclingDocument(name="docx-fixture")
            doc.add_page(page_no=1, size=Size(width=600, height=800))
            return type("R", (), {"status": _Success(), "document": doc})()

    monkeypatch.setattr(docling_adapter, "_preset_document_converter", lambda *_args, **_kwargs: _FakeConverter())
    path = tmp_path / "sample.docx"
    path.write_bytes(_minimal_docx_bytes())
    doc = docling_adapter.convert_whole(path, "structured_layout", ["en"])
    assert sorted(doc.pages) == [1]
    assert captured and captured[0]["page_range"][0] == 1


@pytest.mark.skipif(importlib.util.find_spec("docling") is None, reason="needs docling extra and a real PDF")
def test_convert_range_keeps_original_page_numbers(tmp_path):
    from rag_sidecar.parse import docling_adapter

    pdf = tmp_path / "range.pdf"
    texts = [f"Quarterly stock report page {index}" for index in range(1, 6)]
    pdf.write_bytes(_pdf_bytes(texts))
    doc = docling_adapter.convert_range(pdf, "fast", 2, 4, ocr_languages=["en"])
    assert sorted(doc.pages) == [2, 3, 4]
    for item in doc.texts:
        assert 2 <= item.prov[0].page_no <= 4