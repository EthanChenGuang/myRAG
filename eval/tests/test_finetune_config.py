import json

import pytest
from rag_sidecar.contracts.finetune import FINETUNE_SPLIT_RULE, FinetuneConfig

from rag_eval.finetune import config as finetune_config
from rag_eval.finetune.config import DEFAULT_CONFIG_PATH, load_finetune_config
from rag_eval.paths import REPO_ROOT

QWEN = "Qwen/Qwen3-Embedding-0.6B"
BGE = "BAAI/bge-m3"
E5 = "intfloat/multilingual-e5-large-instruct"
REVISIONS = {
    QWEN: "97b0c614be4d77ee51c0cef4e5f07c00f9eb65b3",
    BGE: "5617a9f61b028005a4858fdac845db406aefb181",
    E5: "274baa43b0e13e37fafa6428dbc7938e62e5c439",
}


def _load(path=None) -> FinetuneConfig:
    config = load_finetune_config() if path is None else load_finetune_config(path)
    assert isinstance(config, FinetuneConfig)
    return config


def _raw() -> dict:
    _load()
    return json.loads(DEFAULT_CONFIG_PATH.read_text(encoding="utf-8"))


def test_loader_reads_the_committed_file():
    config = _load()
    assert isinstance(config, FinetuneConfig)
    assert DEFAULT_CONFIG_PATH == REPO_ROOT / "eval" / "config" / "finetune.json"


def test_unknown_key_fails(tmp_path):
    raw = _raw()
    raw["mining"]["surprise"] = 1
    target = tmp_path / "finetune.json"
    target.write_text(json.dumps(raw), encoding="utf-8")
    with pytest.raises(ValueError):
        load_finetune_config(target)
    raw = _raw()
    raw["unexpected_section"] = {}
    target.write_text(json.dumps(raw), encoding="utf-8")
    with pytest.raises(ValueError):
        load_finetune_config(target)


def test_llm_models_follow_the_draft_config():
    config = _load()
    draft = json.loads((REPO_ROOT / "eval" / "config" / "draft.json").read_text(encoding="utf-8"))
    assert config.generator_model == draft["claude_model"]
    assert config.judge_model == draft["claude_model"]


def test_decision_defaults():
    config = _load()
    assert config.generation.queries_per_chunk == 3
    assert config.generation.cross_language_share == 0.15
    assert config.generation.min_chunk_tokens == 40
    assert config.filters.verbatim_containment == 0.6
    assert config.filters.containment_ngram == 5
    assert config.filters.lcs_ratio == 0.7
    assert config.filters.near_dup_jaccard == 0.8
    assert config.filters.near_dup_ngram == 3
    assert config.filters.golden_overlap_jaccard == 0.8
    assert config.filters.judge_min_confidence == 0.7
    assert config.mined.mined_weight == 2
    mining = config.mining
    assert (mining.relative_margin, mining.range_min, mining.range_max, mining.num_negatives) == (0.05, 0, 50, 5)
    assert mining.sampling_strategy == "top"
    assert mining.absolute_margin is None and mining.round_trip_k is None
    assert (mining.fn_audit_sample, mining.fn_audit_max_upper) == (50, 0.15)
    assert config.split.rule == FINETUNE_SPLIT_RULE
    assert config.retention.retention_days == 30
    assert config.export.batch_rows == 1000


def test_training_recipe_defaults():
    recipe = _load().training
    assert recipe.loss == "CachedMultipleNegativesRankingLoss"
    assert (recipe.mini_batch_size, recipe.per_device_train_batch_size) == (32, 256)
    assert recipe.batch_sampler == "no_duplicates"
    assert (recipe.learning_rate, recipe.warmup_ratio, recipe.num_train_epochs) == (2e-5, 0.1, 1)
    assert recipe.bf16 is True and recipe.seed == 42
    assert recipe.load_best_model_at_end and recipe.metric_for_best_model == "ndcg_at_10"
    assert recipe.gist.enabled is False
    assert recipe.matryoshka.enabled is False and recipe.matryoshka.dims == [1024, 512, 256]


def test_base_models_pinned():
    models = {model.id: model for model in _load().base_models}
    assert set(models) == set(REVISIONS)
    assert [model_id for model_id, model in models.items() if model.default] == [QWEN]
    for model_id, revision in REVISIONS.items():
        assert models[model_id].revision == revision
        assert models[model_id].dims == 1024
    assert models[QWEN].query_prompt.startswith("Instruct: ")
    assert models[QWEN].query_prompt.endswith("\nQuery:")
    assert models[QWEN].document_prompt == ""
    assert (models[E5].query_prompt, models[E5].document_prompt) == ("query: ", "passage: ")
    assert (models[BGE].query_prompt, models[BGE].document_prompt) == ("", "")


def test_prices_default_to_unknown():
    prices = _load().prices
    assert prices.generator.input_usd_per_mtok is None
    assert prices.generator.output_usd_per_mtok is None
    assert prices.judge.input_usd_per_mtok is None
    assert prices.judge.output_usd_per_mtok is None
    assert prices.gpu_hour_usd is None
    assert prices.reembed_usd_per_mtok is None


def test_every_prompt_has_a_version():
    config = _load()
    assert config.prompts.generate and config.prompts.judge
    assert all(model.prompt_version for model in config.base_models)


def test_query_length_bounds_cover_the_configured_languages():
    from rag_sidecar.contracts.languages import LANGUAGE_CODES

    filters = _load().filters
    assert set(filters.min_query_chars) == set(LANGUAGE_CODES)


def test_noise_config_exists():
    assert (REPO_ROOT / _load().evaluation.noise_config).is_file()


def test_module_exports():
    assert finetune_config.load_finetune_config is load_finetune_config
