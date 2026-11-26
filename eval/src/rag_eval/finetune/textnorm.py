"""Text normalisation and character n-gram helpers shared by decontamination and the query filters."""


def normalize(text: str) -> str:
    return text


def char_ngrams(text: str, n: int) -> set[str]:
    return set()


def jaccard(left: set[str], right: set[str]) -> float:
    return 0.0


def containment(part: set[str], whole: set[str]) -> float:
    return 0.0
