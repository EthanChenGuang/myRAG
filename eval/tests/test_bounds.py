import pytest

from rag_eval.bounds import binom_cdf, upper_bound


@pytest.mark.parametrize(("n", "expected"), [(13, 0.206), (18, 0.153), (20, 0.139)])
def test_zero_failures_reference_values(n, expected):
    assert round(upper_bound(0, n), 3) == expected


@pytest.mark.parametrize("n", [1, 5, 13, 18, 20, 200])
def test_zero_failures_closed_form(n):
    assert upper_bound(0, n) == pytest.approx(1 - 0.05 ** (1 / n), abs=1e-9)


def test_bound_sits_above_the_point_estimate_and_below_one():
    bound = upper_bound(2, 50)
    assert 2 / 50 < bound < 1


def test_bound_is_monotone_in_failures():
    bounds = [upper_bound(k, 30) for k in range(0, 31)]
    assert bounds == sorted(bounds)
    assert len(set(bounds)) > 1


def test_all_failures_and_no_samples_give_one():
    assert upper_bound(7, 7) == 1.0
    assert upper_bound(0, 0) == 1.0


def test_alpha_tightens_the_bound():
    assert upper_bound(1, 20, alpha=0.10) < upper_bound(1, 20, alpha=0.05)


def test_bound_inverts_the_cdf():
    bound = upper_bound(3, 40)
    assert binom_cdf(3, 40, bound) == pytest.approx(0.05, abs=1e-9)


def test_cdf_sums_to_one_at_n():
    assert binom_cdf(12, 12, 0.37) == pytest.approx(1.0, abs=1e-12)
    assert binom_cdf(0, 5, 0.0) == 1.0


@pytest.mark.parametrize("args", [(-1, 5), (6, 5), (0, -1)])
def test_invalid_counts_are_rejected(args):
    with pytest.raises(ValueError):
        upper_bound(*args)
