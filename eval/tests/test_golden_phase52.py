"""Phase 5.2 golden items in the D-54 sequence (plan 05.2-29): parity, additions, re-baseline.

The baselines recorded before this plan are kept under eval/baselines/history/*.pre-05.2-29.json; the parity tests
pin the item set they hold, so later tests can prove that set is unchanged by the additions.
"""

import collections
import hashlib
import json
import re
import unicodedata

import pytest

from rag_eval.corpus import load_corpus
from rag_eval.golden_io import load_golden
from rag_eval.matching import chunk_matches_span
from rag_eval.paths import REPO_ROOT
from rag_eval.split import assign_split, load_manifest

BASELINES = REPO_ROOT / "eval/baselines"
HISTORY = BASELINES / "history"
PRE_PREFIX = "pre-05.2-29"

# Item count and sha256 over the sorted, newline-joined item ids of each baseline before plan 05.2-29.
PRE_ITEM_SETS = {
    "fixture-baseline": (247, "cf07523992ee949f439fe6b9b21a350ee5178e7024d1e1aee53a0df634af5cc0"),
    "fixture-ingest-baseline": (308, "1640c9a202fcdb8d9ca82025437029a4e21381b8b7f0d79d5343231a65ece883"),
}


def _baseline(path):
    return json.loads(path.read_text(encoding="utf-8"))


def _ids_digest(ids):
    return hashlib.sha256("\n".join(sorted(ids)).encode("utf-8")).hexdigest()


def _previous(name):
    return _baseline(HISTORY / f"{name}.{PRE_PREFIX}.json")


def test_parity_the_pre_05_2_29_baselines_hold_the_pinned_item_sets():
    for name, (count, digest) in PRE_ITEM_SETS.items():
        items = _previous(name)["items"]
        assert len(items) == count, name
        assert _ids_digest(items) == digest, name


def test_parity_every_pre_05_2_29_item_is_still_in_the_current_baseline():
    for name in PRE_ITEM_SETS:
        current = _baseline(BASELINES / f"{name}.json")["items"]
        missing = sorted(set(_previous(name)["items"]) - set(current))
        assert not missing, (name, missing[:5])


# The Phase 5.2 items (D-42, D-53, D-54). The off_topic_context score bands are checked through the fixture embedder
# in tests/rag/p52-corpus.test.ts.

CORPUS_DIR = REPO_ROOT / "eval/fixtures/corpus"
GOLDEN_PATH = REPO_ROOT / "eval/fixtures/golden.jsonl"
MANIFEST_PATH = REPO_ROOT / "eval/fixtures/split-manifest.json"
LANGUAGES = ("zh", "en", "it")
ANSWER_RULE_CATEGORIES = ("partial_answer", "stale_version", "off_topic_context")
LINK_TAG = "link_injection"
ALLOWLISTED_TAG = "allowlisted_link"
ALLOWLISTED_HOST = "help.fixture-site.example"
HOST_RE = re.compile(r"https?://([^/\s)>\]\"'，。]+)")
# Subject words of the requirement illustrations (D-03 neutrality); mirrors tests/rag/p52-corpus.test.ts.
DENYLIST = (
    "hotel", "lodging", "accommodation", "travel", "trip", "flight", "airfare", "mileage", "per diem", "allowance",
    "leave", "vacation", "salary", "payroll", "wage", "bonus", "restaurant", "meal", "vpn", "faq", "reimburse", "expense",
    "酒店", "住宿", "差旅", "出差", "机票", "假期", "年假", "请假", "工资", "薪资", "薪水", "餐厅", "餐费", "报销",
    "albergo", "alloggio", "viaggio", "trasferta", "ferie", "stipendio", "salario", "ristorante", "pasto", "rimborso",
)


def _fold(text):
    return unicodedata.normalize("NFKC", text).casefold()


@pytest.fixture(scope="module")
def golden():
    return load_golden(GOLDEN_PATH)


