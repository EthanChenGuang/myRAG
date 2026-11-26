"""Phase 5.3 fixture additions (plan 05.3-15, D-08, D-54).

implicit_condition: a passage states a rule that depends on a named condition, the question describes the asker's situation
without naming the condition, and the gold span is the rule; at least one item per language describes a situation that does
not meet the condition. Near-miss no-answer items: an adjacent passage in the corpus shares the item's subject and lacks the
asked fact. Composition: at least 10 unanswerable dev items per language in the prechunked set and a no-answer share at or
above the quality-gates minimum per language in both fixture modes.
"""

import collections
import json
import math
import re

import pytest

from rag_eval.corpus import load_corpus
from rag_eval.golden_io import load_golden
from rag_eval.matching import chunk_matches_span
from rag_eval.paths import REPO_ROOT
from rag_eval.split import assign_split, load_manifest

CORPUS_DIR = REPO_ROOT / "eval/fixtures/corpus"
GOLDEN_PATH = REPO_ROOT / "eval/fixtures/golden.jsonl"
INGEST_GOLDEN_PATH = REPO_ROOT / "eval/fixtures/ingest/golden-ingest.jsonl"
SPLIT_MANIFEST_PATH = REPO_ROOT / "eval/fixtures/split-manifest.json"
GOLDEN_MANIFESTS = (REPO_ROOT / "eval/fixtures/golden.manifest.json", REPO_ROOT / "eval/fixtures/ingest/golden-ingest.manifest.json")
QUALITY_GATES_PATH = REPO_ROOT / "eval/config/quality-gates.json"
NOISE_PATH = REPO_ROOT / "eval/config/noise.json"

LANGUAGES = ("zh", "en", "it")
PHASE53_TAG = "phase53_fixture"
CONDITION_TAG = "condition:"
ADJACENT_TAG = "adjacent_document:"
NOT_MET_TAG = "condition_not_met"
IMPLICIT_PER_LANGUAGE = 4
UNANSWERABLE_DEV_MINIMUM = 10
NEW_DOCUMENTS = {
    language: {f"access-rules.{language}.md", f"instrument-catalog.{language}.md"} for language in LANGUAGES
}
# The expected answer of a condition_not_met item says that the rule does not apply.
NOT_APPLY = {"en": "does not apply", "it": "non si applica", "zh": "不适用"}
SUBJECT_CODE = re.compile(r"\b[A-Z]{2}-\d{2,3}\b")
# Per new near-miss item: words of the asked fact that the subject's passage must not contain.
ABSENT_FACT_TERMS = {
    "en-no-answer-011": ("battery life", "hours"),
    "en-no-answer-013": ("gram", "weigh"),
    "en-no-answer-014": ("temperature",),
    "en-no-answer-015": ("price", "euro"),
    "en-no-answer-016": ("cable", "metre"),
    "it-no-answer-012": ("autonomia", "durata"),
    "it-no-answer-014": ("grammi", "pesa"),
    "it-no-answer-015": ("temperatura",),
    "it-no-answer-016": ("prezzo", "euro"),
    "zh-no-answer-011": ("续航", "小时"),
    "zh-no-answer-012": ("克", "重量"),
    "zh-no-answer-015": ("温度",),
    "zh-no-answer-016": ("价格", "元"),
}


@pytest.fixture(scope="module")
def items():
    return load_golden(GOLDEN_PATH)


@pytest.fixture(scope="module")
def ingest_items(items):
    return items + load_golden(INGEST_GOLDEN_PATH)


@pytest.fixture(scope="module")
def documents():
    return {doc.filename: doc for doc in load_corpus(CORPUS_DIR)}


@pytest.fixture(scope="module")
def composition():
    return json.loads(QUALITY_GATES_PATH.read_text(encoding="utf-8"))["composition"]


def _implicit(items, language=None):
    return [item for item in items if item.category == "implicit_condition" and language in (None, item.language)]


def _new_near_misses(items):
    return [item for item in items if not item.answerable and PHASE53_TAG in item.tags]


def _tag_value(item, prefix):
    values = [tag[len(prefix) :] for tag in item.tags if tag.startswith(prefix)]
    assert len(values) == 1, (item.id, prefix, item.tags)
    return values[0]


def _matching_chunks(documents, span):
    return [
        (name, chunk.text)
        for name, doc in documents.items()
        for chunk in doc.chunks
        if chunk_matches_span(name, chunk.text, span)
    ]


@pytest.mark.parametrize("language", LANGUAGES)
def test_each_language_has_four_answerable_implicit_condition_items(language, items):
    implicit = _implicit(items, language)
    assert len(implicit) >= IMPLICIT_PER_LANGUAGE
    for item in implicit:
        assert item.answerable and item.gold_evidence and item.expected_answer, item.id
        assert item.evidence_language in (None, language), item.id
        assert item.provenance == "synthetic_fixture" and item.review_status == "approved", item.id
        assert PHASE53_TAG in item.tags, item.id


