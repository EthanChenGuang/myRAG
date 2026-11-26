"""Canonical parse-cache option hashes (D-20, D-56, F-12)."""

from __future__ import annotations

import hashlib
import json
from collections.abc import Mapping, Sequence

from rag_sidecar.contracts.ingest import ProcessingProfile
from rag_sidecar.contracts.queue import JobSettingsSnapshot

_ALLOWED_CONVERSION_KEYS = frozenset(
    {
        "preset",
        "pdf_backend",
        "do_ocr",
        "ocr_mode",
        "ocr_languages",
        "do_table_structure",
        "table_mode",
        "pages",
        "input_format",
    }
)

_CHUNKER_KEYS = frozenset({"max_tokens", "repeat_table_header", "tokenizer", "profile_id", "profile_version"})


def _canonical_json(payload: object) -> str:
    return json.dumps(payload, sort_keys=True, separators=(",", ":"), ensure_ascii=False)


def options_hash(opts: Mapping[str, object]) -> str:
    """Hash conversion options only; chunker keys are rejected."""
    for key in opts:
        if key in _CHUNKER_KEYS:
            raise ValueError(f"chunker option {key!r} must not appear in options_hash input")
        if key not in _ALLOWED_CONVERSION_KEYS:
            raise ValueError(f"unsupported conversion option {key!r}")
    digest = hashlib.sha256(_canonical_json(dict(opts)).encode())
    return digest.hexdigest()


def merged_options_hash(entries: Sequence[tuple[str, str, str]]) -> str:
    """Hash ordered range entries as (parser, parser_version, options_hash)."""
    payload = [
        {"parser": parser, "parser_version": version, "options_hash": entry_hash}
        for parser, version, entry_hash in entries
    ]
    digest = hashlib.sha256(_canonical_json(payload).encode())
    return digest.hexdigest()


def effective_repeat_table_header(settings: JobSettingsSnapshot, profile: ProcessingProfile) -> bool:
    """D-22: the snapshot's repeat_table_header_effective, or the profile's repeat_table_header when it is None."""
    forced = settings.repeat_table_header_effective
    return profile.chunker.repeat_table_header if forced is None else forced


def chunker_key(settings: JobSettingsSnapshot, profile: ProcessingProfile) -> str:
    """The chunker part of the merged-document version string (D-22).

    The effective header flag replaces the profile's; header carry-forward (D-20) adds its own part only when on, so
    every key written before Phase 3.2 stays as it was.
    """
    key = f"mt{profile.chunker.max_tokens}-rh{int(effective_repeat_table_header(settings, profile))}"
    return f"{key}-ch1" if settings.carry_table_header else key
