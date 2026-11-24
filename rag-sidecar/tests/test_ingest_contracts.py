import copy
import json
from typing import get_args

import pytest
from pydantic import ValidationError

from rag_sidecar.contracts.ingest import (
    DocType,
    DocTypeChoice,
    DocTypeDetection,
    InjectionRuleSet,
    ProcessingProfile,
    ProcessingProfileSet,
)
from rag_sidecar.contracts.samples import build_samples
from rag_sidecar.export_schemas import CONTRACTS

SIX_TYPES = [
    "general",
    "financial_report",
    "contract_legal",
    "invoice_receipt",
    "product_technical",
    "scanned_image",
]


def _profile(doc_type="general", **changes):
    base = {
        "id": f"{doc_type}@1",
        "version": 1,
        "doc_type": doc_type,
        "parser": {
            "preference": ["configured"],
            "docling": {
                "ocr": True,
                "force_full_page_ocr": False,
                "table_mode": "accurate",
                "heading_hierarchy": True,
                "generate_picture_images": True,
            },
            "ocr_languages": ["zh", "en", "it"],
        },
        "chunker": {
            "kind": "markdown_sections",
            "max_tokens": 512,
            "overlap_tokens": 64,
            "repeat_table_header": False,
            "min_chunk_tokens": 32,
            "clause_patterns": [],
            "lead_in_phrases": [],
        },
        "extractors": ["dates", "urls"],
        "embedding_text_template": {"version": 1},
        "scan_injection": True,
    }
    base.update(changes)
    return base


def _with(base, path, value):
    out = copy.deepcopy(base)
    node = out
    keys = path.split(".")
    for key in keys[:-1]:
        node = node[key]
    node[keys[-1]] = value
    return out


def _rule(rule_id="en-ignore-previous", **changes):
    base = {
        "id": rule_id,
        "language": "en",
        "pattern": "ignore previous instructions",
        "kind": "phrase",
        "severity": "high",
    }
    base.update(changes)
    return base


def _profile_set():
    return {"schema_version": 1, "profiles": [_profile(doc_type) for doc_type in SIX_TYPES]}


def test_doc_types_are_the_six_d12_identifiers_and_the_choice_adds_auto():
    assert sorted(get_args(DocType)) == sorted(SIX_TYPES)
    assert sorted(get_args(DocTypeChoice)) == sorted([*SIX_TYPES, "auto"])


def test_valid_profile_round_trips():
    profile = ProcessingProfile.model_validate(_profile())
    dumped = profile.model_dump(mode="json")
    assert dumped["id"] == "general@1"
    assert dumped["parser"]["preference"] == ["configured"]
    assert dumped["chunker"]["max_tokens"] == 512
    assert dumped["min_tier"] is None and dumped["max_tier"] is None and dumped["parent_child"] is None
    assert ProcessingProfile.model_validate(dumped) == profile


@pytest.mark.parametrize(
    "path,value",
    [
        ("version", 0),
        ("doc_type", "memo"),
        ("parser.preference", []),
        ("parser.preference", ["tesseract"]),
        ("parser.docling.table_mode", "slow"),
        ("parser.ocr_languages", ["zh", "fr"]),
        ("parser.ocr_languages", []),
        ("parser.ocr_languages", ["zh", "zh"]),
        ("chunker.kind", "sentences"),
        ("chunker.max_tokens", 63),
        ("chunker.max_tokens", 4097),
        ("chunker.overlap_tokens", -1),
        ("chunker.overlap_tokens", 512),
        ("chunker.min_chunk_tokens", -1),
        ("extractors", ["dates", "tables"]),
        ("extractors", ["dates", "dates"]),
        ("embedding_text_template.version", 0),
        ("min_tier", "cheap"),
        ("max_tier", "ultra"),
    ],
)
def test_profile_rejects_invalid_values(path, value):
    with pytest.raises(ValidationError):
        ProcessingProfile.model_validate(_with(_profile(), path, value))


@pytest.mark.parametrize("path", ["id", "parser", "chunker", "extractors", "embedding_text_template", "scan_injection"])
def test_profile_requires_its_core_fields(path):
    data = _profile()
    del data[path]
    with pytest.raises(ValidationError):
        ProcessingProfile.model_validate(data)


@pytest.mark.parametrize("bad_id", ["general@2", "contract_legal@1", "general", "general@01"])
def test_profile_id_must_equal_doc_type_at_version(bad_id):
    with pytest.raises(ValidationError):
        ProcessingProfile.model_validate(_profile(id=bad_id))


def test_profile_rejects_unknown_keys_at_every_level():
    for path in ["rogue", "parser.rogue", "parser.docling.rogue", "chunker.rogue", "embedding_text_template.rogue"]:
        with pytest.raises(ValidationError):
            ProcessingProfile.model_validate(_with(_profile(), path, 1))


def test_profile_tiers_must_be_ordered_when_both_present():
    ok = ProcessingProfile.model_validate(_profile(min_tier="fast", max_tier="premium"))
    assert (ok.min_tier, ok.max_tier) == ("fast", "premium")
    assert ProcessingProfile.model_validate(_profile(min_tier="structured")).max_tier is None
    with pytest.raises(ValidationError):
        ProcessingProfile.model_validate(_profile(min_tier="premium", max_tier="fast"))


