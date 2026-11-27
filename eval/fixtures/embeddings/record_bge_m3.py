"""Record BGE-M3 vectors for the identity fixture (D-26), or compare two recordings.

  python eval/fixtures/embeddings/record_bge_m3.py --mode hosted  --out bge-m3-hosted.json   (needs DEEPINFRA_API_KEY)
  python eval/fixtures/embeddings/record_bge_m3.py --mode sidecar --out bge-m3-sidecar.json  (inside the bge-m3 image)
  python eval/fixtures/embeddings/record_bge_m3.py --compare bge-m3-hosted.json bge-m3-sidecar.json

Each fixture text is embedded in its own call. A recording holds the vectors, the model revision, the mode, the date and
the sha256 of the text file, never the API key. The compare mode uses the standard library only, prints per text id the
cosine and the largest component difference after L2 normalization (never the text) and exits 1 beyond the D-26
tolerance, 2 when the recordings cannot be compared. Heavy modules are imported only by the recording modes.
"""

from __future__ import annotations

import argparse
import datetime as _dt
import hashlib
import json
import math
import os
import sys
from collections.abc import Callable, Sequence
from pathlib import Path

HERE = Path(__file__).resolve().parent
DEFAULT_TEXTS = HERE / "bge-m3-texts.json"
MODEL = "BAAI/bge-m3"
REVISION = "5617a9f61b028005a4858fdac845db406aefb181"
DIMS = 1024
MIN_COSINE = 0.9999
MAX_COMPONENT_DIFF = 1e-3
DEFAULT_DEEPINFRA_BASE_URL = "https://api.deepinfra.com/v1/openai"
SCHEMA_VERSION = 1

EXIT_OK = 0
EXIT_BEYOND_TOLERANCE = 1
EXIT_NOT_COMPARABLE = 2

EmbedOne = Callable[[str], Sequence[float]]


class NotComparable(Exception):
    pass


def texts_sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def load_texts(path: Path) -> list[dict]:
    data = json.loads(path.read_text(encoding="utf-8"))
    texts = data["texts"] if isinstance(data, dict) else data
    ids = [entry["id"] for entry in texts]
    if len(ids) != len(set(ids)) or any(not isinstance(entry.get("text"), str) or not entry["text"] for entry in texts):
        raise ValueError("text file needs unique ids and non-empty texts")
    return texts


def l2(vector: Sequence[float]) -> list[float]:
    values = [float(x) for x in vector]
    norm = math.sqrt(math.fsum(x * x for x in values))
    if not math.isfinite(norm) or norm == 0.0:
        raise NotComparable("zero or non-finite vector")
    return [x / norm for x in values]


def compare_vectors(a: Sequence[float], b: Sequence[float]) -> tuple[float, float]:
    if len(a) != len(b):
        raise NotComparable("vectors of different length")
    ua, ub = l2(a), l2(b)
    cosine = math.fsum(x * y for x, y in zip(ua, ub, strict=True))
    diff = max(abs(x - y) for x, y in zip(ua, ub, strict=True))
    return cosine, diff


def within_tolerance(cosine: float, diff: float) -> bool:
    return cosine >= MIN_COSINE and diff <= MAX_COMPONENT_DIFF


def _load_recording(path: Path) -> dict:
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError) as error:
        raise NotComparable(f"{path.name}: unreadable ({type(error).__name__})") from None
    if not isinstance(data, dict) or not isinstance(data.get("vectors"), dict) or not data["vectors"]:
        raise NotComparable(f"{path.name}: no vectors")
    return data


