"""The registry equals the sidecar's current language constants, one check per consumer (Phase 3.2 D-05).

lang.py and the Docling OCR mapping do not read the registry yet; these checks keep both in step until they do.
Detector 3 (docling_adapter.detect_language) keeps its own stopword list and threshold (research F-10):
its outputs are pinned here unchanged, and plan 03.2-10 decides its future.
"""

from __future__ import annotations

import json
from collections.abc import Callable
from pathlib import Path

import pytest

pytest.importorskip("docling_core")
pytest.importorskip("regex")

from rag_sidecar.contracts.languages import LanguagePack, LanguageRegistry  # noqa: E402
from rag_sidecar.ingest.lang import _EN_STOPWORDS, _IT_STOPWORDS  # noqa: E402
from rag_sidecar.parse.docling_adapter import detect_language as docling_detect_language  # noqa: E402
from rag_sidecar.parse.docling_adapter import to_ppocr_code  # noqa: E402

REPO_ROOT = Path(__file__).resolve().parents[2]
REGISTRY_PATH = REPO_ROOT / "config" / "rag" / "language-packs.json"
VECTORS = json.loads((REPO_ROOT / "tests" / "fixtures" / "ingest" / "lang-vectors.json").read_text(encoding="utf-8"))[
    "vectors"
]

_LANG_PY_STOPWORDS: dict[str, frozenset[str]] = {"zh": frozenset(), "en": _EN_STOPWORDS, "it": _IT_STOPWORDS}

# Detector 3 returns None on an en/it stopword tie where detectors 1 and 2 return en (pinned, not changed here).
_DOCLING_DETECTOR_DIFFERS = {"mixed-it-en-tie": None, "en-it-equal-two": None}


def _raw() -> dict:
    return json.loads(REGISTRY_PATH.read_text(encoding="utf-8"))


def _packs(raw: dict | None = None) -> list[LanguagePack]:
    return LanguageRegistry.model_validate(raw or _raw()).packs


def _lang_py_stopwords(packs: list[LanguagePack]) -> list[str]:
    return [pack.code for pack in packs if set(pack.stopwords.detection) != _LANG_PY_STOPWORDS.get(pack.code)]


def _docling_ocr_codes(packs: list[LanguagePack]) -> list[str]:
    return [pack.code for pack in packs if [pack.ocr_codes.docling.rapidocr] != to_ppocr_code([pack.code])]


CONSUMERS: dict[str, Callable[[list[LanguagePack]], list[str]]] = {
    "lang.py detection stopwords": _lang_py_stopwords,
    "docling_adapter.to_ppocr_code": _docling_ocr_codes,
}


@pytest.mark.parametrize("consumer", list(CONSUMERS))
def test_registry_equals_consumer(consumer):
    assert CONSUMERS[consumer](_packs()) == []


def test_to_ppocr_code_maps_each_registry_language_to_its_rapidocr_code():
    assert [to_ppocr_code([code])[0] for code in ("zh", "en", "it")] == ["ch", "en", "it"]


@pytest.mark.parametrize("vector", VECTORS, ids=[vector["name"] for vector in VECTORS])
def test_docling_detector_outputs_are_pinned(vector):
    expected = _DOCLING_DETECTOR_DIFFERS.get(vector["name"], vector["language"])
    assert docling_detect_language(vector["text"]) == expected


def test_changing_one_detection_stopword_fails_exactly_the_stopword_check():
    raw = _raw()
    italian = next(pack for pack in raw["packs"] if pack["code"] == "it")
    italian["stopwords"]["detection"] = italian["stopwords"]["detection"][1:] + ["parolanuova"]
    failing = [name for name, check in CONSUMERS.items() if check(_packs(raw))]
    assert failing == ["lang.py detection stopwords"]
