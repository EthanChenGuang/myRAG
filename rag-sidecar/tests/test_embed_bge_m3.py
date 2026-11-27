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
    """Hidden state: the first token's vector derives from the whole row; later tokens are noise pooling must ignore."""

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
    [
        {},
        {"inputs": []},
        {"inputs": [""]},
        {"inputs": ["x"], "model": "other/model"},
        {"inputs": ["x"] * 33},
        {"inputs": ["x"], "extra": 1},
    ],
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


# --- extra, loader and bake (task 2) --------------------------------------------------------------

import hashlib  # noqa: E402
import subprocess  # noqa: E402
import sys  # noqa: E402
import tomllib  # noqa: E402
from pathlib import Path  # noqa: E402

from rag_sidecar.embed import EmbedderUnavailable, load_from_baked_dir  # noqa: E402
from rag_sidecar.embed import bake as bake_module  # noqa: E402
from rag_sidecar.embed.bge_m3 import BGE_M3_FILES, BGE_M3_SHA256, REVISION_FILE  # noqa: E402

SIDECAR_DIR = Path(__file__).resolve().parent.parent


@pytest.fixture
def no_network(monkeypatch):
    def _refuse(*_args, **_kwargs):
        raise AssertionError("no network call may be attempted")

    monkeypatch.setattr(socket.socket, "connect", _refuse)
    monkeypatch.setattr(socket, "create_connection", _refuse)


