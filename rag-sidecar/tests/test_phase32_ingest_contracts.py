"""Phase 3.2 ingestion-side contracts (plan 03.2-05, D-49).

Models are looked up by name in the exported CONTRACTS list, so a missing model fails an assertion.
"""

import copy

import pytest
from pydantic import BaseModel, ValidationError

from rag_sidecar.contracts.samples import build_samples
from rag_sidecar.export_schemas import CONTRACTS

QUARANTINE_KINDS = ("injection_rule", "hidden_text", "untrusted_link", "invoice_extraction")


def _model(name: str) -> type[BaseModel]:
    by_name = {model.__name__: model for model, _ in CONTRACTS}
    assert name in by_name, f"{name} is not exported in CONTRACTS"
    return by_name[name]


def _variants(model: str) -> dict[str, dict]:
    return {key: entry["value"] for key, entry in build_samples()["variants"].items() if entry["model"] == model}


def _hidden_text_reason() -> dict:
    return {
        "kind": "hidden_text",
        "detail": "2 hidden spans",
        "spans": [
            {"page": 1, "text": "Synthetic hidden sentence one.", "reason": "color_near_background"},
            {"page": 2, "text": "Synthetic hidden sentence two.", "reason": "font_too_small"},
        ],
        "checker_version": "hidden-text@1",
    }


def test_hidden_text_reason_with_two_spans_validates():
    reason = _model("QuarantineReason").model_validate(_hidden_text_reason())
    dumped = reason.model_dump(mode="json")
    assert dumped["kind"] == "hidden_text"
    assert len(dumped["spans"]) == 2
    assert dumped["unlocated"] == 0


def test_untrusted_link_reason_needs_targets():
    model = _model("QuarantineReason")
    valid = {
        "kind": "untrusted_link",
        "detail": "1 target outside the allowlist",
        "targets": ["outside.example.net"],
        "checker_version": "link-check@1",
    }
    assert model.model_validate(valid).model_dump(mode="json")["targets"] == ["outside.example.net"]
    with pytest.raises(ValidationError):
        model.model_validate({**valid, "targets": []})
    without = dict(valid)
    del without["targets"]
    with pytest.raises(ValidationError):
        model.model_validate(without)


@pytest.mark.parametrize(
    "mutate",
    [
        pytest.param(lambda value: value.update(kind="other"), id="unknown_kind"),
        pytest.param(lambda value: (value.pop("spans"), value.update(targets=["outside.example.net"])), id="targets_only"),
        pytest.param(lambda value: value.update(spans=[]), id="empty_spans"),
        pytest.param(lambda value: value.update(unexpected_key=1), id="extra_key"),
        pytest.param(lambda value: value.update(unlocated=-1), id="negative_unlocated"),
        pytest.param(lambda value: value["spans"][0].update(page=0), id="page_zero"),
    ],
)
def test_quarantine_reason_rejects(mutate):
    value = copy.deepcopy(_hidden_text_reason())
    mutate(value)
    with pytest.raises(ValidationError):
        _model("QuarantineReason").model_validate(value)


def test_quarantine_reason_has_one_named_variant_per_kind():
    model = _model("QuarantineReason")
    variants = _variants("QuarantineReason")
    kinds = sorted(value["kind"] for value in variants.values())
    assert kinds == sorted(QUARANTINE_KINDS)
    for key, value in variants.items():
        assert key == f"QuarantineReason:{value['kind']}"
        assert model.model_validate(value).model_dump(mode="json") == value


TASK2_MODELS = (
    "LanguageSettings",
    "SettingsClassification",
    "IngestFingerprintParts",
    "FingerprintImpact",
    "HiddenTextRequest",
    "HiddenTextReport",
    "HiddenTextRules",
    "LinkCheckResult",
    "UploadApproval",
)


def _sample(name: str) -> dict:
    samples = build_samples()["samples"]
    assert name in samples, f"no sample for {name}"
    return copy.deepcopy(samples[name])


def _rejects(name: str, value: dict) -> None:
    with pytest.raises(ValidationError):
        _model(name).model_validate(value)


