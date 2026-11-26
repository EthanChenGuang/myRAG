from rag_eval.paths import REPO_ROOT

FIXTURE_DIR = REPO_ROOT / "eval" / "fixtures"


class LifecycleError(ValueError):
    pass


def build_manifest(set_id, items, previous=None, today=None):
    return None


def verify_manifest(items, manifest):
    return []


def bump(items, manifest, today=None):
    return None


def retire(manifest, item_id, reason, today=None):
    return manifest


def relabel(items, manifest, item_id, today=None):
    return manifest


def stale_scan_fixture(items, manifest, documents, today=None):
    return None, []


def registration_rows(items, resolve):
    return []


def corpus_documents(corpus):
    return {}


def load_manifest(path):
    return None


def load_golden_set(paths):
    return []


def main(argv=None):
    return 0
