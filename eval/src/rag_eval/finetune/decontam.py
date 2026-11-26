"""Golden decontamination (D-09)."""


def load_golden_questions(paths=None) -> list[str]:
    return []


def golden_overlap(query, golden=None, *, threshold=0.8) -> bool:
    return False


def golden_test_documents(items) -> set[str]:
    return set()


PRIVATE_GOLDEN_PATH = None


def default_golden_paths() -> list:
    return []


def golden_test_document_ids(items) -> set[str]:
    return set()