@pytest.mark.parametrize("name", TASK2_MODELS)
def test_task2_model_is_exported_with_a_valid_sample(name):
    model = _model(name)
    sample = _sample(name)
    assert model.model_validate(sample).model_dump(mode="json") == sample
    _rejects(name, {**sample, "unexpected_key": 1})


def test_language_settings_rules():
    unset = {"configured": False, "languages": [], "primary": None, "monolingual": False}
    assert _model("LanguageSettings").model_validate(unset).configured is False
    one = {"configured": True, "languages": ["en"], "primary": "en", "monolingual": True}
    assert _model("LanguageSettings").model_validate(one).monolingual is True
    _rejects("LanguageSettings", {"configured": True, "languages": [], "primary": None, "monolingual": False})
    _rejects("LanguageSettings", {**one, "languages": ["en", "en"], "monolingual": False})
    _rejects("LanguageSettings", {**one, "languages": ["en", "xx"], "monolingual": False})
    _rejects("LanguageSettings", {**one, "primary": "it"})
    _rejects("LanguageSettings", {**one, "monolingual": False})
    _rejects("LanguageSettings", {**unset, "languages": ["en"]})
    _rejects("LanguageSettings", {**unset, "primary": "en"})


def test_settings_classification_rules():
    base = {"schema_version": 1, "entries": [{"name": "RAG_EXAMPLE_PART", "side": "ingestion", "mechanism": "rechunk"}]}
    _model("SettingsClassification").model_validate(base)
    for side in ("ingestion", "both"):
        _rejects("SettingsClassification", {**base, "entries": [{"name": "RAG_EXAMPLE_PART", "side": side}]})
    _rejects(
        "SettingsClassification",
        {**base, "entries": [{"name": "RAG_EXAMPLE_QUERY", "side": "query", "mechanism": "reembed"}]},
    )
    _rejects(
        "SettingsClassification",
        {**base, "entries": [{"name": "RAG_EXAMPLE_PART", "side": "ingestion", "mechanism": "rewrite"}]},
    )
    duplicate = [
        {"name": "RAG_EXAMPLE_PART", "side": "ingestion", "mechanism": "rechunk"},
        {"name": "RAG_EXAMPLE_PART", "side": "query"},
    ]
    _rejects("SettingsClassification", {**base, "entries": duplicate})


def test_rescan_is_a_mechanism_that_starts_no_automatic_rebuild():
    import importlib.util

    assert importlib.util.find_spec("rag_sidecar.contracts.ingest_settings") is not None, "ingest_settings is missing"
    from rag_sidecar.contracts import ingest_settings

    entry = {"name": "RAG_EXAMPLE_CHECK", "side": "ingestion", "mechanism": "rescan"}
    _model("SettingsClassification").model_validate({"schema_version": 1, "entries": [entry]})
    assert "rescan" in ingest_settings.REBUILD_MECHANISMS
    assert "rescan" not in ingest_settings.AUTOMATIC_REBUILD_MECHANISMS


def test_fingerprint_parts_hold_no_floats_and_name_assumed_parts():
    sample = _sample("IngestFingerprintParts")
    model = _model("IngestFingerprintParts")

    def walk(value):
        if isinstance(value, dict):
            for item in value.values():
                walk(item)
        elif isinstance(value, list):
            for item in value:
                walk(item)
        else:
            assert not isinstance(value, float), value

    walk(sample)
    assert set(sample["switches"]) == {
        "language_aware_ingest",
        "table_header_repeat",
        "table_row_serialization",
        "caption_language",
    }
    _rejects("IngestFingerprintParts", {**sample, "processing_profile_version": 1.5})
    _rejects("IngestFingerprintParts", {**sample, "assumed_defaults": ["not_a_part"]})
    _rejects("IngestFingerprintParts", {**sample, "switches": {**sample["switches"], "table_header_repeat": "sometimes"}})
    assert model.model_validate({**sample, "assumed_defaults": ["switches", "ocr_engine_codes"]})


