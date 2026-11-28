import typing

import pytest
from pydantic import BaseModel, ValidationError, WithJsonSchema
from pydantic.fields import FieldInfo

from rag_sidecar.contracts import finetune as ft

TENANT_A = "o:11111111-1111-4111-8111-111111111111"
TENANT_B = "o:22222222-2222-4222-8222-222222222222"
DOC = "33333333-3333-4333-8333-333333333333"
SHA = "a" * 64
REV = "97b0c614be4d77ee51c0cef4e5f07c00f9eb65b3"
UNIT = [1.0] + [0.0] * 1023


def _metrics(value: float = 0.5) -> dict:
    return {"n": 10, "recall_at_10": value, "mrr_at_10": value, "ndcg_at_10": value}


def _model_block() -> dict:
    return {
        "overall": _metrics(),
        "by_language": {"en": _metrics()},
        "by_pair": {"en->zh": _metrics()},
        "by_source": {"synthetic": _metrics(), "mined": _metrics()},
    }


def _offline(passed: bool = True) -> dict:
    return {
        "models": {"base": _model_block(), "finetuned": _model_block(), "production": _model_block()},
        "deltas": [
            {
                "comparison": "finetuned_vs_production",
                "metric": "recall_at_10",
                "slice": "overall",
                "delta": 0.05,
                "ci_low": 0.01,
                "ci_high": 0.09,
            }
        ],
        "noise_band": 0.02,
        "passed": passed,
        "reasons": [] if passed else ["below_production_overall"],
    }


def _probe() -> dict:
    return {
        "texts": list(ft.PROBE_TEXTS),
        "query_prompt": "query: ",
        "document_prompt": "passage: ",
        "vectors": [UNIT, UNIT, UNIT],
    }


def _card(**over) -> dict:
    card = {
        "id": "ft-qwen3-0.6b-2026-11-26",
        "base_model": "Qwen/Qwen3-Embedding-0.6B",
        "base_revision": REV,
        "dims": 1024,
        "scope": "deployment",
        "tenant_keys": [TENANT_A, TENANT_B],
        "dataset_manifest_sha256": SHA,
        "training_config_sha256": SHA,
        "query_prompt": "query: ",
        "document_prompt": "passage: ",
        "offline": _offline(),
        "status": "candidate",
        "probe": _probe(),
        "artifact_uri": "s3://models-bucket/ft/run-1/",
    }
    card.update(over)
    return card


def _chunk(**over) -> dict:
    chunk = {
        "tenant_key": TENANT_A,
        "document_id": DOC,
        "chunk_id": "c-1",
        "chunk_index": 0,
        "content_hash": SHA,
        "document_content_hash": None,
        "language": "en",
        "split": "train",
        "text": "A neutral synthetic sentence about a widget.",
        "token_count": 50,
        "is_golden_test_evidence": False,
    }
    chunk.update(over)
    return chunk


def _manifest(**over) -> dict:
    manifest = {
        "run_id": "run-2026-11-26",
        "purpose": "deployment",
        "split_rule": "ft-sha256-first8hex-mod100-80-10-10",
        "tenant_keys": [TENANT_A],
        "counts": {"train": {"synthetic": 10, "mined": 2}, "dev": {"synthetic": 1}, "test": {"mined": 1}},
        "files": {"chunks.jsonl": SHA},
        "created_at": "2026-11-26T10:00:00Z",
    }
    manifest.update(over)
    return manifest


MINING_PARAMS = {
    "relative_margin": 0.05,
    "absolute_margin": None,
    "range_min": 0,
    "range_max": 50,
    "max_score": None,
    "min_score": None,
    "num_negatives": 5,
    "sampling_strategy": "top",
    "neighbour_window": 1,
    "fn_audit_sample": 50,
    "fn_audit_max_upper": 0.15,
    "round_trip_k": None,
}

