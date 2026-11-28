import hashlib

import pytest
from rag_sidecar.contracts.finetune import DatasetManifest, ExportedChunk

from rag_eval.finetune import bundle, filters
from rag_eval.finetune.config import load_finetune_config
from rag_eval.finetune.decontam import GoldenIndex, load_golden_questions
from rag_eval.finetune.generate import RAW_FILE, TEST_RAW_FILE, RawSyntheticQuery

TENANT = "s:default"
OTHER_TENANT = "o:00000000-0000-4000-8000-000000000001"

CHUNK_EN = "The sample retention period is 24 months from the creation date."
CHUNK_ZH = "样本保留期为自创建之日起24个月。"
CHUNK_IT = "Il periodo di conservazione del campione è di 24 mesi dalla creazione."

COPY_EN = "sample retention period is 24 months from the creation date"
COPY_ZH = "样本保留期为自创建之日起24个月"
COPY_IT = "periodo di conservazione del campione 24 mesi dalla creazione"
PARA_EN = "how long is a sample kept after it is made"
PARA_ZH = "样本做出来以后能放多久"
PARA_IT = "quanto tempo si tiene un campione dopo che è fatto"


def _config():
    return load_finetune_config()


def _chunk(i: int, language: str, text: str, *, tenant: str = TENANT, split: str = "train") -> ExportedChunk:
    return ExportedChunk(
        tenant_key=tenant,
        document_id=f"00000000-0000-4000-8000-{i:012d}",
        chunk_id=f"chunk-{i:02d}",
        chunk_index=0,
        content_hash=hashlib.sha256(text.encode()).hexdigest(),
        language=language,
        split=split,
        text=text,
        token_count=120,
        is_golden_test_evidence=False,
    )


def _query(chunk: ExportedChunk, query: str, *, style: str = "question", language: str | None = None, n: int = 0):
    return RawSyntheticQuery(
        query_id=f"q-{chunk.chunk_id}-{style}-{n}",
        tenant_key=chunk.tenant_key,
        document_id=chunk.document_id,
        chunk_id=chunk.chunk_id,
        split=chunk.split,
        chunk_language=chunk.language,
        language=language or chunk.language,
        style=style,
        query=query,
        prompt_version="ft-generate-v1",
        model="fake-generator",
    )


# --- rule filters ---------------------------------------------------------------------------------------------------


@pytest.mark.parametrize(
    "chunk_text,copy,paraphrase",
    [(CHUNK_EN, COPY_EN, PARA_EN), (CHUNK_ZH, COPY_ZH, PARA_ZH), (CHUNK_IT, COPY_IT, PARA_IT)],
    ids=["en", "zh", "it"],
)
def test_rule_verbatim_copy_drops_a_copy_and_keeps_a_paraphrase(chunk_text, copy, paraphrase):
    assert filters.verbatim_copy(copy, chunk_text) is True
    assert filters.verbatim_copy(paraphrase, chunk_text) is False


def test_rule_verbatim_copy_uses_the_longest_common_substring_when_containment_is_low():
    chunk = "abcdefghijklmnopqrst"
    query = "abcdefghijklmnXYZ"
    # containment 10/13 stays under a threshold of 1.0, so only the LCS rule (14 of 17 characters) can fire
    assert filters.verbatim_copy(query, chunk, containment_threshold=1.0, lcs_ratio=0.7) is True
    assert filters.verbatim_copy(query, chunk, containment_threshold=1.0, lcs_ratio=0.9) is False


def test_rule_longest_common_substring_is_exact():
    assert filters.longest_common_substring("xabcdy", "zzabcdzz") == 4
    assert filters.longest_common_substring("", "abc") == 0
    assert filters.longest_common_substring("样本保留", "这是样本保留期") == 4


def test_rule_shape_drops_a_one_character_english_query_and_keeps_a_normal_one():
    config = _config()
    chunk = _chunk(1, "en", CHUNK_EN)
    assert filters.rule_reason(_query(chunk, "x"), CHUNK_EN, config.filters) == "shape"
    assert filters.rule_reason(_query(chunk, PARA_EN), CHUNK_EN, config.filters) is None


def test_rule_language_mismatch_is_dropped_as_language():
    config = _config()
    chunk = _chunk(1, "it", CHUNK_IT)
    row = _query(chunk, PARA_ZH, language="it")
    assert filters.rule_reason(row, CHUNK_IT, config.filters) == "language"