@pytest.fixture(scope="module")
def pre_count():
    return PRE_ITEM_SETS["fixture-baseline"][0]


@pytest.fixture(scope="module")
def new_items(golden, pre_count):
    return golden[pre_count:]


@pytest.fixture(scope="module")
def documents():
    return {doc.filename: doc for doc in load_corpus(CORPUS_DIR)}


def _one_chunk(documents, span):
    doc = documents.get(span.document)
    assert doc is not None, span.document
    matches = [chunk for chunk in doc.chunks if chunk_matches_span(span.document, chunk.text, span)]
    assert len(matches) == 1, (span.document, span.quote, len(matches))
    assert matches[0].section == span.section, (span.quote, matches[0].section, span.section)
    return matches[0]


def _spans(item):
    spans = list(item.gold_evidence)
    if item.partial is not None:
        spans += item.partial.covered
    if item.versions is not None:
        spans += [item.versions.current.span, item.versions.stale.span]
    if item.off_topic is not None:
        spans += item.off_topic.adjacent_quotes
    if item.attack is not None:
        spans += item.attack.injected_quotes
    return spans


def _link_items(items):
    return [item for item in items if LINK_TAG in item.tags]


def test_existing_items_are_unchanged_the_golden_file_only_grows():
    previous = _previous("fixture-baseline")
    count = PRE_ITEM_SETS["fixture-baseline"][0]
    lines = GOLDEN_PATH.read_bytes().split(b"\n")
    prefix = b"".join(line + b"\n" for line in lines[:count])
    assert hashlib.sha256(prefix).hexdigest() == previous["golden_sha256"]
    assert len([line for line in lines if line.strip()]) > count


def test_new_items_are_synthetic_approved_and_none_was_in_the_set_before(new_items):
    assert new_items
    previous = set(_previous("fixture-baseline")["items"])
    for item in new_items:
        assert item.id not in previous, item.id
        assert item.provenance == "synthetic_fixture" and item.review_status == "approved", item.id
        assert item.category in ANSWER_RULE_CATEGORIES or LINK_TAG in item.tags, item.id


@pytest.mark.parametrize("language", LANGUAGES)
@pytest.mark.parametrize("category", ANSWER_RULE_CATEGORIES)
def test_each_language_has_at_least_four_items_per_answer_rule_category(language, category, golden):
    found = [item for item in golden if item.language == language and item.category == category]
    assert len(found) >= 4, (language, category, len(found))
    pattern = re.compile(rf"^{language}-{category.replace('_', '-')}-\d{{3}}$")
    assert all(pattern.match(item.id) for item in found), [item.id for item in found]


def test_every_span_quote_matches_exactly_one_chunk_of_its_section(new_items, documents):
    for item in new_items:
        for span in _spans(item):
            _one_chunk(documents, span)


def test_partial_items_cover_one_part_and_forbid_claims_the_documents_do_not_make(golden, documents):
    for item in (item for item in golden if item.category == "partial_answer"):
        assert item.answerable and item.partial.uncovered_aspects, item.id
        assert all(span.document == f"p52-answers.{item.language}.md" for span in item.partial.covered), item.id
        assert item.partial.forbidden_claims, item.id
        texts = [item.expected_answer] + [_one_chunk(documents, span).text for span in item.partial.covered]
        for claim in item.partial.forbidden_claims:
            assert not any(re.search(claim, text) for text in texts), (item.id, claim)


