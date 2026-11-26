"""06.1-16: the Python fine-tune pipeline end to end on the fixture corpus, with the leakage invariants in one place.

Fakes only (fixture LLM, FakeEncoder vectors, fake trainer); no network. The --tiny run needs the finetune extra and is
marked finetune_train.
"""
import json
import os
import re
from pathlib import Path

import pytest
from rag_sidecar.contracts.finetune import (
    DatasetManifest,
    ExportedChunk,
    FilterReport,
    FinetunePair,
    MiningReport,
    ModelVersionCard,
    OfflineEvalReport,
    TrainingRunReport,
)

from rag_eval.corpus import load_corpus
from rag_eval.finetune import cli, pipeline
from rag_eval.finetune.decontam import (
    FIXTURE_GOLDEN_PATH,
    GoldenIndex,
    golden_test_documents,
    load_golden_items,
    load_golden_questions,
)
from rag_eval.paths import REPO_ROOT

CORPUS_DIR = REPO_ROOT / "eval" / "fixtures" / "corpus"
PAIR_FILES = ("train_ntuple.jsonl", "train_pairs.jsonl", "dev.jsonl")


def _rows(path: Path, model=None):
    if not path.is_file():
        return []
    lines = [line for line in path.read_text(encoding="utf-8").splitlines() if line.strip()]
    return [model.model_validate_json(line) if model else json.loads(line) for line in lines]


def _run(out: Path, *extra: str) -> int:
    return cli.main(["run", "--fixture", "--out", str(out), *extra])


@pytest.fixture(scope="module")
def fixture_run(tmp_path_factory):
    out = tmp_path_factory.mktemp("ft-pipeline") / "out"
    capture = pytest.MonkeyPatch()
    import io
    import sys

    stdout, stderr = io.StringIO(), io.StringIO()
    capture.setattr(sys, "stdout", stdout)
    capture.setattr(sys, "stderr", stderr)
    try:
        code = _run(out)
    finally:
        capture.undo()
    if code != 0:
        pytest.fail(f"fixture run exited {code}: {stderr.getvalue()[-2000:]}")
    report = json.loads((out / pipeline.PIPELINE_REPORT_FILE).read_text())
    run_dir = out / pipeline.BUNDLES_DIR / report["run_id"]
    return {
        "code": code,
        "out": out,
        "run_dir": run_dir,
        "kit": out / pipeline.KIT_DIR,
        "model": out / pipeline.MODEL_DIR,
        "report": report,
        "stdout": stdout.getvalue(),
        "stderr": stderr.getvalue(),
    }


# --- Task 1: fixture pipeline command --------------------------------------------------------------------------


def test_run_fixture_exits_0_and_writes_every_report(fixture_run):
    assert fixture_run["code"] == 0, fixture_run["stderr"]
    run_dir, model = fixture_run["run_dir"], fixture_run["model"]
    for name in (
        "manifest.json",
        "generate-report.json",
        "filter-report.json",
        "mined-report.json",
        "mining-report.json",
        "offline-eval.json",
        "offline-eval.provenance.json",
        "card.json",
    ):
        assert (run_dir / name).is_file(), name
    for name in ("training-report.json", "training-config.json", "probe.json"):
        assert (model / name).is_file(), name
    assert (fixture_run["kit"] / "kit-manifest.json").is_file()
    report = fixture_run["report"]
    assert report["fixture"] is True
    assert [step["command"] for step in report["steps"]] == list(pipeline.STEPS)
    assert all(step["exit_code"] == 0 for step in report["steps"])
    assert report["trainer"] == "fake"


def test_run_every_stage_produced_rows(fixture_run):
    run_dir = fixture_run["run_dir"]
    manifest = DatasetManifest.model_validate_json((run_dir / "manifest.json").read_text())
    assert manifest.tenant_keys == sorted(pipeline.FIXTURE_TENANTS)
    assert all(manifest.chunks[split] > 0 for split in ("train", "dev", "test"))
    assert _rows(run_dir / "queries.kept.jsonl") and _rows(run_dir / "queries.test.kept.jsonl")
    mined = _rows(run_dir / "pairs.mined.jsonl", FinetunePair)
    assert mined and any(p.split == "test" for p in mined) and any(p.split == "train" for p in mined)
    assert _rows(run_dir / "train_ntuple.jsonl") and _rows(run_dir / "dev.jsonl")
    mining = MiningReport.model_validate_json((run_dir / "mining-report.json").read_text())
    assert mining.miner == "vectors" and mining.fn_audit.skipped is False and mining.fn_audit.passed is True


