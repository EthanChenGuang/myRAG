"""Query generation and answerability LLM calls (Phase 6.1 D-04, D-05). Stub."""
from dataclasses import dataclass
from typing import Protocol, Sequence

from rag_sidecar.contracts.finetune import AnswerabilityVerdict, SyntheticQueryBatch

GENERATE_TOOL = "submit_queries"
JUDGE_TOOL = "judge_answerability"


@dataclass(frozen=True)
class Usage:
    input_tokens: int = 0
    output_tokens: int = 0


@dataclass(frozen=True)
class GenerationChunk:
    ref: int
    language: str
    text: str
    cross_language: str | None = None


@dataclass(frozen=True)
class GenerationRequest:
    chunks: tuple[GenerationChunk, ...]
    styles: tuple[str, ...]
    prompt_version: str


@dataclass(frozen=True)
class JudgeItem:
    ref: int
    query: str
    language: str
    chunk_text: str


@dataclass(frozen=True)
class GenerationResult:
    batch: SyntheticQueryBatch
    usage: Usage


@dataclass(frozen=True)
class JudgeResult:
    verdicts: tuple[AnswerabilityVerdict, ...]
    usage: Usage


class LLMOutputInvalid(Exception):
    def __init__(self, code: str, usage: Usage | None = None):
        super().__init__(code)
        self.code = code
        self.usage = usage or Usage()


class LLMCallFailed(Exception):
    pass


class QueryLLM(Protocol):
    generator_model: str
    judge_model: str

    def submit_queries(self, request: GenerationRequest) -> GenerationResult: ...

    def judge_answerability(self, items: Sequence[JudgeItem], *, prompt_version: str) -> JudgeResult: ...


class AnthropicQueryLLM:
    def __init__(self, config, client_factory=None):
        self.generator_model = ""
        self.judge_model = ""

    def submit_queries(self, request: GenerationRequest) -> GenerationResult:
        return GenerationResult(SyntheticQueryBatch(items=[]), Usage())

    def judge_answerability(self, items: Sequence[JudgeItem], *, prompt_version: str) -> JudgeResult:
        return JudgeResult((), Usage())
