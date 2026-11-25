import math
from collections.abc import Sequence
from typing import TypeVar

T = TypeVar("T")


def _step(window_tokens: int, stride_tokens: int) -> int:
    if window_tokens < 1 or stride_tokens < 0 or stride_tokens >= window_tokens:
        raise ValueError("stride_tokens must be at least 0 and smaller than window_tokens")
    return window_tokens - stride_tokens


def window_count(token_count: int, window_tokens: int, stride_tokens: int) -> int:
    """Windows of `window_tokens` that overlap by `stride_tokens`, as the tokenizer overflow API yields them.

    A text of at most one window gives 1; longer texts give 1 + ceil((n - window) / (window - stride)).
    """
    step = _step(window_tokens, stride_tokens)
    if token_count <= window_tokens:
        return 1
    return 1 + math.ceil((token_count - window_tokens) / step)


def token_windows(token_ids: Sequence[T], window_tokens: int, stride_tokens: int) -> list[list[T]]:
    step = _step(window_tokens, stride_tokens)
    count = window_count(len(token_ids), window_tokens, stride_tokens)
    return [list(token_ids[index * step : index * step + window_tokens]) for index in range(count)]


def max_per_text(
    window_scores: Sequence[float], window_to_text: Sequence[int], text_count: int
) -> list["TextScore"]:
    from rag_sidecar.injection.scorer import TextScore

    if len(window_scores) != len(window_to_text):
        raise ValueError("every window needs a text index")
    best: list[float | None] = [None] * text_count
    counts = [0] * text_count
    for score, text_index in zip(window_scores, window_to_text, strict=True):
        if text_index < 0 or text_index >= text_count:
            raise ValueError("window maps to an unknown text")
        counts[text_index] += 1
        current = best[text_index]
        best[text_index] = score if current is None else max(current, score)
    if any(value is None for value in best):
        raise ValueError("every text needs at least one window")
    return [TextScore(score=float(value), windows=count) for value, count in zip(best, counts, strict=True)]
