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
    InvoiceExtractRequest,
    InvoiceFields,
    ParseJobAccepted,
    ParseJobRequest,
    ParseJobState,
    ParseResult,
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


def _docling(**changes):
    base = {
        "ocr": True,
        "force_full_page_ocr": False,
        "table_mode": "accurate",
        "heading_hierarchy": True,
        "generate_picture_images": True,
    }
    base.update(changes)
    return base


def _parse_request(**changes):
    base = {
        "profile_id": "financial_report@1",
        "profile_version": 1,
        "docling": _docling(),
        "ocr_languages": ["zh", "en", "it"],
        "tokenizer": "cl100k_base",
        "max_tokens": 512,
        "repeat_table_header": True,
    }
    base.update(changes)
    return base


def _chunk(**changes):
    base = {
        "text": "Revenue grew in the second quarter.",
        "contextualized_text": "Report > Results\nRevenue grew in the second quarter.",
        "headings": ["Report", "Results"],
        "pages": [1],
        "is_table": False,
        "table_header": None,
    }
    base.update(changes)
    return base


def _table_chunk():
    return _chunk(
        text="| Item | Amount |\n| --- | --- |\n| Fees | 10 |",
        contextualized_text="Report > Tables\n| Item | Amount |\n| --- | --- |\n| Fees | 10 |",
        headings=["Report", "Tables"],
        pages=[2, 3],
        is_table=True,
        table_header="| Item | Amount |\n| --- | --- |",
    )


def _parse_result(**changes):
    base = {
        "markdown": "# Report\n\nRevenue grew in the second quarter.\n",
        "chunks": [_chunk(), _table_chunk()],
        "pictures": [{"page": 2, "bbox": [10.0, 20.0, 110.0, 220.0], "image_ref": "picture-1.png", "page_area_share": 0.12}],
        "page_count": 3,
        "language": "en",
        "parser": "docling",
        "parser_version": "0.0.0-test",
        "warnings": [],
        "partial": False,
        "artifacts": ["docling.json", "picture-1.png"],
        "text_layer_page_share": 1.0,
    }
    base.update(changes)
    return base


def _party(**changes):
    base = {"name": "Synthetic Supplier Ltd", "tax_id": "91000000MA0000000N", "tax_id_scheme": "cn_uscc"}
    base.update(changes)
    return base


def _invoice(**changes):
    base = {
        "invoice_number": "INV-2026-0001",
        "issue_date": "2026-01-31",
        "due_date": "2026-02-28",
        "supplier": _party(),
        "buyer": _party(name="Esempio Acquirente S.r.l.", tax_id="99999999990", tax_id_scheme="it_iva"),
        "currency": "EUR",
        "net_total": "100.00",
        "tax_total": "22.00",
        "gross_total": "122.00",
        "line_items": [
            {"description": "Consulting", "quantity": "2", "unit_price": "50.00", "amount": "100.00", "tax_rate": "22"}
        ],
        "confidence": 0.9,
        "errors": [],
    }
    base.update(changes)
    return base


def test_parse_job_request_accepts_a_full_request_and_defaults_the_optional_fields():
    parsed = ParseJobRequest.model_validate(_parse_request())
    assert parsed.input_format is None and parsed.page_cap is None
    assert parsed.tokenizer == "cl100k_base"
    for input_format in ("pdf", "docx", "html", "image", "json_docling"):
        assert ParseJobRequest.model_validate(_parse_request(input_format=input_format, page_cap=50)).page_cap == 50


@pytest.mark.parametrize(
    "changes",
    [
        {"tokenizer": "p50k_base"},
        {"input_format": "xlsx"},
        {"max_tokens": 63},
        {"max_tokens": 4097},
        {"page_cap": 0},
        {"profile_version": 0},
        {"profile_id": "bad id"},
        {"ocr_languages": []},
        {"ocr_languages": ["fr"]},
        {"docling": _docling(table_mode="slow")},
        {"rogue": 1},
    ],
)
def test_parse_job_request_rejects_invalid_values(changes):
    with pytest.raises(ValidationError):
        ParseJobRequest.model_validate(_parse_request(**changes))


