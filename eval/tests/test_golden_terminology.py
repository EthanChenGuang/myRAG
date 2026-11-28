"""Colloquial-term golden items (plan 04.1.1-10, D-27, D-28, D-37).

Each term item asks with a variant of the fixture dictionary that occurs nowhere in the fixture corpus, so it can be
answered only through the dictionary; its gold quote holds the variant's canonical inside a synthetic-terms document.
The no_answer term items ask with a variant too, and the corpus holds no answer to them. The language list is the
corpus module's, never a typed-out one (D-35).
"""

import json
import re
import unicodedata

import pytest

from rag_eval.corpus import CORPUS_LANGUAGES, load_corpus
from rag_eval.golden_io import load_golden
from rag_eval.paths import REPO_ROOT

GOLDEN_PATH = REPO_ROOT / "eval/fixtures/golden.jsonl"
CORPUS_DIR = REPO_ROOT / "eval/fixtures/corpus"
DICTIONARY_PATH = REPO_ROOT / "eval/fixtures/terminology/dictionary.jsonl"

TERM_ID = re.compile(r"^(?P<language>[a-z]+(?:-[a-z]+)?)-(?P<kind>colloquial|no_answer)-term-\d{3}$")
SYNTHETIC_DOC = re.compile(r"^synthetic-terms\.[a-z-]+\.md$")
ANSWERABLE_MINIMUM = 4
IDENTIFIER_MINIMUM = 1
NO_ANSWER_MINIMUM = 1


def _normalize(text: str) -> str:
    return " ".join(unicodedata.normalize("NFKC", text).casefold().split())


@pytest.fixture(scope="module")
def entries():
    rows = [json.loads(line) for line in DICTIONARY_PATH.read_text(encoding="utf-8").splitlines() if line.strip()]
    return [row for row in rows if row["kind"] != "translation"]


@pytest.fixture(scope="module")
def corpus_text():
    return _normalize("\n".join(doc.content for doc in load_corpus(CORPUS_DIR)))


@pytest.fixture(scope="module")
def term_items():
    return [item for item in load_golden(GOLDEN_PATH) if TERM_ID.match(item.id)]


def _matched_entries(question: str, entries: list[dict]) -> list[tuple[dict, str]]:
    normalized = _normalize(question)
    return [(entry, variant) for entry in entries for variant in entry["variants"] if _normalize(variant) in normalized]


def test_term_items_are_approved_synthetic_items_of_their_id_category_and_language(term_items):
    for item in term_items:
        match = TERM_ID.match(item.id)
        assert item.language == match.group("language"), item.id
        assert item.category == match.group("kind"), item.id
        assert item.answerable == (match.group("kind") == "colloquial"), item.id
        assert item.provenance == "synthetic_fixture", item.id
        assert item.review_status == "approved", item.id


def test_every_term_item_asks_with_a_dictionary_variant_that_occurs_nowhere_in_the_corpus(term_items, entries, corpus_text):
    for item in term_items:
        matched = _matched_entries(item.question, entries)
        assert matched, f"{item.id}: the question holds no dictionary variant"
        for _entry, variant in matched:
            assert _normalize(variant) not in corpus_text, f"{item.id}: variant {variant!r} occurs in the fixture corpus"


def test_every_answerable_term_item_quotes_its_canonical_from_a_synthetic_terms_document(term_items, entries):
    for item in term_items:
        if not item.answerable:
            continue
        assert item.gold_evidence, item.id
        for span in item.gold_evidence:
            assert SYNTHETIC_DOC.match(span.document), f"{item.id}: gold quote outside a synthetic-terms document"
        quotes = [_normalize(span.quote) for span in item.gold_evidence]
        canonicals = [_normalize(entry["canonical"]) for entry, _variant in _matched_entries(item.question, entries)]
        assert any(canonical in quote for canonical in canonicals for quote in quotes), (
            f"{item.id}: no gold quote holds the canonical of its variant"
        )


def test_no_answer_term_items_carry_no_evidence(term_items):
    for item in term_items:
        if item.answerable:
            continue
        assert item.gold_evidence == [] and item.expected_answer is None, item.id


@pytest.mark.parametrize("language", CORPUS_LANGUAGES)
def test_each_corpus_language_meets_the_term_item_minimums(language, term_items, entries):
    own = [item for item in term_items if item.language == language]
    kinds = [
        {entry["kind"] for entry, _variant in _matched_entries(item.question, entries)}
        for item in own
        if item.answerable
    ]
    answerable = sum(1 for found in kinds if "identifier" not in found)
    identifier = sum(1 for found in kinds if "identifier" in found)
    no_answer = sum(1 for item in own if not item.answerable)
    assert answerable >= ANSWERABLE_MINIMUM, (language, answerable)
    assert identifier >= IDENTIFIER_MINIMUM, (language, identifier)
    assert no_answer >= NO_ANSWER_MINIMUM, (language, no_answer)
