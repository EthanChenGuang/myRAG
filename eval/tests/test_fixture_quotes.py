import re

import pytest

from rag_eval.corpus import load_corpus
from rag_eval.golden_io import load_golden
from rag_eval.matching import chunk_matches_span
from rag_eval.paths import REPO_ROOT

CORPUS_DIR = REPO_ROOT / "eval/fixtures/corpus"
GOLDEN_PATH = REPO_ROOT / "eval/fixtures/golden.jsonl"

PRODUCT_SPECS = {"zh": "product-specs.zh.md", "en": "product-specs.en.md", "it": "product-specs.it.md"}
NUMBER_RE = re.compile(r"\d+")


@pytest.fixture(scope="module")
def items():
    return load_golden(GOLDEN_PATH)


@pytest.fixture(scope="module")
def loaded():
    """Every loaded document, generated template copies (04.2-28) included."""
    return load_corpus(CORPUS_DIR)


@pytest.fixture(scope="module")
def documents(loaded):
    return {doc.filename: doc for doc in loaded}


@pytest.fixture(scope="module")
def by_name(loaded):
    """Filename to documents: the versions of one lineage share their filename (04.2-28)."""
    grouped: dict[str, list] = {}
    for doc in loaded:
        grouped.setdefault(doc.filename, []).append(doc)
    return grouped


def test_every_gold_span_matches_a_chunk_of_its_named_document(items, by_name):
    spans = [(item.id, span) for item in items for span in item.gold_evidence]
    assert len(spans) >= 48
    for item_id, span in spans:
        assert span.document in by_name, (item_id, span.document)
        matches = [
            chunk for doc in by_name[span.document] for chunk in doc.chunks if chunk_matches_span(span.document, chunk.text, span)
        ]
        assert matches, (item_id, span.document, span.quote)
        assert all(chunk.section == span.section for chunk in matches), (item_id, span.section)


def test_a_versioned_gold_span_matches_exactly_one_version(items, by_name):
    versioned = 0
    for item in items:
        for span in item.gold_evidence:
            docs = by_name[span.document]
            if len(docs) < 2:
                continue
            versioned += 1
            hits = [doc.version for doc in docs if any(chunk_matches_span(span.document, c.text, span) for c in doc.chunks)]
            assert len(hits) == 1, (item.id, span.quote, hits)
    assert versioned >= 6


def _templates_of(loaded, document: str) -> set[str]:
    return {doc.fixture_dup_template for doc in loaded if doc.filename == document} - {None}


def test_gold_span_does_not_match_chunks_of_other_documents(items, loaded):
    for item in items:
        for span in item.gold_evidence:
            templates = _templates_of(loaded, span.document)
            # Generated copies of one template repeat the same passage by design (D-20); each copy's span names its copy.
            others = [doc for doc in loaded if doc.filename != span.document and doc.fixture_dup_template not in templates]
            for doc in others:
                assert not any(chunk_matches_span(span.document, chunk.text, span) for chunk in doc.chunks), (item.id, doc.relpath)


def test_generated_copy_spans_match_only_copies_of_their_template(items, loaded):
    copies = 0
    for item in items:
        for span in item.gold_evidence:
            templates = _templates_of(loaded, span.document)
            if not templates:
                continue
            copies += 1
            for doc in [doc for doc in loaded if doc.fixture_dup_template not in templates]:
                assert not any(chunk_matches_span(span.document, c.text, span) for c in doc.chunks), (item.id, doc.relpath)
    assert copies >= 9 * 30


def test_no_answer_items_carry_no_spans_and_answerable_ones_carry_at_least_one(items):
    for item in items:
        assert bool(item.gold_evidence) == item.answerable, item.id


def _numbers(text: str) -> set[str]:
    return set(NUMBER_RE.findall(text))


@pytest.mark.parametrize("language", ["zh", "en", "it"])
def test_each_language_quotes_a_number_that_distinguishes_its_near_duplicate_pair(language, items, documents):
    doc = documents[PRODUCT_SPECS[language]]
    first, second = doc.chunks[0], doc.chunks[1]
    assert first.section != second.section
    only_first = _numbers(first.text) - _numbers(second.text)
    only_second = _numbers(second.text) - _numbers(first.text)
    assert only_first and only_second

    found = False
    for item in items:
        if item.language != language:
            continue
        for span in item.gold_evidence:
            if span.document != doc.filename:
                continue
            for chunk, own_numbers in ((first, only_first), (second, only_second)):
                if span.section == chunk.section and chunk_matches_span(doc.filename, chunk.text, span):
                    if _numbers(span.quote) & own_numbers:
                        found = True
    assert found, language
