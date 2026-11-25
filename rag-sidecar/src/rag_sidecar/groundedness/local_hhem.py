import asyncio
import importlib.util
import logging
import math
import os
import threading
from collections.abc import Callable, Sequence
from pathlib import Path
from typing import Any

from rag_sidecar.groundedness.scorer import LOCAL_SCORER, ScorerBusy, ScorerUnavailable
from rag_sidecar.settings import SidecarSettings

logger = logging.getLogger("rag_sidecar.groundedness.local_hhem")

HHEM_MODEL_ID = "vectara/hallucination_evaluation_model"
_CACHE_DIR_NAME = "models--vectara--hallucination_evaluation_model"
_LOAD_LOCK = threading.Lock()

Loader = Callable[..., Any]


def _packages_installed() -> bool:
    return importlib.util.find_spec("transformers") is not None and importlib.util.find_spec("torch") is not None


def _hub_cache() -> Path:
    explicit = (os.environ.get("HF_HUB_CACHE") or "").strip()
    if explicit:
        return Path(explicit)
    home = (os.environ.get("HF_HOME") or "").strip()
    if home:
        return Path(home) / "hub"
    xdg = (os.environ.get("XDG_CACHE_HOME") or "").strip()
    base = Path(xdg) if xdg else Path.home() / ".cache"
    return base / "huggingface" / "hub"


def _snapshot_present(revision: str) -> bool:
    return (_hub_cache() / _CACHE_DIR_NAME / "snapshots" / revision).is_dir()


def _default_loader(model_id: str, *, revision: str, trust_remote_code: bool, local_files_only: bool) -> Any:
    from transformers import AutoModelForSequenceClassification

    model = AutoModelForSequenceClassification.from_pretrained(
        model_id,
        revision=revision,
        trust_remote_code=trust_remote_code,
        local_files_only=local_files_only,
    )
    model.eval()
    return model


class LocalHhemScorer:
    name = LOCAL_SCORER

    def __init__(
        self,
        settings: SidecarSettings,
        loader: Loader | None = None,
        queue_wait_s: float = 2.0,
    ) -> None:
        self._revision = settings.hhem_model_revision
        self._loader = loader
        self._queue_wait_s = queue_wait_s
        self._model: Any = None
        self._load_failed = False
        self._semaphore: asyncio.Semaphore | None = None
        self._semaphore_loop: asyncio.AbstractEventLoop | None = None

    def available(self) -> bool:
        if self._load_failed:
            return False
        if self._loader is not None or self._model is not None:
            return True
        return _packages_installed() and _snapshot_present(self._revision)

    def _ensure_model(self) -> Any:
        if self._model is not None:
            return self._model
        with _LOAD_LOCK:
            if self._model is not None:
                return self._model
            if self._load_failed:
                raise ScorerUnavailable("model_load_failed")
            loader = self._loader if self._loader is not None else _default_loader
            try:
                self._model = loader(
                    HHEM_MODEL_ID,
                    revision=self._revision,
                    trust_remote_code=True,
                    local_files_only=True,
                )
            except Exception:
                self._load_failed = True
                logger.warning("[Groundedness] local HHEM model failed to load")
                raise ScorerUnavailable("model_load_failed") from None
            return self._model

    def _infer(self, premise: str, hypothesis: str) -> float:
        model = self._ensure_model()
        try:
            output = model.predict([(premise, hypothesis)])
            score = float(output[0])
        except Exception:
            logger.warning("[Groundedness] local HHEM inference failed")
            raise ScorerUnavailable("inference_failed") from None
        if math.isnan(score) or score < 0.0 or score > 1.0:
            raise ScorerUnavailable("invalid_score")
        return score

    def _gate(self) -> asyncio.Semaphore:
        loop = asyncio.get_running_loop()
        if self._semaphore is None or self._semaphore_loop is not loop:
            self._semaphore = asyncio.Semaphore(1)
            self._semaphore_loop = loop
        return self._semaphore

    async def score(self, premise_texts: Sequence[str], hypothesis: str) -> float:
        if self._load_failed:
            raise ScorerUnavailable("model_load_failed")
        gate = self._gate()
        try:
            await asyncio.wait_for(gate.acquire(), timeout=self._queue_wait_s)
        except TimeoutError:
            raise ScorerBusy() from None
        loop = asyncio.get_running_loop()
        try:
            future = loop.run_in_executor(None, self._infer, "\n\n".join(premise_texts), hypothesis)
        except BaseException:
            gate.release()
            raise
        future.add_done_callback(lambda _done: gate.release())
        return await asyncio.shield(future)
