import math
from pathlib import Path

import pytest

from rag_eval import stats
from rag_eval.stats import (
    accuracy,
    bootstrap_interval,
    cohen_kappa,
    jsd_bits,
    largest_remainder,
    permutation_null_p95,
    recall_precision,
)


def _pairs(tp: int, fp: int, fn: int, tn: int) -> list[tuple[bool, bool]]:
    """(judge, human) pairs from a confusion table."""
    return [(True, True)] * tp + [(True, False)] * fp + [(False, True)] * fn + [(False, False)] * tn


def test_cohen_kappa_matches_the_research_formula():
    pairs = _pairs(tp=55, fp=5, fn=5, tn=35)
    assert sum(1 for judge, human in pairs if judge == human) == 90
    expected = (0.9 - 0.52) / 0.48
    assert cohen_kappa(pairs) == pytest.approx(expected)


def test_cohen_kappa_is_undefined_for_empty_and_one_class_samples():
    assert cohen_kappa([]) is None
    assert cohen_kappa([(True, True)] * 10) is None
    assert cohen_kappa([(False, False)] * 10) is None


def test_cohen_kappa_of_perfect_disagreement_is_negative():
    assert cohen_kappa(_pairs(tp=0, fp=50, fn=50, tn=0)) == pytest.approx(-1.0)


def test_accuracy():
    assert accuracy(_pairs(tp=3, fp=1, fn=0, tn=6)) == pytest.approx(0.9)
    assert accuracy([]) is None


def test_recall_precision_hand_values():
    recall, precision = recall_precision(_pairs(tp=6, fp=2, fn=4, tn=8))
    assert recall == pytest.approx(0.6)
    assert precision == pytest.approx(0.75)


def test_recall_precision_with_an_empty_class():
    recall, precision = recall_precision(_pairs(tp=0, fp=3, fn=0, tn=5))
    assert recall is None
    assert precision == 0.0
    recall, precision = recall_precision(_pairs(tp=0, fp=0, fn=2, tn=5))
    assert recall == 0.0
    assert precision is None


def test_jsd_bits_bounds_symmetry_and_zero_shares():
    p = [0.5, 0.5, 0.0]
    q = [0.0, 0.0, 1.0]
    assert jsd_bits(p, p) == pytest.approx(0.0)
    assert jsd_bits(p, q) == pytest.approx(1.0)
    a = [0.7, 0.2, 0.1]
    b = [0.1, 0.3, 0.6]
    assert jsd_bits(a, b) == pytest.approx(jsd_bits(b, a))
    assert 0 < jsd_bits(a, b) < 1


def test_jsd_bits_hand_value_and_mapping_input():
    m = [0.75, 0.25]
    h = lambda xs: -sum(x * math.log2(x) for x in xs if x > 0)  # noqa: E731
    expected = h(m) - (h([1.0, 0.0]) + h([0.5, 0.5])) / 2
    assert jsd_bits([1.0, 0.0], [0.5, 0.5]) == pytest.approx(expected)
    assert jsd_bits({"a": 1.0}, {"a": 0.5, "b": 0.5}) == pytest.approx(expected)


def test_jsd_bits_rejects_lists_of_different_length():
    with pytest.raises(ValueError):
        jsd_bits([0.5, 0.5], [1.0])


def test_largest_remainder_hand_example():
    quotas = largest_remainder({"a": 0.5, "b": 0.3, "c": 0.2}, 7)
    assert quotas == {"a": 4, "b": 2, "c": 1}
    assert sum(quotas.values()) == 7


def test_largest_remainder_breaks_ties_by_key():
    assert largest_remainder({"b": 0.5, "a": 0.5}, 3) == {"a": 2, "b": 1}


def test_largest_remainder_gives_every_non_empty_stratum_one_seat():
    quotas = largest_remainder({"big": 0.97, "small": 0.02, "tiny": 0.01, "none": 0.0}, 10)
    assert quotas["small"] >= 1 and quotas["tiny"] >= 1
    assert quotas["none"] == 0
    assert sum(quotas.values()) == 10
    without = largest_remainder({"big": 0.97, "small": 0.02, "tiny": 0.01}, 10, minimum_one=False)
    assert without["tiny"] == 0


def test_largest_remainder_drops_the_minimum_lowest_share_first_when_strata_outnumber_the_cap():
    quotas = largest_remainder({"a": 0.4, "b": 0.3, "c": 0.2, "d": 0.1}, 2)
    assert quotas == {"a": 1, "b": 1, "c": 0, "d": 0}


def test_seeded_functions_repeat_for_the_same_seed():
    pairs = _pairs(tp=30, fp=8, fn=6, tn=26)
    first = bootstrap_interval(pairs, cohen_kappa, seed=7, rounds=300)
    assert first == bootstrap_interval(pairs, cohen_kappa, seed=7, rounds=300)
    low, high = first
    assert low is not None and high is not None
    assert low <= cohen_kappa(pairs) <= high
    shares = {"a": 0.5, "b": 0.3, "c": 0.2}
    null = permutation_null_p95(shares, 50, seed=11, rounds=300)
    assert null == permutation_null_p95(shares, 50, seed=11, rounds=300)
    assert 0 < null < 1


def test_bootstrap_interval_of_an_empty_sample_is_unknown():
    assert bootstrap_interval([], cohen_kappa, seed=1, rounds=10) == (None, None)


def test_module_uses_only_the_standard_library():
    source = Path(stats.__file__).read_text(encoding="utf-8")
    for name in ("import numpy", "import scipy", "import sklearn", "from numpy", "from scipy", "from sklearn"):
        assert name not in source
