import json
import re
from pathlib import Path

import pytest
from pydantic import ValidationError

from rag_sidecar.contracts.ingest import ProcessingProfileSet

REPO_ROOT = Path(__file__).resolve().parents[2]
PROFILES_PATH = REPO_ROOT / "config" / "rag" / "processing-profiles.json"

SIX_TYPES = {
    "general",
    "financial_report",
    "contract_legal",
    "invoice_receipt",
    "product_technical",
    "scanned_image",
}

D25_CLAUSE_PATTERNS = [
    r"第[一二三四五六七八九十百零〇\d]+条",
    r"^\d+(\.\d+)*[.)]?\s",
    r"^[（(][一二三四五六七八九十]+[)）]",
    r"^Art\.?\s*\d+",
    r"^Articolo\s+\d+",
    r"^Article\s+\d+",
]

# doc_type: (parser preference, chunker kind, max_tokens, overlap_tokens, repeat_table_header, extractors)
D14 = {
    "general": (["configured"], "markdown_sections", 512, 64, False, ["dates", "urls"]),
    "financial_report": (["configured"], "table_aware", 512, 64, True, ["dates", "financial"]),
    "contract_legal": (["configured"], "legal_clauses", 768, 0, False, ["dates"]),
    "invoice_receipt": (["docling", "configured"], "invoice", 1024, 0, True, ["invoice"]),
    "product_technical": (["configured"], "markdown_sections", 512, 64, False, ["urls"]),
    "scanned_image": (["docling"], "markdown_sections", 512, 64, False, ["dates"]),
}


def _raw():
    return json.loads(PROFILES_PATH.read_text(encoding="utf-8"))


def _validation_errors(raw):
    try:
        ProcessingProfileSet.model_validate(raw)
    except ValidationError as error:
        return [f"{'.'.join(str(part) for part in item['loc'])}: {item['msg']}" for item in error.errors()]
    return []


def _by_type():
    return {profile["doc_type"]: profile for profile in _raw()["profiles"]}


def test_file_holds_exactly_one_profile_per_d12_type_with_the_matching_id():
    profiles = _raw()["profiles"]
    assert len(profiles) == 6
    assert {profile["doc_type"] for profile in profiles} == SIX_TYPES
    assert sorted(profile["id"] for profile in profiles) == sorted(f"{name}@1" for name in SIX_TYPES)


def test_file_validates_against_the_pydantic_profile_set():
    assert _validation_errors(_raw()) == []


def test_file_is_already_in_normal_form_so_no_reserved_field_is_implicit():
    raw = _raw()
    assert ProcessingProfileSet.model_validate(raw).model_dump(mode="json") == raw
    for profile in raw["profiles"]:
        for reserved in ("min_tier", "max_tier", "parent_child"):
            assert reserved in profile and profile[reserved] is None, (profile["id"], reserved)


@pytest.mark.parametrize("doc_type", sorted(SIX_TYPES))
def test_profile_carries_the_d14_starting_values(doc_type):
    preference, kind, max_tokens, overlap, repeat_header, extractors = D14[doc_type]
    profile = _by_type()[doc_type]
    assert profile["parser"]["preference"] == preference
    assert profile["chunker"]["kind"] == kind
    assert profile["chunker"]["max_tokens"] == max_tokens
    assert profile["chunker"]["overlap_tokens"] == overlap
    assert profile["chunker"]["repeat_table_header"] is repeat_header
    assert profile["extractors"] == extractors
    assert profile["parser"]["ocr_languages"] == ["zh", "en", "it"]
    assert profile["scan_injection"] is True


def test_type_specific_parser_options_and_templates():
    profiles = _by_type()
    assert profiles["financial_report"]["parser"]["docling"]["table_mode"] == "accurate"
    assert profiles["scanned_image"]["parser"]["docling"]["force_full_page_ocr"] is True
    assert profiles["invoice_receipt"]["parser"]["docling"]["ocr"] is True
    assert profiles["invoice_receipt"]["embedding_text_template"] == {
        "version": 1,
        "header": "Invoice {invoice_number} | {supplier_name} | {supplier_tax_id}",
    }
    for doc_type, profile in profiles.items():
        if doc_type != "invoice_receipt":
            assert profile["embedding_text_template"]["header"] is None, doc_type


def test_contract_profile_holds_the_d25_clause_patterns_and_lead_ins_as_data():
    contract = _by_type()["contract_legal"]["chunker"]
    assert contract["clause_patterns"] == D25_CLAUSE_PATTERNS
    lead_ins = " ".join(contract["lead_in_phrases"]).lower()
    for phrase in ("但以下情况除外", "except as follows", "salvo quanto segue"):
        assert phrase in lead_ins
    for doc_type, profile in _by_type().items():
        if doc_type != "contract_legal":
            assert profile["chunker"]["clause_patterns"] == [] and profile["chunker"]["lead_in_phrases"] == []


def test_every_clause_pattern_compiles_with_re_and_matches_its_own_heading_shape():
    patterns = [re.compile(pattern, re.MULTILINE) for pattern in _by_type()["contract_legal"]["chunker"]["clause_patterns"]]
    headings = ["第五条 适用范围", "1.2 Scope", "（一）适用", "Art. 5 Scope", "Articolo 3 Oggetto", "Article 9 Term"]
    assert len(patterns) == len(headings)
    for pattern, heading in zip(patterns, headings, strict=True):
        assert pattern.search(heading), (pattern.pattern, heading)
    for pattern in patterns:
        assert not pattern.search("This agreement is entered into by the parties.")
