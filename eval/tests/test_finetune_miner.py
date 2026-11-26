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


# --- Task 2: vectors miner, guards and the split rule --------------------------------------------------------

import hashlib  # noqa: E402
import json  # noqa: E402

from rag_sidecar.contracts.finetune import (  # noqa: E402
    DatasetManifest,
    ExportedChunk,
    FinetuneNegative,
    FinetunePair,
    MiningParams,
    MiningReport,
)

from rag_eval.finetune import bundle, miner  # noqa: E402
from rag_eval.finetune.config import load_finetune_config  # noqa: E402
from rag_eval.finetune.generate import RawSyntheticQuery  # noqa: E402
from rag_eval.finetune.mined import cluster_queries  # noqa: E402

DIMS = 16


def _doc(n: int) -> str:
    return f"00000000-0000-4000-8000-{n:012d}"


def _hash(text: str) -> str:
    return hashlib.sha256(text.encode()).hexdigest()


def _chunk(chunk_id, text, *, doc=1, index=0, split="train", tenant=TENANT_A, content_hash=None):
    return ExportedChunk(
        tenant_key=tenant,
        document_id=_doc(doc),
        chunk_id=chunk_id,
        chunk_index=index,
        content_hash=content_hash or _hash(f"{tenant}:{text}"),
        language="en",
        split=split,
        text=text,
        token_count=20,
        is_golden_test_evidence=split == "test",
    )


def _pair(pair_id, anchor, positive: ExportedChunk, *, split="train", source="synthetic", negatives=(), weight=1):
    return FinetunePair(
        pair_id=pair_id,
        tenant_key=positive.tenant_key,
        language="en",
        positive_language="en",
        anchor=anchor,
        positive_chunk_id=positive.chunk_id,
        positive=positive.text,
        negatives=list(negatives),
        source=source,
        split=split,
        weight=weight,
    )


def _params(**overrides) -> MiningParams:
    base = load_finetune_config().mining.model_dump()
    base.update(overrides)
    return MiningParams.model_validate(base)


def _unit(score: float, slot: int) -> list[float]:
    vector = [0.0] * DIMS
    vector[0] = score
    vector[slot] = (1 - score * score) ** 0.5
    return vector


def _hand_built():
    """Query along axis 0; every chunk's cosine with it is its listed score."""
    positive = _chunk("pos", "positive passage", doc=1, index=5)
    chunks = [
        positive,
        _chunk("c079", "close passage", doc=2),
        _chunk("c075", "kept passage", doc=3),
        _chunk("neighbour", "next passage", doc=1, index=6),
        _chunk("dup-hash", "copy passage", doc=4, content_hash=positive.content_hash),
        _chunk("c040", "far passage", doc=5),
    ]
    scores = {"pos": 0.80, "c079": 0.79, "c075": 0.75, "neighbour": 0.5, "dup-hash": 0.5, "c040": 0.40}
    documents = {c.chunk_id: _unit(scores[c.chunk_id], slot) for slot, c in enumerate(chunks, start=1)}
    pair = _pair("q1", "a neutral question", positive)
    encoder = StoredVectorsEncoder({"q1": [1.0] + [0.0] * (DIMS - 1)}, documents)
    return pair, chunks, encoder


def test_vectors_relative_margin_on_hand_built_scores():
    pair, chunks, encoder = _hand_built()
    [mined] = miner.mine_vectors([pair], chunks, encoder, _params(relative_margin=0.05, num_negatives=2))
    assert [n.chunk_id for n in mined.negatives] == ["c075", "c040"]
    assert all(n.negative_source == "mined" for n in mined.negatives)
    assert mined.negatives[0].text == "kept passage"
    [loose] = miner.mine_vectors([pair], chunks, encoder, _params(relative_margin=None, num_negatives=2))
    assert [n.chunk_id for n in loose.negatives] == ["c079", "c075"]


