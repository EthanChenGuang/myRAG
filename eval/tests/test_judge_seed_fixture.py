import collections
import importlib.util
import json
import sys

import pytest
from rag_sidecar.contracts.judge_calibration import JudgeSeedCase

from rag_eval.paths import REPO_ROOT
from rag_eval.review_queue import detect_language, mask_text

SEED_DIR = REPO_ROOT / "eval/fixtures/judge-calibration"
SEED_PATH = SEED_DIR / "seed.jsonl"
GENERATOR_PATH = SEED_DIR / "generate_seed.py"

LANGUAGES = ("zh", "en", "it")
METRICS = ("faithfulness", "answer_relevance")
MIN_BASE_CASES_PER_LANGUAGE = 50
MIN_POSITIVE_SHARE = 0.40
MAX_POSITIVE_SHARE = 0.60
MIN_LENGTH_PAIRS_PER_LANGUAGE = 10
MIN_PERTURBATION_GROUPS_PER_LANGUAGE = 10


def _load_generator():
    spec = importlib.util.spec_from_file_location("judge_seed_generator", GENERATOR_PATH)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


@pytest.fixture(scope="module")
def generator():
    return _load_generator()


@pytest.fixture(scope="module")
def cases() -> list[JudgeSeedCase]:
    lines = [line for line in SEED_PATH.read_text(encoding="utf-8").splitlines() if line.strip()]
    return [JudgeSeedCase.model_validate_json(line) for line in lines]


def _by_language(cases: list[JudgeSeedCase], variant: str | None = None) -> dict[str, list[JudgeSeedCase]]:
    grouped: dict[str, list[JudgeSeedCase]] = collections.defaultdict(list)
    for case in cases:
        if variant is None or case.variant == variant:
            grouped[case.language].append(case)
    return grouped


def test_ids_are_unique(cases):
    ids = [case.id for case in cases]
    assert len(ids) == len(set(ids))


def test_ids_name_their_language(cases):
    for case in cases:
        assert case.id.startswith(f"seed-{case.language}-"), case.id


def test_base_cases_per_language(cases):
    bases = _by_language(cases, "base")
    for lang in LANGUAGES:
        assert len(bases[lang]) >= MIN_BASE_CASES_PER_LANGUAGE, lang


def test_base_cases_are_balanced_per_metric(cases):
    bases = _by_language(cases, "base")
    for lang in LANGUAGES:
        for metric in METRICS:
            labels = [case.expected[metric] for case in bases[lang]]
            share = sum(labels) / len(labels)
            assert MIN_POSITIVE_SHARE <= share <= MAX_POSITIVE_SHARE, (lang, metric, share)


def test_unsupported_flag_matches_faithfulness_label(cases):
    for case in cases:
        assert case.unsupported_content == (not case.expected["faithfulness"]), case.id


def test_variants_name_an_existing_base_with_the_same_labels(cases):
    by_id = {case.id: case for case in cases}
    for case in cases:
        if case.variant == "base":
            continue
        base = by_id.get(case.base_id or "")
        assert base is not None and base.variant == "base", case.id
        assert base.language == case.language
        assert base.question == case.question and base.contexts == case.contexts
        assert base.expected == case.expected and base.unsupported_content == case.unsupported_content


def test_length_pairs(cases):
    pairs: dict[str, list[JudgeSeedCase]] = collections.defaultdict(list)
    for case in cases:
        if case.pair_id is not None:
            pairs[case.pair_id].append(case)
    per_language = collections.Counter()
    for pair_id, members in pairs.items():
        assert sorted(member.variant for member in members) == ["long", "short"], pair_id
        assert len({member.base_id for member in members}) == 1, pair_id
        long_case = next(member for member in members if member.variant == "long")
        short_case = next(member for member in members if member.variant == "short")
        assert len(long_case.answer) > len(short_case.answer), pair_id
        assert all(member.expected["faithfulness"] and member.expected["answer_relevance"] for member in members)
        assert not any(member.unsupported_content for member in members)
        per_language[members[0].language] += 1
    for lang in LANGUAGES:
        assert per_language[lang] >= MIN_LENGTH_PAIRS_PER_LANGUAGE, lang


def test_perturbation_groups(cases):
    by_id = {case.id: case for case in cases}
    groups: dict[str, list[JudgeSeedCase]] = collections.defaultdict(list)
    for case in cases:
        if case.perturbation_group is not None:
            groups[case.perturbation_group].append(case)
    per_language = collections.Counter()
    for group, members in groups.items():
        assert sorted(member.variant for member in members) == ["assertive", "expanded"], group
        base_ids = {member.base_id for member in members}
        assert len(base_ids) == 1 and next(iter(base_ids)) in by_id, group
        per_language[members[0].language] += 1
    for lang in LANGUAGES:
        assert per_language[lang] >= MIN_PERTURBATION_GROUPS_PER_LANGUAGE, lang


def test_masker_leaves_every_text_unchanged(cases):
    for case in cases:
        for text in (case.question, case.answer, *case.contexts):
            assert mask_text(text) == text, case.id


def test_question_language_matches(cases):
    for case in cases:
        assert detect_language(case.question) == case.language, case.id


def test_review_status_follows_the_label_confirmation(cases, generator):
    approved = [case for case in cases if case.review_status == "approved"]
    if generator.LABEL_CONFIRMATION != "confirmed":
        assert approved == []
    for case in approved:
        assert case.reviewed_by is not None, case.id


def test_generator_check_passes(generator):
    assert generator.main(["--check"]) == 0


def test_generator_reproduces_the_committed_file(generator):
    expected = SEED_PATH.read_text(encoding="utf-8")
    assert generator.render(generator.build_cases(), generator._committed_reviews(SEED_PATH)) == expected
    assert generator.build_cases() == generator.build_cases()


def test_generator_never_confirms_a_case(generator):
    assert all(case["review_status"] == "draft" for case in generator.build_cases())
    assert all("reviewed_by" not in case for case in generator.build_cases())


def test_check_carries_human_review_fields_over(generator, tmp_path):
    out = tmp_path / "seed.jsonl"
    reviewed = generator.build_cases()
    first = dict(reviewed[0], review_status="approved", reviewed_by="reviewer.one")
    lines = [json.dumps(first, ensure_ascii=False)] + [json.dumps(case, ensure_ascii=False) for case in reviewed[1:]]
    out.write_text("\n".join(lines) + "\n", encoding="utf-8")
    assert generator.main(["--check", "--out", str(out)]) == 0
    out.write_text("\n".join(lines[1:]) + "\n", encoding="utf-8")
    assert generator.main(["--check", "--out", str(out)]) == 1
