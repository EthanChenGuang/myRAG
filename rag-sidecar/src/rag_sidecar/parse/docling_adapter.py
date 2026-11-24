import json
import re
from collections import Counter
from collections.abc import Callable
from importlib.metadata import version as _package_version
from io import BytesIO
from pathlib import Path
from typing import Any, get_args

import tiktoken
from docling_core.transforms.chunker.hierarchical_chunker import ChunkingDocSerializer, ChunkingSerializerProvider
from docling_core.transforms.chunker.hybrid_chunker import HybridChunker
from docling_core.transforms.chunker.tokenizer.openai import OpenAITokenizer
from docling_core.transforms.serializer.markdown import MarkdownTableSerializer
from docling_core.types.doc import DocItemLabel, DoclingDocument
from docling_core.types.io import DocumentStream

from rag_sidecar.contracts import ParseChunk, ParseJobRequest, ParsePicture, ParseResult
from rag_sidecar.contracts.ingest import ParserUsed
from rag_sidecar.parse import probe
from rag_sidecar.parse.converter import ConfigurationError, ConversionError, PageCapExceeded
from rag_sidecar.settings import SidecarSettings, load_settings

DOCLING_JSON = "docling.json"
SIDECAR_METADATA_KEY = "x_rag_sidecar"
_SEPARATOR_ROW = re.compile(r"^\|[\s:|-]+\|$")
_CJK = re.compile(r"[㐀-䶿一-鿿]")
_WORD = re.compile(r"[a-zà-ÿ]+")
_CJK_SHARE_FOR_ZH = 0.3
_STOPWORDS = {
    "en": frozenset(
        "the of and to in is for that with on are be by as at from within this shall which or an not it its".split()
    ),
    "it": frozenset(
        "il lo la le gli un una di del della dei delle che e è per con su al alla dal dalla nel nella entro sono non "
        "come anche si da in ai agli".split()
    ),
}


class MarkdownTableProvider(ChunkingSerializerProvider):
    """Serializes tables as Markdown so HybridChunker can repeat the header and separator rows."""

    def get_serializer(self, doc: DoclingDocument) -> ChunkingDocSerializer:
        return ChunkingDocSerializer(doc=doc, table_serializer=MarkdownTableSerializer())


def parser_version() -> str:
    return f"docling-{_package_version('docling-core')}"


def detect_language(text: str) -> str | None:
    """Returns zh, en or it when the text gives clear evidence, otherwise None."""
    letters = sum(1 for char in text if char.isalpha())
    if letters == 0:
        return None
    if len(_CJK.findall(text)) / letters >= _CJK_SHARE_FOR_ZH:
        return "zh"
    words = _WORD.findall(text.lower())
    scores = {language: sum(1 for word in words if word in stopwords) for language, stopwords in _STOPWORDS.items()}
    best = max(scores.values())
    if best == 0 or list(scores.values()).count(best) > 1:
        return None
    return max(scores, key=lambda language: scores[language])


def _majority_language(texts: list[str]) -> str | None:
    weights: Counter[str] = Counter()
    for text in texts:
        language = detect_language(text)
        if language is not None:
            weights[language] += len(text)
    if not weights:
        return None
    return weights.most_common(1)[0][0]


def _table_header(text: str) -> str | None:
    lines = text.splitlines()
    for index in range(1, min(len(lines), 6)):
        if lines[index - 1].startswith("|") and _SEPARATOR_ROW.match(lines[index]):
            return "\n".join(lines[index - 1 : index + 1])
    return None


