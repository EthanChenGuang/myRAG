import collections
import json
import re
from pathlib import Path

import pytest

from rag_eval.corpus import load_corpus
from rag_eval.golden_io import load_golden
from rag_eval.paths import REPO_ROOT
from rag_eval.split import SPLIT_RULE, assign_split, load_manifest

CORPUS_DIR = REPO_ROOT / "eval/fixtures/corpus"
GOLDEN_PATH = REPO_ROOT / "eval/fixtures/golden.jsonl"
MANIFEST_PATH = REPO_ROOT / "eval/fixtures/split-manifest.json"

LANGUAGES = ("zh", "en", "it")
PER_LANGUAGE_CATEGORY = {
    "general": 6,
    "multi_turn": 3,
    "compound": 3,
    "exact_term": 3,
    "table": 3,
    "scanned": 2,
    "no_answer": 4,
}
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


def test_seventy_two_items_twenty_four_per_language(items):
    counts = collections.Counter(item.language for item in items)
    assert len(items) == 72
    assert {language: counts[language] for language in LANGUAGES} == {"zh": 24, "en": 24, "it": 24}


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
