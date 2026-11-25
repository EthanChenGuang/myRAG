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