RECIPE = {
    "loss": "CachedMultipleNegativesRankingLoss",
    "mini_batch_size": 32,
    "per_device_train_batch_size": 256,
    "batch_sampler": "no_duplicates",
    "learning_rate": 2e-5,
    "warmup_ratio": 0.1,
    "num_train_epochs": 1,
    "bf16": True,
    "seed": 42,
    "eval_steps": 100,
    "metric_for_best_model": "ndcg_at_10",
    "load_best_model_at_end": True,
    "gist": {"enabled": False, "cached": True, "guide": "base_model"},
    "matryoshka": {"enabled": False, "dims": [1024, 512, 256]},
}


# --- tenant keys and languages -------------------------------------------------------------------------------


@pytest.mark.parametrize("key", ["s:default", TENANT_A, "u:44444444-4444-4444-8444-444444444444"])
def test_tenant_key_accepted(key):
    assert ft.ExportedChunk.model_validate(_chunk(tenant_key=key)).tenant_key == key


@pytest.mark.parametrize("key", ["default", "o:abc", "x:11111111-1111-4111-8111-111111111111", ""])
def test_tenant_key_rejected(key):
    with pytest.raises(ValidationError):
        ft.ExportedChunk.model_validate(_chunk(tenant_key=key))


def test_language_outside_registry_rejected():
    with pytest.raises(ValidationError):
        ft.ExportedChunk.model_validate(_chunk(language="fr"))
    with pytest.raises(ValidationError):
        ft.SyntheticQuery.model_validate({"chunk_ref": 0, "language": "xx", "style": "keyword", "query": "q"})


def test_extra_keys_and_mutation_refused():
    with pytest.raises(ValidationError):
        ft.ExportedChunk.model_validate({**_chunk(), "unknown": 1})
    chunk = ft.ExportedChunk.model_validate(_chunk())
    with pytest.raises(ValidationError):
        chunk.text = "other"  # type: ignore[misc]


# --- LLM tool outputs ----------------------------------------------------------------------------------------


def test_synthetic_query_batch():
    batch = ft.SyntheticQueryBatch.model_validate(
        {
            "items": [
                {"chunk_ref": 0, "language": "en", "style": "keyword", "query": "widget size"},
                {"chunk_ref": 1, "language": "zh", "style": "cross_language", "query": "部件尺寸"},
            ]
        }
    )
    assert len(batch.items) == 2
    for bad in (
        {"chunk_ref": -1, "language": "en", "style": "keyword", "query": "q"},
        {"chunk_ref": 0, "language": "en", "style": "poem", "query": "q"},
        {"chunk_ref": 0, "language": "en", "style": "question", "query": ""},
        {"chunk_ref": 0, "language": "en", "style": "question", "query": "x" * 401},
    ):
        with pytest.raises(ValidationError):
            ft.SyntheticQuery.model_validate(bad)


def test_answerability_verdict_bounds():
    assert ft.AnswerabilityVerdict.model_validate({"answerable": True, "confidence": 0.9}).answerable
    for value in (-0.1, 1.1):
        with pytest.raises(ValidationError):
            ft.AnswerabilityVerdict.model_validate({"answerable": True, "confidence": value})


def test_no_training_pair_class_defined_here():
    assert not hasattr(ft, "TrainingPair")
    names = {
        obj.__name__
        for obj in vars(ft).values()
        if isinstance(obj, type) and issubclass(obj, BaseModel) and obj.__module__ == ft.__name__
    }
    assert "TrainingPair" not in names


# --- pairs ---------------------------------------------------------------------------------------------------


def _pair(**over) -> dict:
    pair = {
        "pair_id": "p-1",
        "tenant_key": TENANT_A,
        "language": "en",
        "positive_language": "en",
        "anchor": "widget size",
        "positive_chunk_id": "c-1",
        "positive": "A neutral synthetic sentence about a widget.",
        "negatives": [{"chunk_id": "c-2", "text": "Another neutral sentence.", "negative_source": "mined"}],
        "source": "synthetic",
        "split": "train",
        "weight": 1,
    }
    pair.update(over)
    return pair