def test_rule_language_is_kept_when_the_detector_is_not_confident():
    config = _config()
    chunk = _chunk(1, "it", CHUNK_IT)
    assert filters.rule_reason(_query(chunk, "termini campione esempio", style="keyword"), CHUNK_IT, config.filters) is None


def test_rule_reason_flags_verbatim_copy_after_shape_and_language():
    config = _config()
    chunk = _chunk(1, "zh", CHUNK_ZH)
    assert filters.rule_reason(_query(chunk, COPY_ZH), CHUNK_ZH, config.filters) == "verbatim_copy"


def test_rule_near_duplicates_within_a_tenant_keep_one_and_across_tenants_keep_both():
    a = _chunk(1, "en", CHUNK_EN)
    b = _chunk(2, "en", CHUNK_EN + " Second copy.")
    c = _chunk(3, "en", CHUNK_EN, tenant=OTHER_TENANT)
    rows = [_query(a, PARA_EN), _query(b, PARA_EN.upper() + "?"), _query(c, PARA_EN)]
    assert filters.near_duplicates(rows) == {1}


def test_rule_near_duplicates_among_one_chunks_queries_keep_the_first_by_style_order():
    chunk = _chunk(1, "en", CHUNK_EN)
    rows = [
        _query(chunk, "so how long is a sample kept after it is made", style="colloquial"),
        _query(chunk, "how long is a sample kept after it is made", style="keyword"),
        _query(chunk, "which records describe the attribute list", style="question"),
    ]
    # colloquial and keyword are near-duplicates; keyword comes first in style order, so colloquial goes
    assert filters.near_duplicates(rows) == {0}


def test_rule_near_duplicates_by_jaccard_only_apply_within_one_chunk():
    a = _chunk(1, "en", CHUNK_EN)
    b = _chunk(2, "en", CHUNK_EN + " Second copy.")
    rows = [
        _query(a, "so how long is a sample kept after it is made"),
        _query(b, "how long is a sample kept after it is made"),
    ]
    assert filters.near_duplicates(rows) == set()


def test_rule_golden_overlap_with_a_fixture_golden_question():
    config = _config()
    questions = load_golden_questions()
    index = GoldenIndex(questions)
    chunk = _chunk(1, "en", CHUNK_EN)
    golden = max(questions, key=len)
    assert filters.golden_reason(_query(chunk, golden), index, config.filters) == "golden_overlap"
    assert filters.golden_reason(_query(chunk, PARA_EN), index, config.filters) is None


# --- judge stage and the filter command -----------------------------------------------------------------------------

CHUNK_EN_2 = "Each neutral record lists three generic attributes for testing purposes."
CHUNK_EN_TEST = "The held out record describes one generic attribute in plain words."
UNANSWERABLE = "which UNANSWERABLE record lists the attributes"
LOW_CONFIDENCE = "which record lists the LOWCONF attributes"
TEST_QUERY = "what does the held out entry talk about"


def _english_golden_question() -> str:
    from rag_eval.finetune.decontam import load_golden_items

    return max((item.question for item in load_golden_items() if item.language == "en"), key=len)


def _judge_rule(seen: list):
    def rule(item):
        seen.append(item.query)
        if "UNANSWERABLE" in item.query:
            return False, 0.95
        if "LOWCONF" in item.query:
            return True, 0.5
        return True, 0.9

    return rule


def _priced(input_price=3.0, output_price=15.0):
    from rag_sidecar.contracts.finetune import TokenPrice

    config = _config()
    prices = config.prices.model_copy(
        update={"judge": TokenPrice(input_usd_per_mtok=input_price, output_usd_per_mtok=output_price)}
    )
    return config.model_copy(update={"prices": prices})