def test_parent_child_is_optional_and_reserved():
    ok = ProcessingProfile.model_validate(_profile(parent_child={"parent_max_tokens": 2048, "child_max_tokens": 256}))
    assert ok.parent_child is not None and ok.parent_child.child_max_tokens == 256
    with pytest.raises(ValidationError):
        ProcessingProfile.model_validate(_profile(parent_child={"parent_max_tokens": 128, "child_max_tokens": 256}))


def test_profile_set_accepts_exactly_one_profile_per_type():
    parsed = ProcessingProfileSet.model_validate(_profile_set())
    assert sorted(profile.doc_type for profile in parsed.profiles) == sorted(SIX_TYPES)


def test_profile_set_rejects_a_missing_type():
    data = _profile_set()
    data["profiles"] = data["profiles"][:-1]
    with pytest.raises(ValidationError):
        ProcessingProfileSet.model_validate(data)


def test_profile_set_rejects_a_repeated_type():
    data = _profile_set()
    data["profiles"].append(_profile("general"))
    with pytest.raises(ValidationError):
        ProcessingProfileSet.model_validate(data)


def test_profile_set_rejects_a_repeat_that_hides_a_missing_type():
    data = _profile_set()
    data["profiles"][-1] = _profile("general")
    with pytest.raises(ValidationError):
        ProcessingProfileSet.model_validate(data)


def test_injection_rule_set_accepts_phrases_and_regexes_in_every_language():
    parsed = InjectionRuleSet.model_validate(
        {
            "rules": [
                _rule("en-ignore-previous"),
                _rule("zh-ignore-previous", language="zh", pattern="忽略之前的指令"),
                _rule("it-ignore-previous", language="it", pattern="ignora le istruzioni precedenti", severity="medium"),
                _rule("any-you-are-now", language="any", pattern=r"you\s+are\s+now\b", kind="regex", severity="low"),
            ]
        }
    )
    assert [rule.language for rule in parsed.rules] == ["en", "zh", "it", "any"]


def test_injection_rule_set_rejects_duplicate_ids():
    with pytest.raises(ValidationError):
        InjectionRuleSet.model_validate({"rules": [_rule("dup"), _rule("dup", pattern="disregard the above")]})


@pytest.mark.parametrize("kind", ["regex", "phrase"])
def test_injection_rule_rejects_a_pattern_over_200_characters(kind):
    InjectionRuleSet.model_validate({"rules": [_rule(kind=kind, pattern="a" * 200)]})
    with pytest.raises(ValidationError):
        InjectionRuleSet.model_validate({"rules": [_rule(kind=kind, pattern="a" * 201)]})


@pytest.mark.parametrize("pattern", [r"(a)\1", r"(?P<x>a)(?P=x)", r"(?<x>a)\k<x>", r"(ab)(cd)\2", r"x\\\1"])
def test_injection_regex_rejects_backreferences(pattern):
    with pytest.raises(ValidationError):
        InjectionRuleSet.model_validate({"rules": [_rule(kind="regex", pattern=pattern)]})


@pytest.mark.parametrize("pattern", [r"\d+", r"a\\1", r"(?:ab|cd)\s*now", r"\bignore\b"])
def test_injection_regex_accepts_patterns_without_backreferences(pattern):
    InjectionRuleSet.model_validate({"rules": [_rule(kind="regex", pattern=pattern)]})


def test_backreference_check_does_not_apply_to_plain_phrases():
    InjectionRuleSet.model_validate({"rules": [_rule(kind="phrase", pattern=r"use \1 here")]})


@pytest.mark.parametrize(
    "field,value",
    [
        ("kind", "glob"),
        ("severity", "critical"),
        ("language", "fr"),
        ("pattern", ""),
        ("id", "Not A Slug"),
    ],
)
def test_injection_rule_rejects_invalid_values(field, value):
    with pytest.raises(ValidationError):
        InjectionRuleSet.model_validate({"rules": [_rule(**{field: value})]})


def test_doc_type_detection_accepts_rules_and_llm_methods():
    for method in ("rules", "llm"):
        parsed = DocTypeDetection.model_validate(
            {"doc_type": "invoice_receipt", "confidence": 0.8, "signals": ["keyword:invoice"], "method": method}
        )
        assert parsed.method == method


@pytest.mark.parametrize(
    "changes",
    [
        {"confidence": -0.01},
        {"confidence": 1.01},
        {"method": "regex"},
        {"doc_type": "auto"},
        {"doc_type": "memo"},
        {"rogue": 1},
    ],
)
def test_doc_type_detection_rejects_invalid_values(changes):
    data = {"doc_type": "general", "confidence": 0.5, "signals": [], "method": "rules"}
    data.update(changes)
    with pytest.raises(ValidationError):
        DocTypeDetection.model_validate(data)


def test_profile_contracts_are_registered_for_export_with_samples():
    modes = {model.__name__: mode for model, mode in CONTRACTS}
    for name in ("ProcessingProfileSet", "DocTypeDetection", "InjectionRuleSet"):
        assert modes.get(name) == "validation", name
    samples = build_samples()["samples"]
    for name in ("ProcessingProfileSet", "DocTypeDetection", "InjectionRuleSet"):
        assert name in samples, name
    parsed = ProcessingProfileSet.model_validate(samples["ProcessingProfileSet"])
    assert sorted(profile.doc_type for profile in parsed.profiles) == sorted(SIX_TYPES)


def test_exported_schema_carries_the_length_cap_so_zod_enforces_it_too():
    schema = json.dumps(InjectionRuleSet.model_json_schema(mode="validation"))
    assert '"maxLength": 200' in schema
