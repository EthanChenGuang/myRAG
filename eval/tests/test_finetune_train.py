import hashlib
import json

import pytest
from rag_sidecar.contracts.finetune import (
    DatasetManifest,
    ExportedChunk,
    FinetuneNegative,
    FinetunePair,
    TrainingRunConfig,
)

from rag_eval.finetune import bundle, cli, kit
from rag_eval.finetune.config import load_finetune_config
from rag_eval.finetune.miner import (
    DEV_FILE,
    REPORT_FILE,
    TRAIN_NTUPLE_FILE,
    TRAIN_PAIRS_FILE,
)

TENANT_A = "o:00000000-0000-4000-8000-0000000000a1"
TENANT_B = "o:00000000-0000-4000-8000-0000000000b2"
GIT_COMMIT = "0123456789abcdef0123456789abcdef01234567"
LIBRARIES = {"torch": "2.15.0", "transformers": "5.17.0", "sentence_transformers": "6.2.0", "datasets": "5.0.1"}
WORDS = ["alpha", "bravo", "cobalt", "delta", "ember", "fjord", "garnet", "harbor", "indigo", "juniper", "kelp", "lumen"]


def _hash(text):
    return hashlib.sha256(text.encode()).hexdigest()


def _doc(n):
    return f"00000000-0000-4000-8000-{n:012d}"


def _text(i):
    return f"record {WORDS[i % 12]} {WORDS[(i * 5 + 3) % 12]} lists entry {i} with code {i * 13 % 97}"


def _chunk(i, split, tenant=TENANT_A):
    return ExportedChunk(
        tenant_key=tenant,
        document_id=_doc(i + 1),
        chunk_id=f"c-{i}",
        chunk_index=0,
        content_hash=_hash(f"{tenant}:{i}"),
        language="en",
        split=split,
        text=_text(i),
        token_count=20,
        is_golden_test_evidence=split == "test",
    )


def _pair(n, positive, *, split, negatives=(), source="synthetic", weight=1):
    return FinetunePair(
        pair_id=f"q-{n}",
        tenant_key=positive.tenant_key,
        language="en",
        positive_language="en",
        anchor=f"which entry lists {WORDS[n % 12]} code {n}",
        positive_chunk_id=positive.chunk_id,
        positive=positive.text,
        negatives=[FinetuneNegative(chunk_id=c.chunk_id, text=c.text, negative_source="mined") for c in negatives],
        source=source,
        split=split,
        weight=weight,
    )


def _split_of(i):
    return "test" if i % 10 == 9 else ("dev" if i % 10 == 8 else "train")


def make_bundle(tmp_path, *, n_chunks=40, n_ntuple=18, n_pairs=12, n_dev=4, num_negatives=3, tenants=(TENANT_A,)):
    """A mined bundle: chunks of all three splits, train_ntuple / train_pairs / dev, a test kept-queries file and the
    mining report, all recorded in the manifest."""
    run_dir = tmp_path / "bundle" / "run-1"
    run_dir.mkdir(parents=True)
    chunks = [_chunk(i, _split_of(i), tenant) for i in range(n_chunks) for tenant in tenants]
    by_split = {s: [c for c in chunks if c.split == s] for s in ("train", "dev", "test")}
    ntuple, pairs, devs, tests = [], [], [], []
    for t, tenant in enumerate(tenants):
        train, dev, test = ([c for c in by_split[s] if c.tenant_key == tenant] for s in ("train", "dev", "test"))
        base = 1000 * t
        ntuple += [
            _pair(base + i, train[i % len(train)], split="train", negatives=[train[(i + k) % len(train)] for k in (1, 2, 3)][:num_negatives])
            for i in range(n_ntuple)
        ]
        pairs += [_pair(base + 100 + i, train[(i + 5) % len(train)], split="train") for i in range(n_pairs)]
        devs += [
            _pair(base + 200 + i, dev[i % len(dev)], split="dev", negatives=[train[i], dev[(i + 1) % len(dev)]])
            for i in range(n_dev)
        ]
        tests += [_pair(base + 300 + i, test[i % len(test)], split="test") for i in range(3)]
    files = {
        bundle.CHUNKS_FILE: bundle.write_jsonl(run_dir / bundle.CHUNKS_FILE, chunks, ExportedChunk),
        TRAIN_NTUPLE_FILE: bundle.write_jsonl(run_dir / TRAIN_NTUPLE_FILE, ntuple, FinetunePair),
        TRAIN_PAIRS_FILE: bundle.write_jsonl(run_dir / TRAIN_PAIRS_FILE, pairs, FinetunePair),
        DEV_FILE: bundle.write_jsonl(run_dir / DEV_FILE, devs, FinetunePair),
        "queries.test.kept.jsonl": bundle.write_jsonl(run_dir / "queries.test.kept.jsonl", tests, FinetunePair),
    }
    (run_dir / REPORT_FILE).write_text("{}\n")
    files[REPORT_FILE] = bundle.sha256_file(run_dir / REPORT_FILE)
    manifest = DatasetManifest(
        run_id="run-1",
        purpose="deployment",
        split_rule="ft-sha256-first8hex-mod100-80-10-10",
        tenant_keys=sorted(tenants),
        chunks={s: len(v) for s, v in by_split.items()},
        counts={"train": {"synthetic": len(ntuple) + len(pairs)}, "dev": {"synthetic": len(devs)}, "test": {"synthetic": len(tests)}},
        files=files,
        created_at="2026-11-26T00:00:00Z",
    )
    bundle.write_manifest(run_dir, manifest)
    return run_dir