def test_run_rerun_into_the_same_out_reproduces_report_hashes(fixture_run, tmp_path):
    first = fixture_run["report"]["reports"]
    out = tmp_path / "again"
    assert _run(out) == 0
    assert _run(out) == 0
    again = json.loads((out / pipeline.PIPELINE_REPORT_FILE).read_text())["reports"]
    assert set(first) == set(pipeline.REPRODUCIBLE_REPORTS)
    assert again == first


def test_run_requires_fixture_mode(tmp_path, capsys):
    assert cli.main(["run", "--out", str(tmp_path / "x")]) == 2
    assert "fixture_required" in capsys.readouterr().err
    assert not (tmp_path / "x").exists()


def test_run_refuses_an_out_dir_it_did_not_write(tmp_path, capsys):
    out = tmp_path / "busy"
    out.mkdir()
    (out / "keep.txt").write_text("operator file")
    assert _run(out) == 2
    assert "out_not_fixture_run" in capsys.readouterr().err
    assert (out / "keep.txt").read_text() == "operator file"


def test_run_sets_rag_finetune_only_for_the_export(fixture_run, monkeypatch, tmp_path):
    monkeypatch.delenv("RAG_FINETUNE", raising=False)
    seen = []
    from rag_eval.finetune import export

    original = export.main

    def spy(argv):
        seen.append(os.environ.get("RAG_FINETUNE"))
        return original(argv)

    monkeypatch.setattr(export, "main", spy)
    assert _run(tmp_path / "env") == 0
    assert seen == ["on"]
    assert "RAG_FINETUNE" not in os.environ


# --- Task 2: leakage and no-text invariants ----------------------------------------------------------------------


def _chunks(run_dir):
    return {(c.tenant_key, c.chunk_id): c for c in _rows(run_dir / "chunks.jsonl", ExportedChunk)}


def _pairs(fixture_run):
    rows = []
    for directory in (fixture_run["run_dir"], fixture_run["kit"]):
        for name in PAIR_FILES:
            rows += _rows(directory / name, FinetunePair)
    return rows


def test_invariant_no_test_document_in_train_or_dev_rows_or_negatives(fixture_run):
    chunks = _chunks(fixture_run["run_dir"])
    test_docs = {c.document_id for c in chunks.values() if c.split == "test"}
    pairs = _pairs(fixture_run)
    assert pairs and any(p.negatives for p in pairs)
    for pair in pairs:
        assert pair.split in ("train", "dev")
        assert chunks[(pair.tenant_key, pair.positive_chunk_id)].document_id not in test_docs
        for negative in pair.negatives:
            assert chunks[(pair.tenant_key, negative.chunk_id)].document_id not in test_docs
    train = [p for p in pairs if p.split == "train"]
    for pair in train:
        assert all(chunks[(pair.tenant_key, n.chunk_id)].split == "train" for n in pair.negatives)
    kit_corpus = _rows(fixture_run["kit"] / "dev_corpus.jsonl")
    assert kit_corpus and all(chunks[(row["tenant_key"], row["chunk_id"])].split != "test" for row in kit_corpus)
    assert not any("test" in path.name for path in fixture_run["kit"].iterdir())


def test_invariant_the_synthetic_sample_exercises_the_test_negative_guard(fixture_run):
    chunks = _chunks(fixture_run["run_dir"])
    sample = _rows(fixture_run["out"] / pipeline.INPUTS_DIR / pipeline.MINED_SAMPLE_FILE)
    assert any(
        chunks[(row["tenant_key"], negative["chunk_id"])].split == "test"
        for row in sample
        for negative in row["hard_negatives"]
        if chunks[(row["tenant_key"], row["positive"]["chunk_id"])].split == "train"
    )
    assert any(row["split"] == "held_out" for row in sample)


def test_invariant_golden_test_evidence_documents_are_in_the_test_split(fixture_run):
    names = {name.casefold() for name in golden_test_documents(load_golden_items([FIXTURE_GOLDEN_PATH]))}
    chunks = list(_chunks(fixture_run["run_dir"]).values())
    docs = {doc.relpath: doc for doc in load_corpus(CORPUS_DIR)}
    evidence = [c for c in chunks if c.is_golden_test_evidence]
    assert evidence
    assert all(c.split == "test" for c in evidence)
    by_name = {doc.filename.casefold() for doc in docs.values()}
    assert names & by_name, "the fixture golden set names corpus documents"
    forced = {c.document_id for c in evidence}
    other = {c.document_id for c in chunks if not c.is_golden_test_evidence}
    assert not forced & other