def test_fingerprint_impact_rejects_negative_counts():
    sample = _sample("FingerprintImpact")
    _rejects("FingerprintImpact", {**sample, "without_fingerprint": -1})
    _rejects("FingerprintImpact", {**sample, "total_current": -1})
    row = {**sample["by_mechanism"][0], "affected": -1}
    _rejects("FingerprintImpact", {**sample, "by_mechanism": [row]})
    _rejects("FingerprintImpact", {**sample, "by_mechanism": [sample["by_mechanism"][0]] * 2})


def test_hidden_text_report_rules():
    sample = _sample("HiddenTextReport")
    assert sample["status"] == "hidden_found" and sample["spans"]
    _rejects("HiddenTextReport", {**sample, "status": "clean"})
    _rejects("HiddenTextReport", {**sample, "spans": []})
    _rejects("HiddenTextReport", {**sample, "status": "unknown"})
    span = {**sample["spans"][0], "bbox": [0.0, 1.0, 2.0]}
    _rejects("HiddenTextReport", {**sample, "spans": [span]})
    _rejects("HiddenTextReport", {**sample, "spans": sample["spans"] * 201})
    _rejects("HiddenTextReport", {**sample, "dropped": -1})
    clean = {"status": "not_checked", "spans": [], "link_targets": [], "checker_version": "hidden-text@1"}
    assert _model("HiddenTextReport").model_validate(clean).dropped == 0


def test_hidden_text_rules_name_every_threshold():
    sample = _sample("HiddenTextRules")
    assert {"rules_version", "pdf", "docx", "zero_width_threshold"} <= set(sample)
    _rejects("HiddenTextRules", {**sample, "zero_width_threshold": 0})
    _rejects("HiddenTextRules", {**sample, "pdf": {**sample["pdf"], "color_distance_max": 1.5}})
    _rejects("HiddenTextRules", {**sample, "pdf": {**sample["pdf"], "min_font_size_pt": 0}})


def test_hidden_text_request_and_link_check_rules():
    request = _sample("HiddenTextRequest")
    _rejects("HiddenTextRequest", {**request, "sha256": "not-a-hash"})
    _rejects("HiddenTextRequest", {**request, "size_bytes": -1})
    link = _sample("LinkCheckResult")
    assert link["status"] == "untrusted_found" and link["targets"]
    _rejects("LinkCheckResult", {**link, "status": "clean"})
    _rejects("LinkCheckResult", {**link, "targets": []})
    _rejects("LinkCheckResult", {**link, "targets": [{**link["targets"][0], "kind": "phone"}]})


def test_upload_approval_rules():
    sample = _sample("UploadApproval")
    assert sample["required"] is True
    _rejects("UploadApproval", {**sample, "mode": "everyone"})
    _rejects("UploadApproval", {**sample, "reason": "exempt_connector"})
    _rejects("UploadApproval", {**sample, "mode": "off"})
    _rejects("UploadApproval", {**sample, "reason": "nobody"})
    off = {"mode": "off", "required": False, "reason": None, "uploader_id": None, "decided_at": sample["decided_at"]}
    _model("UploadApproval").model_validate(off)
    exempt = {**sample, "required": False, "reason": "exempt_uploader"}
    _model("UploadApproval").model_validate(exempt)


# Payloads as recorded before plan 03.2-05 (samples.json at the parent commit); they must validate unchanged.
OLD_JOB_SETTINGS_SNAPSHOT = {
    "cloud_allowed": True,
    "doc_type": "general",
    "embed_mode": "sync",
    "escalation": True,
    "max_tier": "premium",
    "min_tier": "fast",
    "ocr_languages": ["en"],
    "premium_max_pages_per_doc": 20,
    "premium_page_budget": 0,
    "profile_id": "general@1",
    "profile_version": 1,
    "progressive": False,
    "routing": "tiered",
    "routing_config_version": "1",
    "vlm_detect": False,
    "vlm_model": None,
}
OLD_PARSE_JOB_REQUEST = {
    "docling": {
        "force_full_page_ocr": False,
        "generate_picture_images": True,
        "heading_hierarchy": True,
        "ocr": True,
        "table_mode": "accurate",
    },
    "input_format": "pdf",
    "max_tokens": 512,
    "ocr_languages": ["zh", "en", "it"],
    "page_cap": 200,
    "profile_id": "financial_report@1",
    "profile_version": 1,
    "repeat_table_header": True,
    "tokenizer": "cl100k_base",
}
OLD_INGESTION_JOB = {
    "id": "00000000-0000-4000-8000-000000000001",
    "kind": "ingest",
    "status": "queued",
    "tenant_key": "tenant-a",
    "source": "upload",
    "source_key": "docs/sample.pdf",
    "settings": OLD_JOB_SETTINGS_SNAPSHOT,
    "created_at": "2026-01-01T00:00:00Z",
    "updated_at": "2026-01-01T00:00:00Z",
}