def test_vectors_other_margins_and_score_limits():
    pair, chunks, encoder = _hand_built()
    [absolute] = miner.mine_vectors(
        [pair], chunks, encoder, _params(relative_margin=None, absolute_margin=0.1, num_negatives=2)
    )
    assert [n.chunk_id for n in absolute.negatives] == ["c040"]
    [capped] = miner.mine_vectors([pair], chunks, encoder, _params(relative_margin=None, max_score=0.76, num_negatives=2))
    assert [n.chunk_id for n in capped.negatives] == ["c075", "c040"]
    [floored] = miner.mine_vectors([pair], chunks, encoder, _params(relative_margin=None, min_score=0.6, num_negatives=2))
    assert [n.chunk_id for n in floored.negatives] == ["c079", "c075"]
    [ranked] = miner.mine_vectors(
        [pair], chunks, encoder, _params(relative_margin=None, range_min=1, range_max=4, num_negatives=2)
    )
    # ranks 1..3 of the non-positive candidates are c075, neighbour, dup-hash; c040 (rank 4) is outside range_max
    assert [n.chunk_id for n in ranked.negatives] == ["c075"]


def test_guard_neighbour_and_duplicate_hash_are_never_negatives():
    pair, chunks, encoder = _hand_built()
    [mined] = miner.mine_vectors([pair], chunks, encoder, _params(relative_margin=0.05, num_negatives=5))
    ids = [n.chunk_id for n in mined.negatives]
    assert ids == ["c075", "c040"]
    assert "neighbour" not in ids and "dup-hash" not in ids and "pos" not in ids
    [wide] = miner.mine_vectors([pair], chunks, encoder, _params(relative_margin=0.05, num_negatives=5, neighbour_window=0))
    assert "neighbour" in [n.chunk_id for n in wide.negatives]


def test_guard_positive_of_a_near_duplicate_query_is_never_a_negative():
    encoder = FakeEncoder(dims=64)
    first = _chunk("c-first", "the sample register keeps a neutral entry for every placeholder item", doc=1)
    second = _chunk("c-second", "the sample register keeps one neutral entry for each placeholder item", doc=2)
    other = _chunk("c-other", "an unrelated filler sentence about generic weather in a fictional place", doc=3)
    pairs = [
        _pair("q-a", "where does the sample register keep the neutral entry", first),
        _pair("q-b", "where does the sample register keep the neutral entries", second),
    ]
    params = _params(relative_margin=None, num_negatives=2)
    mined = miner.mine_vectors(pairs, [first, second, other], encoder, params)
    for pair in mined:
        assert [n.chunk_id for n in pair.negatives] == ["c-other"]
    unguarded = miner.mine_vectors(pairs, [first, second, other], encoder, params, near_dup_jaccard=1.0)
    assert "c-second" in [n.chunk_id for n in unguarded[0].negatives]


def test_guard_clusters_match_the_all_pairs_comparison():
    words = ["sample", "neutral", "record", "entry", "item", "value", "code", "label", "cycle", "team"]
    rng = np.random.default_rng(7)
    texts = []
    for _ in range(120):
        picked = rng.choice(words, size=rng.integers(2, 6))
        texts.append(" ".join(picked))
    expected = cluster_queries([(TENANT_A, t) for t in texts], ngram=3, threshold=0.8)
    assert miner.near_duplicate_clusters(texts, ngram=3, threshold=0.8) == expected


def _corpus(tenant, prefix, n=12, split_of=lambda i: "train"):
    return [
        _chunk(f"{prefix}{i}", f"generic record {i} names attribute {i % 4} and value {i * 7}", doc=i + 1, tenant=tenant, split=split_of(i))
        for i in range(n)
    ]


def test_tenant_identical_chunks_never_cross():
    a = _corpus(TENANT_A, "a-")
    b = _corpus(TENANT_B, "b-")
    pairs = [_pair(f"qa{i}", f"generic record {i} attribute", a[i]) for i in range(4)]
    pairs += [_pair(f"qb{i}", f"generic record {i} attribute", b[i]) for i in range(4)]
    mined = miner.mine_vectors(pairs, a + b, FakeEncoder(dims=64), _params(relative_margin=None, num_negatives=3))
    for pair in mined:
        prefix = "a-" if pair.tenant_key == TENANT_A else "b-"
        assert pair.negatives and all(n.chunk_id.startswith(prefix) for n in pair.negatives)


