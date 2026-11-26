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
)
INSTRUCTION_KEYS = (
    "citation",
    "citation_per_sentence",
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
