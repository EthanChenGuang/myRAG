"""Phase 3.3 contracts (D-04): limits, validators, omit-when-unset and unchanged committed files."""

import importlib
import json
from pathlib import Path

import pytest
from pydantic import BaseModel, ValidationError

from rag_sidecar.contracts.ingest import ChunkerSettings, ProcessingProfileSet
from rag_sidecar.contracts.ingest_settings import IngestFingerprintParts
from rag_sidecar.contracts.languages import LanguageRegistry
from rag_sidecar.contracts.parse_eval import BackfillManifestEntry

REPO_ROOT = Path(__file__).resolve().parents[2]
RULE_SET_ID = "00000000-0000-4000-8000-000000000001"
HEX64 = "0" * 64


def _templated(name: str) -> type[BaseModel]:
    module = importlib.import_module("rag_sidecar.contracts.ingest")
    try:
        module = importlib.import_module("rag_sidecar.contracts.templated")
    except ModuleNotFoundError:
        pass
    model = getattr(module, name, None)
    assert model is not None, f"contract {name} is defined"
    return model


def _rejects(model: type[BaseModel], payload: dict) -> None:
    with pytest.raises(ValidationError):
        model.model_validate(payload)


# --- unchanged committed files (D-04, D-05)

CONFIG_COPIES = [REPO_ROOT / "config" / "rag", REPO_ROOT / "rag-sidecar" / "config" / "rag"]


@pytest.mark.parametrize("folder", CONFIG_COPIES, ids=["app", "sidecar"])
def test_processing_profiles_file_round_trips_unchanged(folder):
    raw = json.loads((folder / "processing-profiles.json").read_text(encoding="utf-8"))
    assert ProcessingProfileSet.model_validate(raw).model_dump(mode="json") == raw


@pytest.mark.parametrize("folder", CONFIG_COPIES, ids=["app", "sidecar"])
def test_language_packs_file_round_trips_unchanged(folder):
    raw = json.loads((folder / "language-packs.json").read_text(encoding="utf-8"))
    dumped = LanguageRegistry.model_validate(raw).model_dump(mode="json")
    assert dumped == raw
    assert "quantity" not in dumped


# --- unchanged stored objects


def _fingerprint_parts() -> dict:
    return {
        "parser_used": "docling",
        "parser_version": "2.0.0",
        "processing_profile_id": "general",
        "processing_profile_version": 1,
        "ocr_engine_codes": ["en"],
        "chunking_profile_id": "legacy",
        "lexical_version": 2,
        "embedding_text_version": 1,
        "embedding_profile_id": "example-embedding",
        "embedding_profile_version": 1,
        "language_pack_versions": {"en": 1, "it": 1, "zh": 1},
        "switches": {
            "language_aware_ingest": "off",
            "table_header_repeat": "profile",
            "table_row_serialization": "false",
            "caption_language": "en",
        },
    }


def test_fingerprint_parts_of_today_dump_unchanged():
    parts = _fingerprint_parts()
    dumped = IngestFingerprintParts.model_validate(parts).model_dump(mode="json")
    assert dumped == {**parts, "assumed_defaults": []}
    assert "chunk_prep" not in dumped


def test_fingerprint_chunk_prep_holds_strings_and_integers_only():
    boilerplate = {"mode": "both", "cleaner_version": 1, "rules_version": 2, "rule_fingerprint": HEX64}
    section_rules = {"rule_set_id": RULE_SET_ID, "version": 3}
    for chunk_prep in ({"boilerplate": boilerplate}, {"section_rules": section_rules}, {"boilerplate": boilerplate, "section_rules": section_rules}):
        parts = {**_fingerprint_parts(), "chunk_prep": chunk_prep}
        dumped = IngestFingerprintParts.model_validate(parts).model_dump(mode="json")
        assert dumped["chunk_prep"] == chunk_prep
    _rejects(IngestFingerprintParts, {**_fingerprint_parts(), "chunk_prep": {}})
    _rejects(IngestFingerprintParts, {**_fingerprint_parts(), "chunk_prep": {"boilerplate": {**boilerplate, "rules_version": 2.0}}})
    _rejects(IngestFingerprintParts, {**_fingerprint_parts(), "chunk_prep": {"section_rules": {**section_rules, "version": 1.5}}})
    _rejects(IngestFingerprintParts, {**_fingerprint_parts(), "chunk_prep": {"boilerplate": {**boilerplate, "mode": "off"}}})
    _rejects(IngestFingerprintParts, {**_fingerprint_parts(), "chunk_prep": {"boilerplate": {**boilerplate, "rule_fingerprint": "abc"}}})


