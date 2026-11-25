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


# ---------------------------------------------------------------------------------------------------------------------
# Phase 3.2 D-19, D-22: the long-table recordings under the effective header flag
# ---------------------------------------------------------------------------------------------------------------------

LONG_TABLES = ("long-table-zh", "long-table-en", "long-table-it")


def _long_table_spec(fixture_id: str):
    recorder = _recorder()
    return recorder, next(spec for spec in recorder._specs().long_table_specs() if spec.id == fixture_id)


def _recorded_document(fixture_id: str):
    from docling_core.types.doc import DoclingDocument

    from rag_sidecar.parse.docling_adapter import SIDECAR_METADATA_KEY

    payload = json.loads((INGEST / "recorded" / f"{fixture_id}.docling.json").read_text(encoding="utf-8"))
    payload.pop(SIDECAR_METADATA_KEY, None)
    return DoclingDocument.model_validate(payload)


def _parse(fixture_id: str, tmp_path: Path, **request_updates):
    from rag_sidecar.parse.docling_adapter import to_parse_result

    recorder, spec = _long_table_spec(fixture_id)
    request = recorder.request_for(spec).model_copy(update=request_updates)
    out_dir = tmp_path / fixture_id / "-".join(f"{key}={value}" for key, value in sorted(request_updates.items()))
    out_dir.mkdir(parents=True)
    return to_parse_result(_recorded_document(fixture_id), request, out_dir), out_dir


def _header_lines(spec) -> str:
    first_table = next(chunk for chunk in json.loads((INGEST / "recorded" / f"{spec.id}.parse.json").read_text("utf-8"))["chunks"] if chunk["is_table"])
    return "\n".join(first_table["text"].splitlines()[:2])


@pytest.mark.parametrize("fixture_id", LONG_TABLES)
def test_the_recorded_long_table_is_chunked_as_recorded_with_the_profile_flag(fixture_id, tmp_path):
    result, _ = _parse(fixture_id, tmp_path)
    committed = json.loads((INGEST / "recorded" / f"{fixture_id}.parse.json").read_text(encoding="utf-8"))
    assert result.model_dump(mode="json")["chunks"] == committed["chunks"]


@pytest.mark.parametrize("fixture_id", LONG_TABLES)
def test_under_the_effective_flag_every_chunk_of_the_60_row_table_starts_with_the_header(fixture_id, tmp_path):
    _, spec = _long_table_spec(fixture_id)
    header = _header_lines(spec)
    plain, _ = _parse(fixture_id, tmp_path)
    assert any(not chunk.text.startswith(header) for chunk in plain.chunks if chunk.is_table)

    result, _ = _parse(fixture_id, tmp_path, repeat_table_header=True)

    tables = [chunk for chunk in result.chunks if chunk.is_table]
    assert len(tables) > 1
    assert all(chunk.text.startswith(header + "\n") for chunk in tables)


@pytest.mark.parametrize("fixture_id", LONG_TABLES)
def test_under_repeat_and_carry_every_chunk_of_the_continued_variant_starts_with_the_header(fixture_id, tmp_path):
    _, spec = _long_table_spec(fixture_id)
    header = _header_lines(spec)
    continued = f"{fixture_id}-continued"

    result, out_dir = _parse(continued, tmp_path, repeat_table_header=True, carry_table_header=True)

    tables = [chunk for chunk in result.chunks if chunk.is_table]
    assert any(chunk.pages == [2] for chunk in tables)
    assert all(chunk.text.startswith(header + "\n") for chunk in tables)
    assert all(chunk.table_header_carried is True for chunk in tables if chunk.pages == [2])
    committed = json.loads((INGEST / "recorded" / f"{continued}.docling.json").read_text(encoding="utf-8"))
    assert _normalized(json.loads((out_dir / "docling.json").read_text(encoding="utf-8"))) == _normalized(committed)


@pytest.mark.parametrize("fixture_id", LONG_TABLES)
def test_the_carry_leaves_the_single_table_variant_untouched(fixture_id, tmp_path):
    plain, _ = _parse(fixture_id, tmp_path, repeat_table_header=True)
    carried, _ = _parse(fixture_id, tmp_path, repeat_table_header=True, carry_table_header=True)
    assert carried.chunks == plain.chunks
