import json
import socket
from typing import Any

import httpx
import openai
import pytest

import rag_eval.judge  # noqa: F401  (applies the telemetry opt-out before the judge libraries load)
from rag_eval.judge.config import JUDGE_MAX_OUTPUT_TOKENS, JudgeCase, load_judge_config
from rag_eval.judge_calibration import judge_fingerprint

RAGAS_DEFAULT_MAX_TOKENS = 1024


@pytest.fixture
def no_sockets(monkeypatch: pytest.MonkeyPatch) -> list[Any]:
    attempts: list[Any] = []

    def record(*args: Any, **kwargs: Any) -> Any:
        attempts.append(args)
        raise OSError("outbound connection blocked by the test")

    monkeypatch.setattr(socket.socket, "connect", record)
    monkeypatch.setattr(socket, "getaddrinfo", record)
    return attempts


class _FakeProvider:
    """OpenAI-compatible endpoint that records each chat request and answers cut off at the length limit."""

    def __init__(self) -> None:
        self.chat_requests: list[dict[str, Any]] = []

    def handle(self, request: httpx.Request) -> httpx.Response:
        body = json.loads(request.content or b"{}")
        if request.url.path.endswith("/embeddings"):
            inputs = body["input"] if isinstance(body["input"], list) else [body["input"]]
            data = [{"object": "embedding", "index": i, "embedding": [1.0, 0.0, 0.0]} for i in range(len(inputs))]
            return httpx.Response(200, json={"object": "list", "data": data, "model": body["model"], "usage": {"prompt_tokens": 1, "total_tokens": 1}})
        self.chat_requests.append(body)
        limit = body.get("max_tokens", body.get("max_completion_tokens"))
        return httpx.Response(
            200,
            json={
                "id": "chatcmpl-fake",
                "object": "chat.completion",
                "created": 0,
                "model": body["model"],
                "choices": [
                    {
                        "index": 0,
                        "message": {"role": "assistant", "content": '{"statements": ["The policy allows'},
                        "finish_reason": "length",
                    }
                ],
                "usage": {"prompt_tokens": 10, "completion_tokens": limit or 0, "total_tokens": (limit or 0) + 10},
            },
        )


@pytest.fixture
def fake_provider(monkeypatch: pytest.MonkeyPatch) -> _FakeProvider:
    provider = _FakeProvider()

    class OfflineAsyncOpenAI(openai.AsyncOpenAI):
        def __init__(self, *args: Any, **kwargs: Any) -> None:
            kwargs["http_client"] = httpx.AsyncClient(transport=httpx.MockTransport(provider.handle))
            kwargs["max_retries"] = 0
            super().__init__(*args, **kwargs)

    monkeypatch.setattr(openai, "AsyncOpenAI", OfflineAsyncOpenAI)
    return provider


def test_output_limit_is_well_above_the_ragas_default() -> None:
    assert JUDGE_MAX_OUTPUT_TOKENS >= 8 * RAGAS_DEFAULT_MAX_TOKENS


def test_ragas_judge_is_built_with_the_raised_output_limit(no_sockets: list[Any]) -> None:
    from rag_eval.judge.ragas_judge import build_ragas_live

    llm, _ = build_ragas_live(load_judge_config(), "placeholder-openrouter-key", "placeholder-openai-key")
    params = llm._map_provider_params()  # type: ignore[attr-defined]
    assert params.get("max_tokens", params.get("max_completion_tokens")) == JUDGE_MAX_OUTPUT_TOKENS
    assert params["temperature"] == 0.0
    assert no_sockets == []


def test_deepeval_judge_requests_the_raised_output_limit(no_sockets: list[Any]) -> None:
    from rag_eval.judge.deepeval_judge import OpenRouterDeepEvalLLM

    llm = OpenRouterDeepEvalLLM(load_judge_config(), "placeholder-openrouter-key")
    for schema in (None, JudgeCase):
        assert llm._request("prompt", schema)["max_tokens"] == JUDGE_MAX_OUTPUT_TOKENS
    assert no_sockets == []


def test_output_limit_reaches_the_wire_and_a_truncated_answer_counts_as_judge_error(
    fake_provider: _FakeProvider, no_sockets: list[Any]
) -> None:
    from rag_eval.judge.ragas_judge import build_ragas_live, score_ragas

    llm, embeddings = build_ragas_live(load_judge_config(), "placeholder-openrouter-key", "placeholder-openai-key")
    cases = [
        JudgeCase(
            item_id=f"en-general-00{index}",
            question="How long is the refund window?",
            answer="Refunds are accepted within thirty days.",
            contexts=["The policy allows refunds within thirty days."],
            reference="Thirty days.",
        )
        for index in (1, 2)
    ]
    outcomes = score_ragas(cases, llm, embeddings, max_concurrency=2)

    assert len(outcomes) == 6
    assert all(outcome == (None, "judge_error") for outcome in outcomes.values())
    assert fake_provider.chat_requests
    for body in fake_provider.chat_requests:
        assert body.get("max_tokens", body.get("max_completion_tokens")) == JUDGE_MAX_OUTPUT_TOKENS
    assert no_sockets == []


def test_fingerprint_changes_with_the_output_limit() -> None:
    config = load_judge_config()
    versions = {"deepeval": "1.0.0", "ragas": "2.0.0"}
    rubrics = {"ragas.faithfulness": "rubric"}
    base = judge_fingerprint("nightly", config, versions=versions, rubrics=rubrics)
    assert base == judge_fingerprint(
        "nightly", config, versions=versions, rubrics=rubrics, max_output_tokens=JUDGE_MAX_OUTPUT_TOKENS
    )
    assert base != judge_fingerprint(
        "nightly", config, versions=versions, rubrics=rubrics, max_output_tokens=RAGAS_DEFAULT_MAX_TOKENS
    )
