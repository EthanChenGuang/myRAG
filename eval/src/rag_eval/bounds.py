from math import comb

_BISECTION_STEPS = 60


def binom_cdf(k: int, n: int, p: float) -> float:
    return sum(comb(n, i) * p**i * (1 - p) ** (n - i) for i in range(k + 1))


def upper_bound(k: int, n: int, alpha: float = 0.05) -> float:
    """Exact one-sided Clopper-Pearson upper bound: the largest p with P(X <= k | n, p) >= alpha."""
    if n < 0 or k < 0 or k > n:
        raise ValueError(f"invalid counts k={k}, n={n}")
    if n == 0 or k == n:
        return 1.0
    lo, hi = k / n, 1.0
    for _ in range(_BISECTION_STEPS):
        mid = (lo + hi) / 2
        if binom_cdf(k, n, mid) > alpha:
            lo = mid
        else:
            hi = mid
    return hi