def test_parse_job_accepted_is_only_a_safe_job_id():
    assert ParseJobAccepted.model_validate({"job_id": "job_0123-abc"}).job_id == "job_0123-abc"
    for bad in ("", "../etc", "a/b", "x" * 65):
        with pytest.raises(ValidationError):
            ParseJobAccepted.model_validate({"job_id": bad})
    with pytest.raises(ValidationError):
        ParseJobAccepted.model_validate({"job_id": "job-1", "rogue": 1})


@pytest.mark.parametrize("status", ["queued", "running", "expired"])
def test_parse_job_state_without_result_for_non_terminal_states(status):
    state = ParseJobState.model_validate({"job_id": "job-1", "status": status})
    assert state.result is None and state.error_class is None


def test_parse_job_state_succeeded_carries_the_result_and_failed_carries_an_error_class():
    done = ParseJobState.model_validate({"job_id": "job-1", "status": "succeeded", "result": _parse_result()})
    assert done.result is not None and done.result.parser == "docling"
    failed = ParseJobState.model_validate({"job_id": "job-1", "status": "failed", "error_class": "ocr_failed"})
    assert failed.error_class == "ocr_failed"


@pytest.mark.parametrize(
    "state",
    [
        {"status": "succeeded"},
        {"status": "succeeded", "result": _parse_result(), "error_class": "ocr_failed"},
        {"status": "failed"},
        {"status": "failed", "error_class": "ocr_failed", "result": _parse_result()},
        {"status": "running", "result": _parse_result()},
        {"status": "paused"},
        {"status": "failed", "error_class": "Has Spaces"},
    ],
)
def test_parse_job_state_rejects_inconsistent_states(state):
    with pytest.raises(ValidationError):
        ParseJobState.model_validate({"job_id": "job-1", **state})


def test_parse_result_round_trips_with_a_table_chunk_that_keeps_its_header_rows():
    parsed = ParseResult.model_validate(_parse_result())
    table = parsed.chunks[1]
    assert table.is_table and table.table_header == "| Item | Amount |\n| --- | --- |"
    assert table.text.startswith(table.table_header)
    dumped = parsed.model_dump(mode="json")
    assert ParseResult.model_validate(dumped) == parsed
    assert dumped["pictures"][0]["page_area_share"] == 0.12


def test_parse_result_defaults_for_the_optional_fields():
    minimal = _parse_result()
    for key in ("warnings", "partial", "artifacts", "text_layer_page_share", "language"):
        del minimal[key]
    parsed = ParseResult.model_validate(minimal)
    assert parsed.warnings == [] and parsed.partial is False and parsed.artifacts == []
    assert parsed.text_layer_page_share is None and parsed.language is None
    assert {"docling", "llamaparse", "text"} == {
        ParseResult.model_validate(_parse_result(parser=parser)).parser for parser in ("docling", "llamaparse", "text")
    }


@pytest.mark.parametrize(
    "changes",
    [
        {"parser": "tesseract"},
        {"rogue": 1},
        {"page_count": -1},
        {"text_layer_page_share": -0.1},
        {"text_layer_page_share": 1.1},
        {"artifacts": ["../secret"]},
        {"artifacts": ["a/b.png"]},
        {"chunks": [_chunk(rogue=1)]},
        {"chunks": [_chunk(pages=[0])]},
        {"chunks": [_chunk(table_header="| a |\n| - |")]},
        {"pictures": [{"page": 1, "bbox": [1.0, 2.0, 3.0], "image_ref": "p.png", "page_area_share": 0.1}]},
        {"pictures": [{"page": 0, "bbox": [1.0, 2.0, 3.0, 4.0], "image_ref": "p.png", "page_area_share": 0.1}]},
        {"pictures": [{"page": 1, "bbox": [1.0, 2.0, 3.0, 4.0], "image_ref": "../p.png", "page_area_share": 0.1}]},
        {"pictures": [{"page": 1, "bbox": [1.0, 2.0, 3.0, 4.0], "image_ref": "p.png", "page_area_share": 1.5}]},
    ],
)
def test_parse_result_rejects_invalid_values(changes):
    with pytest.raises(ValidationError):
        ParseResult.model_validate(_parse_result(**changes))


