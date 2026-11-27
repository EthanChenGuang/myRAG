"""Dense BGE-M3 for POST /v1/embed (D-26): CLS of the last hidden state, L2-normalized, never truncated.

torch and transformers come from the optional bge-m3 extra and are imported only when a baked model is loaded.
"""

from __future__ import annotations

import contextlib
import hashlib
import logging
import math
import threading
from collections.abc import Callable, Iterator, Mapping, Sequence
from pathlib import Path
from typing import TYPE_CHECKING, Any, Protocol

if TYPE_CHECKING:
    from rag_sidecar.settings import SidecarSettings

logger = logging.getLogger("rag_sidecar.embed")

BGE_M3_MODEL_ID = "BAAI/bge-m3"
BGE_M3_REVISION = "5617a9f61b028005a4858fdac845db406aefb181"
BGE_M3_MAX_MODEL_TOKENS = 8192
BGE_M3_DIMS = 1024
# Padded tokens per forward pass; one 8192-token input still runs alone.
BATCH_TOKEN_BUDGET = 16_384
REVISION_FILE = "REVISION"
# The files the image bakes at the pinned revision; sentencepiece is not needed because tokenizer.json is present.
# Hashes: LFS sha256 from the Hugging Face API for the large files, sha256 of the downloaded bytes (checked against the
# git blob ids of the revision) for the small ones.
BGE_M3_SHA256: dict[str, str] = {
    "config.json": "26159e7ad065073448460117eb24b7a4572f6f4e78eadff65dc0a11c052449fa",
    "tokenizer_config.json": "a62b2b6784f990259fddef5f16388693a8043be4f69179e6a5257eeb3f9abac4",
    "special_tokens_map.json": "8c785abebea9ae3257b61681b4e6fd8365ceafde980c21970d001e834cf10835",
    "tokenizer.json": "21106b6d7dab2952c1d496fb21d5dc9db75c28ed361a05f5020bbba27810dd08",
    "pytorch_model.bin": "b5e0ce3470abf5ef3831aa1bd5553b486803e83251590ab7ff35a117cf6aad38",
}
BGE_M3_FILES: tuple[str, ...] = tuple(BGE_M3_SHA256)


class EmbedInputTooLong(ValueError):
    def __init__(self, index: int, limit: int = BGE_M3_MAX_MODEL_TOKENS) -> None:
        super().__init__(f"embed_input_too_long: input {index} is above the limit of {limit} model tokens")
        self.index = index
        self.limit = limit


class EmbedderUnavailable(RuntimeError):
    pass


class Embedder(Protocol):
    revision: str

    def embed(self, texts: Sequence[str]) -> list[list[float]]: ...


def _floats(row: Any) -> list[float]:
    values = row.tolist() if hasattr(row, "tolist") else row
    return [float(x) for x in values]


def _l2(vector: list[float]) -> list[float]:
    norm = math.sqrt(math.fsum(x * x for x in vector))
    if not math.isfinite(norm) or norm == 0.0:
        raise ValueError("zero or non-finite embedding")
    return [x / norm for x in vector]


def _default_inference_context() -> contextlib.AbstractContextManager[Any]:
    try:
        import torch
    except ImportError:
        return contextlib.nullcontext()
    return torch.inference_mode()


def _batches(lengths: Sequence[int], budget: int) -> Iterator[list[int]]:
    order = sorted(range(len(lengths)), key=lambda index: lengths[index])
    batch: list[int] = []
    width = 0
    for index in order:
        next_width = max(width, lengths[index])
        if batch and next_width * (len(batch) + 1) > budget:
            yield batch
            batch, next_width = [], lengths[index]
        batch.append(index)
        width = next_width
    if batch:
        yield batch


