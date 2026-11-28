"""Known refusal answers per language (orchestrator decision O-1): an answer that is exactly one of them is a refusal."""

import json
from functools import lru_cache
from pathlib import Path

from rag_eval.matching import normalize_text
from rag_eval.paths import REPO_ROOT

REFUSAL_TEXTS_PATH = REPO_ROOT / "eval" / "fixtures" / "refusal-texts.json"


def _read(path: Path) -> dict[str, list[str]]:
    raw = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(raw, dict):
        raise ValueError(f"{path}: expected an object of language code to refusal texts")
    texts: dict[str, list[str]] = {}
    for language, entries in raw.items():
        if not isinstance(entries, list) or not all(isinstance(entry, str) and normalize_text(entry) for entry in entries):
            raise ValueError(f"{path}: {language} must be a list of non-empty refusal texts")
        texts[language] = list(entries)
    return texts


@lru_cache(maxsize=1)
def _normalised() -> dict[str, frozenset[str]]:
    return {language: frozenset(normalize_text(t) for t in texts) for language, texts in load_refusal_texts().items()}


def load_refusal_texts() -> dict[str, list[str]]:
    return _read(REFUSAL_TEXTS_PATH)


def is_refusal_answer(answer: str | None, language: str) -> bool:
    """Whole-answer match after normalize_text; None, empty and longer answers that contain a refusal are not refusals."""
    if answer is None:
        return False
    folded = normalize_text(answer)
    return bool(folded) and folded in _normalised().get(language, frozenset())
