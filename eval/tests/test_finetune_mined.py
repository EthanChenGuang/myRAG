import hashlib
import json
from pathlib import Path

import pytest
from rag_sidecar.contracts.feedback_loop import TrainingPair
from rag_sidecar.contracts.finetune import DatasetManifest, ExportedChunk, FinetunePair

from rag_eval.finetune import bundle, mined
from rag_eval.finetune.config import load_finetune_config
from rag_eval.finetune.decontam import GoldenIndex

SAMPLE = Path(__file__).parent / "fixtures" / "finetune" / "training-pairs.sample.ndjson"
TENANT_A = "o:00000000-0000-4000-8000-0000000000a1"
TENANT_B = "o:00000000-0000-4000-8000-0000000000b2"

TEXTS = {
    "c-train-1": "The neutral record lists three generic attributes for the sample entry.",
    "c-train-2": "Every generic entry carries a short code and a plain label.",
    "c-train-3": "A placeholder item is reviewed once per cycle by the assigned team.",
    "c-neg-1": "Unrelated filler text about a neutral topic with no matching facts.",
    "c-neg-2": "Another filler paragraph that belongs to a held out document.",
    "c-dev-1": "A neutral sample paragraph that sits in a development document.",
    "c-test-1": "The held out record names one generic attribute in plain words.",
}
SPLITS = {"c-neg-2": "test", "c-dev-1": "dev", "c-test-1": "test"}
DOCS = {"c-train-1": 1, "c-train-2": 2, "c-train-3": 3, "c-neg-1": 4, "c-neg-2": 5, "c-dev-1": 6, "c-test-1": 7}


def _doc(n: int) -> str:
    return f"00000000-0000-4000-8000-{n:012d}"


def _chunk(chunk_id: str, *, tenant: str = TENANT_A) -> ExportedChunk:
    text = TEXTS[chunk_id]
    split = SPLITS.get(chunk_id, "train")
    return ExportedChunk(
        tenant_key=tenant,
        document_id=_doc(DOCS[chunk_id]),
        chunk_id=chunk_id,
        chunk_index=0,
        content_hash=hashlib.sha256(f"{tenant}:{text}".encode()).hexdigest(),
        language="en",
        split=split,
        text=text,
        token_count=20,
        is_golden_test_evidence=split == "test",
    )


def _bundle(tmp_path, *, tenants=(TENANT_A,), chunk_ids=tuple(TEXTS), extra_chunks=()):
    chunks = [_chunk(c, tenant=t) for t in tenants for c in chunk_ids] + list(extra_chunks)
    run_dir = bundle.new_run_dir(tmp_path / "out", "run-1")
    files = {bundle.CHUNKS_FILE: bundle.write_jsonl(run_dir / bundle.CHUNKS_FILE, chunks, ExportedChunk)}
    bundle.write_manifest(
        run_dir,
        DatasetManifest(
            run_id="run-1",
            purpose="private" if len(tenants) == 1 else "deployment",
            split_rule="ft-sha256-first8hex-mod100-80-10-10",
            tenant_keys=sorted(tenants),
            chunks={},
            counts={"train": {"synthetic": 5}},
            files=files,
            created_at="2026-11-26T00:00:00Z",
        ),
    )
    return run_dir


def _row(n, query, positive, *, tenant=TENANT_A, negatives=(), split="train"):
    return {
        "tenant_key": tenant,
        "query_masked": query,
        "language": "en",
        "positive": {"chunk_id": positive, "document_id": _doc(DOCS.get(positive, 99)), "quote": "generic"},
        "hard_negatives": [
            {"chunk_id": c, "document_id": _doc(DOCS[c]), "rank": i + 1, "score": 0.4, "confirmed": confirmed}
            for i, (c, confirmed) in enumerate(negatives)
        ],
        "document_group": f"group-{n}",
        "split": split,
        "source": "production_feedback",
        "review_item_id": f"10000000-0000-4000-8000-{n:012d}",
    }


def _write_rows(tmp_path, rows) -> Path:
    path = tmp_path / "training.ndjson"
    path.write_text("".join(json.dumps(r) + "\n" for r in rows), encoding="utf-8")
    return path


def _pairs(run_dir) -> list[FinetunePair]:
    return bundle.read_jsonl(run_dir / mined.PAIRS_FILE, FinetunePair)


class _CountingJudge:
    def __init__(self):
        self.judge_calls = 0
        self.generate_calls = 0

    def judge_answerability(self, *args, **kwargs):
        self.judge_calls += 1
        raise AssertionError("mined pairs never reach the judge")

    def submit_queries(self, *args, **kwargs):
        self.generate_calls += 1
        raise AssertionError("import-mined never generates")