def _chunks(doc: DoclingDocument, request: ParseJobRequest) -> list[ParseChunk]:
    tokenizer = OpenAITokenizer(tokenizer=tiktoken.get_encoding(request.tokenizer), max_tokens=request.max_tokens)
    chunker = HybridChunker(
        tokenizer=tokenizer,
        repeat_table_header=request.repeat_table_header,
        serializer_provider=MarkdownTableProvider(),
    )
    chunks: list[ParseChunk] = []
    for raw in chunker.chunk(dl_doc=doc):
        if not raw.text.strip():
            continue
        items = raw.meta.doc_items
        is_table = any(item.label == DocItemLabel.TABLE for item in items)
        pages = sorted({provenance.page_no for item in items for provenance in item.prov})
        chunks.append(
            ParseChunk(
                text=raw.text,
                contextualized_text=chunker.contextualize(chunk=raw),
                headings=list(raw.meta.headings or []),
                pages=pages,
                is_table=is_table,
                table_header=_table_header(raw.text) if is_table else None,
            )
        )
    return chunks


def _pictures(doc: DoclingDocument, out_dir: Path) -> tuple[list[ParsePicture], list[str], list[str]]:
    pictures: list[ParsePicture] = []
    artifacts: list[str] = []
    warnings: list[str] = []
    for number, picture in enumerate(doc.pictures, start=1):
        if not picture.prov:
            continue
        provenance = picture.prov[0]
        image = picture.get_image(doc)
        if image is None:
            if "picture_image_unavailable" not in warnings:
                warnings.append("picture_image_unavailable")
            continue
        page = doc.pages.get(provenance.page_no)
        left, top, right, bottom = provenance.bbox.l, provenance.bbox.t, provenance.bbox.r, provenance.bbox.b
        share = 0.0
        if page is not None:
            box = provenance.bbox.to_top_left_origin(page_height=page.size.height)
            left, top, right, bottom = box.l, box.t, box.r, box.b
            page_area = page.size.width * page.size.height
            if page_area > 0:
                share = min(1.0, max(0.0, abs(right - left) * abs(bottom - top) / page_area))
        name = f"picture-{number}.png"
        image.save(out_dir / name, format="PNG")
        artifacts.append(name)
        pictures.append(
            ParsePicture(
                page=provenance.page_no,
                bbox=[float(left), float(top), float(right), float(bottom)],
                image_ref=name,
                page_area_share=share,
            )
        )
    return pictures, artifacts, warnings


def _page_count(doc: DoclingDocument) -> int:
    pages = set(doc.pages)
    for item, _level in doc.iterate_items():
        pages.update(provenance.page_no for provenance in getattr(item, "prov", []))
    return max(pages, default=0)


def write_docling_json(doc: DoclingDocument, out_dir: Path, parser: str, version: str) -> None:
    payload = doc.export_to_dict()
    payload[SIDECAR_METADATA_KEY] = {"parser": parser, "parser_version": version}
    (out_dir / DOCLING_JSON).write_text(json.dumps(payload, ensure_ascii=False), encoding="utf-8")


def to_parse_result(
    doc: DoclingDocument,
    request: ParseJobRequest,
    out_dir: Path,
    *,
    parser: str = "docling",
    parser_version_text: str | None = None,
    warnings: list[str] | None = None,
    partial: bool = False,
    text_layer_page_share: float | None = None,
) -> ParseResult:
    """Chunks a DoclingDocument and writes docling.json plus one PNG per picture into out_dir."""
    version = parser_version_text or parser_version()
    chunks = _chunks(doc, request)
    pictures, picture_artifacts, picture_warnings = _pictures(doc, out_dir)
    write_docling_json(doc, out_dir, parser, version)
    merged_warnings = list(dict.fromkeys([*(warnings or []), *picture_warnings]))
    return ParseResult(
        markdown=doc.export_to_markdown(),
        chunks=chunks,
        pictures=pictures,
        page_count=_page_count(doc),
        language=_majority_language([chunk.contextualized_text for chunk in chunks]),
        parser=parser,  # type: ignore[arg-type]
        parser_version=version,
        warnings=merged_warnings,
        partial=partial,
        artifacts=[DOCLING_JSON, *picture_artifacts],
        text_layer_page_share=text_layer_page_share,
    )




