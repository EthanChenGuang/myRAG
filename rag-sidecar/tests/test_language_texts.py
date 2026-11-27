"""Phase 5.2 D-08: the registry's fixed texts are typed in three groups and every shipped pack has every key."""

from __future__ import annotations

import json
import re
from pathlib import Path

import pytest
from pydantic import ValidationError

from rag_sidecar.contracts import languages as registry_module
from rag_sidecar.contracts.languages import LanguagePack, LanguageRegistry, load_language_registry, pack_missing_parts

REPO_ROOT = Path(__file__).resolve().parents[2]
REGISTRY_PATH = REPO_ROOT / "config" / "rag" / "language-packs.json"
SIDECAR_COPY = REPO_ROOT / "rag-sidecar" / "config" / "rag" / "language-packs.json"

NOTICE_KEYS = (
    "no_information",
    "no_information_web",
    "kb_unavailable",
    "answer_truncated",
    "link_removed",
    "credential_request_blocked",
    "credential_request_warning",
    "not_confirmed",
    "uncited",
    "calc_corrected",
    "calc_not_verified",
    "document_updated_or_removed",
    "prompt_too_long",
)
LABEL_KEYS = (
    "from_documents",
    "from_web",
    "general_knowledge",
    "not_covered",
    "version",
    "effective_from",
    "older_version",
    "badge_verified",
    "badge_possibly_unreliable",
    "badge_not_checked",
    "badge_tooltip_verified",
    "badge_tooltip_possibly_unreliable",
    "badge_tooltip_not_checked",
    "condensed_question",
    "earlier_draft",
)
INSTRUCTION_KEYS = (
    "citation",
    "citation_per_sentence",
    "grounding_per_sentence",
    "attached_documents",
    "relevance",
    "relevance_web",
    "relevance_open",
    "partial_answer",
    "general_knowledge",
    "web_separation",
    "version",
    "concise",
    "calculation",
    "calculation_block",
)
ALL_KEYS = (
    [f"notices.{key}" for key in NOTICE_KEYS]
    + [f"labels.{key}" for key in LABEL_KEYS]
    + [f"instructions.{key}" for key in INSTRUCTION_KEYS]
)

EXPECTED_PLACEHOLDERS = {
    "labels.version": {"version"},
    "labels.effective_from": {"date"},
    "notices.calc_corrected": {"value"},
    "instructions.relevance": {"sentinel"},
    "instructions.relevance_web": {"sentinel"},
    "instructions.partial_answer": {"sentinel", "not_covered"},
    "instructions.web_separation": {"from_documents", "from_web"},
    "instructions.relevance_open": {"general_knowledge"},
    "instructions.general_knowledge": {"general_knowledge"},
    "instructions.calculation_block": {"open", "close"},
}
PLACEHOLDER_RE = re.compile(r"\{([A-Za-z_][A-Za-z0-9_]*)\}")


def _raw() -> dict:
    return json.loads(REGISTRY_PATH.read_text(encoding="utf-8"))


def _pack(code: str) -> dict:
    return next(pack for pack in _raw()["packs"] if pack["code"] == code)


def _group(dotted: str) -> tuple[str, str]:
    group, key = dotted.split(".")
    return group, key


def test_the_three_text_groups_exist_with_exactly_the_decided_keys():
    for name, keys in (("NoticeTexts", NOTICE_KEYS), ("LabelTexts", LABEL_KEYS), ("InstructionTexts", INSTRUCTION_KEYS)):
        model = getattr(registry_module, name, None)
        assert model is not None, f"{name} is missing"
        assert tuple(model.model_fields) == keys
    texts = registry_module.LanguagePack.model_fields["texts"].annotation
    assert tuple(texts.model_fields) == ("notices", "labels", "instructions")


def test_text_keys_and_placeholders_are_declared_once():
    assert tuple(getattr(registry_module, "TEXT_KEYS", ())) == tuple(ALL_KEYS)
    declared = {key: set(names) for key, names in getattr(registry_module, "TEXT_PLACEHOLDERS", {}).items()}
    assert declared == EXPECTED_PLACEHOLDERS


