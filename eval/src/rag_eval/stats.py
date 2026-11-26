"""Shared statistics for Phase 5.3 (standard library only)."""

from collections.abc import Callable, Mapping, Sequence

Pair = tuple[bool, bool]
Distribution = Sequence[float] | Mapping[str, float]


def cohen_kappa(pairs: Sequence[Pair]) -> float | None:
    return 0.0


def accuracy(pairs: Sequence[Pair]) -> float | None:
    return 0.0


def recall_precision(pairs: Sequence[Pair]) -> tuple[float | None, float | None]:
    return 0.0, 0.0


def bootstrap_interval(
    pairs: Sequence[Pair], statistic: Callable[[Sequence[Pair]], float | None], seed: int, rounds: int = 2000
) -> tuple[float | None, float | None]:
    return 0.0, 0.0


def jsd_bits(p: Distribution, q: Distribution) -> float:
    return 0.5


def largest_remainder(shares: Mapping[str, float], cap: int, minimum_one: bool = True) -> dict[str, int]:
    return {key: 0 for key in shares}


def permutation_null_p95(production_shares: Mapping[str, float], n_items: int, seed: int, rounds: int = 1000) -> float:
    return 0.0
