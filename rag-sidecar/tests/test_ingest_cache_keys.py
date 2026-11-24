"""Tests for canonical parse-cache option hashes."""

from __future__ import annotations

import pytest

from rag_sidecar.ingest.cache_keys import merged_options_hash, options_hash  # noqa: E402


def test_options_hash_is_stable_for_key_order_and_sensitive_to_preset_and_pages():
    base = {
        "preset": "fast",
        "pdf_backend": "pypdfium2",
        "do_ocr": False,
        "pages": [1, 10],
        "input_format": "pdf",
    }
    reordered = {
        "input_format": "pdf",
        "pages": [1, 10],
        "preset": "fast",
        "pdf_backend": "pypdfium2",
        "do_ocr": False,
    }
    other_pages = {**base, "pages": [1, 11]}
    structured = {**base, "preset": "structured_layout"}
    first = options_hash(base)
    assert first == options_hash(reordered)
    assert len(first) == 64 and first == first.lower()
    assert options_hash(other_pages) != first
    assert options_hash(structured) != first


def test_options_hash_rejects_chunker_options():
    with pytest.raises(ValueError, match="chunker option"):
        options_hash({"preset": "fast", "max_tokens": 512})
    with pytest.raises(ValueError, match="chunker option"):
        options_hash({"preset": "fast", "repeat_table_header": True})


def test_options_hash_preserves_non_ascii_labels():
    opts = {
        "preset": "structured_ocr",
        "ocr_languages": ["zh", "en", "it"],
        "pages": [1],
        "input_format": "pdf",
    }
    first = options_hash(opts)
    second = options_hash({**opts, "ocr_languages": ["zh", "en", "it"]})
    assert first == second
    assert first != options_hash({**opts, "ocr_languages": ["zh"]})


def test_merged_options_hash_depends_on_entry_order_and_version():
    a = ("docling", "docling-2.107.1", "a" * 64)
    b = ("llamaparse", "llamaparse-v2@1", "b" * 64)
    forward = merged_options_hash([a, b])
    reverse = merged_options_hash([b, a])
    assert forward != reverse
    bumped = merged_options_hash([(a[0], "docling-2.108.0", a[2]), b])
    assert bumped != forward