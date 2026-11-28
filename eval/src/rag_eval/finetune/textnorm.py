"""Text normalisation and character n-gram helpers shared by decontamination and the query filters."""
import unicodedata


def normalize(text: str) -> str:
    """NFKC, casefold, then drop whitespace, punctuation and control characters."""
    folded = unicodedata.normalize("NFKC", text).casefold()
    return "".join(ch for ch in folded if unicodedata.category(ch)[0] not in {"P", "Z", "C"} and not ch.isspace())


def char_ngrams(text: str, n: int) -> set[str]:
    if n < 1:
        raise ValueError("n must be >= 1")
    if not text:
        return set()
    if len(text) <= n:
        return {text}
    return {text[i : i + n] for i in range(len(text) - n + 1)}


def jaccard(left: set[str], right: set[str]) -> float:
    union = left | right
    return len(left & right) / len(union) if union else 0.0


def containment(part: set[str], whole: set[str]) -> float:
    """Share of `part`'s n-grams that also occur in `whole`."""
    return len(part & whole) / len(part) if part else 0.0
