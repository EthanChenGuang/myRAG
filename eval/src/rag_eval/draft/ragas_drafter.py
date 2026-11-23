import os
import re
from collections.abc import Callable, Mapping, Sequence
from dataclasses import dataclass
from typing import Any

from rag_sidecar.contracts.golden import DraftedItemProposal, GoldSpan

from rag_eval.draft.config import DraftConfig, load_draft_config
from rag_eval.draft.sources import WorkspaceDocument
from rag_eval.draft.writer import DraftedEntry, DraftOutcome
from rag_eval.matching import normalize_text

GenerateFn = Callable[[list[str], list["RagasBucket"], list[dict[str, str]]], list[Mapping[str, Any]]]

_CJK = re.compile(r"[㐀-鿿豈-﫿]")
_ITALIAN_WORDS = frozenset(
    "il lo gli le una che per con non della del dei delle degli nel nella nello sono come quanto quale quali cosa alla alle "
    "anche più può dove quando devo posso vorrei è".split()
)
_HEADING = re.compile(r"^#{1,6}[ \t]+(.+?)[ \t]*$", re.MULTILINE)
_SENTENCES = re.compile(r"(?<=[.!?。！？])\s+|\n+")
_CODE_TOKEN = re.compile(r"\b(?=[A-Za-z0-9-]*[A-Za-z])(?=[A-Za-z0-9-]*\d)[A-Za-z0-9-]{3,}\b")


@dataclass(frozen=True)
class RagasBucket:
    style: str
    length: str
    count: int


def detect_language(text: str) -> str:
    stripped = "".join(text.split())
    if stripped and len(_CJK.findall(stripped)) / len(stripped) >= 0.2:
        return "zh"
    words = re.findall(r"[^\W\d_]+", text.casefold())
    if words and sum(word in _ITALIAN_WORDS for word in words) / len(words) >= 0.12:
        return "it"
    return "en"


