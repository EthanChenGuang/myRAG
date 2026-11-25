"""Create or update the private Hugging Face Space that runs the sidecar's runtime image.

Run from the repository root:
    HF_TOKEN=<write token> uv run --no-project --with huggingface_hub==1.33.0 python -I rag-sidecar/deploy/huggingface/deploy.py

Uploads only the Space Dockerfile, README, pyproject.toml, uv.lock, src/ and config/, sets the non-secret
variables below, and never touches Space secrets (the owner sets those in the Space settings).
"""

from __future__ import annotations

import argparse
import os
import shutil
import sys
import tempfile
from pathlib import Path

from huggingface_hub import HfApi

SIDECAR = Path(__file__).resolve().parents[2]
HERE = Path(__file__).resolve().parent
DEFAULT_SPACE = "EthanChenGuang/myrag-sidecar"
HARDWARE = "cpu-basic"
VARIABLES = {
    "RAG_INGEST_WORKER": "off",
    "RAG_INGEST_MAINTENANCE": "off",
    "RAG_SIDECAR_PARSE_WORKERS": "1",
    "RAG_INGEST_WORKER_CONCURRENCY": "1",
}
IGNORE = shutil.ignore_patterns("__pycache__", "*.pyc", ".pytest_cache", ".env*", "*.egg-info")


def stage(target: Path) -> None:
    shutil.copy2(HERE / "Dockerfile", target / "Dockerfile")
    shutil.copy2(HERE / "README.md", target / "README.md")
    shutil.copy2(SIDECAR / "pyproject.toml", target / "pyproject.toml")
    shutil.copy2(SIDECAR / "uv.lock", target / "uv.lock")
    shutil.copytree(SIDECAR / "src", target / "src", ignore=IGNORE)
    shutil.copytree(SIDECAR / "config", target / "config", ignore=IGNORE)


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--space", default=DEFAULT_SPACE)
    parser.add_argument("--message", default="Deploy rag-sidecar runtime image")
    args = parser.parse_args()
    token = os.environ.get("HF_TOKEN")
    if not token:
        print("deploy: HF_TOKEN is not set", file=sys.stderr)
        return 2
    api = HfApi(token=token)
    api.create_repo(args.space, repo_type="space", space_sdk="docker", space_hardware=HARDWARE, private=True, exist_ok=True)
    for key, value in VARIABLES.items():
        api.add_space_variable(args.space, key, value)
    with tempfile.TemporaryDirectory(prefix="hf-space-") as tmp:
        root = Path(tmp)
        stage(root)
        api.upload_folder(
            repo_id=args.space,
            repo_type="space",
            folder_path=root,
            commit_message=args.message,
            delete_patterns=["src/**", "config/**"],
        )
    print(f"deploy: uploaded to https://huggingface.co/spaces/{args.space}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
