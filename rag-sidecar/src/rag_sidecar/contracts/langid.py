"""Sidecar language identification (Phase 6.2 D-17, D-18): POST /v1/langid request and response."""

from pydantic import Field

from rag_sidecar.contracts.retrieval import _Contract

from .languages import Language

MAX_LANGID_CHARS = 1000


class LangidRequest(_Contract):
    text: str = Field(min_length=1, max_length=MAX_LANGID_CHARS)
    candidates: list[Language] = Field(min_length=1, max_length=16)


class LangidResponse(_Contract):
    language: Language | None
    confidence: float = Field(ge=0, le=1)
    model: str = Field(min_length=1, max_length=200)
