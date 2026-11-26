"""Shared statistics for Phase 5.3: agreement, divergence, allocation and seeded null levels.

Standard library only (`math`, `random`). Pairs are (judge, human) verdicts; True is the positive class.
"""

import math
import random
from collections.abc import Callable, Mapping, Sequence

Pair = tuple[bool, bool]
Distribution = Sequence[float] | Mapping[str, float]

DEFAULT_ROUNDS = 2000
LEVEL = 0.95


def cohen_kappa(pairs: Sequence[Pair]) -> float | None:
    """Binary Cohen's kappa; None for an empty sample or when both raters gave one class to every case."""
    n = len(pairs)
    if n == 0:
        return None
    p_o = sum(1 for judge, human in pairs if judge == human) / n
    p_j = sum(1 for judge, _ in pairs if judge) / n
    p_h = sum(1 for _, human in pairs if human) / n
    p_e = p_j * p_h + (1 - p_j) * (1 - p_h)
    if math.isclose(p_e, 1.0):
        return None
    return (p_o - p_e) / (1 - p_e)


def accuracy(pairs: Sequence[Pair]) -> float | None:
    if not pairs:
        return None
    return sum(1 for judge, human in pairs if judge == human) / len(pairs)


def recall_precision(pairs: Sequence[Pair]) -> tuple[float | None, float | None]:
    """(recall, precision) of the judge on the human positive class; None where the denominator is empty."""
    tp = sum(1 for judge, human in pairs if judge and human)
    fp = sum(1 for judge, human in pairs if judge and not human)
    fn = sum(1 for judge, human in pairs if not judge and human)
    recall = tp / (tp + fn) if tp + fn else None
    precision = tp / (tp + fp) if tp + fp else None
    return recall, precision


def _quantile(sorted_values: Sequence[float], q: float) -> float:
    """Nearest-rank quantile of a sorted, non-empty sequence."""
    rank = max(1, math.ceil(q * len(sorted_values)))
    return sorted_values[min(rank, len(sorted_values)) - 1]


def bootstrap_interval(
    pairs: Sequence[Pair],
    statistic: Callable[[Sequence[Pair]], float | None],
    seed: int,
    rounds: int = DEFAULT_ROUNDS,
    level: float = LEVEL,
) -> tuple[float | None, float | None]:
    """Seeded percentile bootstrap; resamples whose statistic is undefined are left out."""
    if not pairs or rounds <= 0:
        return None, None
    rng = random.Random(seed)
    n = len(pairs)
    values: list[float] = []
    for _ in range(rounds):
        value = statistic([pairs[rng.randrange(n)] for _ in range(n)])
        if value is not None:
            values.append(value)
    if not values:
        return None, None
    values.sort()
    tail = (1 - level) / 2
    return _quantile(values, tail), _quantile(values, 1 - tail)


def _aligned(p: Distribution, q: Distribution) -> tuple[list[float], list[float]]:
    if isinstance(p, Mapping) or isinstance(q, Mapping):
        if not (isinstance(p, Mapping) and isinstance(q, Mapping)):
            raise ValueError("both distributions must be mappings or both sequences")
        keys = sorted(set(p) | set(q))
        return [float(p.get(key, 0.0)) for key in keys], [float(q.get(key, 0.0)) for key in keys]
    if len(p) != len(q):
        raise ValueError(f"distributions differ in length: {len(p)} and {len(q)}")
    return [float(value) for value in p], [float(value) for value in q]


def _entropy_bits(values: Sequence[float]) -> float:
    return -math.fsum(value * math.log2(value) for value in values if value > 0)


def jsd_bits(p: Distribution, q: Distribution) -> float:
    """Jensen-Shannon divergence in bits (0 to 1), not its square root; a zero share contributes 0."""
    left, right = _aligned(p, q)
    middle = [(a + b) / 2 for a, b in zip(left, right)]
    value = _entropy_bits(middle) - (_entropy_bits(left) + _entropy_bits(right)) / 2
    return min(1.0, max(0.0, value))


def _normalised(shares: Mapping[str, float]) -> dict[str, float]:
    if any(value < 0 for value in shares.values()):
        raise ValueError("shares must not be negative")
    total = math.fsum(shares.values())
    if total <= 0:
        return {key: 0.0 for key in shares}
    return {key: value / total for key, value in shares.items()}


def largest_remainder(shares: Mapping[str, float], cap: int, minimum_one: bool = True) -> dict[str, int]:
    """Allocate `cap` seats by largest remainder, ties by key.

    With `minimum_one`, every non-empty stratum gets at least one seat while the cap allows; when the non-empty strata
    outnumber the cap, the guarantee is dropped lowest share first.
    """
    if cap < 0:
        raise ValueError("cap must not be negative")
    normal = _normalised(shares)
    ideal = {key: cap * share for key, share in normal.items()}
    quotas = {key: math.floor(value) for key, value in ideal.items()}
    guaranteed: set[str] = set()
    if minimum_one and cap > 0:
        non_empty = sorted((key for key, share in normal.items() if share > 0), key=lambda key: (-normal[key], key))
        guaranteed = set(non_empty[:cap])
    lifted = {key for key in guaranteed if quotas[key] == 0}
    for key in lifted:
        quotas[key] = 1
    remaining = cap - sum(quotas.values()) if any(normal.values()) else 0
    if remaining > 0:
        order = sorted(
            (key for key in quotas if key not in lifted and normal[key] > 0),
            key=lambda key: (-(ideal[key] - math.floor(ideal[key])), key),
        ) or sorted((key for key in quotas if normal[key] > 0), key=lambda key: (-normal[key], key))
        for index in range(remaining):
            quotas[order[index % len(order)]] += 1
    while remaining < 0:
        floor_of = {key: 1 if key in guaranteed else 0 for key in quotas}
        donors = sorted(
            (key for key in quotas if quotas[key] > floor_of[key]),
            key=lambda key: (-(quotas[key] - ideal[key]), key),
        )
        quotas[donors[0]] -= 1
        remaining += 1
    return quotas


def permutation_null_p95(
    production_shares: Mapping[str, float], n_items: int, seed: int, rounds: int = 1000
) -> float:
    """95th percentile of jsd_bits between the production shares and n items drawn from them (seeded)."""
    if n_items <= 0 or rounds <= 0:
        raise ValueError("n_items and rounds must be positive")
    normal = _normalised(production_shares)
    keys = sorted(key for key, share in normal.items() if share > 0)
    if not keys:
        return 0.0
    weights = [normal[key] for key in keys]
    rng = random.Random(seed)
    values: list[float] = []
    for _ in range(rounds):
        counts = dict.fromkeys(keys, 0)
        for key in rng.choices(keys, weights=weights, k=n_items):
            counts[key] += 1
        values.append(jsd_bits(normal, {key: count / n_items for key, count in counts.items()}))
    values.sort()
    return _quantile(values, LEVEL)