def _run(run_dir, input_path, **kwargs):
    kwargs.setdefault("golden", GoldenIndex([]))
    return mined.run_import_mined(run_dir, input_path, **kwargs)


# --- validation, tenant and chunk checks, filters --------------------------------------------------------------------


def test_validate_sample_rows_are_5_1_1_training_pairs_except_the_invalid_one():
    valid = invalid = 0
    for line in SAMPLE.read_text(encoding="utf-8").splitlines():
        try:
            TrainingPair.model_validate_json(line)
            valid += 1
        except ValueError:
            invalid += 1
    assert (valid, invalid) == (7, 1)


def test_validate_and_filter_the_sample_counts_every_reason_and_never_calls_the_judge(tmp_path):
    run_dir = _bundle(tmp_path)
    judge = _CountingJudge()
    result = _run(run_dir, SAMPLE, llm=judge)
    assert result.exit_code == 0
    report = result.report
    assert report.input_rows == 8
    assert report.dropped["tenant_not_in_bundle"] == 1
    assert report.dropped["unknown_chunk"] == 1
    assert report.dropped["invalid_row"] == 1
    assert report.dropped["verbatim_copy"] == 1
    assert sum(report.dropped.values()) == 4
    assert report.kept == 4
    assert report.by_split == {"train": 3, "dev": 0, "test": 1}
    assert report.held_out == 1
    assert report.judge == "skipped"
    assert judge.judge_calls == 0 and judge.generate_calls == 0


def test_filter_kept_pairs_are_mined_with_weight_2_and_expert_negatives_confirmed_first(tmp_path):
    run_dir = _bundle(tmp_path)
    _run(run_dir, SAMPLE)
    pairs = {p.pair_id: p for p in _pairs(run_dir)}
    assert len(pairs) == 4
    assert all(p.source == "mined" and p.weight == load_finetune_config().mined.mined_weight == 2 for p in pairs.values())
    assert all(p.tenant_key == TENANT_A for p in pairs.values())

    six = pairs["mined:10000000-0000-4000-8000-000000000006"]
    assert six.anchor == "which record has a trio of properties"
    assert six.positive_chunk_id == "c-train-1" and six.positive == TEXTS["c-train-1"]
    assert [(n.chunk_id, n.negative_source) for n in six.negatives] == [("c-train-3", "expert"), ("c-neg-1", "expert")]
    assert six.negatives[0].text == TEXTS["c-train-3"]
    assert six.split == "train"

    seven = pairs["mined:10000000-0000-4000-8000-000000000007"]
    # c-neg-2 sits in a test document: test text never enters a train pair, even as a negative (D-10)
    assert [n.chunk_id for n in seven.negatives] == ["c-neg-1"]
    assert result_negatives_dropped(run_dir) == 1

    five = pairs["mined:10000000-0000-4000-8000-000000000005"]
    assert five.split == "test"


def result_negatives_dropped(run_dir) -> int:
    report = json.loads((run_dir / mined.REPORT_FILE).read_text(encoding="utf-8"))
    return report["negatives"]["dropped_split"]


def test_filter_held_out_rows_go_to_test_even_when_the_positive_document_is_train(tmp_path):
    run_dir = _bundle(tmp_path)
    path = _write_rows(tmp_path, [_row(1, "which neutral item has a short code", "c-train-2", split="held_out")])
    _run(run_dir, path)
    assert [p.split for p in _pairs(run_dir)] == ["test"]


def test_filter_train_rows_follow_the_positive_documents_split(tmp_path):
    run_dir = _bundle(tmp_path)
    rows = [
        _row(1, "which paragraph sits in the development set", "c-dev-1"),
        _row(2, "what attribute does the held record name", "c-test-1"),
        _row(3, "how often is the placeholder reviewed", "c-train-3"),
    ]
    _run(run_dir, _write_rows(tmp_path, rows))
    assert {p.positive_chunk_id: p.split for p in _pairs(run_dir)} == {"c-dev-1": "dev", "c-test-1": "test", "c-train-3": "train"}


def test_validate_a_chunk_of_another_tenant_is_unknown_even_with_the_same_id(tmp_path):
    run_dir = _bundle(tmp_path, tenants=(TENANT_A, TENANT_B), chunk_ids=("c-train-1",), extra_chunks=[_chunk("c-train-2", tenant=TENANT_B)])
    rows = [
        _row(1, "what does each entry carry besides its label", "c-train-2"),
        _row(2, "which record has a trio of properties", "c-train-1", negatives=[("c-train-2", True)]),
        _row(3, "what does each entry carry besides its label", "c-train-2", tenant=TENANT_B),
    ]
    result = _run(run_dir, _write_rows(tmp_path, rows))
    assert result.report.dropped["unknown_chunk"] == 2
    assert [(p.tenant_key, p.positive_chunk_id) for p in _pairs(run_dir)] == [(TENANT_B, "c-train-2")]


