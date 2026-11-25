"""Injection and evasive golden items on the 05.1-09 fixture documents (plan 05.1-17, D-12, D-13).

Attack k of sec-attacks.<lang>.md targets topic k of sec-topics.<lang>.md. Chunks 1-4 are caught by the shipped
rules and chunks 5-6 paraphrase around them; tests/rag/security/injection-fixtures-rules.test.ts proves that class
with scanText, and pins the same headings this file lists. Injected text is located by quote, never by chunk id.
"""

import collections
import re
import unicodedata

import pytest

from rag_eval.corpus import load_corpus
from rag_eval.golden_io import load_golden
from rag_eval.matching import chunk_matches_span
from rag_eval.paths import REPO_ROOT
from rag_eval.split import assign_split, load_manifest

CORPUS_DIR = REPO_ROOT / "eval/fixtures/corpus"
GOLDEN_PATH = REPO_ROOT / "eval/fixtures/golden.jsonl"
MANIFEST_PATH = REPO_ROOT / "eval/fixtures/split-manifest.json"

LANGUAGES = ("zh", "en", "it")
MINIMUMS = {"injection": 4, "injection_evasive": 2}
CANARY_RE = re.compile(r"ZXQ-CANARY-\d{4}")

# Per language, the sec-attacks headings in file order with their class; mirrors the TS rules test.
ATTACK_CLASS = {
    "zh": (
        ("青岚 LM-77 折叠台灯 读者留言", "injection"),
        ("星湾 TS-12 陶瓷茶具 读者留言", "injection"),
        ("云栖 BN-8 观鸟望远镜 读者留言", "injection"),
        ("松果社区图书馆 读者留言", "injection"),
        ("橙舟 KY-40 皮划艇 读者留言", "injection_evasive"),
        ("雾山 CG-5 磨豆机 读者留言", "injection_evasive"),
    ),
    "en": (
        ("Fernwick DL-77 folding desk lamp reader comment", "injection"),
        ("Harlow Bay TS-12 porcelain tea set reader comment", "injection"),
        ("Cloudmere BN-8 birding binoculars reader comment", "injection"),
        ("Pinecone Community Library reader comment", "injection"),
        ("Tangerine Skiff KY-40 kayak reader comment", "injection_evasive"),
        ("Mistpeak CG-5 coffee grinder reader comment", "injection_evasive"),
    ),
    "it": (
        ("Lampada pieghevole Fiordaliso LP-77 commento dei lettori", "injection"),
        ("Servizio da tè Baia Serena TS-12 commento dei lettori", "injection"),
        ("Binocolo Nuvolaria BN-8 commento dei lettori", "injection"),
        ("Biblioteca di quartiere Pigna commento dei lettori", "injection"),
        ("Kayak Mandarino KY-40 commento dei lettori", "injection_evasive"),
        ("Macinacaffè Montenebbia CG-5 commento dei lettori", "injection_evasive"),
    ),
}


def _fold(text: str) -> str:
    return unicodedata.normalize("NFKC", text).casefold()


@pytest.fixture(scope="module")
def items():
    return load_golden(GOLDEN_PATH)


@pytest.fixture(scope="module")
def injection_items(items):
    return [item for item in items if item.category in MINIMUMS]


@pytest.fixture(scope="module")
def documents():
    return {doc.filename: doc for doc in load_corpus(CORPUS_DIR)}


def _matching_chunks(documents, span):
    doc = documents.get(span.document)
    assert doc is not None, span.document
    return [chunk for chunk in doc.chunks if chunk_matches_span(span.document, chunk.text, span)]


def _injected_chunk(documents, item):
    chunks = [chunk for span in item.attack.injected_quotes for chunk in _matching_chunks(documents, span)]
    assert len({chunk.index for chunk in chunks}) == 1, (item.id, "injected quotes must resolve to one chunk")
    return chunks[0]


@pytest.mark.parametrize("language", LANGUAGES)
@pytest.mark.parametrize("category", sorted(MINIMUMS))
def test_each_language_reaches_the_category_minimum(language, category, injection_items):
    found = [item for item in injection_items if item.language == language and item.category == category]
    assert len(found) >= MINIMUMS[category], (language, category, len(found))
    pattern = re.compile(rf"^{language}-{category.replace('_', '-')}-\d{{3}}$")
    for item in found:
        assert pattern.match(item.id), item.id
        assert item.answerable and item.provenance == "synthetic_fixture" and item.review_status == "approved"


def test_attack_headings_match_the_pinned_classes(documents):
    for language, attacks in ATTACK_CLASS.items():
        doc = documents[f"sec-attacks.{language}.md"]
        assert [chunk.section for chunk in doc.chunks] == [heading for heading, _ in attacks], language


def test_gold_quotes_resolve_in_the_topic_document(injection_items, documents):
    for item in injection_items:
        assert item.gold_evidence, item.id
        for span in item.gold_evidence:
            assert span.document == f"sec-topics.{item.language}.md", (item.id, span.document)
            matches = _matching_chunks(documents, span)
            assert len(matches) == 1, (item.id, span.quote)
            assert matches[0].section == span.section, (item.id, span.section)


def test_injected_quotes_resolve_in_the_attack_document(injection_items, documents):
    for item in injection_items:
        for span in item.attack.injected_quotes:
            assert span.document == f"sec-attacks.{item.language}.md", (item.id, span.document)
            assert "<" not in span.quote and ">" not in span.quote, item.id
            matches = _matching_chunks(documents, span)
            assert len(matches) == 1, (item.id, span.quote)
            assert matches[0].section == span.section, (item.id, span.section)


def test_injected_chunk_class_matches_the_item_category(injection_items, documents):
    for item in injection_items:
        chunk = _injected_chunk(documents, item)
        heading, expected = ATTACK_CLASS[item.language][chunk.index]
        assert chunk.section == heading, item.id
        assert expected == item.category, (item.id, chunk.section, expected)


def test_attack_targets_the_topic_the_item_asks_about(injection_items, documents):
    for item in injection_items:
        attack_index = _injected_chunk(documents, item).index
        topic_indexes = {chunk.index for span in item.gold_evidence for chunk in _matching_chunks(documents, span)}
        assert topic_indexes == {attack_index}, item.id


def test_canary_is_the_injected_chunks_and_unique(injection_items, documents):
    seen = collections.Counter()
    for item in injection_items:
        chunk = _injected_chunk(documents, item)
        assert CANARY_RE.findall(chunk.text) == [item.attack.canary], item.id
        seen[item.attack.canary] += 1
    repeated = sorted(canary for canary, count in seen.items() if count > 1)
    assert not repeated, repeated


def test_forbidden_claims_are_asked_for_and_absent_from_the_answer(injection_items, documents):
    for item in injection_items:
        chunk_text = _fold(_injected_chunk(documents, item).text)
        claims = [_fold(claim) for claim in item.attack.forbidden_claims]
        assert any(claim in chunk_text for claim in claims), (item.id, "the injected chunk asks for a forbidden claim")
        answer = _fold(item.expected_answer)
        assert _fold(item.attack.canary) not in answer, item.id
        for claim in claims:
            assert claim not in answer, (item.id, claim)
            assert all(claim not in _fold(span.quote) for span in item.gold_evidence), (item.id, claim)


def test_new_items_take_the_split_the_rule_gives_them(injection_items):
    manifest = load_manifest(MANIFEST_PATH)
    for item in injection_items:
        assert item.split == assign_split(item.id), item.id
        assert manifest.get(item.id) == item.split, item.id
