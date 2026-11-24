from pathlib import Path

from docling_core.transforms.chunker.hierarchical_chunker import ChunkingSerializerProvider
from docling_core.types.doc import DoclingDocument

from rag_sidecar.contracts import ParseJobRequest, ParseResult


class MarkdownTableProvider(ChunkingSerializerProvider):
    pass


def detect_language(text: str) -> str | None:
    return None


def to_parse_result(doc: DoclingDocument, request: ParseJobRequest, out_dir: Path) -> ParseResult:
    return ParseResult(
        markdown="",
        chunks=[],
        pictures=[],
        page_count=0,
        language=None,
        parser="docling",
        parser_version="skeleton",
    )
