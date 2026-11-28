import pytest

from rag_eval.judge.openai_route import (
    OPENROUTER_BASE_URL,
    OpenAiRouteError,
    embedding_key_name,
    embedding_model_for,
    judge_key_names,
    openai_via,
    resolve_embedding_route,
)


@pytest.mark.parametrize("raw", [None, "", "  ", "openai", "OpenAI"])
def test_unset_or_openai_keeps_the_direct_openai_route(raw: str | None) -> None:
    env = {} if raw is None else {"RAG_EVAL_OPENAI_VIA": raw}
    assert openai_via(env) == "openai"
    assert embedding_key_name(env) == "OPENAI_API_KEY"
    assert judge_key_names(env) == ("OPENROUTER_API_KEY", "OPENAI_API_KEY")


def test_openrouter_needs_only_the_openrouter_key() -> None:
    env = {"RAG_EVAL_OPENAI_VIA": "openrouter"}
    assert openai_via(env) == "openrouter"
    assert judge_key_names(env) == ("OPENROUTER_API_KEY",)


def test_unknown_value_is_refused() -> None:
    with pytest.raises(OpenAiRouteError, match="RAG_EVAL_OPENAI_VIA"):
        openai_via({"RAG_EVAL_OPENAI_VIA": "deepinfra"})


def test_model_ids_follow_the_route() -> None:
    assert embedding_model_for("text-embedding-3-small", "openrouter") == "openai/text-embedding-3-small"
    assert embedding_model_for("openai/text-embedding-3-small", "openrouter") == "openai/text-embedding-3-small"
    assert embedding_model_for("openai/text-embedding-3-small", "openai") == "text-embedding-3-small"
    assert embedding_model_for("text-embedding-3-small", "openai") == "text-embedding-3-small"


def test_resolved_routes() -> None:
    direct = resolve_embedding_route("text-embedding-3-small", {"OPENAI_API_KEY": "placeholder-openai-key"})
    assert (direct.via, direct.key_name, direct.base_url, direct.model) == (
        "openai", "OPENAI_API_KEY", None, "text-embedding-3-small",
    )  # fmt: skip
    routed = resolve_embedding_route(
        "text-embedding-3-small",
        {"RAG_EVAL_OPENAI_VIA": "openrouter", "OPENROUTER_API_KEY": "placeholder-openrouter-key", "OPENAI_API_KEY": ""},
    )
    assert (routed.via, routed.key_name, routed.base_url, routed.model) == (
        "openrouter", "OPENROUTER_API_KEY", OPENROUTER_BASE_URL, "openai/text-embedding-3-small",
    )  # fmt: skip
    assert routed.api_key == "placeholder-openrouter-key"


def test_a_missing_route_key_names_the_variable() -> None:
    with pytest.raises(OpenAiRouteError, match="OPENAI_API_KEY"):
        resolve_embedding_route("text-embedding-3-small", {"OPENROUTER_API_KEY": "placeholder-openrouter-key"})
    with pytest.raises(OpenAiRouteError, match="OPENROUTER_API_KEY"):
        resolve_embedding_route("text-embedding-3-small", {"RAG_EVAL_OPENAI_VIA": "openrouter"})
