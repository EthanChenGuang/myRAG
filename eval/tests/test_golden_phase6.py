"""Phase 6 query-layer golden items (plan 06-38, D-39, D-41).

Each item carries one Phase 6 tag naming the gate behaviour it exercises. Ids follow the usual
language-category-number rule; the split stays the pure hash split, and ids were chosen only so that every
(kind, language) cell has a dev and a test item. The scripted query-LLM outputs live in
eval/fixtures/query-llm/transforms.json, keyed by the item question (condense, decompose, translate).
"""

import collections
import json
import re
import unicodedata

import pytest

from rag_eval.corpus import load_corpus
from rag_eval.golden_io import load_golden
from rag_eval.paths import REPO_ROOT

GOLDEN_PATH = REPO_ROOT / "eval/fixtures/golden.jsonl"
TRANSFORMS_PATH = REPO_ROOT / "eval/fixtures/query-llm/transforms.json"
LEXICON_PATH = REPO_ROOT / "src/lib/rag/query/rewrite-gate.lexicon.json"
CORPUS_DIR = REPO_ROOT / "eval/fixtures/corpus"

LANGUAGES = ("zh", "en", "it")
FOLLOW_UP_TAGS = ("phase6_protected_followup", "phase6_elliptical", "phase6_relative_time")
COMPOUND_TAG = "phase6_compound"
CROSS_TAG = "phase6_cross_lingual"
PER_LANGUAGE_MINIMUM = 2
CROSS_PER_DIRECTION_MINIMUM = 4
CROSS_DIRECTIONS = (("en", "zh"), ("it", "zh"))
PHASE6_TAGS = (*FOLLOW_UP_TAGS, COMPOUND_TAG, CROSS_TAG)

EXACT_CODE = re.compile(r"[A-Z]+[_-][A-Z0-9_-]+|\b[A-Z]{2,}\d+\b")
CJK = re.compile(r"[一-鿿]+")


def _normalize_query(text: str) -> str:
    return " ".join(unicodedata.normalize("NFC", text).split())


@pytest.fixture(scope="module")
def items():
    return load_golden(GOLDEN_PATH)


@pytest.fixture(scope="module")
def phase6(items):
    return [item for item in items if set(item.tags) & set(PHASE6_TAGS) or item.category == "small_talk"]


@pytest.fixture(scope="module")
def entries():
    table = json.loads(TRANSFORMS_PATH.read_text(encoding="utf-8"))
    grouped = collections.defaultdict(list)
    for entry in table["entries"]:
        grouped[(entry["transform"], _normalize_query(entry["query"]))].append(entry)
    return grouped


@pytest.fixture(scope="module")
def lexicon():
    return json.loads(LEXICON_PATH.read_text(encoding="utf-8"))


def _tagged(items, tag):
    return [item for item in items if tag in item.tags]


def test_each_follow_up_and_compound_kind_has_the_minimum_per_language(items):
    for tag in (*FOLLOW_UP_TAGS, COMPOUND_TAG):
        counts = collections.Counter(item.language for item in _tagged(items, tag))
        for language in LANGUAGES:
            assert counts[language] >= PER_LANGUAGE_MINIMUM, (tag, language)


def test_small_talk_items_per_language(items):
    counts = collections.Counter(item.language for item in items if item.category == "small_talk")
    for language in LANGUAGES:
        assert counts[language] >= PER_LANGUAGE_MINIMUM, language


def test_cross_lingual_en_and_it_to_zh_minimums(items):
    counts = collections.Counter((item.language, item.evidence_language) for item in _tagged(items, CROSS_TAG))
    for direction in CROSS_DIRECTIONS:
        assert counts[direction] >= CROSS_PER_DIRECTION_MINIMUM, direction
    assert set(counts) == set(CROSS_DIRECTIONS)


def test_each_item_has_exactly_one_phase6_kind_and_the_matching_category(phase6):
    expected_category = {
        **{tag: "multi_turn" for tag in FOLLOW_UP_TAGS},
        COMPOUND_TAG: "compound",
        CROSS_TAG: "cross_lingual",
    }
    for item in phase6:
        kinds = [tag for tag in item.tags if tag in PHASE6_TAGS]
        if item.category == "small_talk":
            assert kinds == [], item.id
            continue
        assert len(kinds) == 1, item.id
        assert item.category == expected_category[kinds[0]], item.id


def test_new_items_are_approved_synthetic_fixtures(phase6):
    assert phase6
    for item in phase6:
        assert item.provenance == "synthetic_fixture" and item.review_status == "approved", item.id


