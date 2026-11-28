"""Ingestion security checks over original files (Phase 3.2 D-33); base install, optional extras load lazily."""

from rag_sidecar.security.hidden_text import (
    CheckerUnavailable,
    EncryptedDocument,
    UnreadableDocument,
    UnsafePackage,
    check_hidden_text,
    load_hidden_text_rules,
)
from rag_sidecar.security.router import build_hidden_text_router

__all__ = [
    "CheckerUnavailable",
    "EncryptedDocument",
    "UnreadableDocument",
    "UnsafePackage",
    "build_hidden_text_router",
    "check_hidden_text",
    "load_hidden_text_rules",
]