@pytest.mark.parametrize("language", LANGUAGES)
def test_each_implicit_gold_quote_matches_exactly_one_chunk_of_a_new_document(language, items, documents):
    for item in _implicit(items, language):
        for span in item.gold_evidence:
            assert span.document in NEW_DOCUMENTS[language], (item.id, span.document)
            assert len(_matching_chunks(documents, span)) == 1, (item.id, span.quote)


@pytest.mark.parametrize("language", LANGUAGES)
def test_the_question_describes_the_situation_without_naming_the_condition(language, items, documents):
    for item in _implicit(items, language):
        condition = _tag_value(item, CONDITION_TAG)
        assert condition.casefold() not in item.question.casefold(), (item.id, condition)
        (_, chunk_text), = _matching_chunks(documents, item.gold_evidence[0])
        assert condition.casefold() in chunk_text.casefold(), (item.id, condition)
        assert condition.casefold() in item.gold_evidence[0].quote.casefold(), (item.id, condition)


@pytest.mark.parametrize("language", LANGUAGES)
def test_at_least_one_item_per_language_does_not_meet_the_condition(language, items):
    not_met = [item for item in _implicit(items, language) if NOT_MET_TAG in item.tags]
    assert not_met, language
    for item in not_met:
        assert NOT_APPLY[language] in item.expected_answer, item.id
        assert _tag_value(item, CONDITION_TAG).casefold() in item.expected_answer.casefold(), item.id
    for item in _implicit(items, language):
        if NOT_MET_TAG not in item.tags:
            assert NOT_APPLY[language] not in item.expected_answer, item.id


def test_every_new_near_miss_item_has_adjacent_context_without_the_asked_fact(items, documents):
    near = _new_near_misses(items)
    assert {item.id for item in near} == set(ABSENT_FACT_TERMS)
    for item in near:
        assert item.category == "no_answer" and "near_miss" in item.tags, item.id
        adjacent = _tag_value(item, ADJACENT_TAG)
        assert adjacent in NEW_DOCUMENTS[item.language], (item.id, adjacent)
        assert documents[adjacent].language == item.language, (item.id, adjacent)
        subjects = SUBJECT_CODE.findall(item.question)
        assert len(subjects) == 1, (item.id, subjects)
        chunks = [chunk.text for chunk in documents[adjacent].chunks if subjects[0] in chunk.text]
        assert len(chunks) == 1, (item.id, subjects[0])
        for term in ABSENT_FACT_TERMS[item.id]:
            assert term.casefold() not in chunks[0].casefold(), (item.id, term)


def test_new_ids_are_frozen_and_follow_the_split_rule(items):
    frozen = load_manifest(SPLIT_MANIFEST_PATH)
    new = [item for item in items if PHASE53_TAG in item.tags]
    assert len(new) == len(_implicit(items)) + len(ABSENT_FACT_TERMS)
    for item in new:
        assert frozen[item.id] == item.split == assign_split(item.id), item.id


@pytest.mark.parametrize("manifest_path", GOLDEN_MANIFESTS, ids=lambda path: path.name)
def test_both_golden_manifests_record_the_new_ids_in_a_bumped_version(manifest_path, items):
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    new = {item.id for item in items if PHASE53_TAG in item.tags}
    assert manifest["version"] >= 2
    added = {item_id for entry in manifest["changelog"] if entry["version"] >= 2 for item_id in entry["added"]}
    assert new <= added
    listed = {entry["id"] for entry in manifest["items"] if entry["status"] == "active"}
    assert new <= listed


def _gated(items, excluded):
    return [item for item in items if item.split == "dev" and item.category not in excluded]


@pytest.mark.parametrize("language", LANGUAGES)
def test_prechunked_dev_split_has_ten_unanswerable_items_per_language(language, items, composition):
    excluded = set(composition["excluded_categories"])
    unanswerable = [item for item in _gated(items, excluded) if item.language == language and not item.answerable]
    assert len(unanswerable) >= UNANSWERABLE_DEV_MINIMUM, (language, len(unanswerable))


@pytest.mark.parametrize("mode", ("prechunked", "ingest"))
@pytest.mark.parametrize("language", LANGUAGES)
def test_no_answer_share_per_language_reaches_the_gate_minimum(mode, language, items, ingest_items, composition):
    excluded = set(composition["excluded_categories"])
    population = items if mode == "prechunked" else ingest_items
    members = [item for item in _gated(population, excluded) if item.language == language]
    no_answer = sum(1 for item in members if not item.answerable)
    assert len(members) >= composition["min_items_per_language"]
    share = no_answer / len(members)
    needed = max(0, math.ceil((composition["no_answer_share_min"] * len(members) - no_answer) / (1 - composition["no_answer_share_min"])))
    assert share >= composition["no_answer_share_min"], (mode, language, no_answer, len(members), f"{needed} more needed")


def test_implicit_condition_is_report_only(items):
    noise = json.loads(NOISE_PATH.read_text(encoding="utf-8"))
    prefixes = noise["gated_slice_prefixes"]
    assert not any("implicit_condition" in prefix for prefix in prefixes)
    assert collections.Counter(item.category for item in items)["implicit_condition"] >= IMPLICIT_PER_LANGUAGE * len(LANGUAGES)
