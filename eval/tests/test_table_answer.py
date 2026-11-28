import pytest
from rag_sidecar.contracts.golden import TableAnswer

from rag_eval.table_answer import score_table_answer

GOLD = TableAnswer(value="42.5", column="First value (cm)", distractor_values=["17.25"])


@pytest.mark.parametrize(
    "answer",
    [
        "The first value for that row is 42.5.",
        "It reads 42.50 cm.",
        "Il valore è 42,5 centimetri.",
        "The listed amount is $42.5 for the sample.",
        "€ 42,5",
        "数值为４２．５厘米。",
        "42.5",
    ],
)
def test_the_gold_value_in_any_formatting_is_correct(answer: str):
    assert score_table_answer(answer, GOLD) == "correct"


@pytest.mark.parametrize(
    "answer",
    [
        "The first value for that row is 17.25.",
        "",
        "   ",
        "The value is 425.",
        "The value is 4.25.",
        "The value is 142.5.",
        "The value is 42.51.",
        "The table does not say.",
    ],
)
def test_distractor_only_empty_and_substring_lookalikes_are_wrong(answer: str):
    assert score_table_answer(answer, GOLD) == "wrong"


def test_an_answer_naming_both_the_gold_value_and_a_distractor_is_ambiguous():
    assert score_table_answer("The first value is 42.5 and the second value is 17.25.", GOLD) == "ambiguous"
    assert score_table_answer("42,5 oppure 17,25", GOLD) == "ambiguous"


def test_numbers_are_compared_as_decimals_not_substrings():
    gold = TableAnswer(value="2,874", column="Initial thickness (mm)", distractor_values=["2,485"])
    assert score_table_answer("Lo spessore iniziale è 2,874 mm.", gold) == "correct"
    assert score_table_answer("The thickness is 2.874 mm.", gold) == "correct"
    assert score_table_answer("The thickness is 2.8740 mm.", gold) == "correct"
    assert score_table_answer("The thickness is 2874 mm.", gold) == "wrong"
    assert score_table_answer("The thickness is 2,485 mm.", gold) == "wrong"


def test_a_list_of_values_with_a_fullwidth_comma_is_split_into_numbers():
    gold = TableAnswer(value="117.6", column="First height (cm)", distractor_values=["70.9"])
    assert score_table_answer("首测为117.6，复测为70.9", gold) == "ambiguous"
    assert score_table_answer("首测为117.6，单位厘米", gold) == "correct"


def test_row_key_numbers_in_the_answer_are_not_mistaken_for_the_value():
    assert score_table_answer("For sample 07 in week 05 the first value is 42.5.", GOLD) == "correct"
    assert score_table_answer("For sample 42 the first value is 5.", GOLD) == "wrong"


def test_text_values_match_as_whole_words_after_folding():
    gold = TableAnswer(value="rising slowly", column="Trend", distractor_values=["42.5", "17.25", "holding steady"])
    assert score_table_answer("The trend there is Rising Slowly.", gold) == "correct"
    assert score_table_answer("The trend there is holding steady.", gold) == "wrong"
    assert score_table_answer("Rising slowly, then holding steady.", gold) == "ambiguous"
    assert score_table_answer("The trend there is uprising slowlyish.", gold) == "wrong"
    assert score_table_answer("The trend is rising slowly at 42.5.", gold) == "ambiguous"


def test_cjk_text_values_match_inside_a_sentence():
    gold = TableAnswer(value="良好", column="长势", distractor_values=["一般"])
    assert score_table_answer("该行的长势良好。", gold) == "correct"
    assert score_table_answer("该行的长势一般。", gold) == "wrong"


def test_a_distractor_that_differs_only_in_trailing_zeros_is_still_the_distractor():
    gold = TableAnswer(value="340.1", column="Second value (cm)", distractor_values=["306.4"])
    assert score_table_answer("It is 306.40 cm.", gold) == "wrong"
    assert score_table_answer("It is 340.10 cm.", gold) == "correct"


def test_every_fixture_item_scores_its_expected_answer_correct_and_each_distractor_wrong():
    from pathlib import Path

    from rag_sidecar.contracts.golden import GoldenItem

    path = Path(__file__).resolve().parents[1] / "fixtures" / "ingest" / "golden-ingest.jsonl"
    items = [GoldenItem.model_validate_json(line) for line in path.read_text(encoding="utf-8").splitlines() if line.strip()]
    table_items = [item for item in items if item.category == "table_split"]
    assert len(table_items) >= 12
    for item in table_items:
        assert item.table_answer is not None, item.id
        assert score_table_answer(item.expected_answer or "", item.table_answer) == "correct", item.id
        for distractor in item.table_answer.distractor_values:
            assert score_table_answer(f"{distractor}", item.table_answer) == "wrong", (item.id, distractor)