def test_manifest_row_without_attributes_dumps_as_today():
    dumped = BackfillManifestEntry.model_validate({"source_key": "kb/doc-1", "path": "/data/doc-1.pdf"}).model_dump(mode="json")
    assert dumped == {"source_key": "kb/doc-1", "path": "/data/doc-1.pdf", "url": None, "doc_type": None}


def test_manifest_row_attributes_follow_the_value_limits():
    row = {"source_key": "kb/doc-1", "path": "/data/doc-1.pdf", "attributes": {"alpha_code": "X-1", "beta_label": ["one", "two"]}}
    assert BackfillManifestEntry.model_validate(row).model_dump(mode="json")["attributes"] == row["attributes"]
    _rejects(BackfillManifestEntry, {**row, "attributes": {"Alpha": "x"}})
    _rejects(BackfillManifestEntry, {**row, "attributes": {"alpha_code": "x" * 201}})


# --- chunker settings (D-04, D-17)


def _chunker(**overrides) -> dict:
    payload = {
        "kind": "markdown_sections",
        "max_tokens": 512,
        "overlap_tokens": 64,
        "repeat_table_header": True,
        "min_chunk_tokens": 32,
    }
    payload.update(overrides)
    return payload


def _resolved(**overrides) -> dict:
    payload = {
        "rule_set_id": RULE_SET_ID,
        "version": 1,
        "skip_toc": True,
        "toc_min_run": 3,
        "hits": {"Part A": {"name": "part_a", "level": 1, "restart": True}, "1. Lead": {"name": "lead", "level": 2, "restart": False}},
    }
    payload.update(overrides)
    return payload


def test_rule_sections_kind_and_omitted_section_rules():
    plain = ChunkerSettings.model_validate(_chunker(kind="rule_sections"))
    assert plain.kind == "rule_sections"
    assert "section_rules" not in plain.model_dump(mode="json")
    ruled = ChunkerSettings.model_validate(_chunker(kind="rule_sections", section_rules=_resolved()))
    assert ruled.model_dump(mode="json")["section_rules"] == _resolved()


def test_resolved_section_rules_bounds():
    resolved = _templated("ResolvedSectionRules")
    assert resolved.model_validate({"rule_set_id": RULE_SET_ID, "version": 1, "hits": {}}).toc_min_run == 3
    _rejects(resolved, _resolved(hits={"": {"name": "a", "level": 1}}))
    _rejects(resolved, _resolved(hits={" padded ": {"name": "a", "level": 1}}))
    _rejects(resolved, _resolved(hits={"x" * 1001: {"name": "a", "level": 1}}))
    _rejects(resolved, _resolved(hits={f"line {index}": {"name": "a", "level": 1} for index in range(5001)}))
    assert len(resolved.model_validate(_resolved(hits={f"line {index}": {"name": "a", "level": 1} for index in range(5000)})).hits) == 5000
    _rejects(resolved, _resolved(toc_min_run=1))
    _rejects(resolved, _resolved(toc_min_run=21))
    _rejects(resolved, _resolved(hits={"x": {"name": "a", "level": 7}}))
    _rejects(resolved, _resolved(hits={"x": {"name": "a" * 81, "level": 1}}))
    _rejects(resolved, _resolved(rule_set_id="not-a-uuid"))


