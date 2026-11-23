from typing import Literal

from pydantic import BaseModel, ConfigDict

from rag_sidecar.contracts.eval_run import ConversationTurn


class _Contract(BaseModel):
    model_config = ConfigDict(frozen=True)


class GoldSpan(_Contract):
    document: str
    section: str
    quote: str


class GoldenItem(_Contract):
    id: str
    question: str
    conversation: list[ConversationTurn] = []
    language: str
    category: str
    answerable: bool
    expected_answer: str | None = None
    gold_evidence: list[GoldSpan] = []
    review_status: str
    provenance: str
    split: str
