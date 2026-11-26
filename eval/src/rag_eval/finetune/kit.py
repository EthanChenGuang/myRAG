"""python -m rag_eval.finetune kit: a test-free training kit from a mined bundle (FT-07; D-10, D-16). Stub."""

from pathlib import Path

KIT_MANIFEST_FILE = "kit-manifest.json"
TRAINING_CONFIG_FILE = "training-config.json"
DEV_CORPUS_FILE = "dev_corpus.jsonl"


class KitRefused(Exception):
    def __init__(self, code: str, exit_code: int = 2):
        super().__init__(code)
        self.code = code
        self.exit_code = exit_code


def config_sha256(config) -> str:
    return ""


def build_kit(run_dir, out, **kwargs) -> Path:
    Path(out).mkdir(parents=True, exist_ok=True)
    return Path(out)


def read_kit_manifest(kit_dir):
    return None


def verify_kit(kit_dir):
    return None


def main(argv=None, **kwargs) -> int:
    return 0