def _sha(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def _baked(tmp_path: Path, revision: str = BGE_M3_REVISION) -> tuple[Path, dict[str, str]]:
    target = tmp_path / "bge-m3"
    target.mkdir()
    hashes: dict[str, str] = {}
    for name in BGE_M3_FILES:
        data = f"synthetic {name}".encode()
        (target / name).write_bytes(data)
        hashes[name] = _sha(data)
    (target / REVISION_FILE).write_text(revision + "\n", encoding="utf-8")
    return target, hashes


class _FakeAuto:
    def __init__(self, product):
        self.calls: list[tuple[str, dict]] = []
        self._product = product

    def from_pretrained(self, path, **kwargs):
        self.calls.append((path, kwargs))
        return self._product


class _EvalModel(FakeModel):
    def __init__(self):
        super().__init__()
        self.evaluated = False

    def eval(self):
        self.evaluated = True
        return self


def test_extra_reuses_the_hhem_torch_and_transformers_pins():
    optional = tomllib.loads((SIDECAR_DIR / "pyproject.toml").read_text(encoding="utf-8"))["project"][
        "optional-dependencies"
    ]
    assert sorted(optional["bge-m3"]) == sorted(optional["hhem"])
    assert sorted(optional["bge-m3"]) == ["torch==2.15.0", "transformers==5.23.0"]


def test_lock_holds_the_extra_with_the_already_locked_versions():
    lock = tomllib.loads((SIDECAR_DIR / "uv.lock").read_text(encoding="utf-8"))
    versions: dict[str, set[str]] = {}
    for entry in lock["package"]:
        versions.setdefault(entry["name"], set()).add(entry["version"])
    assert {v.split("+")[0] for v in versions["torch"]} == {"2.15.0"}
    assert versions["transformers"] == {"5.23.0"}
    project = next(entry for entry in lock["package"] if entry["name"] == "rag-sidecar")
    assert "bge-m3" in project["metadata"]["provides-extras"]
    assert "sentence-transformers" not in versions and "flagembedding" not in versions


def test_the_base_install_imports_no_torch_or_transformers_at_start():
    code = (
        "import sys, rag_sidecar.main, rag_sidecar.embed;"
        "print(int('torch' in sys.modules or 'transformers' in sys.modules))"
    )
    done = subprocess.run([sys.executable, "-c", code], capture_output=True, text=True, check=True, cwd=SIDECAR_DIR)
    assert done.stdout.strip().splitlines()[-1] == "0"


def test_pinned_files_and_hashes():
    assert set(BGE_M3_FILES) == set(BGE_M3_SHA256)
    assert "pytorch_model.bin" in BGE_M3_FILES and "tokenizer.json" in BGE_M3_FILES
    assert BGE_M3_SHA256["pytorch_model.bin"] == "b5e0ce3470abf5ef3831aa1bd5553b486803e83251590ab7ff35a117cf6aad38"
    assert "sentencepiece.bpe.model" not in BGE_M3_FILES


def test_loader_refuses_a_missing_directory(tmp_path, no_network):
    with pytest.raises(EmbedderUnavailable, match="model_dir_missing"):
        load_from_baked_dir(tmp_path / "absent", BGE_M3_REVISION)


def test_loader_refuses_to_download(tmp_path, no_network):
    target, hashes = _baked(tmp_path)
    with pytest.raises(EmbedderUnavailable, match="download_refused"):
        load_from_baked_dir(target, BGE_M3_REVISION, allow_download=True, expected_sha256=hashes)


def test_loader_refuses_another_requested_revision(tmp_path, no_network):
    target, hashes = _baked(tmp_path)
    with pytest.raises(EmbedderUnavailable, match="revision_mismatch"):
        load_from_baked_dir(target, "0" * 40, expected_sha256=hashes)


def test_loader_refuses_a_directory_baked_at_another_revision(tmp_path, no_network):
    target, hashes = _baked(tmp_path, revision="1" * 40)
    with pytest.raises(EmbedderUnavailable, match="revision_mismatch"):
        load_from_baked_dir(target, BGE_M3_REVISION, expected_sha256=hashes)
    (target / REVISION_FILE).unlink()
    with pytest.raises(EmbedderUnavailable, match="revision_mismatch"):
        load_from_baked_dir(target, BGE_M3_REVISION, expected_sha256=hashes)


def test_loader_refuses_a_changed_or_missing_file(tmp_path, no_network):
    target, hashes = _baked(tmp_path)
    (target / "pytorch_model.bin").write_bytes(b"tampered")
    with pytest.raises(EmbedderUnavailable, match="file_hash_mismatch"):
        load_from_baked_dir(target, BGE_M3_REVISION, expected_sha256=hashes)
    (target / "pytorch_model.bin").unlink()
    with pytest.raises(EmbedderUnavailable, match="file_missing"):
        load_from_baked_dir(target, BGE_M3_REVISION, expected_sha256=hashes)


def test_loader_loads_local_files_only_in_eval_mode(tmp_path, no_network):
    target, hashes = _baked(tmp_path)
    model = _EvalModel()
    tokenizers, models = _FakeAuto(FakeTokenizer()), _FakeAuto(model)
    embedder = load_from_baked_dir(
        target, BGE_M3_REVISION, expected_sha256=hashes, auto_tokenizer=tokenizers, auto_model=models
    )
    assert embedder.revision == BGE_M3_REVISION
    assert model.evaluated
    for path, kwargs in tokenizers.calls + models.calls:
        assert path == str(target)
        assert kwargs.get("local_files_only") is True
        assert "revision" not in kwargs
    assert len(embedder.embed(["one neutral line"])[0]) == DIMS


def test_bake_downloads_the_pinned_revision_checks_hashes_and_records_it(tmp_path, no_network):
    hub = tmp_path / "hub"
    hub.mkdir()
    contents = {name: f"synthetic {name}".encode() for name in BGE_M3_FILES}
    calls: list[dict] = []

    def _download(repo_id, *, revision, filenames, cache_dir):
        calls.append({"repo_id": repo_id, "revision": revision, "filenames": list(filenames)})
        for name in filenames:
            (hub / name).write_bytes(contents[name])
        return hub

    target = tmp_path / "baked"
    hashes = {name: _sha(data) for name, data in contents.items()}
    bake_module.bake(target, download=_download, expected_sha256=hashes, check=lambda path: None)
    assert calls == [{"repo_id": "BAAI/bge-m3", "revision": BGE_M3_REVISION, "filenames": list(BGE_M3_FILES)}]
    assert (target / REVISION_FILE).read_text(encoding="utf-8").strip() == BGE_M3_REVISION
    assert {p.name for p in target.iterdir()} == set(BGE_M3_FILES) | {REVISION_FILE}


def test_bake_fails_on_a_hash_mismatch_and_leaves_no_usable_directory(tmp_path, no_network):
    hub = tmp_path / "hub"
    hub.mkdir()

    def _download(repo_id, *, revision, filenames, cache_dir):
        for name in filenames:
            (hub / name).write_bytes(b"changed upstream")
        return hub

    target = tmp_path / "baked"
    hashes = {name: _sha(f"synthetic {name}".encode()) for name in BGE_M3_FILES}
    with pytest.raises(bake_module.BakeError, match="sha256"):
        bake_module.bake(target, download=_download, expected_sha256=hashes, check=lambda path: None)
    assert not (target / REVISION_FILE).exists()
