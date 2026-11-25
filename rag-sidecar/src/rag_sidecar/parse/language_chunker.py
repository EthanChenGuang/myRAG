"""Language-aware Docling chunking (Phase 3.2 D-15, D-55, research F-2).

HybridChunker splits over-long text with semchunk, whose splitters are ASCII and Latin punctuation only, so a
Chinese paragraph is cut between arbitrary characters. This subclass cuts the text branch at the sentence ends of
the block's language instead, with the splitter twin of src/lib/rag/lang/sentences.ts.
"""

from __future__ import annotations

import tiktoken
from docling_core.transforms.chunker.hierarchical_chunker import DocChunk
from docling_core.transforms.chunker.hybrid_chunker import HybridChunker
from docling_core.transforms.serializer.base import BaseDocSerializer
from docling_core.types.doc import TableItem

from rag_sidecar.ingest.lang import detect_language_with_confidence
from rag_sidecar.parse.sentences import split_sentences


class LanguageAwareHybridChunker(HybridChunker):
    """HybridChunker whose text segments end at the sentence ends of the text's language.

    The text is detected among `languages`; no evidence (`und`) takes `primary_language`. Sentences are packed up
    to the available token length with the chunker's own tokenizer, and only a single over-long sentence is hard
    split. Chunks holding a table, a chunker without a primary language and a non-tiktoken tokenizer keep the parent
    behaviour.
    """

    languages: list[str] = []
    primary_language: str | None = None

    def _text_language(self, text: str) -> str | None:
        if self.primary_language is None or not self.languages:
            return None
        return detect_language_with_confidence(text, self.languages).language or self.primary_language

    def segment(self, doc_chunk: DocChunk, available_length: int, doc_serializer: BaseDocSerializer) -> list[str]:
        has_table = any(isinstance(item, TableItem) for item in doc_chunk.meta.doc_items)
        encoding = self.tokenizer.get_tokenizer()
        language = None if has_table else self._text_language(doc_chunk.text)
        if language is None or not isinstance(encoding, tiktoken.Encoding):
            return super().segment(doc_chunk, available_length, doc_serializer)
        return split_sentences(doc_chunk.text, language, max(1, available_length), encoding=encoding)
