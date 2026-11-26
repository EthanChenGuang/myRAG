import pytest

from rag_sidecar.contracts import finetune as ft
from rag_sidecar.contracts.samples import build_samples
from rag_sidecar.export_schemas import CONTRACTS

EXPECTED_MODES = {
    ft.FinetuneConfig: "validation",
    ft.ExportedChunk: "serialization",
    ft.DatasetManifest: "serialization",
    ft.SyntheticQuery: "validation",
    ft.SyntheticQueryBatch: "validation",
    ft.AnswerabilityVerdict: "validation",
    ft.FilterReport: "serialization",
    ft.FinetunePair: "serialization",
    ft.MiningReport: "serialization",
    ft.TrainingRunConfig: "serialization",
    ft.TrainingRunReport: "serialization",
    ft.IrMetrics: "serialization",
    ft.OfflineEvalReport: "serialization",
    ft.ProbeSet: "serialization",
    ft.ModelVersionCard: "serialization",
    ft.QueryVectorRow: "serialization",
    ft.ChunkVectorRow: "serialization",
    ft.VectorFileHeader: "serialization",
}


def test_finetune_contracts_are_exported_in_their_modes():
    registered = dict(CONTRACTS)
    for model, mode in EXPECTED_MODES.items():
        assert registered.get(model) == mode, model.__name__


def test_training_pair_is_exported_once():
    names = [model.__name__ for model, _ in CONTRACTS]
    assert names.count("TrainingPair") == 1
    assert names.count("FinetunePair") == 1


@pytest.mark.parametrize("model", list(EXPECTED_MODES), ids=lambda model: model.__name__)
def test_finetune_sample_validates(model):
    samples = build_samples()["samples"]
    assert model.__name__ in samples
    assert model.model_validate(samples[model.__name__]).model_dump(mode="json") == samples[model.__name__]


def test_finetune_samples_use_placeholder_tenants():
    samples = build_samples()["samples"]
    for name in ("ExportedChunk", "FinetunePair", "ChunkVectorRow", "VectorFileHeader"):
        assert samples[name]["tenant_key"] == "s:default"
    assert samples["ModelVersionCard"]["tenant_keys"] == ["s:default"]
    assert samples["DatasetManifest"]["tenant_keys"] == ["s:default"]
