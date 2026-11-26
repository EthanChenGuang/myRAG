"""Document-level fine-tune split (D-10)."""
from rag_sidecar.contracts.finetune import FINETUNE_SPLIT_RULE

FT_SPLIT_RULE = FINETUNE_SPLIT_RULE


def split_bucket(tenant_key: str, split_key: str) -> int:
    return 0


def assign_document_split(tenant_key, document_id, content_hash=None, *, forced_test=False) -> str:
    return "train"
