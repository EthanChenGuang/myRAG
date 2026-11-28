"""The sidecar test suite never lets tiktoken fetch an encoding: an empty cache raises a clear error and opens no connection."""

from __future__ import annotations

import socket

import pytest

tiktoken = pytest.importorskip("tiktoken")


def test_an_empty_cache_raises_without_any_connection(monkeypatch: pytest.MonkeyPatch, tmp_path) -> None:
    attempts: list[object] = []

    def refuse_connect(self: socket.socket, address: object) -> None:
        attempts.append(address)
        raise OSError("network disabled in this test")

    monkeypatch.setenv("TIKTOKEN_CACHE_DIR", str(tmp_path))
    monkeypatch.setattr(socket.socket, "connect", refuse_connect)
    monkeypatch.setattr(tiktoken.registry, "ENCODINGS", {})

    error: BaseException | None = None
    try:
        tiktoken.get_encoding("cl100k_base")
    except Exception as caught:  # noqa: BLE001 - the test inspects whatever the load raised
        error = caught
    assert attempts == [], f"tiktoken tried the network: {error!r}"
    assert isinstance(error, RuntimeError), repr(error)
    assert "TIKTOKEN_CACHE_DIR" in str(error)
    assert "fill-tiktoken-cache" in str(error)
    assert list(tmp_path.iterdir()) == []