class BgeM3Embedder:
    """Serves one batch at a time behind a lock so concurrent requests cannot interleave tensors or multiply memory."""

    def __init__(
        self,
        model: Any,
        tokenizer: Any,
        *,
        revision: str,
        max_tokens: int = BGE_M3_MAX_MODEL_TOKENS,
        token_budget: int = BATCH_TOKEN_BUDGET,
        inference_context: Callable[[], contextlib.AbstractContextManager[Any]] = _default_inference_context,
        return_tensors: str | None = None,
    ) -> None:
        self._model = model
        self._tokenizer = tokenizer
        self.revision = revision
        self._max_tokens = max_tokens
        self._token_budget = max(token_budget, max_tokens)
        self._inference_context = inference_context
        self._return_tensors = return_tensors
        self._lock = threading.Lock()

    def _lengths(self, texts: Sequence[str]) -> list[int]:
        encoded = self._tokenizer(list(texts), truncation=False, padding=False)
        lengths = [len(ids) for ids in encoded["input_ids"]]
        for index, length in enumerate(lengths):
            if length > self._max_tokens:
                raise EmbedInputTooLong(index, self._max_tokens)
        return lengths

    def _forward(self, texts: list[str]) -> list[list[float]]:
        kwargs: dict[str, Any] = {"padding": True, "truncation": False}
        if self._return_tensors is not None:
            kwargs["return_tensors"] = self._return_tensors
        tokens = self._tokenizer(texts, **kwargs)
        with self._inference_context():
            hidden = self._model(**tokens).last_hidden_state
        rows = [_floats(sample[0]) for sample in hidden]
        if len(rows) != len(texts) or any(len(row) == 0 for row in rows):
            raise ValueError("model returned an unexpected hidden state")
        return [_l2(row) for row in rows]

    def embed(self, texts: Sequence[str]) -> list[list[float]]:
        items = list(texts)
        if not items:
            return []
        with self._lock:
            lengths = self._lengths(items)
            out: list[list[float] | None] = [None] * len(items)
            for batch in _batches(lengths, self._token_budget):
                for index, vector in zip(batch, self._forward([items[i] for i in batch]), strict=True):
                    out[index] = vector
        return [vector for vector in out if vector is not None]


class LazyBgeM3Embedder:
    """Loads the baked model on first use, under the embed lock; a failed load answers unavailable, never a download."""

    def __init__(self, model_dir: str, loader: Callable[[Path, str], BgeM3Embedder] | None = None) -> None:
        self.revision = BGE_M3_REVISION
        self._model_dir = Path(model_dir)
        self._loader = loader or load_from_baked_dir
        self._lock = threading.Lock()
        self._embedder: BgeM3Embedder | None = None
        self._failed = False

    def _resolve(self) -> BgeM3Embedder:
        with self._lock:
            if self._embedder is None:
                if self._failed:
                    raise EmbedderUnavailable("load_failed")
                try:
                    self._embedder = self._loader(self._model_dir, BGE_M3_REVISION)
                except Exception as exc:
                    self._failed = True
                    logger.warning("[Embed] BGE-M3 model failed to load", extra={"error": type(exc).__name__})
                    raise EmbedderUnavailable("load_failed") from None
            return self._embedder

    def embed(self, texts: Sequence[str]) -> list[list[float]]:
        return self._resolve().embed(texts)


def file_sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for block in iter(lambda: handle.read(1 << 20), b""):
            digest.update(block)
    return digest.hexdigest()


def check_baked_dir(path: Path, revision: str, expected_sha256: Mapping[str, str]) -> None:
    """Raises EmbedderUnavailable unless `path` holds exactly the pinned revision's files with their pinned hashes."""
    if revision != BGE_M3_REVISION:
        raise EmbedderUnavailable("revision_mismatch")
    if not path.is_dir():
        raise EmbedderUnavailable("model_dir_missing")
    marker = path / REVISION_FILE
    recorded = marker.read_text(encoding="utf-8").strip() if marker.is_file() else ""
    if recorded != BGE_M3_REVISION:
        raise EmbedderUnavailable("revision_mismatch")
    for name, expected in expected_sha256.items():
        file = path / name
        if not file.is_file():
            raise EmbedderUnavailable("file_missing")
        if file_sha256(file) != expected:
            raise EmbedderUnavailable("file_hash_mismatch")


def load_from_baked_dir(
    path: Path,
    revision: str = BGE_M3_REVISION,
    *,
    allow_download: bool = False,
    expected_sha256: Mapping[str, str] | None = None,
    auto_tokenizer: Any = None,
    auto_model: Any = None,
) -> BgeM3Embedder:
    """Loads BGE-M3 from the directory baked at image build, on CPU in eval mode. Never downloads: the weights are a
    pickle file, so only the pinned, hash-checked files are ever loaded."""
    if allow_download:
        raise EmbedderUnavailable("download_refused")
    directory = Path(path)
    check_baked_dir(directory, revision, expected_sha256 if expected_sha256 is not None else BGE_M3_SHA256)
    if auto_tokenizer is None or auto_model is None:
        from transformers import AutoModel, AutoTokenizer

        auto_tokenizer = auto_tokenizer or AutoTokenizer
        auto_model = auto_model or AutoModel
    tokenizer = auto_tokenizer.from_pretrained(str(directory), local_files_only=True)
    model = auto_model.from_pretrained(str(directory), local_files_only=True)
    model.eval()
    return BgeM3Embedder(model, tokenizer, revision=BGE_M3_REVISION, return_tensors="pt")


def resolve_embedder(settings: SidecarSettings) -> Embedder | None:
    model_dir = getattr(settings, "bge_m3_model_dir", None)
    if not model_dir:
        return None
    return LazyBgeM3Embedder(model_dir)
