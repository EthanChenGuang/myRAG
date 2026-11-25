"""Docling pipeline presets for tiered PDF conversion (D-48, F-1)."""

from __future__ import annotations

from typing import Any, Literal

from rag_sidecar.contracts.routing import ParseRoutingConfig, Preset
from rag_sidecar.parse.converter import ConfigurationError
from rag_sidecar.parse.docling_adapter import DEFAULT_DOCUMENT_TIMEOUT_SECONDS, to_ppocr_code
from rag_sidecar.preflight.config import load_routing_config

OcrModeName = Literal["default", "full_page"]
PdfBackendName = Literal["pypdfium2", "docling_parse"]
TableModeName = Literal["off", "fast", "accurate"]

# Maps routing preset metadata into the canonical cache-key option dict.
_PRESET_ALIASES: dict[Preset, tuple[PdfBackendName, bool | None, OcrModeName, TableModeName, bool | None]] = {
    "fast": ("pypdfium2", False, "default", "off", None),
    "structured_layout": ("docling_parse", False, "default", "off", True),
    "structured_full": ("docling_parse", True, "default", "accurate", True),
    "structured_ocr": ("docling_parse", True, "full_page", "accurate", None),
}


def _resolve_cfg(cfg: ParseRoutingConfig | None) -> ParseRoutingConfig:
    return cfg if cfg is not None else load_routing_config()


def preset_option_dict(
    preset: str,
    cfg: ParseRoutingConfig | None = None,
    *,
    ocr_languages: list[str] | None = None,
    pages: list[int] | None = None,
) -> dict[str, object]:
    """Pure option fingerprint for cache keys and tests; never imports Docling."""
    if preset not in _PRESET_ALIASES:
        raise ConfigurationError()
    languages = ["zh", "en", "it"] if ocr_languages is None else ocr_languages
    codes = to_ppocr_code(languages)
    backend, do_ocr, ocr_mode, table_mode, heading = _PRESET_ALIASES[preset]  # type: ignore[index]
    routing = _resolve_cfg(cfg).presets
    options = getattr(routing, preset)
    if options is None:
        raise ConfigurationError()
    if options.table_mode is not None and options.table_mode != table_mode and preset != "structured_full":
        table_mode = options.table_mode  # type: ignore[assignment]
    if options.ocr is not None:
        do_ocr = options.ocr
    if options.force_full_page_ocr:
        ocr_mode = "full_page"
    payload: dict[str, object] = {
        "preset": preset,
        "pdf_backend": backend,
        "do_ocr": bool(do_ocr),
        "ocr_mode": ocr_mode,
        "ocr_languages": codes,
        "do_table_structure": table_mode != "off",
        "table_mode": table_mode,
    }
    if heading is not None:
        payload["heading_hierarchy"] = heading
    if pages is not None:
        payload["pages"] = pages
    return payload


def pipeline_options(
    preset: str,
    ocr_languages: list[str],
    cfg: ParseRoutingConfig | None = None,
    *,
    artifacts_path: str | None = None,
    document_timeout_seconds: float = DEFAULT_DOCUMENT_TIMEOUT_SECONDS,
) -> Any:
    """Build Docling PdfPipelineOptions for a routing preset."""
    meta = preset_option_dict(preset, cfg, ocr_languages=ocr_languages)
    from docling.datamodel.pipeline_options import (
        HeadingHierarchyOptions,
        OcrMode,
        PdfPipelineOptions,
        RapidOcrOptions,
        TableFormerMode,
    )

    codes = meta["ocr_languages"]
    assert isinstance(codes, list)
    table_mode = meta["table_mode"]
    assert table_mode in ("off", "fast", "accurate")
    options = PdfPipelineOptions(artifacts_path=artifacts_path, document_timeout=document_timeout_seconds)
    options.do_ocr = bool(meta["do_ocr"])
    mode = OcrMode.FULL_PAGE if meta["ocr_mode"] == "full_page" else OcrMode.DEFAULT
    options.ocr_options = RapidOcrOptions(backend="onnxruntime", lang=codes, mode=mode)
    options.do_table_structure = bool(meta["do_table_structure"])
    if table_mode == "fast":
        options.table_structure_options.mode = TableFormerMode.FAST
    elif table_mode == "accurate":
        options.table_structure_options.mode = TableFormerMode.ACCURATE
    else:
        options.do_table_structure = False
    heading = meta.get("heading_hierarchy")
    if heading is not None:
        options.heading_hierarchy_options = HeadingHierarchyOptions(enabled=bool(heading))
    options.generate_picture_images = False
    options.images_scale = 1.0
    return options


def build_preset_document_converter(preset: str, pipeline_opts: Any) -> Any:
    """DocumentConverter for a preset; fast uses PyPdfium + StandardPdfPipeline (never NativePdfPipeline)."""
    from docling.backend.docling_parse_backend import ThreadedDoclingParseDocumentBackend
    from docling.backend.pypdfium2_backend import PyPdfiumDocumentBackend
    from docling.datamodel.base_models import InputFormat
    from docling.document_converter import (
        DocumentConverter,
        HTMLFormatOption,
        ImageFormatOption,
        PdfFormatOption,
        WordFormatOption,
    )
    from docling.pipeline.standard_pdf_pipeline import StandardPdfPipeline

    pdf_backend = PyPdfiumDocumentBackend if preset == "fast" else ThreadedDoclingParseDocumentBackend
    pdf_option = PdfFormatOption(
        pipeline_options=pipeline_opts,
        backend=pdf_backend,
        pipeline_cls=StandardPdfPipeline,
    )
    return DocumentConverter(
        allowed_formats=[InputFormat.PDF, InputFormat.IMAGE, InputFormat.DOCX, InputFormat.HTML],
        format_options={
            InputFormat.PDF: pdf_option,
            InputFormat.IMAGE: ImageFormatOption(pipeline_options=pipeline_opts),
            InputFormat.DOCX: WordFormatOption(pipeline_options=pipeline_opts),
            InputFormat.HTML: HTMLFormatOption(pipeline_options=pipeline_opts),
        },
    )