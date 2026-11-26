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
