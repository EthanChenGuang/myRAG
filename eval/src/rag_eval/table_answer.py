"""Deterministic table_split answer check (D-46, EVAL-18). Implemented in Task 2."""

from rag_sidecar.contracts.golden import TableAnswer
from rag_sidecar.contracts.report import TableAnswerVerdict


def score_table_answer(answer: str, table_answer: TableAnswer) -> TableAnswerVerdict:
    return "wrong"