def build(run_dir, tmp_path, name="kit", **kwargs):
    kwargs.setdefault("git_commit", GIT_COMMIT)
    kwargs.setdefault("library_versions", LIBRARIES)
    return kit.build_kit(run_dir, tmp_path / name, **kwargs)


def _rows(path):
    return [json.loads(line) for line in path.read_text().splitlines() if line.strip()]


def _test_ids(run_dir):
    return {row["chunk_id"] for row in _rows(run_dir / bundle.CHUNKS_FILE) if row["split"] == "test"}


# --- Task 1: training kit ------------------------------------------------------------------------------------


def test_kit_copies_only_train_dev_corpus_config_and_manifest(tmp_path):
    run_dir = make_bundle(tmp_path)
    out = build(run_dir, tmp_path)
    names = sorted(p.name for p in out.iterdir())
    assert names == sorted(
        [
            TRAIN_NTUPLE_FILE,
            TRAIN_PAIRS_FILE,
            DEV_FILE,
            kit.DEV_CORPUS_FILE,
            kit.TRAINING_CONFIG_FILE,
            kit.KIT_MANIFEST_FILE,
        ]
    )
    assert not any("test" in name for name in names)
    assert (out.stat().st_mode & 0o777) == 0o700


def test_kit_has_no_test_row_or_test_chunk(tmp_path):
    run_dir = make_bundle(tmp_path)
    out = build(run_dir, tmp_path)
    test_ids = _test_ids(run_dir)
    test_texts = {row["text"] for row in _rows(run_dir / bundle.CHUNKS_FILE) if row["split"] == "test"}
    for name in (TRAIN_NTUPLE_FILE, TRAIN_PAIRS_FILE, DEV_FILE, kit.DEV_CORPUS_FILE):
        for row in _rows(out / name):
            assert row["split"] != "test"
            ids = {row.get("chunk_id"), row.get("positive_chunk_id")} | {n["chunk_id"] for n in row.get("negatives", [])}
            assert not ids & test_ids
        payload = (out / name).read_text()
        assert not any(text in payload for text in test_texts)


def test_kit_dev_corpus_covers_dev_documents_and_dev_pair_chunks(tmp_path):
    run_dir = make_bundle(tmp_path)
    out = build(run_dir, tmp_path)
    corpus = {(r["tenant_key"], r["chunk_id"]) for r in _rows(out / kit.DEV_CORPUS_FILE)}
    chunks = _rows(run_dir / bundle.CHUNKS_FILE)
    dev_tenants = {r["tenant_key"] for r in _rows(out / DEV_FILE)}
    dev_chunks = {(r["tenant_key"], r["chunk_id"]) for r in chunks if r["split"] == "dev" and r["tenant_key"] in dev_tenants}
    assert dev_chunks <= corpus
    for row in _rows(out / DEV_FILE):
        assert (row["tenant_key"], row["positive_chunk_id"]) in corpus
        for negative in row["negatives"]:
            assert (row["tenant_key"], negative["chunk_id"]) in corpus