@pytest.mark.parametrize("code", ["zh", "en", "it"])
def test_every_shipped_pack_has_every_text(code):
    pack = load_language_registry().packs
    found = next(entry for entry in pack if entry.code == code)
    assert pack_missing_parts(found) == []
    for dotted in ALL_KEYS:
        group, key = _group(dotted)
        value = _pack(code)["texts"].get(group, {}).get(key)
        assert isinstance(value, str) and value.strip(), f"{code}: {dotted} is missing"


@pytest.mark.parametrize("dotted", ALL_KEYS)
def test_a_missing_text_makes_the_pack_incomplete(dotted):
    raw = _pack("en")
    group, key = _group(dotted)
    del raw["texts"][group][key]
    assert pack_missing_parts(LanguagePack.model_validate(raw)) == [f"texts.{dotted}"]


@pytest.mark.parametrize("dotted", ["notices.link_removed", "labels.from_web", "instructions.concise"])
def test_an_empty_text_fails_validation(dotted):
    raw = _pack("it")
    group, key = _group(dotted)
    raw["texts"][group][key] = ""
    with pytest.raises(ValidationError):
        LanguagePack.model_validate(raw)


def test_an_unknown_text_key_fails_validation():
    raw = _pack("zh")
    raw["texts"]["notices"]["unexpected"] = "text"
    with pytest.raises(ValidationError):
        LanguagePack.model_validate(raw)


@pytest.mark.parametrize("code", ["zh", "en", "it"])
def test_each_text_uses_exactly_its_declared_placeholders(code):
    texts = _pack(code)["texts"]
    for dotted in ALL_KEYS:
        group, key = _group(dotted)
        found = set(PLACEHOLDER_RE.findall(texts[group][key]))
        assert found == EXPECTED_PLACEHOLDERS.get(dotted, set()), f"{code}: {dotted}"


@pytest.mark.parametrize(
    ("dotted", "value"),
    [
        ("labels.version", "Version"),
        ("notices.calc_corrected", "The result is {value} and {extra}."),
        ("notices.link_removed", "(link {value} removed)"),
        ("instructions.partial_answer", "Write {sentinel} only."),
        ("instructions.calculation_block", "Write the block between {open} and the end."),
        ("instructions.calculation_block", "Write the block at the end."),
    ],
)
@pytest.mark.parametrize("code", ["zh", "en", "it"])
def test_a_missing_or_undeclared_placeholder_fails_in_every_language(code, dotted, value):
    raw = _pack(code)
    group, key = _group(dotted)
    raw["texts"][group][key] = value
    with pytest.raises(ValidationError, match="placeholder"):
        LanguagePack.model_validate(raw)


def test_the_partial_answer_example_is_abstract():
    for code in ("zh", "en", "it"):
        text = _pack(code)["texts"]["instructions"]["partial_answer"]
        assert "A" in text and "B" in text
        assert not re.search(r"\d", text), f"{code}: the worked example holds a number"


def test_no_registry_text_holds_a_link_or_domain_like_token():
    link = re.compile(r"https?://|www\.|\b[a-z0-9-]+\.(?:com|net|org|io|ai|dev|app)\b", re.IGNORECASE)
    for pack in _raw()["packs"]:
        for group in ("notices", "labels", "instructions"):
            for key, value in pack["texts"][group].items():
                assert not link.search(value), f"{pack['code']}: {group}.{key}"


def test_the_label_instructions_ask_for_bold_labels_on_their_own_line():
    for code in ("zh", "en", "it"):
        texts = _pack(code)["texts"]["instructions"]
        assert "**{general_knowledge}**" in texts["relevance_open"]
        assert "**{general_knowledge}**" in texts["general_knowledge"]
        assert "**{from_documents}**" in texts["web_separation"]
        assert "**{from_web}**" in texts["web_separation"]


def test_the_registry_still_loads_and_the_sidecar_copy_is_identical():
    LanguageRegistry.model_validate(_raw())
    assert SIDECAR_COPY.read_bytes() == REGISTRY_PATH.read_bytes()


# --- Phase 5.2.1 D-74, D-70: number format and computation-intent lexicon per pack


@pytest.mark.parametrize("field", ["number_format", "calc_intent_terms"])
def test_a_pack_without_number_format_or_intent_terms_fails(field):
    raw = _pack("en")
    del raw[field]
    with pytest.raises(ValidationError, match=field):
        LanguagePack.model_validate(raw)


