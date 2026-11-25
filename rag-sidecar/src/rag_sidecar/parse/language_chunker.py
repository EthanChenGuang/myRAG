"""Language-aware Docling chunking (Phase 3.2 D-15, D-55, research F-2)."""

from __future__ import annotations

from docling_core.transforms.chunker.hybrid_chunker import HybridChunker


class LanguageAwareHybridChunker(HybridChunker):
    languages: list[str] = []
    primary_language: str | None = None
