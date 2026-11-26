import subprocess
import sys

import numpy as np
import pytest

from rag_eval.finetune import encoders, vectors_io
from rag_eval.finetune.encoders import FakeEncoder, StoredVectorsEncoder, TextItem
from rag_eval.finetune.vectors_io import (
    VectorFileInvalid,
    VectorFileShapeError,
    VectorFileTampered,
    read_chunk_vectors,
    read_query_vectors,
    write_vector_set,
)

TENANT_A = "o:00000000-0000-4000-8000-0000000000a1"
TENANT_B = "o:00000000-0000-4000-8000-0000000000b2"
PROFILE = "ft-a-1024"
MODEL = "fake-model"


def _write_chunks(run_dir, tenant=TENANT_A, ids=("c1", "c2", "c3"), dims=4):
    matrix = np.arange(len(ids) * dims, dtype=np.float32).reshape(len(ids), dims) + 1
    write_vector_set(run_dir, kind="chunks", tenant_key=tenant, profile_id=PROFILE, model=MODEL, ids=list(ids), matrix=matrix)
    return matrix


# --- Task 1: vector IO and encoders --------------------------------------------------------------------------


def test_io_round_trip_uses_the_per_tenant_06_1_10_names(tmp_path):
    matrix = _write_chunks(tmp_path)
    queries = np.eye(2, 4, dtype=np.float32)
    write_vector_set(
        tmp_path, kind="queries", tenant_key=TENANT_A, profile_id=PROFILE, model=MODEL, ids=["q1", "q2"], matrix=queries
    )
    stem = "o_00000000-0000-4000-8000-0000000000a1." + PROFILE
    for suffix in (".f32", ".rows.jsonl", ".header.json"):
        assert (tmp_path / "vectors" / f"{stem}{suffix}").is_file()
        assert (tmp_path / "vectors" / f"query-vectors.{stem}{suffix}").is_file()
    chunks = read_chunk_vectors(tmp_path, TENANT_A, PROFILE)
    assert chunks.ids == ("c1", "c2", "c3")
    assert chunks.matrix.dtype == np.float32
    np.testing.assert_array_equal(chunks.matrix, matrix)
    read = read_query_vectors(tmp_path, TENANT_A, PROFILE, expected_dims=4)
    assert read.ids == ("q1", "q2")
    assert vectors_io.chunk_vector_profiles(tmp_path, TENANT_A) == [PROFILE]
    assert vectors_io.chunk_vector_profiles(tmp_path, TENANT_B) == []


def test_io_tampered_f32_is_refused(tmp_path):
    _write_chunks(tmp_path)
    f32 = tmp_path / "vectors" / f"o_00000000-0000-4000-8000-0000000000a1.{PROFILE}.f32"
    data = bytearray(f32.read_bytes())
    data[0] ^= 0x01
    f32.write_bytes(bytes(data))
    with pytest.raises(VectorFileTampered):
        read_chunk_vectors(tmp_path, TENANT_A, PROFILE)


def test_io_dims_mismatch_is_refused(tmp_path):
    _write_chunks(tmp_path, dims=4)
    with pytest.raises(VectorFileShapeError):
        read_chunk_vectors(tmp_path, TENANT_A, PROFILE, expected_dims=8)
    header = tmp_path / "vectors" / f"o_00000000-0000-4000-8000-0000000000a1.{PROFILE}.header.json"
    header.write_text(header.read_text().replace('"dims": 4', '"dims": 3'))
    with pytest.raises(VectorFileShapeError):
        read_chunk_vectors(tmp_path, TENANT_A, PROFILE)


def test_io_header_of_another_tenant_is_refused(tmp_path):
    _write_chunks(tmp_path, tenant=TENANT_B)
    source = tmp_path / "vectors"
    for path in list(source.iterdir()):
        path.rename(source / path.name.replace("0000000000b2", "0000000000a1"))
    with pytest.raises(VectorFileInvalid):
        read_chunk_vectors(tmp_path, TENANT_A, PROFILE)


def test_io_row_count_mismatch_is_refused(tmp_path):
    _write_chunks(tmp_path)
    rows = tmp_path / "vectors" / f"o_00000000-0000-4000-8000-0000000000a1.{PROFILE}.rows.jsonl"
    rows.write_text("".join(rows.read_text().splitlines(keepends=True)[:2]))
    with pytest.raises(VectorFileShapeError):
        read_chunk_vectors(tmp_path, TENANT_A, PROFILE)


def test_encoder_fake_is_deterministic_and_unit_norm():
    encoder = FakeEncoder(dims=32)
    items = [TextItem("a", "a neutral sample sentence"), TextItem("b", "a neutral sample sentence"), TextItem("c", "x")]
    first = encoder.encode_queries(items)
    again = FakeEncoder(dims=32).encode_documents(items)
    assert first.dtype == np.float32 and first.shape == (3, 32)
    np.testing.assert_array_equal(first[0], first[1])
    np.testing.assert_array_equal(first, again)
    np.testing.assert_allclose(np.linalg.norm(first, axis=1), 1.0, atol=1e-6)
    assert not np.allclose(first[0], first[2])


def test_encoder_stored_vectors_by_id(tmp_path):
    _write_chunks(tmp_path)
    write_vector_set(
        tmp_path,
        kind="queries",
        tenant_key=TENANT_A,
        profile_id=PROFILE,
        model=MODEL,
        ids=["q1"],
        matrix=np.array([[3.0, 0.0, 4.0, 0.0]], dtype=np.float32),
    )
    encoder = StoredVectorsEncoder.from_bundle(tmp_path, TENANT_A, PROFILE)
    query = encoder.encode_queries([TextItem("q1", "ignored")])
    np.testing.assert_allclose(query, [[0.6, 0.0, 0.8, 0.0]], atol=1e-6)
    documents = encoder.encode_documents([TextItem("c3", ""), TextItem("c1", "")])
    np.testing.assert_allclose(np.linalg.norm(documents, axis=1), 1.0, atol=1e-6)
    assert encoder.has_document("c2") and not encoder.has_document("c9")
    with pytest.raises(encoders.MissingVector):
        encoder.encode_documents([TextItem("c9", "")])


def test_encoder_stored_vectors_refuse_query_dims_mismatch(tmp_path):
    _write_chunks(tmp_path, dims=4)
    write_vector_set(
        tmp_path, kind="queries", tenant_key=TENANT_A, profile_id=PROFILE, model=MODEL, ids=["q1"], matrix=np.ones((1, 3))
    )
    with pytest.raises(VectorFileShapeError):
        StoredVectorsEncoder.from_bundle(tmp_path, TENANT_A, PROFILE)


def test_encoder_st_module_imports_without_the_finetune_extra():
    code = (
        "import sys\n"
        "sys.modules['sentence_transformers'] = None\n"
        "sys.modules['torch'] = None\n"
        "import rag_eval.finetune.encoders as e\n"
        "enc = e.SentenceTransformerEncoder('some/model')\n"
        "try:\n"
        "    enc.encode_queries([e.TextItem('a', 'b')])\n"
        "except e.EncoderUnavailable as exc:\n"
        "    print('unavailable', exc)\n"
    )
    result = subprocess.run([sys.executable, "-c", code], capture_output=True, text=True, check=True)
    assert "unavailable" in result.stdout
    assert "finetune extra" in result.stdout