SNAPSHOT_DEFAULTS = {
    "language_aware": False,
    "languages": [],
    "primary_language": None,
    "repeat_table_header_effective": None,
    "carry_table_header": False,
    "row_serialization": False,
    "hidden_text_check": "off",
    "approval": None,
    "hold_publish": False,
}
REQUEST_DEFAULTS = {
    "language_aware": False,
    "languages": [],
    "primary_language": None,
    "carry_table_header": False,
}


@pytest.mark.parametrize(
    ("name", "old", "defaults"),
    [
        ("JobSettingsSnapshot", OLD_JOB_SETTINGS_SNAPSHOT, SNAPSHOT_DEFAULTS),
        ("ParseJobRequest", OLD_PARSE_JOB_REQUEST, REQUEST_DEFAULTS),
    ],
)
def test_old_payload_validates_and_new_fields_default_to_today(name, old, defaults):
    model = _model(name)
    for field in defaults:
        assert field in model.model_fields, f"{name} lacks {field}"
    value = model.model_validate(copy.deepcopy(old))
    dumped = value.model_dump(mode="json")
    for field, default in defaults.items():
        assert dumped[field] == default, field
    assert value.model_dump(mode="json", exclude_defaults=True) == model.model_validate(old).model_dump(
        mode="json", exclude_defaults=True
    )
    assert set(value.model_dump(mode="json", exclude_defaults=True)) <= set(old)


def test_old_ingestion_job_validates():
    job = _model("IngestionJob").model_validate(copy.deepcopy(OLD_INGESTION_JOB))
    assert getattr(job.settings, "hidden_text_check", None) == "off"
    assert getattr(job.settings, "hold_publish", None) is False


def test_ingestion_job_accepts_translate_and_pending_review():
    job = {**OLD_INGESTION_JOB, "kind": "translate", "status": "pending_review"}
    try:
        validated = _model("IngestionJob").model_validate(job)
    except ValidationError as exc:
        pytest.fail(f"translate / pending_review rejected: {exc.error_count()} error(s)")
    assert (validated.kind, validated.status) == ("translate", "pending_review")


def test_new_snapshot_and_request_fields_are_validated():
    snapshot = {**OLD_JOB_SETTINGS_SNAPSHOT, **SNAPSHOT_DEFAULTS}
    _rejects("JobSettingsSnapshot", {**snapshot, "hidden_text_check": "strict"})
    _rejects("JobSettingsSnapshot", {**snapshot, "languages": ["xx"]})
    _rejects("JobSettingsSnapshot", {**snapshot, "languages": ["en", "en"]})
    _rejects("JobSettingsSnapshot", {**snapshot, "primary_language": "en"})
    _model("JobSettingsSnapshot").model_validate(
        {
            **snapshot,
            "language_aware": True,
            "languages": ["en"],
            "primary_language": "en",
            "repeat_table_header_effective": True,
            "approval": _sample("UploadApproval"),
            "hold_publish": True,
        }
    )
    request = {**OLD_PARSE_JOB_REQUEST, **REQUEST_DEFAULTS}
    _rejects("ParseJobRequest", {**request, "primary_language": "en"})
    _rejects("ParseJobRequest", {**request, "carry_table_header": "maybe"})
    _model("ParseJobRequest").model_validate({**request, "languages": ["en"], "primary_language": "en", "carry_table_header": True})


@pytest.mark.parametrize("name", ["JobSettingsSnapshot", "ParseJobRequest"])
def test_docstring_states_the_deploy_order(name):
    assert "sidecar first" in (_model(name).__doc__ or "")
