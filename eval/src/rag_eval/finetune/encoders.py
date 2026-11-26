"""Encoders the miner and the evaluator score with (D-11, D-17).

An Encoder turns TextItems into L2-normalised float32 rows, one per item, in input order:
- StoredVectorsEncoder: the production model, read from the bundle's vector files by id (06.1-10 layout); text is ignored.
- FakeEncoder: deterministic feature hashing of words and character trigrams, for tests and fixture runs; no model.
- SentenceTransformerEncoder: any sentence-transformers model with the query and document prompts from finetune.json.
  sentence_transformers is imported on first use, so this module imports without the finetune extra.
"""

import hashlib
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Protocol

import numpy as np

from rag_eval.finetune.textnorm import char_ngrams, normalize
from rag_eval.finetune.vectors_io import (
    VectorFileShapeError,
    VectorSet,
    read_chunk_vectors,
    read_query_vectors,
)

FINETUNE_EXTRA_HINT = "the finetune extra is not installed (uv sync --extra finetune)"


@dataclass(frozen=True)
class TextItem:
    id: str
    text: str


class Encoder(Protocol):
    name: str

    def encode_queries(self, items: Sequence[TextItem]) -> np.ndarray: ...

    def encode_documents(self, items: Sequence[TextItem]) -> np.ndarray: ...


class EncoderUnavailable(RuntimeError):
    pass


class MissingVector(KeyError):
    """An id has no stored vector; the message carries a count, never the id's text."""


def normalize_rows(matrix: np.ndarray) -> np.ndarray:
    matrix = np.asarray(matrix, dtype=np.float32)
    if matrix.ndim != 2:
        raise ValueError("expected a 2-d matrix")
    norms = np.linalg.norm(matrix, axis=1, keepdims=True)
    return (matrix / np.where(norms > 0, norms, 1.0)).astype(np.float32, copy=False)


class StoredVectorsEncoder:
    """Looks up stored production vectors by id: query vectors by pair or query id, chunk vectors by chunk id."""

    name = "vectors"

    def __init__(
        self,
        queries: VectorSet | Mapping[str, Sequence[float]],
        documents: VectorSet | Mapping[str, Sequence[float]],
    ):
        self._queries = self._table(queries)
        self._documents = self._table(documents)
        q_dims, d_dims = self._queries[1].shape[1], self._documents[1].shape[1]
        if q_dims != d_dims:
            raise VectorFileShapeError("query_chunk_dims_mismatch")
        both_stored = isinstance(queries, VectorSet) and isinstance(documents, VectorSet)
        if both_stored and (queries.header.model, queries.header.profile_id) != (
            documents.header.model,
            documents.header.profile_id,
        ):
            raise VectorFileShapeError("query_chunk_profile_mismatch")
        self.dims = int(d_dims)

    @staticmethod
    def _table(
        source: VectorSet | Mapping[str, Sequence[float]],
    ) -> tuple[dict[str, int], np.ndarray]:
        if isinstance(source, VectorSet):
            return source.index(), normalize_rows(source.matrix)
        ids = list(source)
        if not ids:
            return {}, np.zeros((0, 1), dtype=np.float32)
        matrix = np.asarray([source[item] for item in ids], dtype=np.float32)
        return {item: position for position, item in enumerate(ids)}, normalize_rows(matrix)

    @classmethod
    def from_bundle(cls, bundle_dir: Path, tenant_key: str, profile_id: str) -> "StoredVectorsEncoder":
        documents = read_chunk_vectors(bundle_dir, tenant_key, profile_id)
        queries = read_query_vectors(bundle_dir, tenant_key, profile_id, expected_dims=documents.header.dims)
        return cls(queries, documents)

    def has_query(self, item_id: str) -> bool:
        return item_id in self._queries[0]

    def has_document(self, item_id: str) -> bool:
        return item_id in self._documents[0]

    @staticmethod
    def _lookup(table: tuple[dict[str, int], np.ndarray], items: Sequence[TextItem], what: str) -> np.ndarray:
        index, matrix = table
        missing = sum(1 for item in items if item.id not in index)
        if missing:
            raise MissingVector(f"{missing} {what} without a stored vector")
        if not items:
            return np.zeros((0, matrix.shape[1]), dtype=np.float32)
        return matrix[[index[item.id] for item in items]]

    def encode_queries(self, items: Sequence[TextItem]) -> np.ndarray:
        return self._lookup(self._queries, items, "queries")

    def encode_documents(self, items: Sequence[TextItem]) -> np.ndarray:
        return self._lookup(self._documents, items, "chunks")


