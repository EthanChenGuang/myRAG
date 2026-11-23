import json

import pytest
from pydantic import ValidationError

from rag_sidecar.contracts import ReviewQueueItem
from rag_sidecar.contracts.samples import build_samples
from rag_sidecar.export_schemas import CONTRACTS, SCHEMAS_DIR


def _item(**overrides):
    base = {
        "trace_id": "0123456789abcdef0123456789abcdef",
        "observation_id": "0123456789abcdef",
        "captured_at": "2026-01-01T00:00:00.000Z",
        "tenant_key": "tenant-a",
        "query_masked": "How many leave days do employees get?",
        "answer_masked": "Twenty days per year.",
        "context_masked": "Employees receive twenty days of leave per year.",
        "model": "generator/model-b",
        "tags": ["review_candidate"],
    }
    base.update(overrides)
    return base


def test_valid_item_round_trips_and_language_is_optional():
    item = ReviewQueueItem(**_item())
    assert item.language is None
    assert item.tags == ["review_candidate"]
    assert ReviewQueueItem.model_validate(item.model_dump(mode="json")) == item
    assert ReviewQueueItem(**_item(language="it")).language == "it"


def test_unknown_key_rejected():
    with pytest.raises(ValidationError):
        ReviewQueueItem(**_item(smuggled="x"))


@pytest.mark.parametrize("field", ["trace_id", "observation_id", "captured_at"])
def test_empty_identifiers_rejected(field):
    with pytest.raises(ValidationError):
        ReviewQueueItem(**_item(**{field: ""}))


@pytest.mark.parametrize("field", ["trace_id", "observation_id", "captured_at", "tenant_key", "query_masked", "model"])
def test_required_fields_have_no_default(field):
    row = _item()
    del row[field]
    with pytest.raises(ValidationError):
        ReviewQueueItem(**row)


def test_language_outside_the_three_rejected():
    with pytest.raises(ValidationError):
        ReviewQueueItem(**_item(language="fr"))


def test_item_is_frozen():
    item = ReviewQueueItem(**_item())
    with pytest.raises(ValidationError):
        item.tenant_key = "tenant-b"


def test_registered_in_serialization_mode_with_a_sample():
    registered = {model.__name__: mode for model, mode in CONTRACTS}
    assert registered.get("ReviewQueueItem") == "serialization"
    sample = build_samples()["samples"]["ReviewQueueItem"]
    assert ReviewQueueItem.model_validate(sample).model_dump(mode="json") == sample


def test_committed_schema_matches_the_model():
    committed = json.loads((SCHEMAS_DIR / "ReviewQueueItem.schema.json").read_text(encoding="utf-8"))
    assert committed == ReviewQueueItem.model_json_schema(mode="serialization")
