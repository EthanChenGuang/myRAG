import math
import socket
import threading
import time
from types import SimpleNamespace

import pytest
from fastapi.testclient import TestClient
from pydantic import SecretStr

from rag_sidecar.contracts import SidecarError
from rag_sidecar.contracts.embed import EmbedResponse
from rag_sidecar.embed import (
    BGE_M3_MAX_MODEL_TOKENS,
    BGE_M3_REVISION,
    BgeM3Embedder,
    EmbedInputTooLong,
    resolve_embedder,
)
from rag_sidecar.main import create_app
from rag_sidecar.settings import SidecarSettings

SECRET = "e" * 48
HEADER = {"x-sidecar-secret": SECRET}
ROUTE = "/v1/embed"
DIMS = 1024


class FakeTokenizer:
    """Whitespace tokenizer: one CLS id, one id per word. Records every call's keyword arguments."""

    def __init__(self) -> None:
        self.calls: list[dict] = []
        self.vocab: dict[str, int] = {}

    def _ids(self, text: str) -> list[int]:
        return [0] + [self.vocab.setdefault(word, len(self.vocab) + 1) for word in text.split()]

    def __call__(self, texts, **kwargs):
        self.calls.append(dict(kwargs))
        ids = [self._ids(text) for text in texts]
        if kwargs.get("padding"):
            width = max(len(row) for row in ids)
            mask = [[1] * len(row) + [0] * (width - len(row)) for row in ids]
            ids = [row + [-1] * (width - len(row)) for row in ids]
            return {"input_ids": ids, "attention_mask": mask}
        return {"input_ids": ids}


class FakeModel:
    """Hidden state: the first token's vector is derived from the whole row, later tokens are noise the pooling must ignore."""

    def __init__(self, delay_s: float = 0.0) -> None:
        self.delay_s = delay_s
        self.active = 0
        self.max_active = 0
        self.batches: list[int] = []
        self._lock = threading.Lock()

    def __call__(self, input_ids, attention_mask=None):
        with self._lock:
            self.active += 1
            self.max_active = max(self.max_active, self.active)
        try:
            if self.delay_s:
                time.sleep(self.delay_s)
            self.batches.append(len(input_ids))
            hidden = []
            for row in input_ids:
                seed = sum((index + 1) * value for index, value in enumerate(row) if value >= 0)
                cls = [3.0 * math.sin(seed + j * 0.37) + 0.5 for j in range(DIMS)]
                noise = [[99.0] * DIMS for _ in row[1:]]
                hidden.append([cls, *noise])
            return SimpleNamespace(last_hidden_state=hidden)
        finally:
            with self._lock:
                self.active -= 1


def _embedder(model: FakeModel | None = None, tokenizer: FakeTokenizer | None = None) -> BgeM3Embedder:
    return BgeM3Embedder(model or FakeModel(), tokenizer or FakeTokenizer(), revision=BGE_M3_REVISION)


def _norm(vector: list[float]) -> float:
    return math.sqrt(math.fsum(x * x for x in vector))


def test_pinned_revision_and_limit():
    assert BGE_M3_REVISION == "5617a9f61b028005a4858fdac845db406aefb181"
    assert BGE_M3_MAX_MODEL_TOKENS == 8192


def test_takes_the_first_token_state_and_l2_normalizes_it():
    model = FakeModel()
    vectors = _embedder(model).embed(["alpha beta gamma"])
    assert len(vectors) == 1 and len(vectors[0]) == DIMS
    assert abs(_norm(vectors[0]) - 1.0) < 1e-9
    assert max(abs(x) for x in vectors[0]) < 0.2, "the noise tokens (99.0) must not reach the pooled vector"


def test_tokenizer_is_called_with_truncation_off():
    tokenizer = FakeTokenizer()
    _embedder(tokenizer=tokenizer).embed(["one two", "three"])
    assert tokenizer.calls, "the tokenizer was never called"
    for call in tokenizer.calls:
        assert call.get("truncation") is False


def test_rejects_an_input_above_the_model_limit_instead_of_truncating():
    model = FakeModel()
    at_limit = " ".join(["w"] * (BGE_M3_MAX_MODEL_TOKENS - 1))
    _embedder(model).embed([at_limit])
    over = at_limit + " w"
    with pytest.raises(EmbedInputTooLong) as raised:
        _embedder(model).embed(["short text", over])
    assert raised.value.limit == BGE_M3_MAX_MODEL_TOKENS
    assert raised.value.index == 1
    assert "8192" in str(raised.value)
    assert model.batches == [1], "nothing of a request with an over-long input reaches the model"


def test_vectors_come_back_in_input_order():
    texts = [" ".join(["x"] * n) + f" t{n}" for n in (9, 1, 5, 3, 7)]
    embedder = _embedder()
    together = embedder.embed(texts)
    alone = [embedder.embed([text])[0] for text in texts]
    for a, b in zip(together, alone, strict=True):
        assert max(abs(x - y) for x, y in zip(a, b, strict=True)) < 1e-12


