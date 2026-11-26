"""Known refusal answers per language (orchestrator decision O-1); stub until implemented."""

from pathlib import Path

from rag_eval.paths import REPO_ROOT

REFUSAL_TEXTS_PATH = REPO_ROOT / "eval" / "fixtures" / "refusal-texts.json"


def load_refusal_texts() -> dict[str, list[str]]:
    return {"en": [""], "zh": [""], "it": [""]}


def is_refusal_answer(answer: str | None, language: str) -> bool:
    return False
