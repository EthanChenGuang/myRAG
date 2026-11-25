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

# ---------------------------------------------------------------------------------------------------------------------
# D-22: the effective header flag in the chunker part of the key
# ---------------------------------------------------------------------------------------------------------------------

from rag_sidecar.contracts.queue import JobSettingsSnapshot  # noqa: E402
from rag_sidecar.ingest.cache_keys import chunker_key, effective_repeat_table_header  # noqa: E402
from rag_sidecar.preflight.config import load_processing_profiles  # noqa: E402

PROFILES = load_processing_profiles().profiles


def _snapshot(profile, **overrides) -> JobSettingsSnapshot:
    base = {
        "routing": "tiered",
        "cloud_allowed": True,
        "escalation": True,
        "progressive": False,
        "premium_max_pages_per_doc": 50,
        "premium_page_budget": 0,
        "vlm_detect": False,
        "profile_id": profile.id,
        "profile_version": profile.version,
        "doc_type": profile.doc_type,
        "embed_mode": "sync",
        "ocr_languages": ["en"],
        "routing_config_version": "1",
    }
    return JobSettingsSnapshot.model_validate({**base, **overrides})


def _trunk_chunker_key(profile) -> str:
    return f"mt{profile.chunker.max_tokens}-rh{int(profile.chunker.repeat_table_header)}"


def test_the_six_shipped_profiles_are_covered():
    assert len(PROFILES) == 6
    assert {profile.chunker.repeat_table_header for profile in PROFILES} == {True, False}


@pytest.mark.parametrize("profile", PROFILES, ids=lambda profile: profile.id)
def test_an_unset_effective_flag_gives_the_trunk_key_and_the_profile_flag(profile):
    settings = _snapshot(profile)
    assert settings.repeat_table_header_effective is None
    assert effective_repeat_table_header(settings, profile) is profile.chunker.repeat_table_header
    assert chunker_key(settings, profile) == _trunk_chunker_key(profile)


@pytest.mark.parametrize("profile", [p for p in PROFILES if not p.chunker.repeat_table_header], ids=lambda profile: profile.id)
def test_a_forced_flag_on_a_profile_without_it_changes_the_chunker_key(profile):
    settings = _snapshot(profile, repeat_table_header_effective=True)
    assert effective_repeat_table_header(settings, profile) is True
    assert chunker_key(settings, profile) != _trunk_chunker_key(profile)
    assert chunker_key(settings, profile) == f"mt{profile.chunker.max_tokens}-rh1"


@pytest.mark.parametrize("profile", [p for p in PROFILES if p.chunker.repeat_table_header], ids=lambda profile: profile.id)
def test_a_forced_flag_on_a_profile_that_already_repeats_changes_nothing(profile):
    settings = _snapshot(profile, repeat_table_header_effective=True)
    assert effective_repeat_table_header(settings, profile) is True
    assert chunker_key(settings, profile) == _trunk_chunker_key(profile)


@pytest.mark.parametrize("profile", [p for p in PROFILES if p.chunker.repeat_table_header], ids=lambda profile: profile.id)
def test_an_explicit_false_turns_the_profile_flag_off(profile):
    settings = _snapshot(profile, repeat_table_header_effective=False)
    assert effective_repeat_table_header(settings, profile) is False
    assert chunker_key(settings, profile) == f"mt{profile.chunker.max_tokens}-rh0"


@pytest.mark.parametrize("profile", PROFILES, ids=lambda profile: profile.id)
def test_header_carry_forward_has_its_own_part_of_the_chunker_key(profile):
    plain = chunker_key(_snapshot(profile, repeat_table_header_effective=True), profile)
    carried = chunker_key(_snapshot(profile, repeat_table_header_effective=True, carry_table_header=True), profile)
    assert carried != plain
    assert carried.startswith(plain)