def _filter_bundle(tmp_path):
    en1 = _chunk(1, "en", CHUNK_EN)
    zh1 = _chunk(2, "zh", CHUNK_ZH)
    it1 = _chunk(3, "it", CHUNK_IT)
    en2 = _chunk(4, "en", CHUNK_EN_2)
    test = _chunk(5, "en", CHUNK_EN_TEST, split="test")
    missing = _chunk(99, "en", CHUNK_EN)
    chunks = [en1, zh1, it1, en2, test]
    raw = [
        _query(en1, PARA_EN, style="question"),
        _query(en1, COPY_EN, style="keyword"),
        _query(en1, "x", style="colloquial"),
        _query(zh1, PARA_ZH, style="question"),
        _query(zh1, PARA_ZH + "？", style="colloquial"),
        _query(it1, PARA_IT, style="question"),
        _query(it1, PARA_ZH, style="colloquial", language="it"),
        _query(en2, _english_golden_question(), style="question"),
        _query(en2, UNANSWERABLE, style="colloquial"),
        _query(en2, LOW_CONFIDENCE, style="keyword"),
        _query(missing, "which entry is this about", style="question"),
    ]
    test_raw = [_query(test, TEST_QUERY, style="question")]
    run_dir = bundle.new_run_dir(tmp_path / "out", "run-1")
    files = {
        bundle.CHUNKS_FILE: bundle.write_jsonl(run_dir / bundle.CHUNKS_FILE, chunks, ExportedChunk),
        RAW_FILE: bundle.write_jsonl(run_dir / RAW_FILE, raw, RawSyntheticQuery),
        TEST_RAW_FILE: bundle.write_jsonl(run_dir / TEST_RAW_FILE, test_raw, RawSyntheticQuery),
    }
    bundle.write_manifest(
        run_dir,
        DatasetManifest(
            run_id="run-1",
            purpose="private",
            split_rule="ft-sha256-first8hex-mod100-80-10-10",
            tenant_keys=[TENANT],
            chunks={},
            counts={},
            files=files,
            created_at="2026-11-26T00:00:00Z",
        ),
    )
    sentences = [CHUNK_EN, CHUNK_ZH, CHUNK_IT, CHUNK_EN_2, CHUNK_EN_TEST] + [row.query for row in raw + test_raw if len(row.query) > 1]
    return run_dir, len(raw) + len(test_raw), sentences


def _kept(path):
    return [RawSyntheticQuery.model_validate_json(line) for line in path.read_text().splitlines() if line]


def _fake(seen):
    from finetune_fakes import FakeQueryLLM

    return FakeQueryLLM(judge_rule=_judge_rule(seen))


def test_filter_judge_drops_unanswerable_and_low_confidence_queries(tmp_path):
    run_dir, _, _ = _filter_bundle(tmp_path)
    seen: list = []
    result = filters.run_filter(run_dir, budget_usd=1.0, llm=_fake(seen), config=_priced())
    assert result.exit_code == 0
    assert result.report.dropped["not_answerable"] == 1
    assert result.report.dropped["low_confidence"] == 1


def test_filter_judge_sees_only_queries_that_passed_the_rules(tmp_path):
    run_dir, _, _ = _filter_bundle(tmp_path)
    seen: list = []
    filters.run_filter(run_dir, budget_usd=1.0, llm=_fake(seen), config=_priced())
    assert sorted(seen) == sorted([PARA_EN, PARA_ZH, PARA_IT, UNANSWERABLE, LOW_CONFIDENCE, TEST_QUERY])


def test_filter_report_counts_every_reason_and_language_and_writes_kept_files(tmp_path):
    from rag_sidecar.contracts.finetune import FilterReport

    run_dir, raw_count, _ = _filter_bundle(tmp_path)
    result = filters.run_filter(run_dir, budget_usd=1.0, llm=_fake([]), config=_priced())
    report = FilterReport.model_validate_json((run_dir / filters.REPORT_FILE).read_text())
    assert report == result.report
    assert report.kept + sum(report.dropped.values()) == raw_count
    assert report.dropped == {
        "shape": 1,
        "language": 1,
        "verbatim_copy": 1,
        "near_duplicate": 1,
        "not_answerable": 1,
        "low_confidence": 1,
        "golden_overlap": 1,
        "unknown_chunk_ref": 1,
    }
    assert report.round_trip == "not_applied" and report.judge_skipped is False
    assert report.by_language["zh"].kept == 1 and report.by_language["zh"].dropped == 1
    assert report.by_language["it"].kept == 1 and report.by_language["it"].dropped == 1
    assert report.by_language["en"].kept == 2 and report.by_language["en"].dropped == 6
    assert [r.query for r in _kept(run_dir / filters.KEPT_FILE)] == [PARA_EN, PARA_ZH, PARA_IT]
    assert [r.query for r in _kept(run_dir / filters.TEST_KEPT_FILE)] == [TEST_QUERY]
    manifest = bundle.read_manifest(run_dir)
    assert manifest.files[filters.KEPT_FILE] == bundle.sha256_file(run_dir / filters.KEPT_FILE)
    assert manifest.files[filters.TEST_KEPT_FILE] == bundle.sha256_file(run_dir / filters.TEST_KEPT_FILE)


