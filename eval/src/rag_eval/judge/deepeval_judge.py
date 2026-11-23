import asyncio
import sys
from typing import Any

from deepeval.metrics import AnswerRelevancyMetric, ContextualRecallMetric, FaithfulnessMetric
from deepeval.models import DeepEvalBaseLLM
from deepeval.test_case import LLMTestCase
from pydantic import BaseModel
from rag_sidecar.contracts.judge import JudgeConfig

from rag_eval.judge.config import JudgeCase, JudgeFatalError, raise_if_fatal

Outcome = tuple[float | None, str | None]


_METRIC_CLASSES = {
    "faithfulness": FaithfulnessMetric,
    "answer_relevance": AnswerRelevancyMetric,
    "context_recall": ContextualRecallMetric,
}


def _wanted(case: JudgeCase) -> list[str]:
    wanted = ["answer_relevance"]
    if case.contexts:
        wanted.append("faithfulness")
        if case.reference is not None:
            wanted.append("context_recall")
    return wanted


async def _score_one(
    case: JudgeCase, metric_name: str, llm: DeepEvalBaseLLM, gate: asyncio.Semaphore
) -> tuple[tuple[str, str], Outcome]:
    key = (case.item_id, metric_name)
    async with gate:
        metric = _METRIC_CLASSES[metric_name](model=llm, include_reason=False, async_mode=True, eval_mode="llm")
        test_case = LLMTestCase(
            input=case.question,
            actual_output=case.answer,
            expected_output=case.reference,
            retrieval_context=list(case.contexts),
        )
        try:
            value = float(await metric.a_measure(test_case, _show_indicator=False))
        except JudgeFatalError:
            raise
        except Exception as exc:
            raise_if_fatal(exc)
            print(f"[Judge] deepeval {metric_name} failed for {case.item_id}: {type(exc).__name__}", file=sys.stderr)
            return key, (None, "judge_error")
    if value != value or not 0.0 <= value <= 1.0:
        return key, (None, "judge_error")
    return key, (value, None)


async def _score_all(cases: list[JudgeCase], llm: DeepEvalBaseLLM, max_concurrency: int) -> dict[tuple[str, str], Outcome]:
    gate = asyncio.Semaphore(max(1, max_concurrency))
    tasks = [_score_one(case, name, llm, gate) for case in cases for name in _wanted(case)]
    return dict(await asyncio.gather(*tasks))


def score_deepeval(
    cases: list[JudgeCase], llm: DeepEvalBaseLLM, max_concurrency: int = 4
) -> dict[tuple[str, str], Outcome]:
    return asyncio.run(_score_all(cases, llm, max_concurrency))


class OpenRouterDeepEvalLLM(DeepEvalBaseLLM):
    def __init__(self, config: JudgeConfig, api_key: str) -> None:
        self._config = config
        self._api_key = api_key
        super().__init__(model=config.judge_model)

    def load_model(self) -> "OpenRouterDeepEvalLLM":
        from openai import AsyncOpenAI, OpenAI

        self._client = OpenAI(api_key=self._api_key, base_url=self._config.base_url)
        self._async_client = AsyncOpenAI(api_key=self._api_key, base_url=self._config.base_url)
        return self

    def _request(self, prompt: str, schema: type[BaseModel] | None) -> dict[str, Any]:
        request: dict[str, Any] = {
            "model": self._config.judge_model,
            "messages": [{"role": "user", "content": prompt}],
            "temperature": self._config.temperature,
        }
        if schema is not None:
            request["response_format"] = schema
        return request

    @staticmethod
    def _extract(completion: Any, schema: type[BaseModel] | None) -> Any:
        message = completion.choices[0].message
        if schema is None:
            if message.content is None:
                raise ValueError("judge returned no content")
            return message.content
        if message.parsed is None:
            raise ValueError("judge returned no structured output")
        return message.parsed

    def generate(self, prompt: str, schema: type[BaseModel] | None = None) -> Any:
        request = self._request(prompt, schema)
        try:
            if schema is None:
                completion = self._client.chat.completions.create(**request)
            else:
                completion = self._client.chat.completions.parse(**request)
        except Exception as exc:
            raise_if_fatal(exc)
            raise
        return self._extract(completion, schema)

    async def a_generate(self, prompt: str, schema: type[BaseModel] | None = None) -> Any:
        request = self._request(prompt, schema)
        try:
            if schema is None:
                completion = await self._async_client.chat.completions.create(**request)
            else:
                completion = await self._async_client.chat.completions.parse(**request)
        except Exception as exc:
            raise_if_fatal(exc)
            raise
        return self._extract(completion, schema)

    def get_model_name(self) -> str:
        return self._config.judge_model

    def supports_temperature(self) -> bool:
        return True