def test_kit_manifest_lists_tenants_and_matching_hashes(tmp_path):
    run_dir = make_bundle(tmp_path, tenants=(TENANT_B, TENANT_A))
    out = build(run_dir, tmp_path)
    manifest = kit.read_kit_manifest(out)
    assert manifest.tenant_keys == sorted([TENANT_A, TENANT_B])
    assert manifest.dataset_manifest_sha256 == bundle.sha256_file(run_dir / bundle.MANIFEST_FILE)
    assert set(manifest.files) == {p.name for p in out.iterdir()} - {kit.KIT_MANIFEST_FILE}
    for name, digest in manifest.files.items():
        assert digest == bundle.sha256_file(out / name)
    assert manifest.counts == {"ntuple": 36, "pairs": 24, "dev": 8, "dev_corpus": manifest.counts["dev_corpus"]}
    assert kit.verify_kit(out).run_id == "run-1"


def test_kit_resolved_training_config(tmp_path):
    run_dir = make_bundle(tmp_path)
    out = build(run_dir, tmp_path)
    config = TrainingRunConfig.model_validate_json((out / kit.TRAINING_CONFIG_FILE).read_text())
    cfg = load_finetune_config()
    default = next(m for m in cfg.base_models if m.default)
    assert config.base_model == default.id and config.base_revision == default.revision
    assert config.seed == 42 and config.recipe == cfg.training
    assert config.git_commit == GIT_COMMIT
    assert config.dataset_manifest_sha256 == bundle.sha256_file(run_dir / bundle.MANIFEST_FILE)
    assert config.config_sha256 == kit.config_sha256(cfg)
    assert kit.read_kit_manifest(out).base_model == default


def test_kit_weights_mined_pairs_by_repetition(tmp_path):
    run_dir = make_bundle(tmp_path)
    rows = _rows(run_dir / TRAIN_PAIRS_FILE)
    rows[0]["source"], rows[0]["weight"] = "mined", 2
    bundle.write_jsonl(run_dir / TRAIN_PAIRS_FILE, rows, FinetunePair)
    manifest = bundle.read_manifest(run_dir)
    files = {**manifest.files, TRAIN_PAIRS_FILE: bundle.sha256_file(run_dir / TRAIN_PAIRS_FILE)}
    bundle.write_manifest(run_dir, manifest.model_copy(update={"files": files}))
    out = build(run_dir, tmp_path)
    assert kit.read_kit_manifest(out).counts["pairs"] == 13


@pytest.mark.parametrize("target", [TRAIN_NTUPLE_FILE, TRAIN_PAIRS_FILE, DEV_FILE])
def test_kit_refuses_a_bundle_with_a_test_row(tmp_path, target):
    run_dir = make_bundle(tmp_path)
    rows = _rows(run_dir / target)
    rows[0]["split"] = "test"
    bundle.write_jsonl(run_dir / target, rows, FinetunePair)
    manifest = bundle.read_manifest(run_dir)
    files = {**manifest.files, target: bundle.sha256_file(run_dir / target)}
    bundle.write_manifest(run_dir, manifest.model_copy(update={"files": files}))
    with pytest.raises(kit.KitRefused) as exc:
        build(run_dir, tmp_path)
    assert exc.value.code == "bundle_contains_test"
    assert not (tmp_path / "kit").exists()


def test_kit_refuses_a_negative_from_a_test_document(tmp_path):
    run_dir = make_bundle(tmp_path)
    test_chunk = next(r for r in _rows(run_dir / bundle.CHUNKS_FILE) if r["split"] == "test")
    rows = _rows(run_dir / TRAIN_NTUPLE_FILE)
    rows[0]["negatives"][0] = {"chunk_id": test_chunk["chunk_id"], "text": test_chunk["text"], "negative_source": "mined"}
    bundle.write_jsonl(run_dir / TRAIN_NTUPLE_FILE, rows, FinetunePair)
    manifest = bundle.read_manifest(run_dir)
    files = {**manifest.files, TRAIN_NTUPLE_FILE: bundle.sha256_file(run_dir / TRAIN_NTUPLE_FILE)}
    bundle.write_manifest(run_dir, manifest.model_copy(update={"files": files}))
    with pytest.raises(kit.KitRefused) as exc:
        build(run_dir, tmp_path)
    assert exc.value.code == "bundle_contains_test"


