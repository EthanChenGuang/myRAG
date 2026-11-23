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
def documents():
    return {doc.filename: doc for doc in load_corpus(CORPUS_DIR)}


def test_every_gold_span_matches_a_chunk_of_its_named_document(items, documents):
    spans = [(item.id, span) for item in items for span in item.gold_evidence]
    assert len(spans) >= 48
    for item_id, span in spans:
        assert span.document in documents, (item_id, span.document)
        matches = [
            chunk for chunk in documents[span.document].chunks if chunk_matches_span(span.document, chunk.text, span)
        ]
        assert matches, (item_id, span.document, span.quote)
        assert all(chunk.section == span.section for chunk in matches), (item_id, span.section)


def test_gold_span_does_not_match_chunks_of_other_documents(items, documents):
    for item in items:
        for span in item.gold_evidence:
            for name, doc in documents.items():
                if name == span.document:
                    continue
                assert not any(chunk_matches_span(span.document, chunk.text, span) for chunk in doc.chunks)


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