# --- section rule sets (D-12, D-17, D-18)


def _heading(index: int = 0, **overrides) -> dict:
    payload = {"pattern": f"^Part {index}\\b", "flags": "u", "name": f"part_{index}", "level": 1}
    payload.update(overrides)
    return payload


def _rule_set(**overrides) -> dict:
    payload = {"name": "rule set one", "headings": [_heading(0)]}
    payload.update(overrides)
    return payload


def test_section_rule_set_accepts_bindings_and_defaults():
    model = _templated("SectionRuleSet")
    unbound = model.model_validate(_rule_set()).model_dump(mode="json")
    assert "doc_type" not in unbound and "source" not in unbound
    assert unbound["enabled"] is True and unbound["toc_min_run"] == 3 and unbound["skip_toc"] is True
    for binding in ({"doc_type": "general"}, {"source": "upload"}, {"doc_type": "general", "source": "upload"}):
        assert model.model_validate(_rule_set(**binding)).model_dump(mode="json").items() >= binding.items()
    assert len(model.model_validate(_rule_set(headings=[_heading(i) for i in range(60)])).headings) == 60


def test_section_rule_set_rejections():
    model = _templated("SectionRuleSet")
    _rejects(model, _rule_set(headings=[_heading(i) for i in range(61)]))
    _rejects(model, _rule_set(headings=[]))
    _rejects(model, _rule_set(headings=[_heading(0, flags="g")]))
    _rejects(model, _rule_set(headings=[_heading(0, flags="i")]))
    _rejects(model, _rule_set(headings=[_heading(0, pattern="^(a)\\1")]))
    _rejects(model, _rule_set(headings=[_heading(0), _heading(0, name="other")]))
    _rejects(model, _rule_set(headings=[_heading(0, pattern="x" * 201)]))
    _rejects(model, _rule_set(headings=[_heading(0, level=0)]))
    _rejects(model, _rule_set(name=""))
    _rejects(model, _rule_set(name="n" * 81))
    _rejects(model, _rule_set(doc_type="unknown_type"))
    _rejects(model, _rule_set(source="Upper Case"))
    _rejects(model, _rule_set(unexpected=True))


# --- boilerplate rules (D-16)


def test_boilerplate_rule_kinds():
    model = _templated("BoilerplateRule")
    line = {"name": "top line", "kind": "line", "pattern": "^\\W+$", "flags": "u"}
    fragment = {"name": "short fragment", "kind": "fragment", "max_length": 12, "min_page_share": 0.5}
    assert model.model_validate(line).model_dump(mode="json") == {**line, "enabled": True}
    assert model.model_validate(fragment).model_dump(mode="json") == {**fragment, "enabled": True}
    assert model.model_validate({**line, "doc_type": "general", "source": "upload"}).source == "upload"
    _rejects(model, {**line, "pattern": None})
    _rejects(model, {k: v for k, v in line.items() if k != "flags"})
    _rejects(model, {**line, "max_length": 5})
    _rejects(model, {**line, "min_page_share": 0.5})
    _rejects(model, {**line, "pattern": "(x)\\1"})
    _rejects(model, {**fragment, "pattern": "^x$"})
    _rejects(model, {**fragment, "flags": "u"})
    _rejects(model, {k: v for k, v in fragment.items() if k != "max_length"})
    _rejects(model, {**fragment, "max_length": 201})
    _rejects(model, {**fragment, "max_length": 0})
    _rejects(model, {**fragment, "min_page_share": 0})
    _rejects(model, {**fragment, "min_page_share": 1.01})
    assert model.model_validate({**fragment, "min_page_share": 1}).min_page_share == 1


# --- attributes (D-12, D-22, D-23)


