import collections
import json
import re
from pathlib import Path

import pytest

from rag_eval.corpus import load_corpus
from rag_eval.golden_io import load_golden
from rag_eval.matching import chunk_matches_span
from rag_eval.paths import REPO_ROOT
from rag_eval.split import SPLIT_RULE, assign_split, load_manifest

CORPUS_DIR = REPO_ROOT / "eval/fixtures/corpus"
GOLDEN_PATH = REPO_ROOT / "eval/fixtures/golden.jsonl"
MANIFEST_PATH = REPO_ROOT / "eval/fixtures/split-manifest.json"

LANGUAGES = ("zh", "en", "it")
PAIRS = (("en", "zh"), ("it", "zh"), ("zh", "en"), ("it", "en"), ("zh", "it"), ("en", "it"))
PER_PAIR_MINIMUM = 4
PER_LANGUAGE_CATEGORY = {
    "general": 6,
    "multi_turn": 3,
    "compound": 3,
    "exact_term": 3,
    "table": 3,
    "scanned": 2,
    "no_answer": 4,
    "colloquial": 2,
    "ambiguous": 2,
    "typo": 2,
    "cross_lingual": 8,
    "selective_filter": 4,
}
# Tightest selective_filter in this corpus pins a single document (4–6 chunk rows of 71).
FIXTURE_MAX_SELECTIVE_ROW_SHARE = 6 / 71
RELATIVE_DATE_LATIN = ("today", "yesterday", "last week", "this month", "oggi", "ieri")
RELATIVE_DATE_CJK = ("今天", "昨天", "上周", "本月")


@pytest.fixture(scope="module")
def items():
    return load_golden(GOLDEN_PATH)


def test_corpus_has_thirteen_documents_per_language():
    documents = load_corpus(CORPUS_DIR)
    counts = collections.Counter(doc.language for doc in documents)
    assert len(documents) == 13
    assert (counts["zh"], counts["en"], counts["it"]) == (4, 5, 4)


def test_corpus_has_one_image_caption_document():
    documents = load_corpus(CORPUS_DIR)
    assert [doc.filename for doc in documents if doc.image_url] == ["warehouse-floorplan.png"]


def test_single_language_items_thirty_four_per_language(items):
    single = [item for item in items if item.category != "cross_lingual"]
    counts = collections.Counter(item.language for item in single)
    assert len(single) == 102
    assert {language: counts[language] for language in LANGUAGES} == {"zh": 34, "en": 34, "it": 34}


def test_twenty_four_cross_lingual_items_four_per_pair(items):
    cross = [item for item in items if item.category == "cross_lingual"]
    assert len(items) == 102 + len(cross)
    assert len(cross) == PER_PAIR_MINIMUM * len(PAIRS)
    counts = collections.Counter((item.language, item.evidence_language) for item in cross)
    for pair in PAIRS:
        assert counts[pair] >= PER_PAIR_MINIMUM, pair
    assert set(counts) == set(PAIRS)


def test_every_language_category_cell_has_the_planned_count_and_at_least_two(items):
    cells = collections.Counter((item.language, item.category) for item in items)
    for language in LANGUAGES:
        for category, expected in PER_LANGUAGE_CATEGORY.items():
            assert cells[(language, category)] == expected, (language, category)
            assert cells[(language, category)] >= 2


def test_ids_are_unique_and_follow_language_category_number(items):
    ids = [item.id for item in items]
    assert len(set(ids)) == len(ids)
    for item in items:
        if item.category == "cross_lingual":
            expected = re.compile(rf"^xl-{item.language}-{item.evidence_language}-\d{{2}}$")
        else:
            expected = re.compile(rf"^{item.language}-{item.category.replace('_', '-')}-\d{{3}}$")
        assert expected.match(item.id), item.id


def test_every_item_is_approved_synthetic_fixture_without_chunk_ids(items):
    assert all(item.provenance == "synthetic_fixture" for item in items)
    assert all(item.review_status == "approved" for item in items)
    assert "chunk_id" not in GOLDEN_PATH.read_text(encoding="utf-8")


def test_splits_equal_manifest_and_rule(items):
    manifest = load_manifest(MANIFEST_PATH)
    raw = json.loads(MANIFEST_PATH.read_text(encoding="utf-8"))
    assert raw["rule"] == SPLIT_RULE
    assert set(manifest) == {item.id for item in items}
    for item in items:
        assert manifest[item.id] == item.split == assign_split(item.id), item.id


def test_no_relative_date_phrase_in_questions_or_conversations(items):
    for item in items:
        texts = [item.question, *(turn.content for turn in item.conversation)]
        for text in texts:
            lowered = text.lower()
            for phrase in RELATIVE_DATE_LATIN:
                assert re.search(rf"\b{re.escape(phrase)}\b", lowered) is None, (item.id, phrase)
            for phrase in RELATIVE_DATE_CJK:
                assert phrase not in text, (item.id, phrase)


