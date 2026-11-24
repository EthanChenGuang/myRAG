"""Pure ingest helpers for merging range documents, sub-PDF extraction and cache keys.

Names resolve on first access so the worker path (ledger, storage and app clients, the job function) does not import
the Docling stack that the merge helpers need.
"""

from __future__ import annotations

from importlib import import_module
from typing import Any

_EXPORTS = {
    "MergeInvariantError": "rag_sidecar.ingest.merge",
    "merge": "rag_sidecar.ingest.merge",
    "premium_part": "rag_sidecar.ingest.merge",
    "slice_pages": "rag_sidecar.ingest.merge",
    "cut_subpdf": "rag_sidecar.ingest.subpdf",
    "merged_options_hash": "rag_sidecar.ingest.cache_keys",
    "options_hash": "rag_sidecar.ingest.cache_keys",
}

__all__ = [
    "MergeInvariantError",
    "cut_subpdf",
    "merge",
    "merged_options_hash",
    "options_hash",
    "premium_part",
    "slice_pages",
]


def __getattr__(name: str) -> Any:
    module = _EXPORTS.get(name)
    if module is None:
        raise AttributeError(f"module {__name__!r} has no attribute {name!r}")
    value = getattr(import_module(module), name)
    globals()[name] = value
    return value