def test_kit_refuses_a_modified_bundle_and_missing_mining_outputs(tmp_path):
    run_dir = make_bundle(tmp_path)
    with open(run_dir / DEV_FILE, "a") as handle:
        handle.write("\n")
    with pytest.raises(kit.KitRefused) as exc:
        build(run_dir, tmp_path)
    assert exc.value.code == "bundle_modified"
    (run_dir / DEV_FILE).unlink()
    with pytest.raises(kit.KitRefused) as exc:
        build(run_dir, tmp_path, name="kit2")
    assert exc.value.code == "mining_outputs_missing"


def test_kit_refuses_an_existing_out_and_unknown_base(tmp_path):
    run_dir = make_bundle(tmp_path)
    (tmp_path / "kit").mkdir()
    (tmp_path / "kit" / "x").write_text("x")
    with pytest.raises(kit.KitRefused) as exc:
        build(run_dir, tmp_path)
    assert exc.value.code == "out_exists"
    with pytest.raises(kit.KitRefused) as exc:
        build(run_dir, tmp_path, name="kit2", base_model="someone/unknown-model")
    assert exc.value.code == "base_model_unknown"


def _inject(out, name, mutate):
    rows = _rows(out / name)
    mutate(rows)
    (out / name).write_text("".join(json.dumps(r) + "\n" for r in rows))


@pytest.mark.parametrize("target", [TRAIN_NTUPLE_FILE, TRAIN_PAIRS_FILE, DEV_FILE, "dev_corpus.jsonl"])
def test_kit_verify_refuses_a_kit_with_an_injected_test_row(tmp_path, target):
    out = build(make_bundle(tmp_path), tmp_path)

    def mutate(rows):
        rows.append({**rows[0], "split": "test"})

    _inject(out, target, mutate)
    with pytest.raises(kit.KitRefused) as exc:
        kit.verify_kit(out)
    assert exc.value.code == "kit_contains_test"


def test_kit_verify_refuses_a_kit_with_a_test_file(tmp_path):
    out = build(make_bundle(tmp_path), tmp_path)
    (out / "queries.test.kept.jsonl").write_text("{}\n")
    with pytest.raises(kit.KitRefused) as exc:
        kit.verify_kit(out)
    assert exc.value.code == "kit_contains_test"


def test_kit_verify_refuses_changed_hashes_and_unlisted_files(tmp_path):
    out = build(make_bundle(tmp_path), tmp_path)
    _inject(out, TRAIN_PAIRS_FILE, lambda rows: rows.pop())
    with pytest.raises(kit.KitRefused) as exc:
        kit.verify_kit(out)
    assert exc.value.code == "kit_modified"
    out2 = build(make_bundle(tmp_path / "b"), tmp_path, name="kit2")
    (out2 / "extra.jsonl").write_text("{}\n")
    with pytest.raises(kit.KitRefused) as exc:
        kit.verify_kit(out2)
    assert exc.value.code == "kit_unexpected_file"


def test_kit_cli_dispatch_and_exit_codes(tmp_path, capsys):
    run_dir = make_bundle(tmp_path)
    code = kit.main(
        ["--bundle", str(run_dir), "--out", str(tmp_path / "kit")],
        git_commit=GIT_COMMIT,
        library_versions=LIBRARIES,
    )
    assert code == 0
    captured = capsys.readouterr()
    assert "run_id=run-1" in captured.out
    assert "record " not in captured.out + captured.err
    assert cli.COMMANDS["kit"] == "rag_eval.finetune.kit:main"
    assert kit.main(["--bundle", str(tmp_path / "missing"), "--out", str(tmp_path / "k3")]) == 2
