"""Language detector parity with src/lib/rag/lang/detect.ts via lang-vectors.json (03.1-14, 03.2-10)."""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from rag_sidecar.contracts.languages import LanguageRegistry
from rag_sidecar.ingest.lang import LanguageDetection, detect_language, detect_language_with_confidence

_ROOT = Path(__file__).resolve().parents[2]
_VECTORS_PATH = _ROOT / "tests" / "fixtures" / "ingest" / "lang-vectors.json"
_REGISTRY_PATH = _ROOT / "config" / "rag" / "language-packs.json"
_FIXTURE = json.loads(_VECTORS_PATH.read_text(encoding="utf-8"))
_VECTORS = _FIXTURE["vectors"]


def _registry(mutate=None) -> LanguageRegistry:
    raw = json.loads(_REGISTRY_PATH.read_text(encoding="utf-8"))
    if mutate is not None:
        mutate(raw)
    return LanguageRegistry.model_validate(raw)


def test_fixture_has_at_least_thirty_vectors_each_with_a_confidence():
    assert len(_VECTORS) >= 30
    assert all(isinstance(vector["confidence"], (int, float)) for vector in _VECTORS)


@pytest.mark.parametrize("vector", _VECTORS, ids=[item["name"] for item in _VECTORS])
def test_python_matches_pinned_vector(vector: dict) -> None:
    result = detect_language_with_confidence(vector["text"], vector.get("candidates"))
    assert result.language == vector["language"]
    assert result.confident == vector["confident"]
    assert result.confidence == pytest.approx(vector["confidence"], abs=5e-5)
    assert 0 <= result.confidence <= 1
    if "candidates" not in vector:
        assert detect_language(vector["text"]) == (vector["language"], vector["confident"])


def test_detection_stopwords_come_from_the_registry():
    neutral = "alpha beta gamma"
    assert detect_language_with_confidence(neutral).language is None

    def add_word(raw: dict) -> None:
        italian = next(pack for pack in raw["packs"] if pack["code"] == "it")
        italian["stopwords"]["detection"].append("gamma")

    assert detect_language_with_confidence(neutral, registry=_registry(add_word)) == LanguageDetection("it", True, 0.5)


def test_a_language_missing_from_the_registry_is_never_detected():
    def drop_italian(raw: dict) -> None:
        raw["packs"] = [pack for pack in raw["packs"] if pack["code"] != "it"]

    assert detect_language_with_confidence("Il prodotto è disponibile", registry=_registry(drop_italian)).language is None


def test_single_candidate_returns_at_once_with_confidence_one():
    assert detect_language_with_confidence("本合同自双方签字盖章之日起生效。", ["en"]) == LanguageDetection("en", True, 1.0)
    assert detect_language_with_confidence("", ["it", "it"]) == LanguageDetection("it", True, 1.0)
