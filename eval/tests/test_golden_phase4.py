"""Calibration cell minimums for the fixture golden set (plan 04-38, D-18, D-26, D-32, F-20).

Stratification rule: the split of an item is the pure function assign_split(item_id), so new item ids are
chosen by their hash split and by topic only, to fill every (question language, pairing, split) cell the
refusal calibration fits and checks. No run outcome, score or retrieval result is used to pick an id or an
item (A15). Pairing: an answerable item is cross when its evidence_language differs from its question
language; a no-answer item is cross when it carries the cross_language tag.
"""

import collections
import hashlib
import json

import pytest

from rag_eval.corpus import load_corpus
from rag_eval.golden_io import load_golden
from rag_eval.paths import REPO_ROOT
from rag_eval.split import assign_split

CORPUS_DIR = REPO_ROOT / "eval/fixtures/corpus"
GOLDEN_PATH = REPO_ROOT / "eval/fixtures/golden.jsonl"
CALIBRATION_PATH = REPO_ROOT / "eval/config/refusal-calibration.json"

LANGUAGES = ("zh", "en", "it")
PAIRINGS = ("same", "cross")
SPLITS = ("dev", "test")

PRE_EXISTING_COUNT = 126
# Categories added after plan 04-38 (05.1-17 injection items, 06-39 cache pairs); test_golden_injection.py and
# test_golden_phase6.py cover them.
LATER_PHASE_CATEGORIES = frozenset({"injection", "injection_evasive", "small_talk", "cache_paraphrase", "cache_near_miss"})
# Plan 06-38 adds Phase 6 items under these tags (and small_talk); test_golden_phase6.py covers them.
# Plan 04.2-37 adds Phase 4.2 items under the tag phase42; test_golden_phase42.py covers them.
LATER_PHASE_TAGS = frozenset(
    {"phase6_protected_followup", "phase6_elliptical", "phase6_relative_time", "phase6_compound", "phase6_cross_lingual", "phase42"}
)
PRE_EXISTING_SHA256 = "78d15c174a16d1aad33814318f67cf1c9d71530813f80b777fd907e6307618dd"

NEW_NO_ANSWER_IDS = {
    "en": ("en-no-answer-005", "en-no-answer-006", "en-no-answer-007", "en-no-answer-008", "en-no-answer-009", "en-no-answer-010"),
    "it": ("it-no-answer-005", "it-no-answer-006", "it-no-answer-007", "it-no-answer-008", "it-no-answer-009", "it-no-answer-010"),
    "zh": ("zh-no-answer-005", "zh-no-answer-006", "zh-no-answer-007", "zh-no-answer-008", "zh-no-answer-009", "zh-no-answer-010"),
}
NEW_ANSWERABLE_IDS = ("xl-en-it-05", "xl-it-en-05")
NEW_IDS = {item_id for ids in NEW_NO_ANSWER_IDS.values() for item_id in ids} | set(NEW_ANSWERABLE_IDS)

# cross-language near-miss: (language of the document that holds the topic, topic terms found in that
# language's corpus, question-language terms that no corpus document of the question language contains)
CROSS_TOPICS = {
    "en-no-answer-006": ("zh", ("差旅与报销", "报销"), ("business trip", "meal allowance")),
    "en-no-answer-007": ("zh", ("巡检", "违约责任"), ("jurisdiction", "maintenance contract")),
    "en-no-answer-008": ("zh", ("试用期与转正", "试用期"), ("probation", "resign")),
    "en-no-answer-009": ("it", ("scontrino", "carta di credito"), ("receipt", "card brand")),
    "it-no-answer-006": ("en", ("import duties", "customs"), ("dazi", "dogan")),
    "it-no-answer-007": ("en", ("warehouse", "aisle"), ("magazzino",)),
    "it-no-answer-008": ("zh", ("年假", "病假"), ("congedo", "ferie", "dipendent")),
    "it-no-answer-009": ("zh", ("违约责任", "违约金"), ("contratto", "penale")),
    "zh-no-answer-006": ("en", ("import duties", "customs"), ("关税", "海关")),
    "zh-no-answer-007": ("en", ("receiving zone", "dock door"), ("收货区", "叉车", "平面图")),
    "zh-no-answer-008": ("it", ("scontrino", "totali"), ("小票", "优惠券")),
    "zh-no-answer-009": ("en", ("inv-24-00381",), ("inv-24-00381",)),
}
SAME_TOPICS = {
    "en-no-answer-005": "XR-5100",
    "en-no-answer-010": "LV-BC-0011",
    "it-no-answer-005": "VR-700",
    "it-no-answer-010": "VV-RC-0061",
    "zh-no-answer-005": "GT-500",
    "zh-no-answer-010": "GV-WM-0019",
}


@pytest.fixture(scope="module")
def items():
    return load_golden(GOLDEN_PATH)


@pytest.fixture(scope="module")
def minimums():
    config = json.loads(CALIBRATION_PATH.read_text(encoding="utf-8"))
    return config["dev_minimums"]["fixture"], config["holdout_minimums"]["fixture"]


