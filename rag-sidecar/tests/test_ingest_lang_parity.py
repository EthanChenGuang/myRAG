"""Language detector parity with src/lib/rag/lang/detect.ts via lang-vectors.json."""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from rag_sidecar.ingest.lang import detect_language

_VECTORS_PATH = (
    Path(__file__).resolve().parents[2] / "tests" / "fixtures" / "ingest" / "lang-vectors.json"
)
_FIXTURE = json.loads(_VECTORS_PATH.read_text(encoding="utf-8"))
_VECTORS = _FIXTURE["vectors"]


def test_fixture_has_at_least_thirty_vectors():
    assert len(_VECTORS) >= 30


@pytest.mark.parametrize("vector", _VECTORS, ids=[item["name"] for item in _VECTORS])
def test_python_matches_pinned_vector(vector: dict) -> None:
    language, confident = detect_language(vector["text"])
    assert language == vector["language"]
    assert confident == vector["confident"]