def test_split_train_pairs_only_get_train_negatives_and_dev_pairs_no_test():
    split_of = lambda i: ("train", "dev", "test")[i % 3]  # noqa: E731
    chunks = _corpus(TENANT_A, "c-", n=18, split_of=split_of)
    by_id = {c.chunk_id: c for c in chunks}
    pairs = [_pair(f"q{i}", f"generic record {i} attribute", chunks[i], split=chunks[i].split) for i in range(6)]
    mined = miner.mine_vectors(
        [p for p in pairs if p.split != "test"], chunks, FakeEncoder(dims=64), _params(relative_margin=None, num_negatives=4)
    )
    for pair in mined:
        splits = {by_id[n.chunk_id].split for n in pair.negatives}
        assert pair.negatives
        assert splits <= ({"train"} if pair.split == "train" else {"train", "dev"})
    assert any(by_id[n.chunk_id].split == "dev" for p in mined if p.split == "dev" for n in p.negatives)


def test_vectors_random_sampling_is_seeded_and_reproducible():
    chunks = _corpus(TENANT_A, "c-", n=30)
    pairs = [_pair(f"q{i}", f"generic record {i} attribute", chunks[i]) for i in range(5)]
    params = _params(relative_margin=None, num_negatives=3, sampling_strategy="random", range_max=20)
    first = miner.mine_vectors(pairs, chunks, FakeEncoder(dims=64), params, seed=11)
    again = miner.mine_vectors(pairs, chunks, FakeEncoder(dims=64), params, seed=11)
    other = miner.mine_vectors(pairs, chunks, FakeEncoder(dims=64), params, seed=12)
    assert [p.negatives for p in first] == [p.negatives for p in again]
    assert [p.negatives for p in first] != [p.negatives for p in other]
    top = miner.mine_vectors(pairs, chunks, FakeEncoder(dims=64), _params(relative_margin=None, num_negatives=3, range_max=20))
    assert [p.negatives for p in first] != [p.negatives for p in top]


def test_vectors_expert_negatives_first_and_the_miner_tops_up():
    chunks = _corpus(TENANT_A, "c-", n=12)
    expert = FinetuneNegative(chunk_id="c-9", text=chunks[9].text, negative_source="expert")
    pair = _pair("mined:item-1", "generic record 0 attribute", chunks[0], source="mined", negatives=[expert], weight=2)
    [mined] = miner.mine_vectors([pair], chunks, FakeEncoder(dims=64), _params(relative_margin=None, num_negatives=3))
    assert mined.negatives[0] == expert
    assert [n.negative_source for n in mined.negatives] == ["expert", "mined", "mined"]
    assert "c-9" not in [n.chunk_id for n in mined.negatives[1:]]
    assert mined.weight == 2


def test_vectors_query_blocks_do_not_change_the_result():
    chunks = _corpus(TENANT_A, "c-", n=20)
    pairs = [_pair(f"q{i}", f"generic record {i} value", chunks[i]) for i in range(7)]
    params = _params(relative_margin=0.05, num_negatives=3)
    assert miner.mine_vectors(pairs, chunks, FakeEncoder(), params, block_size=2) == miner.mine_vectors(
        pairs, chunks, FakeEncoder(), params
    )


# --- bundle-level helpers (used by Task 2 and Task 3 tests) ---------------------------------------------------

WORDS = ["alpha", "bravo", "cobalt", "delta", "ember", "fjord", "garnet", "harbor", "indigo", "juniper", "kelp", "lumen"]


def _fixture_texts(n):
    return [f"record {WORDS[i % 12]} {WORDS[(i * 5 + 3) % 12]} lists entry {i} with code {i * 13 % 97}" for i in range(n)]