def test_attribute_definition_and_schema():
    definition = _templated("AttributeDefinition")
    schema = _templated("AttributeSchema")
    dumped = definition.model_validate({"key": "alpha_code", "type": "code"}).model_dump(mode="json")
    assert dumped == {"key": "alpha_code", "type": "code", "filterable": False, "in_header": False, "in_identifier_index": False, "soft": False}
    assert definition.model_validate({"key": "alpha_code", "type": "code", "in_identifier_index": True}).in_identifier_index
    for kind in ("text", "text_list"):
        _rejects(definition, {"key": "beta_label", "type": kind, "in_identifier_index": True})
    for key in ("Alpha", "1alpha", "_alpha", "a" * 41, "alpha-code", ""):
        _rejects(definition, {"key": key, "type": "text"})
    assert definition.model_validate({"key": "a" * 40, "type": "text"}).key == "a" * 40
    _rejects(definition, {"key": "alpha", "type": "number"})
    defs = [{"key": f"key_{i}", "type": "text"} for i in range(30)]
    assert len(schema.model_validate({"definitions": defs}).definitions) == 30
    _rejects(schema, {"definitions": [*defs, {"key": "key_30", "type": "text"}]})
    _rejects(schema, {"definitions": [{"key": "alpha", "type": "text"}, {"key": "alpha", "type": "code"}]})


def test_attribute_values_limits():
    row = _templated("AttributeImportRow")
    ok = {"source_key": "kb/doc-1", "attributes": {"alpha_code": "X-1", "beta_label": ["v1", "v2"]}}
    assert row.model_validate(ok).model_dump(mode="json") == ok
    assert row.model_validate({**ok, "source": "upload"}).source == "upload"
    assert row.model_validate({**ok, "attributes": {"alpha_code": "x" * 200}}).attributes["alpha_code"] == "x" * 200
    assert len(row.model_validate({**ok, "attributes": {"beta_label": [f"v{i}" for i in range(50)]}}).attributes["beta_label"]) == 50
    for bad in (
        {"alpha_code": "x" * 201},
        {"alpha_code": ""},
        {"beta_label": [f"v{i}" for i in range(51)]},
        {"beta_label": []},
        {"beta_label": ["v1", "v1"]},
        {"alpha_code": 12},
        {"alpha_code": 1.5},
        {"alpha_code": True},
        {"alpha_code": {"nested": "x"}},
        {"beta_label": [["nested"]]},
        {f"key_{i}": "x" for i in range(31)},
        {"Bad-Key": "x"},
    ):
        _rejects(row, {**ok, "attributes": bad})
    assert len(row.model_validate({**ok, "attributes": {f"key_{i}": "x" for i in range(30)}}).attributes) == 30
    _rejects(row, {"source_key": "", "attributes": {"alpha_code": "x"}})
    _rejects(row, {**ok, "extra": 1})


def test_header_template_and_rules_file():
    header = _templated("AttributeHeaderTemplate")
    assert header.model_validate({"template": "{alpha_code} {beta_label}", "version": 1}).version == 1
    _rejects(header, {"template": "", "version": 1})
    _rejects(header, {"template": "x" * 201, "version": 1})
    _rejects(header, {"template": "x", "version": 0})
    rules = _templated("TenantRulesFile")
    empty = rules.model_validate({"schema_version": 1}).model_dump(mode="json")
    assert empty == {"schema_version": 1, "section_rule_sets": [], "boilerplate_rules": []}
    fragment = {"kind": "fragment", "max_length": 10, "min_page_share": 0.5}
    sets = [_rule_set(name=f"set {i}") for i in range(10)]
    plates = [{**fragment, "name": f"rule {i}"} for i in range(40)]
    assert len(rules.model_validate({"section_rule_sets": sets, "boilerplate_rules": plates}).boilerplate_rules) == 40
    _rejects(rules, {"section_rule_sets": [*sets, _rule_set(name="set 10")]})
    _rejects(rules, {"boilerplate_rules": [*plates, {**fragment, "name": "rule 40"}]})
    _rejects(rules, {"section_rule_sets": [_rule_set(), _rule_set()]})
    _rejects(rules, {"boilerplate_rules": [{**fragment, "name": "same"}, {**fragment, "name": "same"}]})
    _rejects(rules, {"schema_version": 2})