def test_filter_stdout_and_report_contain_no_query_or_chunk_text(tmp_path, capsys):
    run_dir, _, sentences = _filter_bundle(tmp_path)
    code = filters.main(["--bundle", str(run_dir), "--budget-usd", "1"], llm=_fake([]), config=_priced())
    assert code == 0
    captured = capsys.readouterr()
    report_text = (run_dir / filters.REPORT_FILE).read_text()
    for sentence in sentences:
        assert sentence not in captured.out and sentence not in captured.err and sentence not in report_text


def test_filter_without_budget_and_without_fixture_skip_judge_exits_2(tmp_path, capsys):
    run_dir, _, _ = _filter_bundle(tmp_path)
    fake = _fake([])
    assert filters.main(["--bundle", str(run_dir)], llm=fake, config=_priced()) == 2
    assert filters.main(["--bundle", str(run_dir), "--skip-judge"], llm=fake, config=_priced()) == 2
    assert fake.judge_calls == 0
    assert not (run_dir / filters.REPORT_FILE).exists()
    assert "budget_required" in capsys.readouterr().err


def test_filter_fixture_skip_judge_runs_without_budget_and_records_it(tmp_path):
    run_dir, raw_count, _ = _filter_bundle(tmp_path)
    fake = _fake([])
    assert filters.main(["--bundle", str(run_dir), "--fixture", "--skip-judge"], llm=fake, config=_config()) == 0
    assert fake.judge_calls == 0
    from rag_sidecar.contracts.finetune import FilterReport

    report = FilterReport.model_validate_json((run_dir / filters.REPORT_FILE).read_text())
    assert report.judge_skipped is True
    assert report.dropped["not_answerable"] == 0 and report.dropped["low_confidence"] == 0
    assert report.kept + sum(report.dropped.values()) == raw_count


def test_filter_with_a_budget_but_no_judge_prices_exits_2(tmp_path, capsys):
    run_dir, _, _ = _filter_bundle(tmp_path)
    assert filters.main(["--bundle", str(run_dir), "--budget-usd", "1"], llm=_fake([]), config=_config()) == 2
    assert "prices_unknown" in capsys.readouterr().err


def test_filter_stops_before_the_judge_call_that_exceeds_the_budget_and_resumes_from_the_cache(tmp_path):
    run_dir, _, _ = _filter_bundle(tmp_path)
    fake = _fake([])
    stopped = filters.run_filter(run_dir, budget_usd=0.0, llm=fake, config=_priced())
    assert stopped.exit_code == 5 and fake.judge_calls == 0
    assert not (run_dir / filters.REPORT_FILE).exists() and not (run_dir / filters.KEPT_FILE).exists()
    first = filters.run_filter(run_dir, budget_usd=1.0, llm=fake, config=_priced())
    assert first.exit_code == 0 and fake.judge_calls >= 1
    calls = fake.judge_calls
    again = filters.run_filter(run_dir, budget_usd=1.0, llm=fake, config=_priced())
    assert again.exit_code == 0 and fake.judge_calls == calls
    assert again.report == first.report


def test_filter_dry_run_projects_the_judge_cost_and_writes_nothing(tmp_path, capsys):
    run_dir, _, _ = _filter_bundle(tmp_path)
    fake = _fake([])
    assert filters.main(["--bundle", str(run_dir), "--dry-run"], llm=fake, config=_config()) == 0
    assert fake.judge_calls == 0 and not (run_dir / filters.REPORT_FILE).exists()
    out = capsys.readouterr().out
    assert "judge_items=6" in out and "cost unknown" in out


def test_filter_refuses_a_modified_raw_file(tmp_path, capsys):
    run_dir, _, _ = _filter_bundle(tmp_path)
    with (run_dir / RAW_FILE).open("a", encoding="utf-8") as handle:
        handle.write("\n")
    assert filters.main(["--bundle", str(run_dir), "--budget-usd", "1"], llm=_fake([]), config=_priced()) == 1
    assert "bundle_modified" in capsys.readouterr().err


def test_filter_missing_bundle_exits_2(tmp_path):
    assert filters.main(["--bundle", str(tmp_path / "nope"), "--budget-usd", "1"], llm=_fake([]), config=_priced()) == 2
