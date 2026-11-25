import hashlib
import subprocess
from pathlib import Path

FLAN_T5_MODEL_ID = "google/flan-t5-base"
FLAN_T5_REVISION = "7bcac572ce56db69c1ea7c8af255c5d7c9672fc2"
FLAN_T5_FILES = ("config.json", "tokenizer.json", "tokenizer_config.json", "special_tokens_map.json", "spiece.model")
HHEM_FILES = ("config.json", "configuration_hhem_v2.py", "modeling_hhem_v2.py", "model.safetensors")
HHEM_SAFETENSORS_SHA256 = "634de18a38cf1e991c1acd0f7a9e0d30f7ea187fba42bb4798f862d3edd31e72"
PINNED_SHA256: dict[str, str] = {}


class BakeError(SystemExit):
    pass


def file_sha256(path: Path) -> str:
    return ""


def offline_load(model_id, **kwargs):
    return None


def bake(*, download=None, sha256=None, load=None) -> None:
    return None


def main(argv=None, **kwargs) -> int:
    return 0