def test_validate_a_positive_whose_document_id_does_not_match_the_bundle_is_unknown(tmp_path):
    run_dir = _bundle(tmp_path)
    row = _row(1, "which record has a trio of properties", "c-train-1")
    row["positive"]["document_id"] = _doc(42)
    result = _run(run_dir, _write_rows(tmp_path, [row]))
    assert result.report.dropped["unknown_chunk"] == 1 and result.report.kept == 0


def test_validate_broken_json_and_repeated_review_items_are_invalid_rows(tmp_path):
    run_dir = _bundle(tmp_path)
    good = _row(1, "which record has a trio of properties", "c-train-1")
    path = tmp_path / "training.ndjson"
    path.write_text("{not json\n" + json.dumps(good) + "\n\n" + json.dumps(good) + "\n", encoding="utf-8")
    result = _run(run_dir, path)
    assert result.report.input_rows == 3
    assert result.report.dropped["invalid_row"] == 2 and result.report.kept == 1


def test_filter_golden_overlap_drops_a_mined_query_that_matches_a_golden_question(tmp_path):
    run_dir = _bundle(tmp_path)
    rows = [_row(1, "which record has a trio of properties", "c-train-1"), _row(2, "how often is the placeholder reviewed", "c-train-3")]
    result = _run(run_dir, _write_rows(tmp_path, rows), golden=GoldenIndex(["Which record has a trio of properties?"]))
    assert result.report.dropped["golden_overlap"] == 1
    assert [p.positive_chunk_id for p in _pairs(run_dir)] == ["c-train-3"]


def test_filter_shape_and_near_duplicate_rules_apply(tmp_path):
    run_dir = _bundle(tmp_path)
    rows = [
        _row(1, "x", "c-train-1"),
        _row(2, "how often is the placeholder reviewed", "c-train-3"),
        _row(3, "How often is the placeholder reviewed?", "c-train-3"),
    ]
    result = _run(run_dir, _write_rows(tmp_path, rows))
    assert result.report.dropped["shape"] == 1
    assert result.report.dropped["near_duplicate"] == 1
    assert result.report.kept == 1


def test_filter_reuses_the_filter_rule_functions(monkeypatch, tmp_path):
    from rag_eval.finetune import filters

    seen = []
    original = filters.rule_reason

    def spy(row, chunk_text, config):
        seen.append(row.query)
        return original(row, chunk_text, config)

    monkeypatch.setattr(filters, "rule_reason", spy)
    run_dir = _bundle(tmp_path)
    _run(run_dir, _write_rows(tmp_path, [_row(1, "how often is the placeholder reviewed", "c-train-3")]))
    assert seen == ["how often is the placeholder reviewed"]


def test_filter_manifest_records_the_pairs_file_and_mined_counts(tmp_path):
    run_dir = _bundle(tmp_path)
    _run(run_dir, SAMPLE)
    manifest = bundle.read_manifest(run_dir)
    assert manifest.files[mined.PAIRS_FILE] == bundle.sha256_file(run_dir / mined.PAIRS_FILE)
    assert manifest.counts["train"] == {"synthetic": 5, "mined": 3}
    assert manifest.counts["test"]["mined"] == 1
    assert manifest.counts["dev"]["mined"] == 0


def test_filter_stdout_stderr_and_report_carry_no_query_or_chunk_text(tmp_path, capsys):
    run_dir = _bundle(tmp_path)
    _run(run_dir, SAMPLE)
    captured = capsys.readouterr()
    report_text = (run_dir / mined.REPORT_FILE).read_text(encoding="utf-8")
    queries = [json.loads(line)["query_masked"] for line in SAMPLE.read_text(encoding="utf-8").splitlines()]
    for sentence in [*queries, *TEXTS.values()]:
        assert sentence not in captured.out and sentence not in captured.err and sentence not in report_text
    assert "kept=4" in captured.out


def test_validate_missing_bundle_or_input_exits_2(tmp_path):
    run_dir = _bundle(tmp_path)
    assert _run(tmp_path / "nope", SAMPLE).exit_code == 2
    assert _run(run_dir, tmp_path / "missing.ndjson").exit_code == 2
    assert not (run_dir / mined.PAIRS_FILE).exists()


def test_validate_a_modified_chunks_file_is_refused(tmp_path, capsys):
    run_dir = _bundle(tmp_path)
    with open(run_dir / bundle.CHUNKS_FILE, "a", encoding="utf-8") as handle:
        handle.write("\n")
    assert _run(run_dir, SAMPLE).exit_code == 1
    assert "bundle_modified" in capsys.readouterr().err
    assert not (run_dir / mined.PAIRS_FILE).exists()


