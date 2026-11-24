"""WorkerEnv reads the four variables the worker needs and never prints their values."""

from __future__ import annotations

import pytest

from rag_sidecar.ingest.worker_env import WorkerEnv

_ENV = {
    "NEXT_PUBLIC_SUPABASE_URL": "https://example.supabase.co/",
    "SUPABASE_SERVICE_ROLE_KEY": "service-key-placeholder-value",
    "RAG_APP_INTERNAL_URL": "http://app.internal:3000/",
    "RAG_SIDECAR_SECRET": "sidecar-secret-placeholder-value",
}


def test_from_env_reads_the_four_variables():
    env = WorkerEnv.from_env(_ENV)
    assert env.supabase_url == "https://example.supabase.co"
    assert env.app_internal_url == "http://app.internal:3000"
    assert env.service_role_key.get_secret_value() == _ENV["SUPABASE_SERVICE_ROLE_KEY"]
    assert env.sidecar_secret.get_secret_value() == _ENV["RAG_SIDECAR_SECRET"]


def test_secrets_never_appear_in_repr_or_dump():
    env = WorkerEnv.from_env(_ENV)
    text = repr(env) + str(env) + env.model_dump_json()
    assert _ENV["SUPABASE_SERVICE_ROLE_KEY"] not in text
    assert _ENV["RAG_SIDECAR_SECRET"] not in text


@pytest.mark.parametrize("missing", sorted(_ENV))
def test_a_missing_variable_is_named_without_any_value(missing):
    partial = {key: value for key, value in _ENV.items() if key != missing}
    with pytest.raises(ValueError) as caught:
        WorkerEnv.from_env(partial)
    message = str(caught.value)
    assert missing in message
    assert not any(value in message for value in partial.values())


def test_blank_values_count_as_missing():
    with pytest.raises(ValueError, match="RAG_SIDECAR_SECRET"):
        WorkerEnv.from_env({**_ENV, "RAG_SIDECAR_SECRET": "   "})
