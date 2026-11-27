"""Phase 5.2.1 fixture additions (plan 05.2.1-12, D-77, D-78, D-88).

multi_step_calc: per language, a calc-rules document states five independent synthetic rules (per-item cap, threshold,
percentage, tiered rate, date difference), each in its own section with its values in digits; each rule has one
paraphrase group of at least three items that combine values given in the question with that rule and share one
expected value. context_overflow: per language, a long-reference document whose related sections exceed the 4,096-token
window of the small-window fake, at least two ranked_evidence questions over it and at least two long_history items
with eight or more prior turns; each names the evidence that must survive packing by span quote. All content is
synthetic and neutral.
"""

import collections
import json
import re
import unicodedata
from fractions import Fraction
from datetime import date

import pytest
import tiktoken

from rag_eval.corpus import load_corpus
from rag_eval.golden_io import load_golden
from rag_eval.matching import chunk_matches_span
from rag_eval.paths import REPO_ROOT
from rag_eval.split import assign_split, load_manifest
from rag_sidecar.contracts.calc import CalcRequest

CORPUS_DIR = REPO_ROOT / "eval/fixtures/corpus"
GOLDEN_PATH = REPO_ROOT / "eval/fixtures/golden.jsonl"
MANIFEST_PATH = REPO_ROOT / "eval/fixtures/split-manifest.json"
SCRIPTS_PATH = REPO_ROOT / "eval/fixtures/calc-fake-scripts.json"
LANGUAGES = ("zh", "en", "it")
SHAPES = ("cap", "threshold", "percentage", "tiered", "date")
CALC_DOCUMENTS = {language: f"calc-rules.{language}.md" for language in LANGUAGES}
LONG_DOCUMENTS = {language: f"long-reference.{language}.md" for language in LANGUAGES}
NEW_DOCUMENTS = set(CALC_DOCUMENTS.values()) | set(LONG_DOCUMENTS.values())
SMALL_WINDOW_TOKENS = 4096
MIN_LONG_SECTIONS = 8
MIN_PARAPHRASES = 3
MIN_OVERFLOW_PER_LANGUAGE = 4
MIN_LONG_HISTORY_PER_LANGUAGE = 2
MIN_RANKED_PER_LANGUAGE = 2
MIN_HISTORY_TURNS = 8
# Subject words of the requirement illustrations (REQUIREMENTS domain neutrality, D-03); they must never appear in a
# fixture document or item of this plan. Kept here, in the test's own data, and nowhere in the fixtures.
ILLUSTRATION_TERMS = (
    "hotel", "lodging", "accommodation", "travel", "trip", "flight", "airfare", "mileage", "per diem", "allowance",
    "leave", "vacation", "holiday", "salary", "payroll", "wage", "bonus", "restaurant", "meal", "vpn", "password",
    "faq", "reimburse", "expense", "branch", "employee", "invoice", "tax",
    "酒店", "住宿", "差旅", "出差", "机票", "假期", "年假", "请假", "工资", "薪资", "薪水", "餐厅", "餐费", "报销", "密码",
    "分行", "员工", "发票", "税",
    "albergo", "alloggio", "viaggio", "trasferta", "ferie", "stipendio", "salario", "ristorante", "pasto", "rimborso",
    "filiale", "dipendente", "fattura", "tassa",
)
NUMBER_RE = re.compile(r"\d+(?:[.,]\d+)?")


def _fold(text):
    return unicodedata.normalize("NFKC", text).casefold()


def _illustration_hits(text):
    folded = _fold(text)
    hits = []
    for term in ILLUSTRATION_TERMS:
        pattern = rf"\b{re.escape(term)}" if re.fullmatch(r"[a-z ]+", term) else re.escape(term)
        if re.search(pattern, folded):
            hits.append(term)
    return hits


@pytest.fixture(scope="module")
def documents():
    return {doc.filename: doc for doc in load_corpus(CORPUS_DIR)}


@pytest.fixture(scope="module")
def golden():
    return load_golden(GOLDEN_PATH)


@pytest.fixture(scope="module")
def calc_items(golden):
    return [item for item in golden if item.category == "multi_step_calc"]


@pytest.fixture(scope="module")
def overflow_items(golden):
    return [item for item in golden if item.category == "context_overflow"]


@pytest.fixture(scope="module")
def encoder():
    return tiktoken.get_encoding("cl100k_base")


def _item_texts(item):
    return [item.question, item.expected_answer or "", *(turn.content for turn in item.conversation)]


# Documents (Task 1)


@pytest.mark.parametrize("language", LANGUAGES)
def test_calc_rules_document_states_five_rules_each_in_its_own_section_with_digits(language, documents):
    doc = documents.get(CALC_DOCUMENTS[language])
    assert doc is not None, CALC_DOCUMENTS[language]
    assert doc.language == language
    assert len(doc.chunks) == len(SHAPES), [chunk.section for chunk in doc.chunks]
    assert len({chunk.section for chunk in doc.chunks}) == len(SHAPES)
    for chunk in doc.chunks:
        assert NUMBER_RE.search(chunk.text), chunk.section


