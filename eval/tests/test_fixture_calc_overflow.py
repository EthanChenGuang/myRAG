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
        assert tokens > SMALL_WINDOW_TOKENS, (item.id, tokens)


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


# Fake scripts (Task 2, D-78): fake behaviour is data; the requests compute the items' expected values.


def _number(text):
    return Fraction(text)


def _evaluate(request):
    """A small exact reference for the operations the scripts use (D-67, D-68): Fraction and civil-day arithmetic."""
    values = {}
    for operand in request.operands:
        if operand.values is not None:
            values[operand.name] = [_number(value) for value in operand.values]
        elif re.fullmatch(r"\d{4}-\d{2}-\d{2}", operand.value):
            values[operand.name] = date.fromisoformat(operand.value)
        else:
            values[operand.name] = _number(operand.value)
    for step in request.steps:
        args = [values[name] for name in step.args]
        if step.op == "add":
            result = sum(args, Fraction(0))
        elif step.op == "subtract":
            result = args[0] - args[1]
        elif step.op == "multiply":
            result = Fraction(1)
            for arg in args:
                result *= arg
        elif step.op == "min":
            result = min(args)
        elif step.op == "max":
            result = max(args)
        elif step.op == "sum":
            result = sum(args[0], Fraction(0))
        elif step.op == "cap_each":
            result = [min(value, args[1]) for value in args[0]]
        elif step.op == "percentage":
            result = args[0] * args[1] / 100
        elif step.op == "date_diff":
            assert step.date_unit == "days"
            result = Fraction((args[1] - args[0]).days + (1 if step.inclusive else 0))
        else:
            raise AssertionError(f"operation not used by the scripts: {step.op}")
        values[step.id] = result
    return values[request.result]


def _canonical_numbers(text, language):
    """Numbers written in the text, as Fractions; Italian writes a decimal comma (D-74 number_format)."""
    found = set()
    for raw in NUMBER_RE.findall(text):
        canonical = raw.replace(",", ".") if language == "it" else raw.replace(",", "")
        found.add(Fraction(canonical))
    return found


@pytest.fixture(scope="module")
def scripts():
    assert SCRIPTS_PATH.is_file(), SCRIPTS_PATH
    return json.loads(SCRIPTS_PATH.read_text(encoding="utf-8"))


def _block_text(documents, span):
    doc = documents[span["document"]]
    (chunk,) = [chunk for chunk in doc.chunks if chunk.section == span["section"]]
    assert _fold(span["quote"]) in _fold(chunk.text), span["quote"]
    return chunk.text


def test_every_paraphrase_group_has_exactly_one_script_naming_its_items(scripts, calc_items):
    assert scripts["schema_version"] == 1
    by_group = collections.defaultdict(list)
    for item in calc_items:
        by_group[item.calc.paraphrase_group].append(item)
    groups = {entry["paraphrase_group"]: entry for entry in scripts["groups"]}
    assert len(groups) == len(scripts["groups"])
    assert set(groups) == set(by_group)
    for group, entry in groups.items():
        members = by_group[group]
        assert entry["items"] == [item.id for item in members], group
        assert entry["questions"] == [item.question for item in members], group
        assert {entry["language"]} == {item.language for item in members}, group
        assert entry["expected_value"] == members[0].calc.expected_value and entry["unit"] == members[0].calc.unit, group
        assert f"calc_shape:{entry['rule_shape']}" in members[0].tags, group


def test_scripted_requests_are_valid_and_compute_the_expected_value(scripts, documents, calc_items):
    gold = {item.id: item.gold_evidence for item in calc_items}
    for entry in scripts["groups"]:
        request = CalcRequest.model_validate(entry["request"])
        assert _evaluate(request) == Fraction(entry["expected_value"]), entry["paraphrase_group"]
        aliases = {operand.source.alias for operand in request.operands if operand.source.kind == "chunk"}
        assert aliases and aliases <= set(entry["blocks"]), entry["paraphrase_group"]
        for alias, span in entry["blocks"].items():
            assert any(span == g.model_dump(exclude_none=True) for item_id in entry["items"] for g in gold[item_id])
            block_numbers = _canonical_numbers(_block_text(documents, span), entry["language"])
            for operand in request.operands:
                if operand.source.kind == "chunk" and operand.source.alias == alias:
                    assert Fraction(operand.value) in block_numbers, (entry["paraphrase_group"], operand.name)
        for operand in request.operands:
            if operand.source.kind != "question":
                continue
            for question in entry["questions"]:
                written = operand.values if operand.values is not None else [operand.value]
                for value in written:
                    if re.fullmatch(r"\d{4}-\d{2}-\d{2}", value):
                        assert value in question, (entry["paraphrase_group"], value)
                    else:
                        assert Fraction(value) in _canonical_numbers(question, entry["language"]), (entry["paraphrase_group"], value)


def test_rule_skipping_and_missing_operand_scripts_are_wrong_in_the_scripted_way(scripts, documents):
    for entry in scripts["groups"]:
        group = entry["paraphrase_group"]
        request = CalcRequest.model_validate(entry["request"])
        skip = entry["skip_rule"]
        assert Fraction(skip["stated_value"]) != Fraction(entry["expected_value"]), group
        assert skip["how"].strip(), group
        missing = entry["missing_operand"]
        (operand,) = [operand for operand in request.operands if operand.name == missing["operand"]]
        assert operand.source.kind == "chunk", group
        block_numbers = _canonical_numbers(_block_text(documents, entry["blocks"][operand.source.alias]), entry["language"])
        assert Fraction(missing["cited_value"]) not in block_numbers, group
        assert Fraction(missing["cited_value"]) != Fraction(operand.value), group
        swapped = entry["request"] | {
            "operands": [
                (raw | {"value": missing["cited_value"]}) if raw["name"] == missing["operand"] else raw
                for raw in entry["request"]["operands"]
            ]
        }
        assert _evaluate(CalcRequest.model_validate(swapped)) != Fraction(entry["expected_value"]), group