def test_multi_turn_items_end_on_a_user_question_with_history(items):
    for item in items:
        if item.category == "multi_turn":
            assert item.conversation[0].role == "user"
            assert len(item.conversation) >= 2


def _cross_lingual_items(items):
    found = [item for item in items if item.category == "cross_lingual"]
    assert found, "the fixture golden set has no cross_lingual items"
    return found


def test_every_cross_lingual_item_is_approved_and_answerable(items):
    for item in _cross_lingual_items(items):
        assert item.review_status == "approved" and item.answerable, item.id
        assert item.evidence_language is not None and item.evidence_language != item.language, item.id


def test_gold_document_language_folder_equals_the_evidence_language(items):
    documents = {doc.filename: doc for doc in load_corpus(CORPUS_DIR)}
    for item in _cross_lingual_items(items):
        for span in item.gold_evidence:
            assert span.document in documents, (item.id, span.document)
            assert documents[span.document].language == item.evidence_language, (item.id, span.document)


def test_every_cross_lingual_quote_is_found_in_a_chunk_of_its_document(items):
    documents = {doc.filename: doc for doc in load_corpus(CORPUS_DIR)}
    for item in _cross_lingual_items(items):
        for span in item.gold_evidence:
            assert any(
                chunk_matches_span(span.document, chunk.text, span) for chunk in documents[span.document].chunks
            ), (item.id, span.quote)


_NUMBER = re.compile(r"\d+")
_IDENTIFIER = re.compile(r"[A-Za-z0-9]+(?:[-@.][A-Za-z0-9]+)+")


def _shared_features(text: str) -> set[str]:
    return set(_NUMBER.findall(text)) | {token.casefold() for token in _IDENTIFIER.findall(text)}


def _shares_a_number_or_identifier(item, documents) -> bool:
    chunk_features: set[str] = set()
    for span in item.gold_evidence:
        for chunk in documents[span.document].chunks:
            if chunk_matches_span(span.document, chunk.text, span):
                chunk_features |= _shared_features(chunk.text)
    return bool(_shared_features(item.question) & chunk_features)


def test_each_pair_mixes_number_sharing_and_purely_semantic_questions(items):
    documents = {doc.filename: doc for doc in load_corpus(CORPUS_DIR)}
    for pair in PAIRS:
        members = [item for item in _cross_lingual_items(items) if (item.language, item.evidence_language) == pair]
        sharing = [item.id for item in members if _shares_a_number_or_identifier(item, documents)]
        semantic = [item.id for item in members if not _shares_a_number_or_identifier(item, documents)]
        assert len(sharing) >= 2, (pair, sharing)
        assert len(semantic) >= 2, (pair, semantic)


DOC_ID_CHUNK_ROWS = {
    "4dda7ba2-55f3-4e0f-8cfd-83f2ef597e40": 4,
    "b0f11cff-e756-4458-a963-b53776c9da72": 5,
    "1338762a-94bb-4894-b1a8-4ca497e3f3cc": 6,
}


def _selective_filter_items(items):
    return [item for item in items if item.category == "selective_filter"]


def test_selective_filter_filters_admit_rows_within_fixture_ceiling(items):
    documents = load_corpus(CORPUS_DIR)
    documents_by_filename = {doc.filename: doc for doc in documents}
    total = sum(len(doc.chunks) for doc in documents)
    selective = _selective_filter_items(items)
    assert len(selective) == 12
    for item in selective:
        assert item.retrieval_filters is not None, item.id
        doc_ids = [str(doc_id) for doc_id in item.retrieval_filters.document_ids or []]
        assert doc_ids, item.id
        matched = sum(DOC_ID_CHUNK_ROWS[doc_id] for doc_id in doc_ids)
        assert matched >= 1
        assert matched / total <= FIXTURE_MAX_SELECTIVE_ROW_SHARE, item.id
        for span in item.gold_evidence:
            doc = documents_by_filename[span.document]
            assert any(chunk_matches_span(span.document, chunk.text, span) for chunk in doc.chunks), (item.id, span.quote)


def test_each_pair_gates_on_a_dev_split_that_mixes_both_kinds_of_question(items):
    documents = {doc.filename: doc for doc in load_corpus(CORPUS_DIR)}
    for pair in PAIRS:
        dev = [
            item
            for item in _cross_lingual_items(items)
            if (item.language, item.evidence_language) == pair and item.split == "dev"
        ]
        kinds = {_shares_a_number_or_identifier(item, documents) for item in dev}
        assert kinds == {True, False}, (pair, [item.id for item in dev])
