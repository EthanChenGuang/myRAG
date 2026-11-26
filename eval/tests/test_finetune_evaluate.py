import hashlib
import json
import math

import numpy as np
import pytest
from rag_sidecar.contracts.finetune import (
    DatasetManifest,
    ExportedChunk,
    FinetunePair,
    OfflineEvalReport,
)

from rag_eval.finetune import bundle, cli, evaluate
from rag_eval.finetune.config import load_finetune_config
from rag_eval.finetune.encoders import FakeEncoder, TextItem, normalize_rows
from rag_eval.finetune.generate import RawSyntheticQuery
from rag_eval.finetune.vectors_io import write_vector_set

TENANT_A = "o:00000000-0000-4000-8000-0000000000a1"
TENANT_B = "o:00000000-0000-4000-8000-0000000000b2"
PROFILE = "ft-a-1024"
MODEL = "fake-model"
WORDS = ("alpha", "bravo", "cobalt", "delta", "ember", "fjord", "garnet", "harbor", "indigo", "juniper", "kelp", "lumen")


def _doc(n: int) -> str:
    return f"00000000-0000-4000-8000-{n:012d}"


def _hash(text: str) -> str:
    return hashlib.sha256(text.encode()).hexdigest()


def _text(i: int) -> str:
    return f"record {WORDS[i % 12]} {WORDS[(i * 5 + 3) % 12]} lists entry {i} with code {i * 13 % 97}"


class TargetEncoder:
    """Documents: FakeEncoder vectors of their text. A query is encoded as the document vector of the chunk text its
    target function picks, so the test decides exactly which chunk ranks first."""

    name = "target"

    def __init__(self, target):
        self._fake = FakeEncoder(dims=64)
        self._target = target

    def encode_documents(self, items):
        return self._fake.encode_documents(items)

    def encode_queries(self, items):
        return self._fake.encode_documents([TextItem(item.id, self._target(item)) for item in items])


def _chunk(tenant, chunk_id, i, *, language="en", split="test", content_hash=None):
    return ExportedChunk(
        tenant_key=tenant,
        document_id=_doc(i + 1),
        chunk_id=chunk_id,
        chunk_index=0,
        content_hash=content_hash or _hash(f"{tenant}:{chunk_id}"),
        language=language,
        split=split,
        text=_text(i),
        token_count=20,
        is_golden_test_evidence=False,
    )


def _write_bundle(tmp_path, *, tenants=(TENANT_A,), n=12, languages=None, mined_every=0, test=True, run_id="run-1"):
    """n chunks per tenant (identical texts across tenants), one query per chunk. languages(i) gives the query and chunk
    language; every mined_every-th query is a mined test pair, the rest are kept synthetic test queries."""
    run_dir = bundle.new_run_dir(tmp_path / "out", run_id)
    languages = languages or (lambda i: "en")
    split = "test" if test else "train"
    chunks, raws, mined = [], [], []
    for t_index, tenant in enumerate(tenants):
        prefix = "ab"[t_index]
        for i in range(n):
            chunk = _chunk(tenant, f"{prefix}-{i}", i, language=languages(i), split=split)
            chunks.append(chunk)
            anchor = f"{WORDS[i % 12]} entry {i} query {prefix}"
            if mined_every and i % mined_every == 0:
                mined.append(
                    FinetunePair(
                        pair_id=f"{prefix}-m{i}",
                        tenant_key=tenant,
                        language=languages(i),
                        positive_language=languages(i),
                        anchor=anchor,
                        positive_chunk_id=chunk.chunk_id,
                        positive=chunk.text,
                        source="mined",
                        split=split,
                        weight=2,
                    )
                )
            else:
                raws.append(
                    RawSyntheticQuery(
                        query_id=f"{prefix}-q{i}",
                        tenant_key=tenant,
                        document_id=chunk.document_id,
                        chunk_id=chunk.chunk_id,
                        split=split,
                        chunk_language=languages(i),
                        language=languages(i),
                        style="keyword",
                        query=anchor,
                        prompt_version="ft-generate-v1",
                        model="fake-generator",
                    )
                )
    files = {bundle.CHUNKS_FILE: bundle.write_jsonl(run_dir / bundle.CHUNKS_FILE, chunks, ExportedChunk)}
    name = "queries.test.kept.jsonl" if test else "queries.kept.jsonl"
    files[name] = bundle.write_jsonl(run_dir / name, raws, RawSyntheticQuery)
    if mined:
        files["pairs.mined.jsonl"] = bundle.write_jsonl(run_dir / "pairs.mined.jsonl", mined, FinetunePair)
    bundle.write_manifest(
        run_dir,
        DatasetManifest(
            run_id=run_id,
            purpose="private" if len(tenants) == 1 else "deployment",
            split_rule="ft-sha256-first8hex-mod100-80-10-10",
            tenant_keys=sorted(tenants),
            counts={},
            files=files,
            created_at="2026-11-26T00:00:00Z",
        ),
    )
    return run_dir, chunks