def _write_bundle(tmp_path, *, tenants=(TENANT_A,), n_chunks=40, n_queries=20, split_of=lambda i: "train", mined_pairs=(), vectors=True):
    run_dir = bundle.new_run_dir(tmp_path / "out", "run-1")
    chunks, raws = [], []
    texts = _fixture_texts(n_chunks)
    for t_index, tenant in enumerate(tenants):
        prefix = "ab"[t_index]
        for i, text in enumerate(texts):
            chunks.append(_chunk(f"{prefix}-{i}", text, doc=i + 1, tenant=tenant, split=split_of(i)))
        for i in range(n_queries):
            chunk = chunks[t_index * n_chunks + i]
            raws.append(
                RawSyntheticQuery(
                    query_id=f"{prefix}-q{i}",
                    tenant_key=tenant,
                    document_id=chunk.document_id,
                    chunk_id=chunk.chunk_id,
                    split=chunk.split,
                    chunk_language="en",
                    language="en",
                    style="keyword",
                    query=f"{WORDS[i % 12]} {WORDS[(i * 5 + 3) % 12]} entry {i}",
                    prompt_version="ft-generate-v1",
                    model="fake-generator",
                )
            )
    files = {bundle.CHUNKS_FILE: bundle.write_jsonl(run_dir / bundle.CHUNKS_FILE, chunks, ExportedChunk)}
    train_dev = [r for r in raws if r.split != "test"]
    files["queries.kept.jsonl"] = bundle.write_jsonl(run_dir / "queries.kept.jsonl", train_dev, RawSyntheticQuery)
    files["queries.test.kept.jsonl"] = bundle.write_jsonl(
        run_dir / "queries.test.kept.jsonl", [r for r in raws if r.split == "test"], RawSyntheticQuery
    )
    if mined_pairs:
        files["pairs.mined.jsonl"] = bundle.write_jsonl(run_dir / "pairs.mined.jsonl", list(mined_pairs), FinetunePair)
    bundle.write_manifest(
        run_dir,
        DatasetManifest(
            run_id="run-1",
            purpose="private" if len(tenants) == 1 else "deployment",
            split_rule="ft-sha256-first8hex-mod100-80-10-10",
            tenant_keys=sorted(tenants),
            counts={},
            files=files,
            created_at="2026-11-26T00:00:00Z",
        ),
    )
    if vectors:
        encoder = FakeEncoder(dims=DIMS * 2)
        for tenant in tenants:
            own = [c for c in chunks if c.tenant_key == tenant]
            write_vector_set(
                run_dir,
                kind="chunks",
                tenant_key=tenant,
                profile_id=PROFILE,
                model=MODEL,
                ids=[c.chunk_id for c in own],
                matrix=encoder.encode_documents([TextItem(c.chunk_id, c.text) for c in own]),
            )
            items = [TextItem(r.query_id, r.query) for r in raws if r.tenant_key == tenant]
            items += [TextItem(p.pair_id, p.anchor) for p in mined_pairs if p.tenant_key == tenant]
            write_vector_set(
                run_dir,
                kind="queries",
                tenant_key=tenant,
                profile_id=PROFILE,
                model=MODEL,
                ids=[i.id for i in items],
                matrix=encoder.encode_queries(items),
            )
    return run_dir, chunks


def _read_pairs(path):
    return [FinetunePair.model_validate_json(line) for line in path.read_text().splitlines() if line.strip()]


def test_vectors_run_writes_ntuple_pairs_and_dev_files(tmp_path, capsys):
    split_of = lambda i: "dev" if i % 5 == 4 else ("test" if i % 7 == 6 else "train")  # noqa: E731
    run_dir, chunks = _write_bundle(tmp_path, n_chunks=40, n_queries=24, split_of=split_of)
    config = load_finetune_config()
    config = config.model_copy(update={"mining": _params(relative_margin=0.05, num_negatives=5, range_max=12)})
    result = miner.run_mine(run_dir, fixture=True, skip_audit=True, config=config)
    assert result.exit_code == 0
    ntuple = _read_pairs(run_dir / "train_ntuple.jsonl")
    short = _read_pairs(run_dir / "train_pairs.jsonl")
    dev = _read_pairs(run_dir / "dev.jsonl")
    assert ntuple and dev
    assert all(len(p.negatives) == 5 and p.split == "train" for p in ntuple)
    assert all(len(p.negatives) < 5 and p.split == "train" for p in short)
    assert all(p.split == "dev" for p in dev)
    by_id = {c.chunk_id: c for c in chunks}
    for pair in ntuple + short:
        assert all(by_id[n.chunk_id].split == "train" for n in pair.negatives)
    for pair in dev:
        assert all(by_id[n.chunk_id].split in {"train", "dev"} for n in pair.negatives)
    written = {p.pair_id for p in ntuple + short + dev}
    test_ids = {f"a-q{i}" for i in range(24) if split_of(i) == "test"}
    assert test_ids and not written & test_ids
    report = MiningReport.model_validate_json((run_dir / "mining-report.json").read_text())
    assert report.miner == "vectors" and report.pairs == len(written)
    dev_full = sum(1 for p in dev if len(p.negatives) == 5)
    assert report.with_full_negatives == len(ntuple) + dev_full
    assert report.pairs_only == len(short) + len(dev) - dev_full
    assert report.fn_audit.skipped and report.params.range_max == 12
    manifest = bundle.read_manifest(run_dir)
    for name in ("train_ntuple.jsonl", "train_pairs.jsonl", "dev.jsonl", "mining-report.json"):
        assert manifest.files[name] == bundle.sha256_file(run_dir / name)
    captured = capsys.readouterr()
    for chunk in chunks:
        assert chunk.text not in captured.out and chunk.text not in captured.err