class FakeEncoder:
    """Signed feature hashing of normalised words and character trigrams into `dims` buckets; identical text gives an
    identical unit vector. Queries and documents share one space, so a query that repeats a chunk's words scores high."""

    name = "fake"

    def __init__(self, dims: int = 64, salt: str = "ft-fake-encoder"):
        if dims < 2:
            raise ValueError("dims must be at least 2")
        self.dims = dims
        self.salt = salt

    def _features(self, text: str) -> list[str]:
        words = [normalize(word) for word in text.split()]
        features = [f"w:{word}" for word in words if word]
        features += [f"g:{gram}" for gram in sorted(char_ngrams(normalize(text), 3))]
        return features or ["empty"]

    def _vector(self, text: str) -> np.ndarray:
        vector = np.zeros(self.dims, dtype=np.float64)
        for feature in self._features(text):
            digest = hashlib.sha256(f"{self.salt}|{feature}".encode()).digest()
            bucket = int.from_bytes(digest[:4], "little") % self.dims
            vector[bucket] += 1.0 if digest[4] & 1 else -1.0
        if not vector.any():
            vector[0] = 1.0
        return vector

    def _encode(self, items: Sequence[TextItem]) -> np.ndarray:
        if not items:
            return np.zeros((0, self.dims), dtype=np.float32)
        return normalize_rows(np.stack([self._vector(item.text) for item in items]))

    def encode_queries(self, items: Sequence[TextItem]) -> np.ndarray:
        return self._encode(items)

    def encode_documents(self, items: Sequence[TextItem]) -> np.ndarray:
        return self._encode(items)


def load_sentence_transformer(model: str, *, device: str = "cpu") -> Any:
    try:
        from sentence_transformers import SentenceTransformer
    except ImportError as exc:
        raise EncoderUnavailable(FINETUNE_EXTRA_HINT) from exc
    return SentenceTransformer(model, device=device)


class SentenceTransformerEncoder:
    """`model` is a loaded SentenceTransformer or a local path / hub id loaded on first use. Prompts are prepended as
    raw strings (empty means none), the same strings the st miner passes to mine_hard_negatives."""

    name = "st"

    def __init__(
        self,
        model: Any,
        *,
        query_prompt: str = "",
        document_prompt: str = "",
        batch_size: int = 32,
        device: str = "cpu",
    ):
        self._model = model
        self.query_prompt = query_prompt
        self.document_prompt = document_prompt
        self.batch_size = batch_size
        self.device = device

    @property
    def model(self) -> Any:
        if isinstance(self._model, (str, Path)):
            self._model = load_sentence_transformer(str(self._model), device=self.device)
        return self._model

    def _encode(self, items: Sequence[TextItem], prompt: str) -> np.ndarray:
        model = self.model
        if not items:
            return np.zeros((0, int(model.get_embedding_dimension())), dtype=np.float32)
        vectors = model.encode(
            [item.text for item in items],
            prompt=prompt or None,
            batch_size=self.batch_size,
            convert_to_numpy=True,
            normalize_embeddings=True,
            show_progress_bar=False,
        )
        return normalize_rows(vectors)

    def encode_queries(self, items: Sequence[TextItem]) -> np.ndarray:
        return self._encode(items, self.query_prompt)

    def encode_documents(self, items: Sequence[TextItem]) -> np.ndarray:
        return self._encode(items, self.document_prompt)