def _anchor_index(item) -> int:
    return int(item.text.split(" ")[2])


def _positive_text(item):
    return _text(_anchor_index(item))


def _wrong_text(item):
    return _text((_anchor_index(item) + 1) % 12)


def _hit_if(predicate):
    return TargetEncoder(lambda item: _positive_text(item) if predicate(_anchor_index(item)) else _wrong_text(item))


ALWAYS = _hit_if(lambda i: True)
NEVER = _hit_if(lambda i: False)


# --- Task 1: IR metrics ----------------------------------------------------------------------------------------


def test_metrics_hand_built_ranks():
    ranked = ["p", "x1", "x2", "x3", "x4", "x5", "x6", "x7", "x8", "x9", "late"]
    assert evaluate.ir_metrics(ranked, {"p"}) == {"recall_at_10": 1.0, "mrr_at_10": 1.0, "ndcg_at_10": 1.0}
    third = evaluate.ir_metrics(["x1", "x2", "p", "x3"], {"p"})
    assert third["recall_at_10"] == 1.0
    assert third["mrr_at_10"] == pytest.approx(1 / 3)
    assert third["ndcg_at_10"] == pytest.approx(1 / math.log2(4))
    assert evaluate.ir_metrics(ranked[1:], {"p"}) == {"recall_at_10": 0.0, "mrr_at_10": 0.0, "ndcg_at_10": 0.0}
    assert evaluate.ir_metrics(ranked, {"late"}) == {"recall_at_10": 0.0, "mrr_at_10": 0.0, "ndcg_at_10": 0.0}


def test_metrics_a_duplicate_of_the_positive_counts_as_the_hit():
    second = evaluate.ir_metrics(["x", "dup", "p"], {"p", "dup"})
    assert second == {
        "recall_at_10": 1.0,
        "mrr_at_10": pytest.approx(0.5),
        "ndcg_at_10": pytest.approx(1 / math.log2(3)),
    }


# --- Task 1: evaluate ------------------------------------------------------------------------------------------


def test_evaluate_two_tenants_never_see_each_others_chunks(tmp_path):
    run_dir, chunks = _write_bundle(tmp_path, tenants=(TENANT_A, TENANT_B))
    result = evaluate.run_evaluate(
        run_dir,
        finetuned=ALWAYS,
        base=NEVER,
        production={TENANT_A: NEVER, TENANT_B: NEVER},
        config=load_finetune_config(),
    )
    assert result.exit_code == 0
    owner = {c.chunk_id: c.tenant_key for c in chunks}
    for model in ("base", "finetuned", "production"):
        rankings = result.rankings[model]
        assert len(rankings) == 24
        for (tenant, _pair_id), ranked in rankings.items():
            assert ranked and len(ranked) <= 10
            assert {owner[chunk_id] for chunk_id in ranked} == {tenant}
    assert result.report.models.finetuned.overall.recall_at_10 == 1.0
    assert result.report.models.finetuned.overall.n == 24