@pytest.fixture(scope="module")
def corpus_text():
    text: dict[str, list[str]] = collections.defaultdict(list)
    for doc in load_corpus(CORPUS_DIR):
        text[doc.language].append("\n".join(chunk.text for chunk in doc.chunks).casefold())
    return text


def _pairing(item) -> str:
    if item.answerable:
        return "cross" if item.evidence_language not in (None, item.language) else "same"
    return "cross" if "cross_language" in item.tags else "same"


def _cells(items):
    cells = collections.Counter()
    for item in items:
        kind = "answerable" if item.answerable else "no_answer"
        cells[(item.language, _pairing(item), item.split, kind)] += 1
    return cells


@pytest.mark.parametrize("language", LANGUAGES)
@pytest.mark.parametrize("pairing", PAIRINGS)
def test_every_calibration_cell_reaches_its_fixture_minimum(language, pairing, items, minimums):
    dev_minimum, holdout_minimum = minimums
    cells = _cells(items)
    assert cells[(language, pairing, "dev", "no_answer")] >= dev_minimum["no_answer"], (language, pairing, "dev no_answer")
    assert cells[(language, pairing, "dev", "answerable")] >= dev_minimum["answerable"], (language, pairing, "dev answerable")
    assert cells[(language, pairing, "test", "no_answer")] >= holdout_minimum["no_answer"], (language, pairing, "test no_answer")
    assert cells[(language, pairing, "test", "answerable")] >= holdout_minimum["answerable"], (language, pairing, "test answerable")


@pytest.mark.parametrize("language", LANGUAGES)
def test_each_language_has_eight_no_answer_items_with_near_misses(language, items):
    no_answer = [item for item in items if item.language == language and not item.answerable]
    cross = [item for item in no_answer if {"near_miss", "cross_language"} <= set(item.tags)]
    same = [item for item in no_answer if "near_miss" in item.tags and "cross_language" not in item.tags]
    assert len(no_answer) >= 8
    assert len(cross) >= 4
    assert len(same) >= 2


def test_english_has_at_least_four_answerable_test_items(items):
    english = [item for item in items if item.language == "en" and item.answerable and item.split == "test"]
    assert len(english) >= 4


def test_new_ids_exist_with_the_planned_shape(items):
    by_id = {item.id: item for item in items}
    assert NEW_IDS <= set(by_id)
    for language, ids in NEW_NO_ANSWER_IDS.items():
        for item_id in ids:
            item = by_id[item_id]
            assert item.language == language and item.category == "no_answer" and not item.answerable
            assert item.provenance == "synthetic_fixture" and item.review_status == "approved"
            assert "near_miss" in item.tags
            assert ("cross_language" in item.tags) == (item_id in CROSS_TOPICS)
    for item_id in NEW_ANSWERABLE_IDS:
        assert by_id[item_id].category == "cross_lingual" and by_id[item_id].answerable


def test_every_new_id_split_equals_assign_split(items):
    for item in items:
        if item.id in NEW_IDS:
            assert item.split == assign_split(item.id), item.id


def test_pre_existing_items_are_byte_identical_and_new_items_only_add():
    lines = [line for line in GOLDEN_PATH.read_text(encoding="utf-8").split("\n") if line.strip()]
    rows = [json.loads(line) for line in lines]
    later = [
        row
        for row in rows
        if row["category"] in LATER_PHASE_CATEGORIES or set(row.get("tags") or ()) & LATER_PHASE_TAGS
    ]
    old = sorted((row for row in rows if row["id"] not in NEW_IDS and row not in later), key=lambda row: row["id"])
    assert len(old) == PRE_EXISTING_COUNT
    payload = "\n".join(json.dumps(row, sort_keys=True, ensure_ascii=False) for row in old)
    assert hashlib.sha256(payload.encode("utf-8")).hexdigest() == PRE_EXISTING_SHA256
    assert len(rows) == PRE_EXISTING_COUNT + len(NEW_IDS) + len(later)


@pytest.mark.parametrize("item_id", sorted(CROSS_TOPICS))
def test_cross_language_near_miss_topic_exists_only_in_another_language(item_id, corpus_text):
    topic_language, topic_terms, absent_terms = CROSS_TOPICS[item_id]
    question_language = item_id.split("-")[0]
    assert topic_language != question_language
    assert any(term.casefold() in doc for term in topic_terms for doc in corpus_text[topic_language]), item_id
    for term in absent_terms:
        assert not any(term.casefold() in doc for doc in corpus_text[question_language]), (item_id, term)


@pytest.mark.parametrize("item_id", sorted(SAME_TOPICS))
def test_same_language_near_miss_names_a_topic_present_in_its_own_language(item_id, items, corpus_text):
    language = item_id.split("-")[0]
    term = SAME_TOPICS[item_id]
    question = next(item.question for item in items if item.id == item_id)
    assert term in question
    assert any(term.casefold() in doc for doc in corpus_text[language]), item_id