def plan_buckets(n: int, styles: Sequence[str], lengths: Sequence[str]) -> list[RagasBucket]:
    if n <= 0:
        return []
    combos = [(styles[i % len(styles)], lengths[(i // len(styles)) % len(lengths)]) for i in range(len(styles) * len(lengths))]
    base, extra = divmod(n, len(combos))
    buckets = [RagasBucket(style, length, base + (1 if i < extra else 0)) for i, (style, length) in enumerate(combos)]
    return [bucket for bucket in buckets if bucket.count > 0]


def _bigrams(text: str) -> set[str]:
    norm = normalize_text(text)
    return {norm[i : i + 2] for i in range(len(norm) - 1)}


def _best_sentence(chunk: str, answer: str) -> str | None:
    answer_grams = _bigrams(answer)
    best: tuple[int, int, int, str] | None = None
    for position, raw in enumerate(_SENTENCES.split(chunk)):
        sentence = re.sub(r"^#{1,6}[ \t]+", "", raw.strip())
        if len(normalize_text(sentence)) < 8:
            continue
        score = (len(_bigrams(sentence) & answer_grams), -len(sentence), -position, sentence)
        if best is None or score[:3] > best[:3]:
            best = score
    return best[3] if best else None


def _locate(context: str, docs: Sequence[WorkspaceDocument]) -> tuple[WorkspaceDocument, str] | None:
    wanted = normalize_text(context)
    if not wanted:
        return None
    for doc in docs:
        for chunk in doc.chunks:
            if chunk == context:
                return doc, chunk
    for doc in docs:
        for chunk in doc.chunks:
            norm = normalize_text(chunk)
            if wanted in norm or norm in wanted:
                return doc, chunk
    return None


def _category(question: str, chunk: str) -> str:
    if sum(1 for line in chunk.split("\n") if line.count("|") >= 2) >= 3:
        return "table"
    if _CODE_TOKEN.search(question):
        return "exact_term"
    return "general"


def rows_to_proposals(rows: Sequence[Mapping[str, Any]], docs: Sequence[WorkspaceDocument]) -> DraftOutcome:
    outcome = DraftOutcome()
    for row in rows:
        question = str(row.get("user_input") or "").strip()
        answer = str(row.get("reference") or "").strip()
        contexts = [str(c) for c in (row.get("reference_contexts") or [])]
        if not question or not answer:
            outcome.rejected.append("ragas row without a question or reference answer")
            continue
        located = next((hit for hit in (_locate(c, docs) for c in contexts) if hit is not None), None)
        if located is None:
            outcome.rejected.append("ragas context is not a chunk of the workspace")
            continue
        doc, chunk = located
        quote = _best_sentence(chunk, answer)
        if quote is None:
            outcome.rejected.append("ragas context has no sentence long enough to quote")
            continue
        heading = _HEADING.search(chunk)
        proposal = DraftedItemProposal(
            question=question,
            language=detect_language(f"{question} {answer}"),
            category=_category(question, chunk),
            answerable=True,
            expected_answer=answer,
            gold_evidence=[GoldSpan(document=doc.filename, section=heading.group(1) if heading else "", quote=quote)],
        )
        notes = {"drafter": "ragas"}
        for key, field in (("style", "query_style"), ("length", "query_length"), ("persona", "persona_name")):
            if row.get(field):
                notes[key] = str(row[field])
        outcome.entries.append(DraftedEntry(proposal=proposal, provenance="ragas_generated", notes=notes))
    return outcome


def build_pinned_synthesizer(llm: Any, style: str, length: str) -> Any:
    from dataclasses import dataclass as _dataclass

    from ragas.testset.synthesizers.base import QueryLength, QueryStyle
    from ragas.testset.synthesizers.single_hop.specific import SingleHopSpecificQuerySynthesizer

    pinned_style, pinned_length = QueryStyle[style], QueryLength[length]

    @_dataclass
    class PinnedSingleHopSynthesizer(SingleHopSpecificQuerySynthesizer):
        def convert_to_scenario(self, data: dict[str, Any]) -> Any:
            return super().convert_to_scenario({**data, "style": pinned_style, "length": pinned_length})

    return PinnedSingleHopSynthesizer(llm=llm)


def _live_generate(chunks: list[str], buckets: list[RagasBucket], personas: list[dict[str, str]]) -> list[Mapping[str, Any]]:
    from langchain_openai import ChatOpenAI, OpenAIEmbeddings
    from ragas.embeddings import LangchainEmbeddingsWrapper
    from ragas.llms import LangchainLLMWrapper
    from ragas.testset import TestsetGenerator
    from ragas.testset.persona import Persona

    from rag_eval.judge.config import load_judge_config

    judge = load_judge_config()
    llm = LangchainLLMWrapper(
        ChatOpenAI(
            model=judge.judge_model,
            base_url=judge.base_url,
            api_key=os.environ["OPENROUTER_API_KEY"],
            temperature=judge.temperature,
        )
    )
    embeddings = LangchainEmbeddingsWrapper(
        OpenAIEmbeddings(model=judge.embedding_model, api_key=os.environ["OPENAI_API_KEY"])
    )
    generator = TestsetGenerator(
        llm=llm,
        embedding_model=embeddings,
        persona_list=[Persona(**persona) for persona in personas],
    )
    rows: list[Mapping[str, Any]] = []
    for position, bucket in enumerate(buckets):
        distribution = [(build_pinned_synthesizer(llm, bucket.style, bucket.length), 1.0)]
        if position == 0:
            testset = generator.generate_with_chunks(
                chunks, testset_size=bucket.count, query_distribution=distribution, raise_exceptions=False
            )
        else:
            testset = generator.generate(
                testset_size=bucket.count,
                query_distribution=distribution,
                num_personas=len(personas),
                raise_exceptions=False,
            )
        rows.extend(testset.to_list())  # type: ignore[union-attr]
    return rows


def draft_with_ragas(
    docs: Sequence[WorkspaceDocument],
    n: int,
    generate_fn: GenerateFn | None = None,
    *,
    config: DraftConfig | None = None,
) -> DraftOutcome:
    config = config or load_draft_config()
    buckets = plan_buckets(n, config.ragas_styles, config.ragas_lengths)
    if not buckets or not docs:
        return DraftOutcome()
    chunks = [chunk for doc in docs for chunk in doc.chunks]
    generate = generate_fn or _live_generate
    rows = generate(chunks, buckets, [persona.model_dump() for persona in config.personas])
    return rows_to_proposals(rows, docs)
