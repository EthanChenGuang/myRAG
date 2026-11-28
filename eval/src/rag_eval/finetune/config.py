from pathlib import Path

from pydantic import ValidationError
from rag_sidecar.contracts.finetune import FinetuneConfig

from rag_eval.paths import REPO_ROOT

DEFAULT_CONFIG_PATH = REPO_ROOT / "eval" / "config" / "finetune.json"


def load_finetune_config(path: Path | None = None) -> FinetuneConfig:
    """Read eval/config/finetune.json (or `path`) as FinetuneConfig; unknown keys fail."""
    target = DEFAULT_CONFIG_PATH if path is None else Path(path)
    try:
        return FinetuneConfig.model_validate_json(target.read_text(encoding="utf-8"))
    except ValidationError as exc:
        raise ValueError(f"{target}: not a valid FinetuneConfig: {exc}") from exc
