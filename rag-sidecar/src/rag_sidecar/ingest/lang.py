"""Dominant-language detection aligned with src/lib/rag/lang/detect.ts (Phase 3 D-09 / 03.1-14)."""

from __future__ import annotations

import regex as re

HAN_SHARE_FOR_ZH = 0.2

_EN_STOPWORDS = frozenset(
    {
        "the",
        "and",
        "of",
        "to",
        "is",
        "are",
        "was",
        "were",
        "be",
        "been",
        "for",
        "with",
        "that",
        "this",
        "it",
        "as",
        "on",
        "at",
        "by",
        "from",
        "or",
        "not",
        "have",
        "has",
        "will",
        "can",
        "if",
        "within",
        "you",
        "your",
        "we",
        "our",
        "an",
        "which",
        "any",
        "all",
        "such",
        "than",
        "their",
        "its",
    }
)

_IT_STOPWORDS = frozenset(
    {
        "il",
        "lo",
        "la",
        "le",
        "gli",
        "un",
        "una",
        "uno",
        "di",
        "del",
        "della",
        "dei",
        "delle",
        "degli",
        "che",
        "è",
        "per",
        "con",
        "su",
        "sono",
        "non",
        "nel",
        "nella",
        "alla",
        "al",
        "dal",
        "dalla",
        "si",
        "come",
        "più",
        "anche",
        "questo",
        "questa",
        "se",
        "ha",
        "hanno",
        "entro",
        "nei",
        "sul",
        "tra",
        "fra",
        "ogni",
    }
)

_HAN = re.compile(r"\p{Script=Han}")
_LATIN = re.compile(r"\p{Script=Latin}")
_WORD = re.compile(r"\p{L}+", re.IGNORECASE)

DetectedLanguage = str


def _count_matches(text: str, pattern: re.Pattern[str]) -> int:
    return len(pattern.findall(text))


def detect_language(text: str) -> tuple[DetectedLanguage | None, bool]:
    """Return (zh|en|it|None, confident) using the same rules as detectLanguageWithConfidence."""
    han = _count_matches(text, _HAN)
    latin = _count_matches(text, _LATIN)
    letters = han + latin
    if letters == 0:
        return None, False
    if han / letters >= HAN_SHARE_FOR_ZH:
        return "zh", True

    lowered = text.lower()
    en = 0
    it = 0
    for match in _WORD.finditer(lowered):
        word = match.group(0)
        if word in _EN_STOPWORDS:
            en += 1
        if word in _IT_STOPWORDS:
            it += 1
    if en == 0 and it == 0:
        return None, False
    confident = en != it
    language: DetectedLanguage = "it" if it > en else "en"
    return language, confident