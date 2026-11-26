"""Deterministic fakes for the fine-tune pipeline tests (Phase 6.1 D-05, D-17). No network, no API key."""
import hashlib
import math
from collections.abc import Callable, Sequence

from rag_sidecar.contracts.finetune import AnswerabilityVerdict, SyntheticQuery, SyntheticQueryBatch

from rag_eval.finetune.llm import GenerationRequest, GenerationResult, JudgeItem, JudgeResult, Usage

TEMPLATES: dict[str, dict[str, str]] = {
    "en": {
        "keyword": "sample topic terms {tag}",
        "question": "What does the passage say about item {tag}?",
        "colloquial": "so how does that thing {tag} work",
        "cross_language": "Which statement covers entry {tag}?",
    },
    "it": {
        "keyword": "termini argomento esempio {tag}",
        "question": "Che cosa dice il passaggio sull'elemento {tag}?",
        "colloquial": "allora come funziona la cosa {tag}",
        "cross_language": "Quale frase riguarda la voce {tag}?",
    },
    "zh": {
        "keyword": "示例主题词 {tag}",
        "question": "这段文字关于条目 {tag} 说了什么？",
        "colloquial": "那个东西 {tag} 到底怎么用",
        "cross_language": "哪句话讲到了条目 {tag}？",
    },
}
UNANSWERABLE_MARKER = "UNANSWERABLE"


def _tag(text: str, style: str) -> str:
    return hashlib.sha256(f"{style}|{text}".encode("utf-8")).hexdigest()[:8]


def _tokens(text: str) -> int:
    return max(1, math.ceil(len(text) / 4))


class FakeQueryLLM:
    """Builds queries from fixed templates per language and style; counts calls; usage is a character estimate."""

    def __init__(
        self,
        generator_model: str = "fake-generator",
        judge_model: str = "fake-judge",
        *,
        judge_rule: Callable[[JudgeItem], tuple[bool, float]] | None = None,
        unknown_refs: int = 0,
        wrong_language: bool = False,
    ):
        self.generator_model = generator_model
        self.judge_model = judge_model
        self.generate_calls = 0
        self.judge_calls = 0
        self.requests: list[GenerationRequest] = []
        self.judge_rule = judge_rule or (
            lambda item: (False, 0.95) if UNANSWERABLE_MARKER in item.query else (True, 0.9)
        )
        self.unknown_refs = unknown_refs
        self.wrong_language = wrong_language

    def submit_queries(self, request: GenerationRequest) -> GenerationResult:
        self.generate_calls += 1
        self.requests.append(request)
        items: list[SyntheticQuery] = []
        for chunk in request.chunks:
            for style in request.styles:
                language = chunk.language
                if self.wrong_language:
                    language = next(code for code in sorted(TEMPLATES) if code != chunk.language)
                text = TEMPLATES[chunk.language][style].format(tag=_tag(chunk.text, style))
                items.append(SyntheticQuery(chunk_ref=chunk.ref, language=language, style=style, query=text))
            if chunk.cross_language:
                text = TEMPLATES[chunk.cross_language]["cross_language"].format(tag=_tag(chunk.text, "cross_language"))
                items.append(
                    SyntheticQuery(chunk_ref=chunk.ref, language=chunk.cross_language, style="cross_language", query=text)
                )
        top = max((chunk.ref for chunk in request.chunks), default=-1)
        for extra in range(self.unknown_refs):
            items.append(SyntheticQuery(chunk_ref=top + 1 + extra, language="en", style="keyword", query="stray entry"))
        usage = Usage(
            input_tokens=sum(_tokens(chunk.text) for chunk in request.chunks) + 200,
            output_tokens=sum(_tokens(item.query) + 10 for item in items),
        )
        return GenerationResult(SyntheticQueryBatch(items=items), usage)

    def judge_answerability(self, items: Sequence[JudgeItem], *, prompt_version: str) -> JudgeResult:
        self.judge_calls += 1
        verdicts = []
        for item in items:
            answerable, confidence = self.judge_rule(item)
            verdicts.append(AnswerabilityVerdict(answerable=answerable, confidence=confidence))
        usage = Usage(
            input_tokens=sum(_tokens(item.query) + _tokens(item.chunk_text) for item in items) + 150,
            output_tokens=12 * len(items),
        )
        return JudgeResult(tuple(verdicts), usage)
