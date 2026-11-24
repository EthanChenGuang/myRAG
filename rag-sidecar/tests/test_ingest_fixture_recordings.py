import base64
import hashlib
import importlib.util
import io
import json
import sys
from pathlib import Path

import pytest

pytest.importorskip("docling_core.transforms.chunker.hybrid_chunker")
pytest.importorskip("tiktoken")
Image = pytest.importorskip("PIL.Image")

INGEST = Path(__file__).resolve().parents[2] / "eval" / "fixtures" / "ingest"
DATA_URI_PREFIX = "data:image/png;base64,"


def _recorder():
    spec = importlib.util.spec_from_file_location("ingest_fixture_recorder", INGEST / "record_parse_results.py")
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


def _pixels_hash(png: bytes) -> str:
    with Image.open(io.BytesIO(png)) as image:
        return hashlib.sha256(image.convert("RGB").tobytes()).hexdigest()


def _normalized(value):
    """Replaces embedded PNG data by the hash of its pixels, so a different zlib build does not count as drift."""
    if isinstance(value, dict):
        return {key: _normalized(item) for key, item in value.items()}
    if isinstance(value, list):
        return [_normalized(item) for item in value]
    if isinstance(value, str) and value.startswith(DATA_URI_PREFIX):
        return "png-pixels:" + _pixels_hash(base64.b64decode(value[len(DATA_URI_PREFIX) :]))
    return value


@pytest.fixture(scope="module")
def fresh():
    return _recorder().build_all(INGEST / "pdf")


def test_the_recorder_owns_every_committed_recording_and_the_manifest(fresh):
    committed = {f"recorded/{path.name}" for path in (INGEST / "recorded").iterdir()} | {"manifest.json"}
    assert set(fresh) == committed


def test_committed_recordings_equal_a_fresh_run_of_the_adapter(fresh):
    for relative, data in fresh.items():
        committed = (INGEST / relative).read_bytes()
        if relative.endswith(".png"):
            assert _pixels_hash(committed) == _pixels_hash(data), relative
        elif relative.endswith(".docling.json"):
            assert _normalized(json.loads(committed)) == _normalized(json.loads(data)), relative
        else:
            assert committed == data, relative


def test_the_manifest_hashes_match_the_committed_pdfs(fresh):
    manifest = json.loads(fresh["manifest.json"])
    for entry in manifest["fixtures"]:
        assert hashlib.sha256((INGEST / entry["path"]).read_bytes()).hexdigest() == entry["file_sha256"], entry["id"]