def test_finetune_pair():
    assert ft.FinetunePair.model_validate(_pair()).weight == 1
    with pytest.raises(ValidationError):
        ft.FinetunePair.model_validate(_pair(weight=0))
    with pytest.raises(ValidationError):
        ft.FinetunePair.model_validate(
            _pair(negatives=[{"chunk_id": "c-1", "text": "x", "negative_source": "expert"}])
        )
    with pytest.raises(ValidationError):
        ft.FinetunePair.model_validate(
            _pair(
                negatives=[
                    {"chunk_id": "c-2", "text": "x", "negative_source": "expert"},
                    {"chunk_id": "c-2", "text": "x", "negative_source": "mined"},
                ]
            )
        )
    with pytest.raises(ValidationError):
        ft.FinetunePair.model_validate(_pair(source="other"))


# --- manifest ------------------------------------------------------------------------------------------------


def test_dataset_manifest_split_rule():
    manifest = ft.DatasetManifest.model_validate(_manifest())
    assert manifest.purpose == "deployment"
    with pytest.raises(ValidationError):
        ft.DatasetManifest.model_validate(_manifest(split_rule="item-sha256-mod100"))
    with pytest.raises(ValidationError):
        ft.DatasetManifest.model_validate(_manifest(purpose="public"))


def test_private_manifest_has_one_tenant():
    ft.DatasetManifest.model_validate(_manifest(purpose="private", tenant_keys=[TENANT_A]))
    with pytest.raises(ValidationError):
        ft.DatasetManifest.model_validate(_manifest(purpose="private", tenant_keys=[TENANT_A, TENANT_B]))


# --- model card ----------------------------------------------------------------------------------------------


def test_model_card_valid():
    card = ft.ModelVersionCard.model_validate(_card())
    assert card.dims == 1024
    assert list(card.tenant_keys) == sorted(card.tenant_keys)


def test_model_card_dims_must_be_1024():
    with pytest.raises(ValidationError):
        ft.ModelVersionCard.model_validate(_card(dims=768))


@pytest.mark.parametrize(
    "uri",
    [
        "https://user:secret@host.example/model",
        "https://token@host.example/model",
        "https://host.example/model?sig=abc",
        "https://host.example/model#frag",
        "no-scheme/path",
    ],
)
def test_model_card_artifact_uri_rejected(uri):
    with pytest.raises(ValidationError):
        ft.ModelVersionCard.model_validate(_card(artifact_uri=uri))


@pytest.mark.parametrize("uri", ["s3://bucket/path/model", "https://host.example/models/ft-1", "file:///srv/models/ft-1"])
def test_model_card_artifact_uri_accepted(uri):
    assert ft.ModelVersionCard.model_validate(_card(artifact_uri=uri)).artifact_uri == uri


def test_tenant_scope_card_has_exactly_one_tenant():
    ft.ModelVersionCard.model_validate(_card(scope="tenant", tenant_keys=[TENANT_A]))
    with pytest.raises(ValidationError):
        ft.ModelVersionCard.model_validate(_card(scope="tenant", tenant_keys=[TENANT_A, TENANT_B]))


def test_card_tenant_keys_unique_sorted_nonempty():
    with pytest.raises(ValidationError):
        ft.ModelVersionCard.model_validate(_card(tenant_keys=[]))
    with pytest.raises(ValidationError):
        ft.ModelVersionCard.model_validate(_card(tenant_keys=[TENANT_A, TENANT_A]))
    with pytest.raises(ValidationError):
        ft.ModelVersionCard.model_validate(_card(tenant_keys=[TENANT_B, TENANT_A]))


@pytest.mark.parametrize("bad", ["Ft-x", "ft-", "ft-a", "model-1", "ft-" + "a" * 60])
def test_card_id_pattern(bad):
    with pytest.raises(ValidationError):
        ft.ModelVersionCard.model_validate(_card(id=bad))


def test_card_revision_is_40_hex():
    with pytest.raises(ValidationError):
        ft.ModelVersionCard.model_validate(_card(base_revision="main"))


def test_card_status_enum():
    ft.ModelVersionCard.model_validate(_card(status="rejected_offline", offline=_offline(passed=False)))
    with pytest.raises(ValidationError):
        ft.ModelVersionCard.model_validate(_card(status="registered"))