def test_evaluate_language_regression_fails_the_gate(tmp_path):
    zh = lambda i: i >= 8
    run_dir, _ = _write_bundle(tmp_path, languages=lambda i: "zh" if zh(i) else "en")
    result = evaluate.run_evaluate(
        run_dir,
        finetuned=_hit_if(lambda i: not zh(i)),
        base=_hit_if(zh),
        production={TENANT_A: _hit_if(zh)},
        config=load_finetune_config(),
    )
    report = result.report
    assert report.models.finetuned.by_language["en"].recall_at_10 == 1.0
    assert report.models.finetuned.by_language["zh"].recall_at_10 == 0.0
    assert report.models.production.by_language["zh"].recall_at_10 == 1.0
    assert report.passed is False
    assert report.reasons == ["language_slice_below_production"]
    assert report.noise_band == pytest.approx(0.02)


def test_evaluate_passing_report_deltas_and_written_file(tmp_path):
    run_dir, _ = _write_bundle(tmp_path, n=12, mined_every=3)
    result = evaluate.run_evaluate(
        run_dir,
        finetuned=ALWAYS,
        base=_hit_if(lambda i: i % 2 == 0),
        production={TENANT_A: _hit_if(lambda i: i % 3 == 0)},
        config=load_finetune_config(),
    )
    report = result.report
    assert report.passed is True and report.reasons == []
    assert set(report.models.finetuned.by_source) == {"synthetic", "mined"}
    assert report.models.finetuned.by_source["mined"].n == 4
    by_key = {(d.comparison, d.metric, d.slice): d for d in report.deltas}
    overall = by_key[("finetuned_vs_production", "recall_at_10", "overall")]
    assert overall.delta == pytest.approx(1 - 4 / 12)
    assert overall.ci_low <= overall.delta <= overall.ci_high
    assert ("finetuned_vs_base", "ndcg_at_10", "source:mined") in by_key
    written = OfflineEvalReport.model_validate_json((run_dir / "offline-eval.json").read_text())
    assert written == report
    again = evaluate.run_evaluate(
        run_dir,
        finetuned=ALWAYS,
        base=_hit_if(lambda i: i % 2 == 0),
        production={TENANT_A: _hit_if(lambda i: i % 3 == 0)},
        config=load_finetune_config(),
    )
    assert again.report.deltas == report.deltas


def test_evaluate_below_production_and_below_base(tmp_path):
    run_dir, _ = _write_bundle(tmp_path)
    result = evaluate.run_evaluate(
        run_dir,
        finetuned=_hit_if(lambda i: i < 6),
        base=ALWAYS,
        production={TENANT_A: _hit_if(lambda i: i < 6)},
        config=load_finetune_config(),
    )
    assert result.report.passed is False
    assert result.report.reasons == ["below_production_overall", "below_base"]


def test_evaluate_cross_language_pairs_are_sliced(tmp_path):
    run_dir, chunks = _write_bundle(tmp_path, languages=lambda i: "en")
    cross = [
        line
        for line in (run_dir / "queries.test.kept.jsonl").read_text().splitlines()
        if line.strip()
    ]
    rows = [RawSyntheticQuery.model_validate_json(line) for line in cross]
    rows = [r.model_copy(update={"language": "it", "style": "cross_language"}) if i < 4 else r for i, r in enumerate(rows)]
    files = dict(bundle.read_manifest(run_dir).files)
    files["queries.test.kept.jsonl"] = bundle.write_jsonl(run_dir / "queries.test.kept.jsonl", rows, RawSyntheticQuery)
    bundle.write_manifest(run_dir, bundle.read_manifest(run_dir).model_copy(update={"files": files}))
    result = evaluate.run_evaluate(
        run_dir, finetuned=ALWAYS, base=NEVER, production={TENANT_A: NEVER}, config=load_finetune_config()
    )
    assert set(result.report.models.finetuned.by_pair) == {"it->en"}
    assert result.report.models.finetuned.by_pair["it->en"].n == 4
    assert result.report.models.finetuned.by_language["it"].n == 4


