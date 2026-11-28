"""The hidden-text check in the worker's preflight (D-33, D-34).

Under tiered routing the worker already holds the original, so it runs the check here when the job's settings
snapshot asks for it and sends the report with every post-parse advance call; the app's scan stage then uses it
instead of calling ``POST /v1/hidden-text``. A snapshot with ``hidden_text_check`` off runs nothing.
"""

from __future__ import annotations

import logging
from collections.abc import Callable
from pathlib import PurePosixPath

from rag_sidecar.contracts.ingest_security import HiddenTextReport
from rag_sidecar.contracts.queue import IngestionJob

logger = logging.getLogger(__name__)

CHECKER_UNAVAILABLE = "hidden_text_checker_unavailable"

# The formats the app sends to the checker (src/lib/rag/security/hidden-text.ts, hiddenTextMimeType): PDF and Word.
_CHECKED_MIME_TYPES = frozenset(
    {"application/pdf", "application/vnd.openxmlformats-officedocument.wordprocessingml.document"}
)
_EXTENSION_MIME_TYPES = {
    "pdf": "application/pdf",
    "docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
}
_GENERIC_MIME_TYPES = frozenset({"", "application/octet-stream", "binary/octet-stream"})

HiddenTextChecker = Callable[[bytes, str], HiddenTextReport]


class HiddenTextPreflightUnavailable(Exception):
    """The check could not run under quarantine; the job fails and nothing is published (fail closed, D-34)."""

    def __init__(self, *, retryable: bool) -> None:
        super().__init__(CHECKER_UNAVAILABLE)
        self.error_class = CHECKER_UNAVAILABLE
        self.retryable = retryable


def hidden_text_mime_type(mime_type: str | None, filename: str) -> str | None:
    """The media type to check, or None for a format without a checker; a missing or generic type falls back to the extension."""
    kind = (mime_type or "").split(";", 1)[0].strip().lower()
    if kind in _CHECKED_MIME_TYPES:
        return kind
    if kind not in _GENERIC_MIME_TYPES:
        return None
    suffix = PurePosixPath(filename).suffix.lower().lstrip(".")
    return _EXTENSION_MIME_TYPES.get(suffix)


def needs_hidden_text_check(job: IngestionJob) -> str | None:
    """The media type to check when the snapshot asks for the check and the file has a checker; None otherwise."""
    if job.settings.hidden_text_check == "off" or job.kind != "ingest":
        return None
    return hidden_text_mime_type(job.mime_type, job.filename or job.source_key)


def _default_checker(data: bytes, mime_type: str) -> HiddenTextReport:
    from rag_sidecar.security.hidden_text import check_hidden_text

    return check_hidden_text(data, mime_type)


def _permanent(exc: Exception) -> bool:
    from rag_sidecar.security.hidden_text import EncryptedDocument, UnreadableDocument

    return isinstance(exc, (EncryptedDocument, UnreadableDocument))


def run_hidden_text_preflight(
    job: IngestionJob, original_bytes: bytes, *, checker: HiddenTextChecker | None = None
) -> HiddenTextReport | None:
    """The report for the job's original, or None when the snapshot has the check off or the format has no checker.

    Under ``flag`` a checker failure returns None (the app then records ``not_checked`` as it does inline); under
    ``quarantine`` it raises HiddenTextPreflightUnavailable. Spans are never logged.
    """
    mime_type = needs_hidden_text_check(job)
    if mime_type is None:
        return None
    mode = job.settings.hidden_text_check
    try:
        report = (checker or _default_checker)(original_bytes, mime_type)
        validated = HiddenTextReport.model_validate(report.model_dump(mode="json"))
    except Exception as exc:  # noqa: BLE001 - every failure is a checker failure; the class decides retry
        logger.warning(
            "[RAG Security] hidden-text preflight failed", extra={"mode": mode, "error": type(exc).__name__}
        )
        if mode == "quarantine":
            raise HiddenTextPreflightUnavailable(retryable=not _permanent(exc)) from exc
        return None
    logger.info(
        "[RAG Security] hidden-text preflight checked",
        extra={"status": validated.status, "spans": len(validated.spans), "checker_version": validated.checker_version},
    )
    return validated