# --- probe ---------------------------------------------------------------------------------------------------


def test_probe_set_shape():
    ft.ProbeSet.model_validate(_probe())
    with pytest.raises(ValidationError):
        ft.ProbeSet.model_validate({**_probe(), "texts": list(ft.PROBE_TEXTS[:2])})
    with pytest.raises(ValidationError):
        ft.ProbeSet.model_validate({**_probe(), "vectors": [UNIT, UNIT, [1.0] * 1023]})
    with pytest.raises(ValidationError):
        ft.ProbeSet.model_validate({**_probe(), "vectors": [UNIT, UNIT, [0.5] + [0.0] * 1023]})


def test_probe_texts_are_the_fixed_strings():
    assert len(ft.PROBE_TEXTS) == 3
    with pytest.raises(ValidationError):
        ft.ProbeSet.model_validate({**_probe(), "texts": [*ft.PROBE_TEXTS[:2], "another sentence"]})


# --- reports -------------------------------------------------------------------------------------------------


def test_filter_report():
    report = ft.FilterReport.model_validate(
        {
            "kept": 5,
            "dropped": {"verbatim_copy": 2, "not_answerable": 1},
            "by_language": {"en": {"kept": 5, "dropped": 3}},
            "round_trip": "not_applied",
            "judge_skipped": False,
        }
    )
    assert report.dropped["verbatim_copy"] == 2
    with pytest.raises(ValidationError):
        ft.FilterReport.model_validate(
            {
                "kept": 0,
                "dropped": {"made_up_reason": 1},
                "by_language": {},
                "round_trip": "not_applied",
                "judge_skipped": True,
            }
        )


def test_mining_report():
    report = ft.MiningReport.model_validate(
        {
            "miner": "vectors",
            "pairs": 10,
            "with_full_negatives": 8,
            "pairs_only": 2,
            "mean_negatives": 4.2,
            "round_trip_k": None,
            "round_trip_miss": 0,
            "fn_audit": {"sampled": 50, "answerable": 2, "upper_95": 0.12, "passed": True, "skipped": False},
            "params": MINING_PARAMS,
        }
    )
    assert report.fn_audit.passed


def test_offline_eval_report():
    report = ft.OfflineEvalReport.model_validate(_offline())
    assert report.models.finetuned.overall.recall_at_10 == 0.5
    with pytest.raises(ValidationError):
        ft.OfflineEvalReport.model_validate({**_offline(), "reasons": ["free text"]})
    with pytest.raises(ValidationError):
        ft.IrMetrics.model_validate({**_metrics(), "recall_at_10": 1.5})


def test_training_run_config_and_report():
    run_config = {
        "run_id": "run-1",
        "base_model": "Qwen/Qwen3-Embedding-0.6B",
        "base_revision": REV,
        "dataset_manifest_sha256": SHA,
        "config_sha256": SHA,
        "seed": 42,
        "git_commit": "abcdef1",
        "library_versions": {
            "torch": "2.15.0",
            "transformers": "5.23.0",
            "sentence_transformers": "6.2.0",
            "datasets": "4.0.0",
        },
        "recipe": RECIPE,
    }
    ft.TrainingRunConfig.model_validate(run_config)
    ft.TrainingRunReport.model_validate(
        {
            "run_id": "run-1",
            "training_config_sha256": SHA,
            "examples": {"ntuple": 100, "pairs": 20},
            "steps": 10,
            "final_train_loss": 0.3,
            "best_step": 10,
            "best_dev_ndcg_at_10": 0.6,
            "duration_seconds": 120.0,
            "device": "cpu",
        }
    )


