"""Phase 6.2 golden items (plan 06.2-22, D-09, D-15, D-27, D-38).

The items are served from the isolated q62 fixture tenant of plan 06.2-34 (eval/harness/q62-fixtures.mts): every
scoped_compound or glossary item and every no_answer item tagged off_domain. Their gold spans point into
eval/fixtures/q62-corpus, never into the main corpus, so no pre-existing item can move. The scripted query-LLM outputs
(decompositions with per-sub-question scope filters, generic translations that miss the glossary target) live in
eval/fixtures/query-llm/transforms.json.
"""

import collections
import json
import re
import unicodedata

import pytest

from rag_eval.corpus import load_corpus
from rag_eval.golden_io import load_golden
from rag_eval.matching import chunk_matches_span, normalize_text
from rag_eval.paths import REPO_ROOT
from rag_eval.split import assign_split, load_manifest

GOLDEN_PATH = REPO_ROOT / "eval/fixtures/golden.jsonl"
SPLIT_MANIFEST_PATH = REPO_ROOT / "eval/fixtures/split-manifest.json"
TRANSFORMS_PATH = REPO_ROOT / "eval/fixtures/query-llm/transforms.json"
Q62_CORPUS_DIR = REPO_ROOT / "eval/fixtures/q62-corpus"
Q62_MANIFEST_PATH = Q62_CORPUS_DIR / "manifest.json"

LANGUAGES = ("zh", "en", "it")
Q62_CATEGORIES = ("scoped_compound", "glossary", "version_compare")
OFF_DOMAIN_TAG = "off_domain"
PLAN_TAG = "phase62"
MINIMUMS = {"scoped_compound": 3, "glossary": 3, "off_domain": 4}
ADJACENT_DOCUMENT = "q62-adjacent.{language}.md"
DRAFTED_LANGUAGES = ("zh", "it")

# Example domains of the REQUIREMENTS.md neutrality rule (same list as test_golden_phase42.py).
DOMAIN_WORDS = (
    "travel", "lodging", "hotel", "leave day", "vacation", "salary", "salaries", "wage", "payroll", "restaurant",
    "menu", "vpn", "password", "branch", "faq", "expense", "reimburse", "viaggio", "viaggi", "alloggio", "albergo",
    "ferie", "stipendio", "ristorante", "filiale", "rimborso", "trasferta", "差旅", "出差", "住宿", "酒店", "年假",
    "请假", "工资", "薪资", "薪水", "餐厅", "饭店", "密码", "分行", "支行", "报销",
)


def _normalize_query(text: str) -> str:
    return " ".join(unicodedata.normalize("NFC", text).split())


def _is_q62(item) -> bool:
    return item.category in Q62_CATEGORIES or OFF_DOMAIN_TAG in item.tags


@pytest.fixture(scope="module")
def items():
    return load_golden(GOLDEN_PATH)


@pytest.fixture(scope="module")
def q62(items):
    return [item for item in items if _is_q62(item)]


@pytest.fixture(scope="module")
def documents():
    return {doc.filename: doc for doc in load_corpus(Q62_CORPUS_DIR)}


@pytest.fixture(scope="module")
def manifest():
    return json.loads(Q62_MANIFEST_PATH.read_text(encoding="utf-8"))


@pytest.fixture(scope="module")
def entries():
    table = json.loads(TRANSFORMS_PATH.read_text(encoding="utf-8"))
    grouped = collections.defaultdict(list)
    for entry in table["entries"]:
        grouped[(entry["transform"], _normalize_query(entry["query"]))].append(entry)
    return grouped


def _kind(item) -> str:
    return OFF_DOMAIN_TAG if OFF_DOMAIN_TAG in item.tags else item.category


def test_each_kind_reaches_its_minimum_per_language(q62):
    counts = collections.Counter((_kind(item), item.language) for item in q62)
    for kind, minimum in MINIMUMS.items():
        for language in LANGUAGES:
            assert counts[(kind, language)] >= minimum, (kind, language)


def test_no_version_compare_item_yet(q62):
    # version_compare needs the Phase 4.2 version filter; plan 06.2-31 adds those items.
    assert not [item.id for item in q62 if item.category == "version_compare"]


def test_every_item_carries_the_plan_tag_and_only_q62_items_do(items):
    for item in items:
        assert (PLAN_TAG in item.tags) == _is_q62(item), item.id


def test_ids_follow_language_category_number(q62):
    for item in q62:
        assert re.fullmatch(rf"{item.language}-{item.category.replace('_', '-')}-\d{{3}}", item.id), item.id


def test_items_are_approved_synthetic_fixtures(q62):
    for item in q62:
        assert item.provenance == "synthetic_fixture" and item.review_status == "approved", item.id


def test_drafted_zh_and_it_items_wait_for_native_review(q62):
    for item in q62:
        if item.language in DRAFTED_LANGUAGES:
            assert item.native_review is not None, item.id
            assert (item.native_review.origin, item.native_review.status) == ("llm_drafted", "pending"), item.id
        else:
            assert item.native_review is None, item.id


