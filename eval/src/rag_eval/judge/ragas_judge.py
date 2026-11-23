import asyncio
import sys
from typing import Any

from ragas.embeddings.base import BaseRagasEmbedding
from ragas.llms.base import InstructorBaseRagasLLM
from ragas.metrics.collections import AnswerRelevancy, ContextRecall, Faithfulness
from rag_sidecar.contracts.judge import JudgeConfig

from rag_eval.judge.config import JudgeCase, JudgeFatalError, raise_if_fatal

Outcome = tuple[float | None, str | None]


def _wanted(case: JudgeCase) -> list[str]:
    wanted = ["answer_relevance"]
    if case.contexts:
        wanted.append("faithfulness")
        if case.reference is not None:
            wanted.append("context_recall")
    return wanted


async def _score_one(
    case: JudgeCase,
    metric_name: str,
    metrics: dict[str, Any],
    gate: asyncio.Semaphore,
) -> tuple[tuple[str, str], Outcome]:
    key = (case.item_id, metric_name)
    async with gate:
        try:
            if metric_name == "faithfulness":
                result = await metrics[metric_name].ascore(
                    user_input=case.question, response=case.answer, retrieved_contexts=list(case.contexts)
                )
            elif metric_name == "answer_relevance":
                result = await metrics[metric_name].ascore(user_input=case.question, response=case.answer)
            else:
                result = await metrics[metric_name].ascore(
                    user_input=case.question,
                    retrieved_contexts=list(case.contexts),
                    reference=case.reference or "",
                )
            value = float(result.value)
        except JudgeFatalError:
            raise
        except Exception as exc:
            raise_if_fatal(exc)
            print(f"[Judge] ragas {metric_name} failed for {case.item_id}: {type(exc).__name__}", file=sys.stderr)
            return key, (None, "judge_error")
    if value != value or not 0.0 <= value <= 1.0:
        return key, (None, "judge_error")
    return key, (value, None)


async def _score_all(
    cases: list[JudgeCase], llm: InstructorBaseRagasLLM, embeddings: BaseRagasEmbedding, max_concurrency: int
) -> dict[tuple[str, str], Outcome]:
    metrics: dict[str, Any] = {
        "faithfulness": Faithfulness(llm=llm),
        "answer_relevance": AnswerRelevancy(llm=llm, embeddings=embeddings),
        "context_recall": ContextRecall(llm=llm),
    }
    gate = asyncio.Semaphore(max(1, max_concurrency))
    tasks = [_score_one(case, name, metrics, gate) for case in cases for name in _wanted(case)]
    return dict(await asyncio.gather(*tasks))


def score_ragas(
    cases: list[JudgeCase],
    llm: InstructorBaseRagasLLM,
    embeddings: BaseRagasEmbedding,
    max_concurrency: int = 4,
) -> dict[tuple[str, str], Outcome]:
    return asyncio.run(_score_all(cases, llm, embeddings, max_concurrency))


def build_ragas_live(config: JudgeConfig, openrouter_key: str, openai_key: str) -> tuple[InstructorBaseRagasLLM, BaseRagasEmbedding]:
    from openai import AsyncOpenAI
    from ragas.embeddings.base import embedding_factory
    from ragas.llms.base import llm_factory

    llm = llm_factory(
        config.judge_model,
        provider="openai",
        client=AsyncOpenAI(api_key=openrouter_key, base_url=config.base_url),
        temperature=config.temperature,
    )
    sent = llm._map_provider_params().get("temperature")  # type: ignore[attr-defined]
    if sent != config.temperature:
        raise JudgeFatalError(
            f"the Ragas wrapper would send temperature {sent!r} instead of {config.temperature!r} "
            f"for {config.judge_model!r}; pin another non-Claude judge"
        )
    embeddings = embedding_factory(
        "openai",
        model=config.embedding_model,
        client=AsyncOpenAI(api_key=openai_key),
        interface="modern",
    )
    return llm, embeddings  # type: ignore[return-value]

