from __future__ import annotations

import time
from pathlib import Path

from rag_sidecar.preflight.config import load_routing_config
from rag_sidecar.preflight.l1 import l1_signals

REPO_ROOT = Path(__file__).resolve().parents[2]
BENCH_PDF = REPO_ROOT / "eval" / "fixtures" / "parse" / "pdf" / "bench-100.pdf"
CI_TOLERANCE = 3.0
TARGET_SECONDS = 1.0


def test_l1_bench_100_pages():
    cfg = load_routing_config()
    elapsed = None
    result = None
    for _ in range(3):
        start = time.perf_counter()
        result = l1_signals(BENCH_PDF, cfg)
        candidate = time.perf_counter() - start
        if elapsed is None or candidate < elapsed:
            elapsed = candidate
    assert result is not None and elapsed is not None
    gated_share = result.gated_share
    print(
        f"L1 bench-100: {elapsed:.3f}s gated_share={gated_share:.3f} gated_pages={result.gated_pages}"
    )
    assert result.gated_pages == [10, 50, 90]
    assert gated_share == 0.03
    assert elapsed < TARGET_SECONDS * CI_TOLERANCE