def test_evaluate_empty_test_split_is_refused_by_the_gate(tmp_path):
    run_dir, _ = _write_bundle(tmp_path, test=False)
    result = evaluate.run_evaluate(
        run_dir, finetuned=ALWAYS, base=ALWAYS, production={TENANT_A: ALWAYS}, config=load_finetune_config()
    )
    assert result.exit_code == 0
    assert result.report.passed is False
    assert result.report.reasons == ["empty_test_split"]
    assert result.report.models.finetuned.overall.n == 0


def test_evaluate_refuses_a_modified_bundle(tmp_path, capsys):
    run_dir, _ = _write_bundle(tmp_path)
    with open(run_dir / "queries.test.kept.jsonl", "a", encoding="utf-8") as handle:
        handle.write("\n")
    result = evaluate.run_evaluate(
        run_dir, finetuned=ALWAYS, base=ALWAYS, production={TENANT_A: ALWAYS}, config=load_finetune_config()
    )
    assert result.exit_code == 1
    assert "bundle_modified" in capsys.readouterr().err
    assert not (run_dir / "offline-eval.json").exists()


def _write_production_vectors(run_dir, chunks, encoder, *, tenants=(TENANT_A,), skip_query=None):
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
        items = []
        for path in ("queries.test.kept.jsonl", "pairs.mined.jsonl"):
            if not (run_dir / path).is_file():
                continue
            for line in (run_dir / path).read_text().splitlines():
                if not line.strip():
                    continue
                row = json.loads(line)
                if row["tenant_key"] != tenant:
                    continue
                item_id = row.get("query_id") or row["pair_id"]
                if item_id != skip_query:
                    items.append(TextItem(item_id, row.get("query") or row["anchor"]))
        write_vector_set(
            run_dir,
            kind="queries",
            tenant_key=tenant,
            profile_id=PROFILE,
            model=MODEL,
            ids=[i.id for i in items],
            matrix=normalize_rows(encoder.encode_queries(items)),
        )


def test_evaluate_cli_reads_production_vectors_and_prints_no_text(tmp_path, capsys):
    run_dir, chunks = _write_bundle(tmp_path, n=12, mined_every=4)
    _write_production_vectors(run_dir, chunks, _hit_if(lambda i: i % 2 == 0))
    model_dir = tmp_path / "model"
    model_dir.mkdir()
    (model_dir / "weights.bin").write_bytes(b"weights")
    config = load_finetune_config()
    default_base = next(m.id for m in config.base_models if m.default)
    encoders = {str(model_dir): ALWAYS, default_base: NEVER}
    code = evaluate.main(
        ["--bundle", str(run_dir), "--finetuned", str(model_dir)],
        config=config,
        encoder_factory=lambda ref: encoders[ref],
    )
    assert code == 0
    captured = capsys.readouterr()
    report = OfflineEvalReport.model_validate_json((run_dir / "offline-eval.json").read_text())
    assert report.models.production.overall.recall_at_10 == pytest.approx(0.5)
    assert report.passed is True
    provenance = json.loads((run_dir / "offline-eval.provenance.json").read_text())
    assert provenance["base_model"] == default_base
    assert provenance["finetuned_sha256"] == evaluate.model_fingerprint(model_dir)
    assert provenance["report_sha256"] == bundle.sha256_file(run_dir / "offline-eval.json")
    text = captured.out + captured.err + (run_dir / "offline-eval.json").read_text()
    for chunk in chunks:
        assert chunk.text not in text
    assert "entry 3 query" not in text
    assert "PASSED" in captured.out


