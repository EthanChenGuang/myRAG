import hashlib
import re
import uuid

from rag_sidecar.contracts.finetune import FINETUNE_SPLIT_RULE

from rag_eval.finetune import split
from rag_eval.finetune.split import FT_SPLIT_RULE, assign_document_split, split_bucket
from rag_eval.paths import REPO_ROOT

TENANT = "s:default"
HASH = hashlib.sha256(b"neutral synthetic document body").hexdigest()


def test_rule_string_is_the_contract_rule():
    assert FT_SPLIT_RULE == FINETUNE_SPLIT_RULE == "ft-sha256-first8hex-mod100-80-10-10"


def test_bucket_formula():
    key = "00000000-0000-4000-8000-000000000001"
    expected = int(hashlib.sha256(f"{TENANT}:{key}".encode()).hexdigest()[:8], 16) % 100
    assert split_bucket(TENANT, key) == expected


def test_bucket_boundaries(monkeypatch):
    for bucket, expected in [(0, "train"), (79, "train"), (80, "dev"), (89, "dev"), (90, "test"), (99, "test")]:
        monkeypatch.setattr(split, "split_bucket", lambda tenant_key, split_key, b=bucket: b)
        assert assign_document_split(TENANT, "00000000-0000-4000-8000-000000000001") == expected


def test_assignment_is_deterministic_and_tenant_scoped():
    doc = "00000000-0000-4000-8000-000000000002"
    assert assign_document_split(TENANT, doc) == assign_document_split(TENANT, doc)
    keys = [str(uuid.UUID(int=i)) for i in range(400)]
    a = [assign_document_split("o:00000000-0000-4000-8000-0000000000aa", key) for key in keys]
    b = [assign_document_split("o:00000000-0000-4000-8000-0000000000bb", key) for key in keys]
    assert a != b


def test_content_hash_wins_over_document_id():
    first = "00000000-0000-4000-8000-000000000003"
    second = "00000000-0000-4000-8000-000000000004"
    assert assign_document_split(TENANT, first, HASH) == assign_document_split(TENANT, second, HASH)
    bucket = int(hashlib.sha256(f"{TENANT}:{HASH}".encode()).hexdigest()[:8], 16) % 100
    expected = "train" if bucket < 80 else "dev" if bucket < 90 else "test"
    assert assign_document_split(TENANT, first, HASH) == expected


def test_forced_test_overrides_the_bucket():
    keys = [str(uuid.UUID(int=i)) for i in range(200)]
    assert {assign_document_split(TENANT, key, forced_test=True) for key in keys} == {"test"}


def test_shares_within_two_points_of_80_10_10():
    keys = [str(uuid.UUID(int=i + 1)) for i in range(10_000)]
    counts = {"train": 0, "dev": 0, "test": 0}
    for key in keys:
        counts[assign_document_split(TENANT, key)] += 1
    assert abs(counts["train"] / 100 - 80) <= 2
    assert abs(counts["dev"] / 100 - 10) <= 2
    assert abs(counts["test"] / 100 - 10) <= 2


def test_no_pair_level_split_exists():
    package = REPO_ROOT / "eval" / "src" / "rag_eval" / "finetune"
    for path in package.rglob("*.py"):
        assert not re.search(r"assign_pair_split", path.read_text(encoding="utf-8")), path.name