@pytest.mark.parametrize("language", LANGUAGES)
def test_long_reference_sections_are_related_and_exceed_the_small_window(language, documents, encoder):
    doc = documents.get(LONG_DOCUMENTS[language])
    assert doc is not None, LONG_DOCUMENTS[language]
    assert doc.language == language
    assert len(doc.chunks) >= MIN_LONG_SECTIONS
    total = sum(len(encoder.encode(chunk.text)) for chunk in doc.chunks)
    assert total > 2 * SMALL_WINDOW_TOKENS, total
    # Related: every section names the same sequence. Distinct: each section's title (its marker) is its own.
    titles = [chunk.section for chunk in doc.chunks]
    assert len(set(titles)) == len(titles)
    shared = re.sub(r"\d+.*$", "", titles[0]).strip()
    assert shared and all(chunk.text.count(shared) >= 1 or shared in chunk.section for chunk in doc.chunks), shared
    markers = [re.split(r"[:：]", title)[-1].strip().split()[-1].removeprefix("标记") for title in titles]
    for marker, chunk in zip(markers, doc.chunks):
        holders = [other.section for other in doc.chunks if marker in other.text]
        assert holders == [chunk.section], (marker, holders)


def test_new_documents_carry_no_illustration_term_and_no_contact_data(documents):
    for name in sorted(NEW_DOCUMENTS):
        doc = documents.get(name)
        assert doc is not None, name
        assert _illustration_hits(doc.content) == [], (name, _illustration_hits(doc.content))
        assert "@" not in doc.content and "http" not in doc.content, name


# Items (Task 2)


@pytest.mark.parametrize("language", LANGUAGES)
def test_every_rule_shape_has_a_paraphrase_group_of_three_with_one_expected_value(language, calc_items):
    items = [item for item in calc_items if item.language == language]
    groups = collections.defaultdict(list)
    for item in items:
        groups[item.calc.paraphrase_group].append(item)
    shapes = {}
    for group, members in groups.items():
        assert len(members) >= MIN_PARAPHRASES, (group, len(members))
        assert len({item.calc.expected_value for item in members}) == 1, group
        assert len({item.calc.unit for item in members}) == 1, group
        assert len({item.question for item in members}) == len(members), group
        tags = {tag for item in members for tag in item.tags if tag.startswith("calc_shape:")}
        assert len(tags) == 1, (group, tags)
        shapes[tags.pop().removeprefix("calc_shape:")] = group
    assert set(shapes) == set(SHAPES), (language, sorted(shapes))
    assert len(items) >= len(SHAPES) * MIN_PARAPHRASES


def test_structures_appear_only_on_their_category(golden):
    for item in golden:
        assert (item.calc is not None) == (item.category == "multi_step_calc"), item.id
        assert (item.overflow is not None) == (item.category == "context_overflow"), item.id


def test_calc_items_take_their_rule_from_the_calc_rules_document(calc_items):
    for item in calc_items:
        assert item.answerable and item.calc.tolerance == "0", item.id
        assert [span.document for span in item.gold_evidence] == [CALC_DOCUMENTS[item.language]], item.id
        assert item.calc.expected_value in item.expected_answer, item.id


@pytest.mark.parametrize("language", LANGUAGES)
def test_overflow_items_per_language_with_long_histories(language, overflow_items):
    items = [item for item in overflow_items if item.language == language]
    assert len(items) >= MIN_OVERFLOW_PER_LANGUAGE, len(items)
    kinds = collections.Counter(item.overflow.kind for item in items)
    assert kinds["long_history"] >= MIN_LONG_HISTORY_PER_LANGUAGE, kinds
    assert kinds["ranked_evidence"] >= MIN_RANKED_PER_LANGUAGE, kinds
    for item in items:
        assert item.answerable, item.id
        assert set(item.overflow.must_keep) == set(item.gold_evidence), item.id
        assert all(span.document == LONG_DOCUMENTS[language] for span in item.gold_evidence), item.id
        if item.overflow.kind == "long_history":
            turns = item.conversation
            assert len(turns) >= MIN_HISTORY_TURNS, (item.id, len(turns))
            assert [turn.role for turn in turns] == ["user", "assistant"] * (len(turns) // 2), item.id
        else:
            assert not item.conversation, item.id


def test_long_histories_alone_exceed_the_small_window(overflow_items, encoder):
    for item in (item for item in overflow_items if item.overflow.kind == "long_history"):
        tokens = sum(len(encoder.encode(turn.content)) for turn in item.conversation)
        assert tokens > SMALL_WINDOW_TOKENS // 2, (item.id, tokens)


def test_every_new_span_quote_matches_exactly_one_chunk_of_its_section(calc_items, overflow_items, documents):
    for item in [*calc_items, *overflow_items]:
        for span in item.gold_evidence:
            assert "chunk" not in span.model_dump(), item.id
            matches = [
                (doc.filename, chunk.section)
                for doc in documents.values()
                for chunk in doc.chunks
                if chunk_matches_span(doc.filename, chunk.text, span)
            ]
            assert matches == [(span.document, span.section)], (item.id, span.quote, matches)


def test_new_items_are_synthetic_approved_neutral_and_well_named(calc_items, overflow_items):
    assert calc_items and overflow_items
    for item in [*calc_items, *overflow_items]:
        assert item.provenance == "synthetic_fixture" and item.review_status == "approved", item.id
        assert re.fullmatch(rf"{item.language}-{item.category.replace('_', '-')}-\d{{3}}", item.id), item.id
        hits = [hit for text in _item_texts(item) for hit in _illustration_hits(text)]
        assert hits == [], (item.id, hits)


def test_new_items_take_the_frozen_split(calc_items, overflow_items):
    manifest = load_manifest(MANIFEST_PATH)
    for item in [*calc_items, *overflow_items]:
        assert manifest.get(item.id) == item.split == assign_split(item.id), item.id