def test_vector_rows_and_header():
    ft.QueryVectorRow.model_validate(
        {"query_id": "q-1", "profile_id": "openai-3-small-1536", "model": "text-embedding-3-small", "dims": 3, "vector": [0.1, 0.2, 0.3]}
    )
    with pytest.raises(ValidationError):
        ft.QueryVectorRow.model_validate(
            {"query_id": "q-1", "profile_id": "p", "model": "m", "dims": 3, "vector": [0.1, 0.2]}
        )
    ft.ChunkVectorRow.model_validate(
        {"tenant_key": TENANT_A, "chunk_id": "c-1", "row_index": 0, "profile_id": "p", "model": "m", "dims": 3}
    )
    ft.VectorFileHeader.model_validate(
        {
            "tenant_key": TENANT_A,
            "profile_id": "p",
            "model": "m",
            "dims": 3,
            "rows": 1,
            "dtype": "float32-le",
            "sha256": SHA,
        }
    )
    with pytest.raises(ValidationError):
        ft.VectorFileHeader.model_validate(
            {"tenant_key": TENANT_A, "profile_id": "p", "model": "m", "dims": 3, "rows": 1, "dtype": "float64", "sha256": SHA}
        )


# --- D-31: report models carry no free text ------------------------------------------------------------------

REPORT_MODELS = [ft.FilterReport, ft.MiningReport, ft.TrainingRunReport, ft.OfflineEvalReport, ft.DatasetManifest]
FREE_TEXT_ALLOW_LIST: frozenset[str] = frozenset()


def _constrained(metadata) -> bool:
    """A patterned id/hash alias, or an enum alias such as the registry Language type."""
    for meta in metadata:
        if isinstance(meta, FieldInfo) and _constrained(meta.metadata):
            return True
        if getattr(meta, "pattern", None):
            return True
        if isinstance(meta, WithJsonSchema) and "enum" in (meta.json_schema or {}):
            return True
    return False


def _is_constrained_str(field) -> bool:
    return _constrained(field.metadata)


def _walk(model: type[BaseModel], seen: set[type], offenders: list[str]) -> None:
    if model in seen:
        return
    seen.add(model)
    for name, field in model.model_fields.items():
        _check_annotation(model, name, field, field.annotation, seen, offenders)


def _check_annotation(model, name, field, annotation, seen, offenders) -> None:
    origin = typing.get_origin(annotation)
    if annotation is str:
        if not _is_constrained_str(field) and name not in FREE_TEXT_ALLOW_LIST:
            offenders.append(f"{model.__name__}.{name}")
        return
    if origin is typing.Literal:
        return
    if isinstance(annotation, type) and issubclass(annotation, BaseModel):
        _walk(annotation, seen, offenders)
        return
    if origin is typing.Annotated:
        inner, *metadata = typing.get_args(annotation)
        if inner is str:
            if not _constrained(metadata) and name not in FREE_TEXT_ALLOW_LIST:
                offenders.append(f"{model.__name__}.{name}")
            return
        _check_annotation(model, name, field, inner, seen, offenders)
        return
    for arg in typing.get_args(annotation):
        if arg is type(None):
            continue
        if arg is str:
            # str inside a container: dict keys/values or list items must be enums or patterned aliases.
            offenders.append(f"{model.__name__}.{name}")
            continue
        _check_annotation(model, name, field, arg, seen, offenders)


@pytest.mark.parametrize("model", REPORT_MODELS, ids=lambda m: m.__name__)
def test_report_models_have_no_free_text(model):
    offenders: list[str] = []
    _walk(model, set(), offenders)
    assert offenders == []


def test_walker_catches_free_text():
    class _Leaky(BaseModel):
        note: str

    offenders: list[str] = []
    _walk(_Leaky, set(), offenders)
    assert offenders == ["_Leaky.note"]


def test_contract_count():
    contracts = [
        obj
        for obj in vars(ft).values()
        if isinstance(obj, type) and issubclass(obj, ft._Contract) and obj is not ft._Contract
    ]
    assert len(contracts) >= 18


def test_exported_from_package():
    import rag_sidecar.contracts as contracts

    for name in ("FinetuneConfig", "ModelVersionCard", "FinetunePair", "SyntheticQueryBatch", "AnswerabilityVerdict"):
        assert getattr(contracts, name) is getattr(ft, name)
        assert name in contracts.__all__
