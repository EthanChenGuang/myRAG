"""Which host serves the judge's OpenAI embedding model (RAG_EVAL_OPENAI_VIA).

``openai`` (default, also for an unset or empty value) calls api.openai.com with OPENAI_API_KEY, as before.
``openrouter`` sends the same OpenAI model through OpenRouter's OpenAI-compatible endpoint with OPENROUTER_API_KEY and the
``openai/``-prefixed model id, so the judge tier runs with OPENROUTER_API_KEY alone. The judge LLM already goes through
OpenRouter in both modes; only the embedding client changes.
"""

import os
from collections.abc import Mapping
from dataclasses import dataclass
from typing import Literal

OpenAiVia = Literal["openai", "openrouter"]

ENV_NAME = "RAG_EVAL_OPENAI_VIA"
OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1"
OPENAI_PREFIX = "openai/"


class OpenAiRouteError(ValueError):
    pass


@dataclass(frozen=True)
class EmbeddingRoute:
    via: OpenAiVia
    key_name: str
    api_key: str
    base_url: str | None
    model: str


def openai_via(env: Mapping[str, str] | None = None) -> OpenAiVia:
    source = os.environ if env is None else env
    raw = (source.get(ENV_NAME) or "").strip().lower()
    if raw in ("", "openai"):
        return "openai"
    if raw == "openrouter":
        return "openrouter"
    raise OpenAiRouteError(f"{ENV_NAME}={raw!r} is not openai or openrouter")


def embedding_key_name(env: Mapping[str, str] | None = None) -> str:
    """The environment variable that authenticates the judge's embedding calls under the configured route."""
    return "OPENROUTER_API_KEY" if openai_via(env) == "openrouter" else "OPENAI_API_KEY"


def judge_key_names(env: Mapping[str, str] | None = None) -> tuple[str, ...]:
    """Every key the live judge needs, in the order the CLIs report them: one name when both calls go through OpenRouter."""
    names = ["OPENROUTER_API_KEY", embedding_key_name(env)]
    return tuple(dict.fromkeys(names))


def embedding_model_for(model: str, via: OpenAiVia) -> str:
    bare = model.removeprefix(OPENAI_PREFIX)
    return f"{OPENAI_PREFIX}{bare}" if via == "openrouter" else bare


def resolve_embedding_route(model: str, env: Mapping[str, str] | None = None) -> EmbeddingRoute:
    """The client settings for the judge's embedding model; raises OpenAiRouteError when the route's key is missing."""
    source = os.environ if env is None else env
    via = openai_via(source)
    key_name = embedding_key_name(source)
    key = (source.get(key_name) or "").strip()
    if not key:
        raise OpenAiRouteError(f"{key_name} is not set")
    return EmbeddingRoute(
        via=via,
        key_name=key_name,
        api_key=key,
        base_url=OPENROUTER_BASE_URL if via == "openrouter" else None,
        model=embedding_model_for(model, via),
    )