def test_identical_inputs_in_one_request_give_identical_vectors():
    vectors = _embedder().embed(["same neutral sentence", "other words here", "same neutral sentence"])
    assert vectors[0] == vectors[2]
    assert vectors[0] != vectors[1]


def test_serves_one_batch_at_a_time():
    model = FakeModel(delay_s=0.05)
    embedder = _embedder(model)
    threads = [threading.Thread(target=embedder.embed, args=([f"text number {i}"],)) for i in range(4)]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join()
    assert model.max_active == 1
    assert len(model.batches) == 4


def test_a_zero_vector_is_an_error_not_a_vector():
    class ZeroModel(FakeModel):
        def __call__(self, input_ids, attention_mask=None):
            return SimpleNamespace(last_hidden_state=[[[0.0] * DIMS] for _ in input_ids])

    with pytest.raises(ValueError):
        _embedder(ZeroModel()).embed(["anything"])


# --- route ---------------------------------------------------------------------------------------


def _settings(secret: str | None = SECRET, **overrides) -> SidecarSettings:
    return SidecarSettings(secret=SecretStr(secret) if secret is not None else None, **overrides)


def _client(embedder=None, settings: SidecarSettings | None = None) -> TestClient:
    app = create_app(settings if settings is not None else _settings(), scorers={}, embedder=embedder)
    return TestClient(app)


def test_route_answers_an_embed_response_with_the_revision():
    response = _client(_embedder()).post(ROUTE, json={"inputs": ["first text", "second text"]}, headers=HEADER)
    assert response.status_code == 200
    body = EmbedResponse.model_validate(response.json())
    assert body.revision == BGE_M3_REVISION
    assert body.model == "BAAI/bge-m3"
    assert body.dims == DIMS
    assert len(body.vectors) == 2


def test_route_requires_the_secret():
    assert _client(_embedder()).post(ROUTE, json={"inputs": ["x"]}).status_code == 401
    wrong = {"x-sidecar-secret": "z" * 48}
    assert _client(_embedder()).post(ROUTE, json={"inputs": ["x"]}, headers=wrong).status_code == 401


def test_route_fails_closed_without_a_configured_secret():
    response = _client(_embedder(), settings=_settings(secret=None)).post(ROUTE, json={"inputs": ["x"]}, headers=HEADER)
    assert response.status_code == 503


def test_route_answers_503_model_unavailable_without_a_model():
    response = _client(None).post(ROUTE, json={"inputs": ["x"]}, headers=HEADER)
    assert response.status_code == 503
    assert SidecarError.model_validate(response.json()).error == "model_unavailable"


@pytest.mark.parametrize(
    "body",
    [{}, {"inputs": []}, {"inputs": [""]}, {"inputs": ["x"], "model": "other/model"}, {"inputs": ["x"] * 33}, {"inputs": ["x"], "extra": 1}],
)
def test_route_validates_the_embed_request(body):
    response = _client(_embedder()).post(ROUTE, json=body, headers=HEADER)
    assert response.status_code == 422
    assert SidecarError.model_validate(response.json()).error == "invalid_embed_request"


def test_route_refuses_an_over_long_input_with_a_422_naming_the_limit():
    at_limit = " ".join(["w"] * (BGE_M3_MAX_MODEL_TOKENS - 1))
    assert _client(_embedder()).post(ROUTE, json={"inputs": [at_limit]}, headers=HEADER).status_code == 200
    model = FakeModel()
    over = at_limit + " w"
    assert len(over) <= 20_000
    response = _client(_embedder(model)).post(ROUTE, json={"inputs": ["short text", over]}, headers=HEADER)
    assert response.status_code == 422
    error = SidecarError.model_validate(response.json()).error
    assert error.startswith("embed_input_too_long")
    assert "8192" in error
    assert model.batches == []


def test_route_answers_503_when_the_model_fails():
    class Broken(FakeModel):
        def __call__(self, input_ids, attention_mask=None):
            raise RuntimeError("out of memory")

    response = _client(_embedder(Broken())).post(ROUTE, json={"inputs": ["x"]}, headers=HEADER)
    assert response.status_code == 503
    assert SidecarError.model_validate(response.json()).error == "model_unavailable"


def test_default_settings_resolve_no_embedder(monkeypatch):
    monkeypatch.delenv("BGE_M3_MODEL_DIR", raising=False)
    assert resolve_embedder(_settings()) is None


def test_resolving_with_a_model_dir_loads_nothing_and_opens_no_socket(monkeypatch, tmp_path):
    def _no_network(*_args, **_kwargs):
        raise AssertionError("no network call may be attempted")

    monkeypatch.setattr(socket.socket, "connect", _no_network)
    embedder = resolve_embedder(_settings(bge_m3_model_dir=str(tmp_path / "missing")))
    assert embedder is not None
    assert embedder.revision == BGE_M3_REVISION
    response = _client(embedder).post(ROUTE, json={"inputs": ["x"]}, headers=HEADER)
    assert response.status_code == 503
    assert SidecarError.model_validate(response.json()).error == "model_unavailable"