def test_split_entries_exist_and_follow_the_hash_rule(q62):
    assignments = load_manifest(SPLIT_MANIFEST_PATH)
    for item in q62:
        assert assignments.get(item.id) == item.split == assign_split(item.id), item.id


def test_every_kind_and_language_cell_has_a_dev_item(q62):
    cells = collections.defaultdict(set)
    for item in q62:
        cells[(_kind(item), item.language)].add(item.split)
    assert len(cells) == len(MINIMUMS) * len(LANGUAGES)
    for cell, splits in cells.items():
        assert "dev" in splits, cell


def test_gold_spans_are_found_in_a_chunk_of_a_q62_document(q62, documents):
    for item in q62:
        for span in item.gold_evidence:
            assert span.document in documents, (item.id, span.document)
            chunks = documents[span.document].chunks
            assert any(chunk_matches_span(span.document, chunk.text, span) for chunk in chunks), (item.id, span.quote)


def test_scoped_compound_items_have_one_scoped_document_per_sub_question(q62, documents, manifest):
    scoped = manifest["document_scopes"]
    for item in q62:
        if item.category != "scoped_compound":
            continue
        assert item.answerable and len(item.sub_questions) >= 2, item.id
        assert {span for sub in item.sub_questions for span in sub.gold_spans} == set(item.gold_evidence), item.id
        for sub in item.sub_questions:
            for span in sub.gold_spans:
                assert span.document in scoped, (item.id, span.document)
                assert documents[span.document].language == item.language, (item.id, span.document)


def test_scoped_compound_decompositions_name_the_gold_scopes(q62, entries, manifest):
    vocabulary = {(entry["dimension"], entry["value"]) for entry in manifest["vocabulary"]}
    for item in q62:
        if item.category != "scoped_compound":
            continue
        scripted = entries[("decompose", _normalize_query(item.question))]
        assert len(scripted) == 1, item.id
        questions = scripted[0]["output"]["questions"]
        assert len(questions) == len(item.sub_questions), item.id
        for sub, question in zip(item.sub_questions, questions):
            assert question["text"].strip(), item.id
            scopes = question["filter"]["scopes"]
            named = {(dimension, value) for dimension, values in scopes.items() for value in values}
            assert named <= vocabulary, item.id
            gold_scopes = {
                tuple(tag.split(":", 1)) for span in sub.gold_spans for tag in manifest["document_scopes"][span.document]
            }
            assert named == gold_scopes, (item.id, sub.index)


def _glossary_row(manifest, language):
    rows = [row for row in manifest["glossary"] if row["language"] == language]
    assert len(rows) == 1, language
    return rows[0]


def test_glossary_items_depend_on_the_required_translation(q62, documents, manifest):
    for item in q62:
        if item.category != "glossary":
            continue
        row = _glossary_row(manifest, item.language)
        assert item.answerable and item.evidence_language is None, item.id
        assert any(normalize_text(variant) in normalize_text(item.question) for variant in row["variants"]), item.id
        assert normalize_text(row["canonical"]) not in normalize_text(item.question), item.id
        for span in item.gold_evidence:
            assert span.document == f"q62-glossary.{row['target_language']}.md", (item.id, span.document)
            assert documents[span.document].language == row["target_language"], item.id
            assert normalize_text(row["canonical"]) in normalize_text(span.quote), item.id


def test_glossary_translations_are_scripted_generic_and_miss_the_target(q62, entries, manifest):
    kept_source = collections.Counter()
    for item in q62:
        if item.category != "glossary":
            continue
        row = _glossary_row(manifest, item.language)
        scripted = entries[("translate", _normalize_query(item.question))]
        targets = [entry for entry in scripted if entry["output"]["target_language"] == row["target_language"]]
        assert len(targets) == 1, item.id
        text = normalize_text(targets[0]["output"]["text"])
        assert text.strip(), item.id
        assert normalize_text(row["canonical"]) not in text, item.id
        if any(normalize_text(variant) in text for variant in row["variants"]):
            kept_source[item.language] += 1
    # Each language has one script that keeps the source term (enforcement corrects it) and others that translate it
    # generically (enforcement drops the variant as glossary_term_lost).
    for language in LANGUAGES:
        assert kept_source[language] == 1, language


def test_off_domain_items_are_unanswerable_against_an_adjacent_passage(q62, documents):
    for item in q62:
        if OFF_DOMAIN_TAG not in item.tags:
            continue
        assert item.category == "no_answer" and not item.answerable, item.id
        assert not item.gold_evidence and item.expected_answer is None, item.id
        adjacent = ADJACENT_DOCUMENT.format(language=item.language)
        assert adjacent in documents, item.id
        assert f"q62_adjacent:{adjacent}" in item.tags, item.id


def test_no_domain_example_words(q62):
    for item in q62:
        text = json.dumps(item.model_dump(mode="json"), ensure_ascii=False).casefold()
        for word in DOMAIN_WORDS:
            if word.isascii():
                assert not re.search(rf"\b{re.escape(word)}\b", text), (item.id, word)
            else:
                assert word not in text, (item.id, word)