@pytest.mark.parametrize("code", ["zh", "en", "it"])
def test_every_shipped_pack_has_a_number_format_and_intent_terms(code):
    pack = next(entry for entry in load_language_registry().packs if entry.code == code)
    fmt = pack.number_format
    assert fmt.group_separators and fmt.decimal_marks and fmt.magnitude_words
    assert not set(fmt.group_separators) & set(fmt.decimal_marks)
    assert all(1 <= entry.power <= 12 for entry in fmt.magnitude_words)
    assert 1 <= len(pack.calc_intent_terms) <= 40


def test_the_shipped_number_formats_follow_each_language_convention():
    by_code = {pack.code: pack.number_format for pack in load_language_registry().packs}
    assert by_code["en"].decimal_marks == ["."] and "," in by_code["en"].group_separators
    assert by_code["it"].decimal_marks == [","] and "." in by_code["it"].group_separators
    assert by_code["zh"].fullwidth_digits is True
    assert by_code["en"].fullwidth_digits is False and by_code["it"].fullwidth_digits is False
    powers = {code: {entry.word: entry.power for entry in fmt.magnitude_words} for code, fmt in by_code.items()}
    assert powers["en"] == {"thousand": 3, "million": 6, "billion": 9}
    assert powers["it"] == {"mila": 3, "milione": 6, "milioni": 6, "miliardo": 9, "miliardi": 9}
    assert powers["zh"] == {"千": 3, "万": 4, "亿": 8}


@pytest.mark.parametrize(
    ("change", "message"),
    [
        ({"group_separators": [".", ","], "decimal_marks": ["."]}, "group"),
        ({"group_separators": [",", " ", "'", "_", "."]}, "group_separators"),
        ({"magnitude_words": [{"word": "w", "power": 13}]}, "power"),
        ({"magnitude_words": [{"word": "w", "power": 0}]}, "power"),
        ({"decimal_marks": []}, "decimal_marks"),
        ({"group_separators": ["5"]}, "group_separators"),
        ({"magnitude_words": [{"word": "w", "power": 3}, {"word": "w", "power": 6}]}, "magnitude"),
    ],
)
def test_number_format_rejects_bad_values(change, message):
    raw = _pack("en")
    raw["number_format"] = {**raw["number_format"], **change}
    with pytest.raises(ValidationError, match=message):
        LanguagePack.model_validate(raw)


@pytest.mark.parametrize(
    ("terms", "message"),
    [
        (["t"] * 0 + [f"term{chr(97 + i % 26)}{chr(97 + i // 26)}" for i in range(41)], "calc_intent_terms"),
        (["x" * 25], "calc_intent_terms"),
        (["top 3"], "calc_intent_terms"),
        (["第３"], "calc_intent_terms"),
        ([], "calc_intent_terms"),
        (["sum", "sum"], "calc_intent_terms"),
        ([" sum"], "calc_intent_terms"),
    ],
)
def test_calc_intent_terms_rejects_bad_values(terms, message):
    raw = _pack("en")
    raw["calc_intent_terms"] = terms
    with pytest.raises(ValidationError, match=message):
        LanguagePack.model_validate(raw)


def test_the_calculation_block_instruction_carries_both_tags_in_every_language():
    for code in ("zh", "en", "it"):
        text = _pack(code)["texts"]["instructions"]["calculation_block"]
        assert text.index("{open}") < text.index("{close}"), code
        assert "JSON" in text, code


def test_the_calculation_instruction_asks_for_tool_steps_citations_and_fact_precedence():
    en = _pack("en")["texts"]["instructions"]["calculation"]
    for phrase in ("calculate tool", "mentally", "each item", "before the total", "cite", "fact tool"):
        assert phrase in en, phrase
    for code in ("zh", "it"):
        assert "calculate" in _pack(code)["texts"]["instructions"]["calculation"], code


def test_intent_terms_and_texts_hold_no_digit_or_example_number():
    for pack in _raw()["packs"]:
        for term in pack["calc_intent_terms"]:
            assert not re.search(r"\d", term), f"{pack['code']}: {term}"
        for key in ("calculation", "calculation_block"):
            assert not re.search(r"\d", pack["texts"]["instructions"][key]), f"{pack['code']}: {key}"
