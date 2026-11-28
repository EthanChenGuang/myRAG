"""Language-pack registry contract and completeness rule (Phase 3.2 D-04, D-05)."""

from __future__ import annotations

import json
from pathlib import Path

import pytest
from pydantic import ValidationError

from rag_sidecar.contracts.languages import (
    COMPLETENESS_PARTS,
    LanguagePack,
    LanguageRegistry,
    complete_packs,
    default_language_packs_path,
    get_language_pack,
    load_language_registry,
    pack_missing_parts,
)

REPO_ROOT = Path(__file__).resolve().parents[2]
REGISTRY_PATH = REPO_ROOT / "config" / "rag" / "language-packs.json"
CASES_PATH = REPO_ROOT / "tests" / "fixtures" / "rag" / "language-pack-completeness-cases.json"


def _raw() -> dict:
    return json.loads(REGISTRY_PATH.read_text(encoding="utf-8"))


def _pack(code: str) -> dict:
    return next(pack for pack in _raw()["packs"] if pack["code"] == code)


def test_the_checkout_reads_the_repo_registry():
    assert default_language_packs_path() == REGISTRY_PATH


def test_the_registry_holds_zh_en_it_in_registry_order():
    assert [pack.code for pack in load_language_registry().packs] == ["zh", "en", "it"]


def test_sentence_ends_and_list_separators():
    assert get_language_pack("zh").sentence_end == "。！？"
    assert get_language_pack("en").sentence_end == ".!?"
    assert get_language_pack("it").sentence_end == ".!?"
    assert get_language_pack("zh").list_separator == "，"
    assert get_language_pack("en").list_separator == ", "


def test_ocr_codes_per_parser():
    zh = get_language_pack("zh")
    assert zh.ocr_codes.llamaparse == "ch_sim"
    assert zh.ocr_codes.docling.rapidocr == "ch"
    assert [get_language_pack(code).ocr_codes.docling.rapidocr for code in ("en", "it")] == ["en", "it"]
    assert [get_language_pack(code).ocr_codes.llamaparse for code in ("en", "it")] == ["en", "it"]


def test_an_unknown_code_has_no_pack():
    assert get_language_pack("xx") is None


def test_duplicate_codes_are_rejected():
    raw = _raw()
    raw["packs"].append(_pack("en"))
    with pytest.raises(ValidationError, match="duplicate language codes: en"):
        LanguageRegistry.model_validate(raw)


def test_an_unknown_field_is_rejected():
    raw = _raw()
    raw["packs"][0]["unexpected"] = 1
    with pytest.raises(ValidationError):
        LanguageRegistry.model_validate(raw)


def test_an_unknown_segmentation_is_rejected():
    raw = _raw()
    raw["packs"][1]["segmentation"] = "stem"
    with pytest.raises(ValidationError):
        LanguageRegistry.model_validate(raw)


def test_a_pattern_that_does_not_compile_is_rejected():
    raw = _raw()
    raw["packs"][2]["version_markers"] = ["(unclosed"]
    with pytest.raises(ValidationError, match="does not compile"):
        LanguageRegistry.model_validate(raw)


def test_every_shipped_pack_is_complete():
    assert [pack.code for pack in complete_packs()] == ["zh", "en", "it"]
    assert all(pack_missing_parts(pack) == [] for pack in load_language_registry().packs)


def _apply(pack: dict, removal: dict) -> dict:
    target = pack
    *parents, leaf = removal["path"]
    for key in parents:
        target = target[key]
    if removal["op"] == "delete":
        del target[leaf]
    else:
        target[leaf] = removal["value"]
    return pack


_CASES = json.loads(CASES_PATH.read_text(encoding="utf-8"))["cases"]


def test_the_shared_cases_cover_every_part_once():
    assert sorted(case["missing"][0] for case in _CASES) == sorted(COMPLETENESS_PARTS)
    assert all(len(case["missing"]) == 1 for case in _CASES)


@pytest.mark.parametrize("case", _CASES, ids=[case["name"] for case in _CASES])
def test_a_fixture_pack_missing_one_part_is_incomplete(case):
    pack = LanguagePack.model_validate(_apply(_pack(case["base"]), case["change"]))
    assert pack_missing_parts(pack) == case["missing"]