def test_evaluate_cli_refuses_missing_query_vectors(tmp_path, capsys):
    run_dir, chunks = _write_bundle(tmp_path)
    _write_production_vectors(run_dir, chunks, ALWAYS, skip_query="a-q3")
    model_dir = tmp_path / "model"
    model_dir.mkdir()
    config = load_finetune_config()
    code = evaluate.main(
        ["--bundle", str(run_dir), "--finetuned", str(model_dir)],
        config=config,
        encoder_factory=lambda ref: ALWAYS,
    )
    assert code == 1
    assert "query_vectors_incomplete" in capsys.readouterr().err


def test_evaluate_cli_usage_refusals(tmp_path, capsys):
    run_dir, _ = _write_bundle(tmp_path)
    config = load_finetune_config()
    assert evaluate.main(["--bundle", str(run_dir)], config=config, encoder_factory=lambda ref: ALWAYS) == 2
    assert "finetuned_required" in capsys.readouterr().err
    assert (
        evaluate.main(
            ["--bundle", str(run_dir), "--finetuned", str(tmp_path / "missing")],
            config=config,
            encoder_factory=lambda ref: ALWAYS,
        )
        == 2
    )
    assert "finetuned_not_found" in capsys.readouterr().err
    assert (
        evaluate.main(
            ["--bundle", str(run_dir), "--finetuned", str(tmp_path), "--base", "nobody/unknown-model"],
            config=config,
            encoder_factory=lambda ref: ALWAYS,
        )
        == 2
    )
    assert "base_model_unknown" in capsys.readouterr().err


def test_evaluate_command_is_dispatched():
    assert cli.COMMANDS["evaluate"] == "rag_eval.finetune.evaluate:main"
    assert callable(evaluate.main)


# --- Task 1: zero-shot -----------------------------------------------------------------------------------------


def test_zero_shot_ranks_three_fake_base_encoders(tmp_path, capsys):
    run_dir, _ = _write_bundle(tmp_path, n=12)
    config = load_finetune_config()
    ids = [m.id for m in config.base_models]
    assert len(ids) == 3
    hits = {ids[0]: _hit_if(lambda i: i < 4), ids[1]: ALWAYS, ids[2]: _hit_if(lambda i: i < 8)}
    code = evaluate.main(["--bundle", str(run_dir), "--zero-shot"], config=config, encoder_factory=lambda ref: hits[ref])
    assert code == 0
    report = evaluate.ZeroShotReport.model_validate_json((run_dir / "zero-shot.json").read_text())
    assert [entry.model for entry in report.ranking] == [ids[1], ids[2], ids[0]]
    assert [entry.rank for entry in report.ranking] == [1, 2, 3]
    assert report.ranking[0].metrics.overall.recall_at_10 == 1.0
    assert report.ranking[2].metrics.overall.recall_at_10 == pytest.approx(4 / 12)
    assert report.production is None
    assert not (run_dir / "offline-eval.json").exists()
    out = capsys.readouterr().out
    assert out.index(ids[1]) < out.index(ids[2]) < out.index(ids[0])


def test_zero_shot_refuses_a_finetuned_model(tmp_path, capsys):
    run_dir, _ = _write_bundle(tmp_path)
    code = evaluate.main(
        ["--bundle", str(run_dir), "--zero-shot", "--finetuned", str(tmp_path)],
        config=load_finetune_config(),
        encoder_factory=lambda ref: ALWAYS,
    )
    assert code == 2
    assert "zero_shot_takes_no_finetuned" in capsys.readouterr().err


def test_bootstrap_interval_is_seeded():
    differences = [1.0, 0.0, 1.0, -1.0, 0.0, 1.0, 1.0, 0.0]
    assert evaluate.bootstrap_interval(differences, seed=42, resamples=1000) == evaluate.bootstrap_interval(
        differences, seed=42, resamples=1000
    )
    low, high = evaluate.bootstrap_interval(differences, seed=42, resamples=1000)
    assert low < float(np.mean(differences)) < high
    assert evaluate.bootstrap_interval([0.0, 0.0], seed=42, resamples=1000) == (0.0, 0.0)