def compare(a_path: Path, b_path: Path, out=sys.stdout) -> int:
    try:
        a, b = _load_recording(a_path), _load_recording(b_path)
        if set(a["vectors"]) != set(b["vectors"]):
            raise NotComparable("the recordings cover different text ids")
        for key in ("model", "revision", "texts_sha256"):
            if a.get(key) != b.get(key):
                raise NotComparable(f"the recordings differ in {key}")
        failed = 0
        for text_id in sorted(a["vectors"]):
            cosine, diff = compare_vectors(a["vectors"][text_id], b["vectors"][text_id])
            ok = within_tolerance(cosine, diff)
            failed += 0 if ok else 1
            print(f"{text_id}\tcosine={cosine:.8f}\tmax_diff={diff:.3e}\t{'ok' if ok else 'BEYOND'}", file=out)
    except NotComparable as error:
        print(f"[BGE-M3 identity] not comparable: {error}", file=out)
        return EXIT_NOT_COMPARABLE
    print(f"[BGE-M3 identity] {len(a['vectors']) - failed}/{len(a['vectors'])} within tolerance", file=out)
    return EXIT_BEYOND_TOLERANCE if failed else EXIT_OK


def record(mode: str, texts_path: Path, embed_one: EmbedOne, revision: str = REVISION) -> dict:
    vectors: dict[str, list[float]] = {}
    for entry in load_texts(texts_path):
        vector = [float(x) for x in embed_one(entry["text"])]
        if len(vector) != DIMS or not all(math.isfinite(x) for x in vector):
            raise ValueError(f"{entry['id']}: expected {DIMS} finite components")
        vectors[entry["id"]] = vector
    return {
        "schema_version": SCHEMA_VERSION,
        "model": MODEL,
        "revision": revision,
        "mode": mode,
        "recorded_on": _dt.date.today().isoformat(),
        "texts_sha256": texts_sha256(texts_path),
        "dims": DIMS,
        "vectors": vectors,
    }


def hosted_embedder() -> EmbedOne:
    import urllib.request

    key = (os.environ.get("DEEPINFRA_API_KEY") or "").strip()
    if not key:
        raise SystemExit("DEEPINFRA_API_KEY is not set")
    base = (os.environ.get("DEEPINFRA_BASE_URL") or DEFAULT_DEEPINFRA_BASE_URL).rstrip("/")

    def embed_one(text: str) -> list[float]:
        body = json.dumps({"model": MODEL, "input": [text], "encoding_format": "float"}).encode("utf-8")
        request = urllib.request.Request(
            f"{base}/embeddings",
            data=body,
            headers={"content-type": "application/json", "authorization": f"Bearer {key}"},
            method="POST",
        )
        with urllib.request.urlopen(request, timeout=120) as response:
            data = json.loads(response.read().decode("utf-8"))
        if data.get("model") != MODEL or len(data.get("data") or []) != 1:
            raise SystemExit("hosted answer is not one BAAI/bge-m3 vector")
        return data["data"][0]["embedding"]

    return embed_one


def sidecar_embedder(model_dir: str | None) -> EmbedOne:
    from rag_sidecar.embed import load_from_baked_dir

    directory = model_dir or os.environ.get("BGE_M3_MODEL_DIR") or ""
    if not directory:
        raise SystemExit("set --model-dir or BGE_M3_MODEL_DIR to the baked model directory")
    embedder = load_from_baked_dir(Path(directory), REVISION)
    return lambda text: embedder.embed([text])[0]


def main(argv: Sequence[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--mode", choices=["hosted", "sidecar"])
    parser.add_argument("--out", type=Path)
    parser.add_argument("--texts", type=Path, default=DEFAULT_TEXTS)
    parser.add_argument("--model-dir")
    parser.add_argument("--compare", nargs=2, type=Path, metavar=("A", "B"))
    args = parser.parse_args(argv)

    if args.compare:
        return compare(args.compare[0], args.compare[1])
    if not args.mode or not args.out:
        parser.error("--mode and --out are required unless --compare is given")
    embed_one = hosted_embedder() if args.mode == "hosted" else sidecar_embedder(args.model_dir)
    recording = record(args.mode, args.texts, embed_one)
    args.out.write_text(json.dumps(recording, indent=1, sort_keys=True) + "\n", encoding="utf-8")
    print(f"[BGE-M3 record] {args.mode}: {len(recording['vectors'])} vectors written to {args.out}")
    return EXIT_OK


if __name__ == "__main__":
    sys.exit(main())
