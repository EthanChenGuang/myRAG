from pathlib import Path

from rag_eval.paths import REPO_ROOT

DEFAULT_CONFIG_PATH = REPO_ROOT / "eval" / "config" / "finetune.json"


def load_finetune_config(path: Path | None = None):
    return None