def test_validate_main_runs_through_the_cli_dispatch(tmp_path):
    from rag_eval.finetune import cli

    run_dir = _bundle(tmp_path)
    assert cli.main(["import-mined", "--bundle", str(run_dir), "--input", str(SAMPLE)]) == 0
    assert len(_pairs(run_dir)) == 4
    assert cli.main(["import-mined", "--bundle", str(run_dir)]) == 2


# --- clustering and split --------------------------------------------------------------------------------------------

NEAR_1 = "which generic entry lists the three plain attributes"
NEAR_2 = "which generic entry lists three plain attributes"


def test_cluster_near_identical_queries_share_a_cluster_within_a_tenant_only():
    rows = [(TENANT_A, NEAR_1), (TENANT_A, NEAR_2), (TENANT_B, NEAR_2), (TENANT_A, "how often is the placeholder reviewed")]
    clusters = mined.cluster_queries(rows)
    assert clusters[0] == clusters[1]
    assert clusters[2] != clusters[0]
    assert clusters[3] not in (clusters[0], clusters[2])


def test_cluster_union_is_transitive():
    a = "alpha beta gamma delta epsilon zeta"
    b = "alpha beta gamma delta epsilon zeta eta"
    c = "alpha beta gamma delta epsilon zeta eta theta"
    assert mined.cluster_queries([(TENANT_A, a), (TENANT_A, c)], threshold=0.86) == [0, 1]
    clusters = mined.cluster_queries([(TENANT_A, a), (TENANT_A, b), (TENANT_A, c)], threshold=0.86)
    assert clusters[0] == clusters[1] == clusters[2]


def test_cluster_near_identical_mined_queries_on_a_test_and_a_train_doc_land_in_the_first_members_split(tmp_path):
    run_dir = _bundle(tmp_path)
    rows = [_row(1, NEAR_1, "c-test-1"), _row(2, NEAR_2, "c-train-1")]
    result = _run(run_dir, _write_rows(tmp_path, rows))
    assert result.report.kept == 2
    assert [p.split for p in _pairs(run_dir)] == ["test", "test"]
    assert result.report.cluster_promoted == 1


def test_cluster_takes_the_strictest_split_whatever_the_member_order(tmp_path):
    run_dir = _bundle(tmp_path)
    rows = [_row(1, NEAR_2, "c-train-1"), _row(2, NEAR_1, "c-dev-1"), _row(3, "how often is the placeholder reviewed", "c-train-3")]
    _run(run_dir, _write_rows(tmp_path, rows))
    assert {p.positive_chunk_id: p.split for p in _pairs(run_dir)} == {"c-train-1": "dev", "c-dev-1": "dev", "c-train-3": "train"}


def test_cluster_a_held_out_member_pulls_its_cluster_into_test(tmp_path):
    run_dir = _bundle(tmp_path)
    rows = [_row(1, NEAR_2, "c-train-1"), _row(2, NEAR_1, "c-train-2", split="held_out")]
    _run(run_dir, _write_rows(tmp_path, rows))
    assert [p.split for p in _pairs(run_dir)] == ["test", "test"]


def test_cluster_includes_rows_that_a_filter_later_drops(tmp_path):
    run_dir = _bundle(tmp_path)
    # the test-doc member is an exact duplicate and is dropped, but it still pulls the kept member into test
    rows = [_row(1, NEAR_2, "c-train-1"), _row(2, NEAR_2 + "?", "c-test-1")]
    result = _run(run_dir, _write_rows(tmp_path, rows))
    assert result.report.dropped["near_duplicate"] == 1
    assert [(p.positive_chunk_id, p.split) for p in _pairs(run_dir)] == [("c-train-1", "test")]


def test_cluster_never_straddles_splits_in_the_written_pairs(tmp_path):
    run_dir = _bundle(tmp_path)
    rows = [
        _row(1, NEAR_1, "c-train-1"),
        _row(2, NEAR_2, "c-train-2"),
        _row(3, NEAR_1 + " now", "c-test-1"),
        _row(4, "what does each entry carry besides its label", "c-train-3"),
    ]
    _run(run_dir, _write_rows(tmp_path, rows))
    pairs = _pairs(run_dir)
    clusters = mined.cluster_queries([(p.tenant_key, p.anchor) for p in pairs])
    by_cluster: dict[int, set[str]] = {}
    for cluster, pair in zip(clusters, pairs, strict=True):
        by_cluster.setdefault(cluster, set()).add(pair.split)
    assert all(len(splits) == 1 for splits in by_cluster.values())


@pytest.mark.parametrize("splits,expected", [(("train", "dev"), "dev"), (("dev", "test", "train"), "test"), (("train",), "train")])
def test_cluster_strictest_split(splits, expected):
    assert mined.strictest_split(splits) == expected