def test_invoice_extract_request_takes_markdown_tables_and_an_optional_language_hint():
    parsed = InvoiceExtractRequest.model_validate({"markdown": "Fattura n. 1", "tables": ["| a |\n| - |"]})
    assert parsed.language_hint is None and parsed.tables == ["| a |\n| - |"]
    assert InvoiceExtractRequest.model_validate({"markdown": "发票", "language_hint": "zh"}).tables == []


@pytest.mark.parametrize(
    "data",
    [
        {"markdown": ""},
        {"markdown": "x", "language_hint": "fr"},
        {"markdown": "x", "tables": [1]},
        {"markdown": "x", "rogue": 1},
        {"tables": []},
    ],
)
def test_invoice_extract_request_rejects_invalid_values(data):
    with pytest.raises(ValidationError):
        InvoiceExtractRequest.model_validate(data)


def test_invoice_fields_round_trip_with_decimal_strings_and_both_tax_schemes():
    parsed = InvoiceFields.model_validate(_invoice())
    assert parsed.supplier.tax_id_scheme == "cn_uscc" and parsed.buyer.tax_id_scheme == "it_iva"
    dumped = parsed.model_dump(mode="json")
    assert dumped["issue_date"] == "2026-01-31" and dumped["gross_total"] == "122.00"
    assert InvoiceFields.model_validate(dumped) == parsed


def test_invoice_fields_allow_every_field_to_be_missing_but_the_confidence():
    empty = InvoiceFields.model_validate({"confidence": 0.0})
    assert empty.invoice_number is None and empty.issue_date is None and empty.currency is None
    assert empty.supplier.tax_id_scheme == "unknown" and empty.buyer.name is None
    assert empty.line_items == [] and empty.errors == []


@pytest.mark.parametrize("amount", ["-12.5", "1200", "1200.0000", "0"])
def test_invoice_amounts_accept_plain_decimal_strings(amount):
    assert InvoiceFields.model_validate(_invoice(gross_total=amount)).gross_total == amount


@pytest.mark.parametrize("amount", ["1,200.00", "12.34567", "1e3", " 5", "", 12.5, 12])
def test_invoice_amounts_reject_everything_else(amount):
    with pytest.raises(ValidationError):
        InvoiceFields.model_validate(_invoice(gross_total=amount))
    with pytest.raises(ValidationError):
        InvoiceFields.model_validate(
            _invoice(line_items=[{"description": "x", "quantity": "1", "unit_price": amount, "amount": "1", "tax_rate": None}])
        )


@pytest.mark.parametrize(
    "changes",
    [
        {"currency": "eur"},
        {"currency": "EURO"},
        {"issue_date": "2026-02-30"},
        {"issue_date": "31/01/2026"},
        {"due_date": "2026-13-01"},
        {"supplier": _party(tax_id_scheme="us_ein")},
        {"confidence": 1.5},
        {"confidence": -0.1},
        {"rogue": 1},
        {"line_items": [{"description": "x", "rogue": 1}]},
    ],
)
def test_invoice_fields_reject_invalid_values(changes):
    with pytest.raises(ValidationError):
        InvoiceFields.model_validate(_invoice(**changes))


def test_wire_contracts_are_registered_with_the_right_export_mode_and_synthetic_samples():
    modes = {model.__name__: mode for model, mode in CONTRACTS}
    expected = {
        "ParseJobRequest": "validation",
        "InvoiceExtractRequest": "validation",
        "ParseJobAccepted": "serialization",
        "ParseJobState": "serialization",
        "ParseResult": "serialization",
        "InvoiceFields": "serialization",
    }
    for name, mode in expected.items():
        assert modes.get(name) == mode, name
    built = build_samples()["samples"]
    for name in expected:
        assert name in built, name
    result = ParseResult.model_validate(built["ParseResult"])
    assert len(result.chunks) == 2 and [chunk.is_table for chunk in result.chunks] == [False, True]
    assert result.chunks[1].table_header is not None and result.chunks[1].text.startswith(result.chunks[1].table_header)
    invoice = InvoiceFields.model_validate(built["InvoiceFields"])
    assert {invoice.supplier.tax_id, invoice.buyer.tax_id} == {"91000000MA0000000N", "99999999990"}