def test_vectors_run_pairs_short_of_negatives_go_to_train_pairs(tmp_path):
    run_dir, _ = _write_bundle(tmp_path, n_chunks=6, n_queries=4)
    config = load_finetune_config()
    config = config.model_copy(update={"mining": _params(relative_margin=0.05, num_negatives=7, range_max=10)})
    assert miner.run_mine(run_dir, fixture=True, skip_audit=True, config=config).exit_code == 0
    assert _read_pairs(run_dir / "train_ntuple.jsonl") == []
    short = _read_pairs(run_dir / "train_pairs.jsonl")
    assert len(short) == 4 and all(len(p.negatives) < 7 for p in short)


def test_tenant_run_with_identical_chunks_keeps_tenants_apart(tmp_path):
    run_dir, _ = _write_bundle(tmp_path, tenants=(TENANT_A, TENANT_B), n_chunks=20, n_queries=10)
    config = load_finetune_config()
    config = config.model_copy(update={"mining": _params(relative_margin=0.05, num_negatives=3, range_max=10)})
    assert miner.run_mine(run_dir, fixture=True, skip_audit=True, config=config).exit_code == 0
    pairs = _read_pairs(run_dir / "train_ntuple.jsonl") + _read_pairs(run_dir / "train_pairs.jsonl")
    assert {p.tenant_key for p in pairs} == {TENANT_A, TENANT_B}
    for pair in pairs:
        prefix = "a-" if pair.tenant_key == TENANT_A else "b-"
        assert pair.positive_chunk_id.startswith(prefix)
        assert all(n.chunk_id.startswith(prefix) for n in pair.negatives)


def test_vectors_run_refuses_tampered_vectors_and_missing_query_vectors(tmp_path):
    run_dir, _ = _write_bundle(tmp_path, n_chunks=10, n_queries=4)
    f32 = run_dir / "vectors" / f"o_00000000-0000-4000-8000-0000000000a1.{PROFILE}.f32"
    data = bytearray(f32.read_bytes())
    data[-1] ^= 0x10
    f32.write_bytes(bytes(data))
    assert miner.run_mine(run_dir, fixture=True, skip_audit=True).exit_code == 1
    assert not (run_dir / "train_ntuple.jsonl").exists()

    run_dir, _ = _write_bundle(tmp_path / "second", n_chunks=10, n_queries=4)
    stem = f"query-vectors.o_00000000-0000-4000-8000-0000000000a1.{PROFILE}"
    rows = (run_dir / "vectors" / f"{stem}.rows.jsonl").read_text().splitlines()
    header = json.loads((run_dir / "vectors" / f"{stem}.header.json").read_text())
    matrix = np.fromfile(run_dir / "vectors" / f"{stem}.f32", dtype="<f4").reshape(header["rows"], header["dims"])
    ids = [json.loads(r)["pair_id"] for r in rows][:-1]
    write_vector_set(run_dir, kind="queries", tenant_key=TENANT_A, profile_id=PROFILE, model=MODEL, ids=ids, matrix=matrix[:-1])
    assert miner.run_mine(run_dir, fixture=True, skip_audit=True).exit_code == 1


def test_vectors_run_refuses_a_kept_file_changed_after_the_manifest(tmp_path):
    run_dir, _ = _write_bundle(tmp_path, n_chunks=10, n_queries=4)
    kept = run_dir / "queries.kept.jsonl"
    kept.write_text("\n".join(kept.read_text().splitlines()[:-1]) + "\n")
    assert miner.run_mine(run_dir, fixture=True, skip_audit=True).exit_code == 1