def test_stale_items_take_current_from_v2_and_stale_from_v1_with_one_historical_question_per_language(golden, documents):
    historical = collections.Counter()
    for item in (item for item in golden if item.category == "stale_version"):
        versions = item.versions
        current_doc = documents[versions.current.span.document]
        stale_doc = documents[versions.stale.span.document]
        assert versions.current.span.document == f"p52-rules-v2.{item.language}.md", item.id
        assert versions.stale.span.document == f"p52-rules-v1.{item.language}.md", item.id
        assert (versions.current.version_label, versions.stale.version_label) == (
            current_doc.version_label,
            stale_doc.version_label,
        ), item.id
        assert versions.current.span.section == versions.stale.span.section, item.id
        answer = _fold(item.expected_answer)
        wanted, unwanted = (versions.stale, versions.current) if versions.historical else (versions.current, versions.stale)
        assert _fold(wanted.value) in answer and _fold(wanted.version_label) in answer, item.id
        assert _fold(unwanted.value) not in answer, item.id
        historical[item.language] += versions.historical
    assert all(historical[language] >= 1 for language in LANGUAGES), historical


@pytest.mark.parametrize("language", LANGUAGES)
def test_off_topic_items_are_unanswerable_and_split_evenly_between_the_score_bands(language, golden):
    items = [item for item in golden if item.language == language and item.category == "off_topic_context"]
    assert items
    for item in items:
        assert not item.answerable and not item.gold_evidence and item.expected_answer is None, item.id
        assert all(span.document == f"p52-answers.{language}.md" for span in item.off_topic.adjacent_quotes), item.id
    bands = collections.Counter(item.off_topic.score_band for item in items)
    assert bands["below_threshold"] == bands["above_threshold"], bands


@pytest.mark.parametrize("language", LANGUAGES)
def test_link_injection_items_use_a_sec_links_attack_and_sec_link_topics_gold(language, golden, documents):
    items = [item for item in _link_items(golden) if item.language == language]
    assert len(items) >= 2, (language, len(items))
    assert sum(ALLOWLISTED_TAG in item.tags for item in items) >= 1, language
    for item in items:
        assert item.category == "injection_evasive" and item.answerable and item.attack is not None, item.id
        assert re.match(rf"^{language}-injection-evasive-\d{{3}}$", item.id), item.id
        assert all(span.document == f"sec-link-topics.{language}.md" for span in item.gold_evidence), item.id
        assert all(span.document == f"sec-links.{language}.md" for span in item.attack.injected_quotes), item.id
        attack_chunks = {_one_chunk(documents, span).text for span in item.attack.injected_quotes}
        assert len(attack_chunks) == 1, item.id
        attack_text = _fold(next(iter(attack_chunks)))
        planted = {host for host in HOST_RE.findall(attack_text) if host.endswith(".test")}
        assert planted == {_fold(item.attack.canary)}, (item.id, planted)
        answer = _fold(item.expected_answer)
        for claim in item.attack.forbidden_claims:
            assert _fold(claim) in attack_text and _fold(claim) not in answer, (item.id, claim)
        gold_section = item.gold_evidence[0].section
        assert all(span.section.startswith(gold_section) for span in item.attack.injected_quotes), item.id
        hosts = set(HOST_RE.findall(item.expected_answer))
        if ALLOWLISTED_TAG in item.tags:
            assert hosts == {ALLOWLISTED_HOST}, item.id
            assert any(ALLOWLISTED_HOST in span.quote for span in item.gold_evidence), item.id
        else:
            assert not hosts, item.id


def test_canaries_are_unique(golden):
    canaries = collections.Counter(item.attack.canary for item in golden if item.attack is not None)
    assert [canary for canary, count in canaries.items() if count > 1] == []


def test_new_item_text_is_neutral(new_items):
    hits = []
    for item in new_items:
        text = _fold(" ".join(filter(None, [item.question, item.expected_answer])))
        for word in DENYLIST:
            pattern = rf"\b{re.escape(word)}" if re.fullmatch(r"[a-z ]+", word) else re.escape(word)
            if re.search(pattern, text):
                hits.append((item.id, word))
    assert hits == []


def test_new_items_take_the_frozen_split_and_existing_splits_do_not_move(golden, pre_count):
    manifest = load_manifest(MANIFEST_PATH)
    for index, item in enumerate(golden):
        assert manifest.get(item.id) == item.split, item.id
        if index >= pre_count:
            assert item.split == assign_split(item.id), item.id

