"""Document-level fine-tune split (D-10). There is no pair-level split: a pair takes its positive chunk's document's split."""
import hashlib

from rag_sidecar.contracts.finetune import FINETUNE_SPLIT_RULE, FinetuneSplit

FT_SPLIT_RULE = FINETUNE_SPLIT_RULE


def split_bucket(tenant_key: str, split_key: str) -> int:
    return int(hashlib.sha256(f"{tenant_key}:{split_key}".encode()).hexdigest()[:8], 16) % 100


def assign_document_split(
    tenant_key: str, document_id: str, content_hash: str | None = None, *, forced_test: bool = False
) -> FinetuneSplit:
    """<80 train, 80-89 dev, 90-99 test on sha256(tenant_key:split_key); split_key is the content hash when present (so
    duplicate documents share a split), else the document id. A document holding golden test evidence is forced to test (D-09)."""
    if forced_test:
        return "test"
    bucket = split_bucket(tenant_key, content_hash or document_id)
    if bucket < 80:
        return "train"
    if bucket < 90:
        return "dev"
    return "test"