# --- numbers-only config files (D-13, D-29, D-30)


def _boilerplate_config(**overrides) -> dict:
    payload = {
        "schema_version": 1,
        "rules_version": 1,
        "page_share": 0.6,
        "edge_lines": 3,
        "max_line_tokens": 12,
        "min_pages": 3,
        "fragment_max_length": 12,
        "fragment_page_share": 0.6,
        "review_share": 0.3,
    }
    payload.update(overrides)
    return payload


def test_boilerplate_rules_config_numbers_only():
    model = _templated("BoilerplateRulesConfig")
    assert model.model_validate(_boilerplate_config()).model_dump(mode="json") == _boilerplate_config()
    assert model.model_validate(_boilerplate_config(page_share=1)).page_share == 1
    for bad in (
        {"page_share": 0},
        {"page_share": 1.1},
        {"review_share": "0.3"},
        {"edge_lines": 0},
        {"edge_lines": 2.5},
        {"rules_version": 0},
        {"max_line_tokens": True},
        {"unknown": 1},
    ):
        _rejects(model, _boilerplate_config(**bad))


def test_attribute_filter_config_numbers_only():
    model = _templated("AttributeFilterConfig")
    ok = {"schema_version": 1, "rules_version": 1, "soft_weight": 0.5, "id_cap": 2000}
    assert model.model_validate(ok).model_dump(mode="json") == ok
    for bad in ({"id_cap": 0}, {"soft_weight": 0}, {"soft_weight": 1.5}, {"rules_version": 0}, {"id_cap": "2000"}, {"label": 1}):
        _rejects(model, {**ok, **bad})


def test_boilerplate_report_counts():
    model = _templated("BoilerplateReport")
    ok = {"cleaner_version": 1, "rules_version": 1, "lines_removed": 4, "tokens_removed": 20, "share": 0.05}
    assert model.model_validate(ok).model_dump(mode="json") == ok
    for bad in ({"lines_removed": -1}, {"share": 1.5}, {"cleaner_version": 0}, {"removed_text": "x"}):
        _rejects(model, {**ok, **bad})


# --- language-pack registry quantity block (D-31, D-32)


def _registry() -> dict:
    return json.loads((REPO_ROOT / "config" / "rag" / "language-packs.json").read_text(encoding="utf-8"))


def _quantity(**overrides) -> dict:
    payload = {"unit_symbols": ["ab", "cd"], "decimal_separators": [".", ","], "grouping_separators": [",", " "]}
    payload.update(overrides)
    return payload


def test_registry_quantity_block():
    registry = {**_registry(), "quantity": _quantity()}
    assert LanguageRegistry.model_validate(registry).model_dump(mode="json")["quantity"] == _quantity()
    assert LanguageRegistry.model_validate({**_registry(), "quantity": _quantity(unit_symbols=[f"u{chr(97 + i % 26)}{chr(97 + i // 26)}" for i in range(200)])})
    for bad in (
        {"unit_symbols": []},
        {"unit_symbols": ["ab", "ab"]},
        {"unit_symbols": ["a b"]},
        {"unit_symbols": ["a1"]},
        {"unit_symbols": ["abcdefghi"]},
        {"unit_symbols": [f"x{chr(97 + i % 26)}{chr(97 + i // 26)}" for i in range(201)]},
        {"decimal_separators": []},
        {"decimal_separators": [".."]},
        {"decimal_separators": ["1"]},
        {"decimal_separators": [".", "."]},
        {"grouping_separators": [",", ".", " ", "'", "_"]},
    ):
        _rejects(LanguageRegistry, {**_registry(), "quantity": _quantity(**bad)})