# Parity and re-baseline (Task 3; Phase 2 D-25, 05.2 D-54, D-62): the baselines recorded before this plan are kept as
# eval/baselines/history/*.pre-05.2.1-12.json; every pre-existing item and every slice holding no new item is unchanged.

BASELINES = REPO_ROOT / "eval/baselines"
PRE_PREFIX = "pre-05.2.1-12"
# Item count and sha256 over the sorted, newline-joined item ids of each baseline before plan 05.2.1-12. Train 38: the ingest
# record before 05.2.1-12 on this line is train 37's, which holds the 83 templated items of plan 03.3-20 (417 + 83).
PRE_ITEM_SETS = {
    "fixture-baseline": (356, "8db17f757861f85c25bf6f004db4769fea880a6640163e8d651e94bc58d45a93"),
    "fixture-ingest-baseline": (500, "97a3b52a3824a763289e52c58419e1c6acf95c0f5f5f15d12b08d02a63b8b29f"),
}
NEW_CATEGORY_SLICES = ("category:multi_step_calc", "category:context_overflow")
# Slices that also hold new items; their pre-existing items are compared one by one.
MIXED_SLICES = ("overall", "language:en", "language:it", "language:zh")
# The one pre-existing item that moved, and only in the ingest tier: its gold chunk (p52-rules-v2.zh.md) and the stale
# version's chunk (p52-rules-v1.zh.md) have exactly the same similarity, the search orders by distance with no
# tie-break, and the larger index returns the tied pair in the other order. No new document is among its candidates.
# It is a test-split item, so no gated slice changes. Pinned so any other movement fails.
TIE_ORDER_FLIPS = {
    "fixture-ingest-baseline": {"zh-stale-version-003": {"mrr": ([1.0] * 3, [0.5] * 3)}},
}


def _baseline(path):
    return json.loads(path.read_text(encoding="utf-8"))


def _previous(name):
    return _baseline(BASELINES / "history" / f"{name}.{PRE_PREFIX}.json")


def test_parity_the_pre_05_2_1_12_baselines_hold_the_pinned_item_sets():
    import hashlib

    for name, (count, digest) in PRE_ITEM_SETS.items():
        items = _previous(name)["items"]
        assert len(items) == count, name
        assert hashlib.sha256("\n".join(sorted(items)).encode("utf-8")).hexdigest() == digest, name


def test_existing_golden_lines_are_unchanged_the_file_only_grows():
    import hashlib

    previous = _previous("fixture-baseline")
    count = PRE_ITEM_SETS["fixture-baseline"][0]
    lines = GOLDEN_PATH.read_bytes().split(b"\n")
    prefix = b"".join(line + b"\n" for line in lines[:count])
    assert hashlib.sha256(prefix).hexdigest() == previous["golden_sha256"]
    added = [json.loads(line) for line in lines[count:] if line.strip()]
    assert added and {row["category"] for row in added} == {"multi_step_calc", "context_overflow"}


@pytest.mark.parametrize("name", sorted(PRE_ITEM_SETS))
def test_rebaseline_pre_existing_items_and_slices_equal_the_previous_baseline(name):
    previous = _previous(name)
    current = _baseline(BASELINES / f"{name}.json")
    assert len(current["runs"]) >= 3
    assert {run["run_id"] for run in current["runs"]}.isdisjoint({run["run_id"] for run in previous["runs"]}), "not re-recorded"
    assert current["corpus_sha256"] != previous["corpus_sha256"] and current["golden_sha256"] != previous["golden_sha256"]
    flips = TIE_ORDER_FLIPS.get(name, {})
    moved = {item_id for item_id in previous["items"] if current["items"][item_id] != previous["items"][item_id]}
    assert moved == set(flips), (name, sorted(moved))
    for item_id, metrics in flips.items():
        for metric, (before, after) in metrics.items():
            assert (previous["items"][item_id][metric], current["items"][item_id][metric]) == (before, after), item_id
        unchanged = {key: value for key, value in previous["items"][item_id].items() if key not in metrics}
        assert {key: current["items"][item_id][key] for key in unchanged} == unchanged, item_id
    for slice_name, metrics in previous["slices"].items():
        if slice_name in MIXED_SLICES:
            continue
        before = {metric: stat["runs"] for metric, stat in metrics.items()}
        after = {metric: stat["runs"] for metric, stat in current["slices"][slice_name].items()}
        assert after == before, (name, slice_name)
    assert all(stat["spread"] == 0.0 for stats in current["slices"].values() for stat in stats.values()), name


@pytest.mark.parametrize("name", sorted(PRE_ITEM_SETS))
def test_rebaseline_holds_the_new_items_and_their_category_slices(name, calc_items, overflow_items):
    current = _baseline(BASELINES / f"{name}.json")
    assert {item.id for item in [*calc_items, *overflow_items]} <= set(current["items"]), name
    for slice_name in NEW_CATEGORY_SLICES:
        assert slice_name in current["slices"], (name, slice_name)