DEFAULT_DOCUMENT_TIMEOUT_SECONDS = 120.0
PP_OCR_V6_CODES: frozenset[str] = frozenset(
    "af az bs ca ch chinese_cht cs cy da de en es et eu fi fr french ga german gl hr hu id is it japan ku la lb lt lv "
    "mi ms mt nl no oc pl pt qu rm ro rs_latin sk sl sq sv sw tl tr uz vi".split()
)
_PROFILE_LANGUAGE_TO_PP_OCR = {"zh": "ch"}
_HEAD_BYTES = 1024
_IMAGE_EXTENSIONS = (
    (b"\x89PNG\r\n\x1a\n", "png"),
    (b"\xff\xd8\xff", "jpg"),
    (b"II*\x00", "tif"),
    (b"MM\x00*", "tif"),
)
_SUCCESS_STATUSES = frozenset({"success", "partial_success"})


def to_ppocr_code(languages: list[str]) -> list[str]:
    """Maps the profile languages to the single PP-OCRv6 code RapidOCR runs with.

    One multilingual checkpoint serves every supported language, and RapidOCR uses only the first
    language of a list, so the result has one entry. An empty list or a code outside the PP-OCRv6
    set is a configuration error, never a silent fallback.
    """
    codes = [_PROFILE_LANGUAGE_TO_PP_OCR.get(language, language) for language in languages]
    if not codes or any(code not in PP_OCR_V6_CODES for code in codes):
        raise ConfigurationError()
    return codes[:1]


def build_pipeline_options(
    request: ParseJobRequest,
    *,
    artifacts_path: str | None = None,
    document_timeout_seconds: float = DEFAULT_DOCUMENT_TIMEOUT_SECONDS,
) -> Any:
    codes = to_ppocr_code(request.ocr_languages)
    from docling.datamodel.pipeline_options import (
        HeadingHierarchyOptions,
        OcrMode,
        PdfPipelineOptions,
        RapidOcrOptions,
        TableFormerMode,
    )

    docling = request.docling
    options = PdfPipelineOptions(artifacts_path=artifacts_path, document_timeout=document_timeout_seconds)
    options.do_ocr = docling.ocr
    options.ocr_options = RapidOcrOptions(
        backend="onnxruntime",
        lang=codes,
        mode=OcrMode.FULL_PAGE if docling.force_full_page_ocr else OcrMode.DEFAULT,
    )
    options.do_table_structure = docling.table_mode != "off"
    table_mode = TableFormerMode.FAST if docling.table_mode == "fast" else TableFormerMode.ACCURATE
    options.table_structure_options.mode = table_mode
    options.heading_hierarchy_options = HeadingHierarchyOptions(enabled=docling.heading_hierarchy)
    options.generate_picture_images = docling.generate_picture_images
    options.images_scale = 2.0 if docling.generate_picture_images else 1.0
    return options


def build_document_converter(options: Any) -> Any:
    """Images share the PDF pipeline options, so a scanned image gets the same OCR configuration."""
    from docling.datamodel.base_models import InputFormat
    from docling.document_converter import DocumentConverter, ImageFormatOption, PdfFormatOption

    return DocumentConverter(
        allowed_formats=[InputFormat.PDF, InputFormat.IMAGE, InputFormat.DOCX, InputFormat.HTML],
        format_options={
            InputFormat.PDF: PdfFormatOption(pipeline_options=options),
            InputFormat.IMAGE: ImageFormatOption(pipeline_options=options),
        },
    )


def sniff_input_format(head: bytes) -> str:
    """Guesses the input format from the leading bytes; the uploaded file has no usable name."""
    if b"%PDF" in head[:_HEAD_BYTES]:
        return "pdf"
    if _image_extension(head) is not None:
        return "image"
    text = head.removeprefix(b"\xef\xbb\xbf").lstrip().lower()
    if text.startswith(b"{"):
        return "json_docling"
    if head.startswith(b"PK\x03\x04"):
        return "docx"
    if text.startswith((b"<!doctype html", b"<html")):
        return "html"
    raise ConversionError("unsupported_input")


