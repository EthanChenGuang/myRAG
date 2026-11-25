"""Dominant-language detection, the twin of src/lib/rag/lang/detect.ts (Phase 3.2 D-05, D-13).

Stopwords and candidate languages come from the language registry; both runtimes are pinned by
tests/fixtures/ingest/lang-vectors.json.
"""

from __future__ import annotations

from collections.abc import Iterable
from dataclasses import dataclass

import regex as re

from rag_sidecar.contracts.languages import LanguageRegistry, load_language_registry

HAN_SHARE_FOR_ZH = 0.2
_HAN_SCRIPT = "Hani"

_HAN = re.compile(r"\p{Script=Han}")
_LATIN = re.compile(r"\p{Script=Latin}")
_WORD = re.compile(r"\p{L}+")

DetectedLanguage = str


@dataclass(frozen=True)
class LanguageDetection:
    language: DetectedLanguage | None
    confident: bool
    confidence: float


@dataclass(frozen=True)
class _DetectionPack:
    code: str
    han: bool
    stopwords: frozenset[str]


_NONE = LanguageDetection(None, False, 0.0)
_pack_cache: tuple[LanguageRegistry, list[_DetectionPack]] | None = None


def _detection_packs(registry: LanguageRegistry) -> list[_DetectionPack]:
    global _pack_cache
    if _pack_cache is not None and _pack_cache[0] is registry:
        return _pack_cache[1]
    packs = [
        _DetectionPack(pack.code, pack.script == _HAN_SCRIPT, frozenset(pack.stopwords.detection))
        for pack in registry.packs
    ]
    _pack_cache = (registry, packs)
    return packs


def _count_matches(text: str, pattern: re.Pattern[str]) -> int:
    return len(pattern.findall(text))


def detect_language_with_confidence(
    text: str,
    candidates: Iterable[str] | None = None,
    *,
    registry: LanguageRegistry | None = None,
) -> LanguageDetection:
    """Same rules and confidence formula as detectLanguageWithConfidence in detect.ts."""
    packs = _detection_packs(registry or load_language_registry())
    if candidates is not None:
        wanted = set(candidates)
        packs = [pack for pack in packs if pack.code in wanted]
        if not packs:
            return _NONE
        if len(packs) == 1:
            return LanguageDetection(packs[0].code, True, 1.0)

    han = _count_matches(text, _HAN)
    latin = _count_matches(text, _LATIN)
    letters = han + latin
    if letters == 0:
        return _NONE
    han_pack = next((pack for pack in packs if pack.han), None)
    han_share = han / letters
    if han_pack is not None and han_share >= HAN_SHARE_FOR_ZH:
        confidence = 0.5 + (0.5 * (han_share - HAN_SHARE_FOR_ZH)) / (1 - HAN_SHARE_FOR_ZH)
        return LanguageDetection(han_pack.code, True, confidence)

    word_packs = [pack for pack in packs if pack.stopwords]
    counts = [0] * len(word_packs)
    for match in _WORD.finditer(text.lower()):
        word = match.group(0)
        for index, pack in enumerate(word_packs):
            if word in pack.stopwords:
                counts[index] += 1
    best_index = -1
    best = 0
    second = 0
    for index, count in enumerate(counts):
        if count > best:
            second = best
            best = count
            best_index = index
        elif count > second:
            second = count
    if best_index < 0:
        return _NONE
    margin = best - second
    confidence = (margin / (best + second)) * (margin / (margin + 1))
    return LanguageDetection(word_packs[best_index].code, margin > 0, confidence)


def detect_language(text: str) -> tuple[DetectedLanguage | None, bool]:
    """Return (language or None, confident), as detectLanguageWithConfidence does."""
    result = detect_language_with_confidence(text)
    return result.language, result.confident
