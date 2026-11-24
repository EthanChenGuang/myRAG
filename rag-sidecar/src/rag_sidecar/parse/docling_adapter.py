import json
import re
from collections import Counter
from importlib.metadata import version as _package_version
from pathlib import Path

import tiktoken
from docling_core.transforms.chunker.hierarchical_chunker import ChunkingDocSerializer, ChunkingSerializerProvider
from docling_core.transforms.chunker.hybrid_chunker import HybridChunker
from docling_core.transforms.chunker.tokenizer.openai import OpenAITokenizer
from docling_core.transforms.serializer.markdown import MarkdownTableSerializer
from docling_core.types.doc import DocItemLabel, DoclingDocument

from rag_sidecar.contracts import ParseChunk, ParseJobRequest, ParsePicture, ParseResult

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