def _image_extension(head: bytes) -> str | None:
    for magic, extension in _IMAGE_EXTENSIONS:
        if head.startswith(magic):
            return extension
    if head[:4] == b"RIFF" and head[8:12] == b"WEBP":
        return "webp"
    return None


def _stream_name(input_format: str, head: bytes) -> str:
    extension = (_image_extension(head) or "png") if input_format == "image" else input_format
    return f"input.{extension}"


def _status_value(status: object) -> str:
    return str(getattr(status, "value", status)).lower()


def _stored_parser_fields(stored: object) -> tuple[str, str]:
    if isinstance(stored, dict):
        parser, version = stored.get("parser"), stored.get("parser_version")
        if parser in get_args(ParserUsed) and isinstance(version, str) and 0 < len(version) <= 100:
            return parser, version
    return "docling", parser_version()


def _rechunk_stored_json(input_path: Path, request: ParseJobRequest, out_dir: Path) -> ParseResult:
    """Chunks a stored docling.json again; no layout or OCR model runs and the parser fields are kept."""
    try:
        payload = json.loads(input_path.read_text(encoding="utf-8"))
        if not isinstance(payload, dict):
            raise ValueError("not an object")
        stored = payload.pop(SIDECAR_METADATA_KEY, None)
        doc = DoclingDocument.model_validate(payload)
    except (OSError, ValueError):
        raise ConversionError("invalid_docling_json") from None
    parser, version = _stored_parser_fields(stored)
    return to_parse_result(doc, request, out_dir, parser=parser, parser_version_text=version)


class DoclingConverter:
    """Converts one uploaded file with Docling; the pipeline is built lazily on the first convert call."""

    def __init__(
        self,
        settings: SidecarSettings | None = None,
        document_timeout_seconds: float = DEFAULT_DOCUMENT_TIMEOUT_SECONDS,
        converter_factory: Callable[[ParseJobRequest], Any] | None = None,
    ) -> None:
        self._settings = settings
        self._document_timeout_seconds = document_timeout_seconds
        self._converter_factory = converter_factory
        self._converters: dict[str, Any] = {}

    def pipeline_options(self, request: ParseJobRequest) -> Any:
        settings = self._settings or load_settings()
        return build_pipeline_options(
            request,
            artifacts_path=settings.docling_artifacts,
            document_timeout_seconds=self._document_timeout_seconds,
        )

    def _document_converter(self, request: ParseJobRequest) -> Any:
        if self._converter_factory is not None:
            return self._converter_factory(request)
        key = json.dumps([request.docling.model_dump(), to_ppocr_code(request.ocr_languages)], sort_keys=True)
        if key not in self._converters:
            self._converters[key] = build_document_converter(self.pipeline_options(request))
        return self._converters[key]

    def convert(self, input_path: Path, request: ParseJobRequest, out_dir: Path) -> ParseResult:
        with input_path.open("rb") as handle:
            head = handle.read(_HEAD_BYTES)
        input_format = request.input_format or sniff_input_format(head)
        if input_format == "json_docling":
            return _rechunk_stored_json(input_path, request, out_dir)
        text_layer_share = (
            probe.text_layer_page_share(input_path, request.page_cap) if input_format == "pdf" else None
        )
        document_converter = self._document_converter(request)
        stream = DocumentStream(name=_stream_name(input_format, head), stream=BytesIO(input_path.read_bytes()))
        options: dict[str, Any] = {"raises_on_error": False}
        if request.page_cap is not None:
            options["max_num_pages"] = request.page_cap
        converted = document_converter.convert(stream, **options)
        status = _status_value(converted.status)
        if status not in _SUCCESS_STATUSES:
            page_count = getattr(getattr(converted, "input", None), "page_count", 0) or 0
            if request.page_cap is not None and page_count > request.page_cap:
                raise PageCapExceeded()
            raise ConversionError("conversion_failed")
        partial = status == "partial_success"
        return to_parse_result(
            converted.document,
            request,
            out_dir,
            warnings=["docling_partial_success"] if partial else None,
            partial=partial,
            text_layer_page_share=text_layer_share,
        )
