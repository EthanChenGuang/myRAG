"""Pure ingest helpers for merging range documents, sub-PDF extraction and cache keys."""

from rag_sidecar.ingest.cache_keys import merged_options_hash, options_hash
from rag_sidecar.ingest.merge import MergeInvariantError, merge, premium_part, slice_pages
from rag_sidecar.ingest.subpdf import cut_subpdf

__all__ = [
    "MergeInvariantError",
    "cut_subpdf",
    "merge",
    "merged_options_hash",
    "options_hash",
    "premium_part",
    "slice_pages",
]