def test_invariant_no_kept_query_overlaps_a_golden_question(fixture_run):
    run_dir = fixture_run["run_dir"]
    index = GoldenIndex(load_golden_questions([FIXTURE_GOLDEN_PATH]))
    queries = [r["query"] for name in ("queries.kept.jsonl", "queries.test.kept.jsonl") for r in _rows(run_dir / name)]
    queries += [p.anchor for p in _rows(run_dir / "pairs.mined.jsonl", FinetunePair)]
    queries += [p.anchor for p in _pairs(fixture_run)]
    assert queries
    assert not [q for q in queries if index.overlaps(q, 0.8)]
    filter_report = FilterReport.model_validate_json((run_dir / "filter-report.json").read_text())
    assert filter_report.kept > 0
    assert filter_report.dropped["golden_overlap"] > 0, "the fixture LLM emits golden questions the filter must drop"
    mined_report = json.loads((run_dir / "mined-report.json").read_text())
    assert mined_report["dropped"]["golden_overlap"] > 0, "the synthetic sample asks golden questions"


def test_invariant_every_pair_belongs_to_one_tenant(fixture_run):
    chunks = _chunks(fixture_run["run_dir"])
    manifest = DatasetManifest.model_validate_json((fixture_run["run_dir"] / "manifest.json").read_text())
    for pair in _pairs(fixture_run) + _rows(fixture_run["run_dir"] / "pairs.mined.jsonl", FinetunePair):
        assert pair.tenant_key in manifest.tenant_keys
        assert chunks[(pair.tenant_key, pair.positive_chunk_id)].tenant_key == pair.tenant_key
        for negative in pair.negatives:
            assert (pair.tenant_key, negative.chunk_id) in chunks
            assert chunks[(pair.tenant_key, negative.chunk_id)].tenant_key == pair.tenant_key


def _fixture_sentences(n: int = 20) -> list[str]:
    sentences: list[str] = []
    for doc in sorted(load_corpus(CORPUS_DIR), key=lambda d: d.relpath):
        for piece in re.split(r"(?<=[.!?。！？])\s*|\n+", doc.content):
            piece = piece.strip().lstrip("#-*> ").strip()
            if len(piece) >= 24 and piece not in sentences:
                sentences.append(piece)
                break
    for doc in sorted(load_corpus(CORPUS_DIR), key=lambda d: d.relpath):
        for piece in re.split(r"(?<=[.!?。！？])\s*|\n+", doc.content):
            piece = piece.strip().lstrip("#-*> ").strip()
            if len(sentences) >= n:
                return sentences[:n]
            if len(piece) >= 24 and piece not in sentences:
                sentences.append(piece)
    return sentences[:n]


def test_invariant_reports_validate_and_contain_no_fixture_text(fixture_run):
    run_dir, model, kit = fixture_run["run_dir"], fixture_run["model"], fixture_run["kit"]
    DatasetManifest.model_validate_json((run_dir / "manifest.json").read_text())
    FilterReport.model_validate_json((run_dir / "filter-report.json").read_text())
    MiningReport.model_validate_json((run_dir / "mining-report.json").read_text())
    TrainingRunReport.model_validate_json((model / "training-report.json").read_text())
    OfflineEvalReport.model_validate_json((run_dir / "offline-eval.json").read_text())
    ModelVersionCard.model_validate_json((run_dir / "card.json").read_text())
    sentences = _fixture_sentences()
    assert len(sentences) == 20
    chunk_text = "\n".join(c.text for c in _chunks(run_dir).values())
    assert sum(1 for s in sentences if s in chunk_text) >= 10, "the probe sentences are exported text"
    reports = [path for path in run_dir.iterdir() if path.suffix == ".json"]
    reports += [model / "training-report.json", model / "training-config.json", kit / "kit-manifest.json"]
    reports.append(fixture_run["out"] / pipeline.PIPELINE_REPORT_FILE)
    texts = {str(path): path.read_text(encoding="utf-8") for path in reports}
    texts["stdout"] = fixture_run["stdout"]
    texts["stderr"] = fixture_run["stderr"]
    leaks = [(name, s) for name, text in texts.items() for s in sentences if s in text]
    assert not leaks


@pytest.mark.finetune_train
def test_tiny_model_recall_is_not_below_the_untrained_model(tmp_path):
    pytest.importorskip("sentence_transformers")
    out = tmp_path / "tiny"
    assert _run(out, "--tiny") == 0
    report = json.loads((out / pipeline.PIPELINE_REPORT_FILE).read_text())
    assert report["trainer"] == "tiny"
    assert report["note"] == "fixture: proves wiring, not real gain"
    offline = OfflineEvalReport.model_validate_json(
        (out / pipeline.BUNDLES_DIR / report["run_id"] / "offline-eval.json").read_text()
    )
    trained = offline.models.finetuned.overall.recall_at_10
    untrained = offline.models.base.overall.recall_at_10
    assert trained >= untrained
    assert report["tiny"] == {"untrained_recall_at_10": untrained, "trained_recall_at_10": trained}