def test_every_kind_and_language_cell_has_a_dev_and_a_test_item(items):
    cells = collections.defaultdict(set)
    for item in items:
        for tag in PHASE6_TAGS:
            if tag in item.tags:
                cells[(tag, item.language)].add(item.split)
        if item.category == "small_talk":
            cells[("small_talk", item.language)].add(item.split)
    assert cells
    for cell, splits in cells.items():
        assert splits == {"dev", "test"}, cell


def test_small_talk_items_are_whole_query_greetings_without_evidence(items, lexicon):
    for item in items:
        if item.category != "small_talk":
            continue
        assert not item.answerable and not item.gold_evidence and item.expected_answer is None, item.id
        assert item.conversation == [], item.id
        bare = re.sub(r"[\s!?.,！？。，]+$", "", item.question.strip()).casefold()
        assert bare in {term.casefold() for term in lexicon["small_talk"][item.language]}, item.id


def test_protected_follow_ups_carry_a_code_and_condense_keeps_it(items, entries):
    for item in _tagged(items, "phase6_protected_followup"):
        codes = EXACT_CODE.findall(item.question)
        assert codes, item.id
        condensed = entries[("condense", _normalize_query(item.question))]
        assert condensed, item.id
        for entry in condensed:
            for code in codes:
                assert code in entry["output"]["standalone"], (item.id, code)


def test_relative_time_follow_ups_name_a_relative_period(items, lexicon):
    for item in _tagged(items, "phase6_relative_time"):
        terms = [entry["term"] for entry in lexicon["relative_time"][item.language]]
        lowered = item.question.casefold().replace("’", "'")
        assert any(term.casefold() in lowered for term in terms), item.id


def test_elliptical_follow_ups_use_an_elliptical_marker(items, lexicon):
    for item in _tagged(items, "phase6_elliptical"):
        lowered = item.question.casefold()
        markers = list(lexicon["elliptical"].get(item.language, []))
        markers += lexicon["elliptical_leading"].get(item.language, [])
        by_marker = any(marker.casefold() in lowered for marker in markers)
        by_pattern = item.language == "zh" and any(
            re.search(pattern, item.question) for pattern in lexicon["patterns"]["zh_elliptical"]
        )
        assert by_marker or by_pattern, item.id


def test_every_follow_up_has_a_changed_condense_entry(items, entries):
    for tag in FOLLOW_UP_TAGS:
        for item in _tagged(items, tag):
            assert item.conversation, item.id
            condensed = entries[("condense", _normalize_query(item.question))]
            assert condensed, item.id
            assert all(entry["output"]["unchanged"] is False for entry in condensed), item.id


def test_compound_items_have_three_or_four_parts(items, entries):
    for item in _tagged(items, COMPOUND_TAG):
        decomposed = entries[("decompose", _normalize_query(item.question))]
        assert len(decomposed) == 1, item.id
        parts = decomposed[0]["output"]["questions"]
        assert 3 <= len(parts) <= 4, item.id
        assert len(item.gold_evidence) >= 3, item.id


def _longest_common_cjk_run(a: str, b: str) -> int:
    best = 0
    for run in CJK.findall(a):
        for start in range(len(run)):
            for end in range(start + best + 1, len(run) + 1):
                if run[start:end] in b:
                    best = end - start
                else:
                    break
    return best


def test_cross_lingual_items_ask_about_zh_only_documents_and_translate_to_corpus_terms(items, entries):
    documents = {doc.filename: doc for doc in load_corpus(CORPUS_DIR)}
    for item in _tagged(items, CROSS_TAG):
        assert item.evidence_language == "zh", item.id
        for span in item.gold_evidence:
            assert documents[span.document].language == "zh", item.id
        translated = [entry for entry in entries[("translate", _normalize_query(item.question))]
                      if entry["output"]["target_language"] == "zh"]
        assert translated, item.id
        quotes = "".join(span.quote for span in item.gold_evidence)
        for entry in translated:
            assert _longest_common_cjk_run(entry["output"]["text"], quotes) >= 2, item.id
            for code in EXACT_CODE.findall(item.question):
                assert code in entry["output"]["text"], (item.id, code)


def test_every_new_non_small_talk_item_has_a_transform_entry(phase6, entries):
    keyed = {query for (_transform, query) in entries}
    for item in phase6:
        if item.category == "small_talk":
            continue
        assert _normalize_query(item.question) in keyed, item.id
