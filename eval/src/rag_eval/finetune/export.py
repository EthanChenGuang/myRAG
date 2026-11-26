"""python -m rag_eval.finetune export: the tenant-scoped, consent-checked corpus export (D-02, D-09, D-10, D-27, D-28, D-31, D-36).

The export refuses unless RAG_FINETUNE is on, takes an explicit tenant list (no "all"), asks
rag_finetune_consent_for_export for the exact list and purpose before any read, then reads only current, ready rows of each
listed tenant with the service key, keyset-paged by id. Every row's tenant_key is checked again, so a row of another tenant
stops the run and nothing is written. The bundle is staged in a private directory and published as <out>/<run_id> only when
complete. Output and errors carry counts and codes, never chunk text.
"""
import argparse
import hashlib
import os
import re
import shutil
import sys
import tempfile
import uuid
from collections.abc import Iterator, Sequence
from dataclasses import dataclass, field
from datetime import UTC, datetime
from pathlib import Path

import httpx
from rag_sidecar.contracts.finetune import (
    SHA256_PATTERN,
    TENANT_KEY_PATTERN,
    DatasetManifest,
    ExportedChunk,
)
from rag_sidecar.contracts.languages import LANGUAGE_CODES

from rag_eval.corpus import CORPUS_LANGUAGES, load_corpus
from rag_eval.draft.sources import _STORED_PREFIX
from rag_eval.finetune import bundle
from rag_eval.finetune.config import load_finetune_config
from rag_eval.finetune.decontam import (
    golden_test_document_ids,
    golden_test_documents,
    load_golden_items,
)
from rag_eval.finetune.split import FT_SPLIT_RULE, assign_document_split
from rag_eval.paths import REPO_ROOT

ENV_LOCAL_PATH = REPO_ROOT / ".env.local"
FIXTURES_ROOT = REPO_ROOT / "eval" / "fixtures"
DEFAULT_OUT = REPO_ROOT / "eval" / "out" / "finetune"
CONSENT_RPC = "rag_finetune_consent_for_export"
FIXTURE_NAMESPACE = uuid.UUID("6f1c0e9a-3d0b-4c55-9a51-0f7e2b6d1a06")
SPLITS = ("train", "dev", "test")

_TENANT_KEY = re.compile(TENANT_KEY_PATTERN)
_SHA256 = re.compile(SHA256_PATTERN)
_ENV_LINE = re.compile(r"^\s*(?:export\s+)?RAG_FINETUNE\s*=\s*(.*?)\s*$")
_REFUSAL_PREFIX = re.compile(r"^([a-z_]+):")


class ExportRefused(Exception):
    """A refusal with a stable code; the message never carries row content."""

    def __init__(self, code: str, exit_code: int = 2, detail: str = ""):
        super().__init__(f"{code}: {detail}" if detail else code)
        self.code = code
        self.exit_code = exit_code
        self.detail = detail


# --- switch ---------------------------------------------------------------------------------------------------


def _env_local_value(path: Path) -> str | None:
    try:
        lines = Path(path).read_text(encoding="utf-8").splitlines()
    except OSError:
        return None
    value = None
    for line in lines:
        match = _ENV_LINE.match(line)
        if match:
            raw = match.group(1)
            if len(raw) >= 2 and raw[0] == raw[-1] and raw[0] in "'\"":
                raw = raw[1:-1]
            else:
                raw = raw.split("#", 1)[0].strip()
            value = raw
    return value


def finetune_enabled() -> bool:
    """RAG_FINETUNE from the process environment, else from .env.local; only 'on' enables (D-02)."""
    value = os.environ.get("RAG_FINETUNE")
    if value is None:
        value = _env_local_value(ENV_LOCAL_PATH)
    return (value or "").strip().lower() == "on"


# --- arguments ------------------------------------------------------------------------------------------------


def check_tenants(tenants: Sequence[str], purpose: str) -> list[str]:
    if not tenants:
        raise ExportRefused("tenant_required", detail="pass --tenant <key> for every tenant to export (there is no 'all')")
    for key in tenants:
        if not _TENANT_KEY.fullmatch(key):
            raise ExportRefused("tenant_key_invalid", detail="tenant keys are s:default, u:<uuid> or o:<uuid>")
    if len(set(tenants)) != len(tenants):
        raise ExportRefused("tenant_key_duplicate")
    if purpose == "private" and len(tenants) != 1:
        raise ExportRefused("private_takes_one_tenant", detail="--purpose private exports exactly one tenant")
    return sorted(tenants)


def check_fixture_dir(path: Path | str) -> Path:
    """Fixture mode reads only directories under eval/fixtures/ (resolved real path, D-36)."""
    resolved = Path(path).resolve()
    root = Path(FIXTURES_ROOT).resolve()
    if resolved != root and root not in resolved.parents:
        raise ExportRefused("fixture_dir_refused", detail="--source-dir must be a directory under eval/fixtures/")
    if not resolved.is_dir():
        raise ExportRefused("fixture_dir_refused", detail="--source-dir is not a directory")
    return resolved


# --- sources --------------------------------------------------------------------------------------------------


@dataclass(frozen=True)
class SourceDocument:
    id: str
    tenant_key: str
    filename: str
    content_hash: str | None
    language: str | None


@dataclass(frozen=True)
class SourceChunk:
    id: str
    document_id: str
    tenant_key: str
    chunk_index: int | None
    text: str
    content_hash: str | None
    language: str | None


def _valid_hash(value: object) -> str | None:
    return value.lower() if isinstance(value, str) and _SHA256.fullmatch(value.lower()) else None


def _language(value: object) -> str | None:
    return value if isinstance(value, str) and value in LANGUAGE_CODES else None


def _refusal_code(response: httpx.Response) -> str | None:
    try:
        body = response.json()
    except ValueError:
        return None
    message = body.get("message") if isinstance(body, dict) else None
    match = _REFUSAL_PREFIX.match(message) if isinstance(message, str) else None
    return match.group(1) if match else None


class SupabaseExportSource:
    """Supabase REST with the service key; every read is filtered by tenant_key, is_current and status, keyset by id."""

    def __init__(self, url: str, service_key: str, *, client: httpx.Client | None = None, batch_rows: int = 1000):
        self._base = url.rstrip("/") + "/rest/v1"
        self._headers = {"apikey": service_key, "Authorization": f"Bearer {service_key}"}
        self._client = client or httpx.Client(timeout=60.0)
        self._batch = batch_rows

    def consent(self, tenants: list[str], purpose: str) -> None:
        try:
            response = self._client.post(
                f"{self._base}/rpc/{CONSENT_RPC}",
                json={"p_tenant_keys": tenants, "p_purpose": purpose},
                headers=self._headers,
            )
        except httpx.HTTPError as exc:
            raise ExportRefused("consent_check_failed", 1, type(exc).__name__) from None
        if response.status_code == 200:
            granted = response.json()
            if sorted(granted) != sorted(tenants):
                raise ExportRefused("consent_refused", 4, "the consent check did not confirm the exact tenant list")
            return
        code = _refusal_code(response)
        if code == "consent_refused" or response.status_code == 403:
            raise ExportRefused("consent_refused", 4, "a listed tenant's consent does not cover this purpose")
        if code == "tenant_key_invalid":
            raise ExportRefused("tenant_key_invalid", 2, "a tenant key is not valid for this deployment mode")
        raise ExportRefused("consent_check_failed", 1, f"HTTP {response.status_code}")

    def _pages(self, table: str, tenant: str, select: str) -> Iterator[dict]:
        last: str | None = None
        while True:
            params = {
                "select": select,
                "tenant_key": f"eq.{tenant}",
                "is_current": "eq.true",
                "status": "eq.ready",
                "order": "id.asc",
                "limit": str(self._batch),
            }
            if last is not None:
                params["id"] = f"gt.{last}"
            try:
                response = self._client.get(f"{self._base}/{table}", params=params, headers=self._headers)
            except httpx.HTTPError as exc:
                raise ExportRefused("read_failed", 1, f"{table}: {type(exc).__name__}") from None
            if response.status_code != 200:
                raise ExportRefused("read_failed", 1, f"{table}: HTTP {response.status_code}")
            page = response.json()
            if not isinstance(page, list):
                raise ExportRefused("read_failed", 1, f"{table}: unexpected response")
            for row in page:
                if not isinstance(row, dict) or row.get("tenant_key") != tenant:
                    raise ExportRefused("tenant_mismatch", 5, f"{table} returned a row outside the requested tenant")
                yield row
            if len(page) < self._batch:
                return
            last = str(page[-1]["id"])

    def documents(self, tenant: str) -> Iterator[SourceDocument]:
        for row in self._pages("documents", tenant, "id,tenant_key,filename,content_hash,language"):
            yield SourceDocument(
                id=str(row["id"]).lower(),
                tenant_key=tenant,
                filename=str(row.get("filename") or ""),
                content_hash=_valid_hash(row.get("content_hash")),
                language=_language(row.get("language")),
            )

    def chunks(self, tenant: str) -> Iterator[SourceChunk]:
        select = "id,document_id,tenant_key,chunk_index,content,content_hash,language,metadata"
        for row in self._pages("document_chunks", tenant, select):
            metadata = row.get("metadata") if isinstance(row.get("metadata"), dict) else {}
            index = row.get("chunk_index")
            if not isinstance(index, int):
                index = metadata.get("chunk_index") if isinstance(metadata.get("chunk_index"), int) else None
            yield SourceChunk(
                id=str(row["id"]),
                document_id=str(row.get("document_id") or "").lower(),
                tenant_key=tenant,
                chunk_index=index if isinstance(index, int) and index >= 0 else None,
                text=_STORED_PREFIX.sub("", str(row.get("content") or ""), count=1).strip(),
                content_hash=_valid_hash(row.get("content_hash")),
                language=_language(row.get("language")) or _language(metadata.get("language")),
            )


class FixtureExportSource:
    """The committed fixture corpus as one tenant's documents; ids are derived from tenant and path, no HTTP."""

    def __init__(self, path: Path):
        root = check_fixture_dir(path)
        corpus_root, only = root, None
        if root.name in CORPUS_LANGUAGES and not any((root / lang).is_dir() for lang in CORPUS_LANGUAGES):
            corpus_root, only = root.parent, root.name
        self._docs = [doc for doc in load_corpus(corpus_root) if only is None or doc.language == only]

    def consent(self, tenants: list[str], purpose: str) -> None:
        return None

    @staticmethod
    def _doc_id(tenant: str, relpath: str) -> str:
        return str(uuid.uuid5(FIXTURE_NAMESPACE, f"{tenant}:{relpath}"))

    def documents(self, tenant: str) -> Iterator[SourceDocument]:
        for doc in self._docs:
            if doc.chunks:
                yield SourceDocument(
                    id=self._doc_id(tenant, doc.relpath),
                    tenant_key=tenant,
                    filename=doc.filename,
                    content_hash=hashlib.sha256(doc.content.encode("utf-8")).hexdigest(),
                    language=_language(doc.language),
                )

    def chunks(self, tenant: str) -> Iterator[SourceChunk]:
        for doc in self._docs:
            doc_id = self._doc_id(tenant, doc.relpath)
            for chunk in doc.chunks:
                yield SourceChunk(
                    id=str(uuid.uuid5(FIXTURE_NAMESPACE, f"{tenant}:{doc.relpath}:{chunk.index}")),
                    document_id=doc_id,
                    tenant_key=tenant,
                    chunk_index=chunk.index,
                    text=chunk.text,
                    content_hash=None,
                    language=_language(doc.language),
                )


# --- token counting and language -----------------------------------------------------------------------------


def _token_counter():
    """tiktoken through the sidecar chunker (what ingestion counts with); a char/4 estimate when it cannot load."""
    try:
        from rag_sidecar.parse.sentences import count_tokens

        count_tokens("probe")
        return count_tokens, False
    except Exception:  # noqa: BLE001 - any tokenizer load failure falls back to the estimate
        return (lambda text: max(1, len(text) // 4) if text else 0), True


def _detect_language(text: str) -> str | None:
    try:
        from rag_sidecar.ingest.lang import detect_language
    except Exception:  # noqa: BLE001
        return None
    language, _confident = detect_language(text)
    return _language(language)


# --- export ---------------------------------------------------------------------------------------------------


@dataclass
class ExportResult:
    run_dir: Path
    tenants: int
    documents: int = 0
    chunks: dict[str, int] = field(default_factory=lambda: {split: 0 for split in SPLITS})
    golden_test_documents: int = 0
    skipped: dict[str, int] = field(default_factory=dict)
    token_count_estimated: bool = False


def _skip(result: ExportResult, reason: str) -> None:
    result.skipped[reason] = result.skipped.get(reason, 0) + 1


def _now() -> str:
    return datetime.now(UTC).strftime("%Y-%m-%dT%H:%M:%SZ")


def default_run_id() -> str:
    return "ft-" + datetime.now(UTC).strftime("%Y%m%dT%H%M%SZ") + "-" + uuid.uuid4().hex[:6]


def run_export(
    *,
    tenants: Sequence[str],
    purpose: str,
    out: Path,
    source,
    run_id: str | None = None,
    golden_paths: Sequence[Path] | None = None,
) -> ExportResult:
    """Consent first, then read and write each tenant; any refusal leaves no run directory behind."""
    keys = check_tenants(list(tenants), purpose)
    run_id = bundle.check_run_id(run_id or default_run_id())
    out = Path(out)
    final_dir = out / run_id
    if final_dir.exists():
        raise ExportRefused("run_exists", detail="the run directory already exists")

    source.consent(keys, purpose)

    golden_items = load_golden_items(golden_paths)
    forced_names = {name.casefold() for name in golden_test_documents(golden_items)}
    forced_ids = golden_test_document_ids(golden_items)
    count_tokens, estimated = _token_counter()

    out.mkdir(parents=True, exist_ok=True)
    staging = Path(tempfile.mkdtemp(prefix=".partial-", dir=out))
    os.chmod(staging, 0o700)
    result = ExportResult(run_dir=final_dir, tenants=len(keys), token_count_estimated=estimated)
    writer = bundle.JsonlWriter(staging / bundle.CHUNKS_FILE, ExportedChunk)
    try:
        for tenant in keys:
            docs: dict[str, tuple[SourceDocument, str, bool]] = {}
            for doc in source.documents(tenant):
                if doc.tenant_key != tenant:
                    raise ExportRefused("tenant_mismatch", 5, "a document outside the requested tenant")
                forced = doc.id in forced_ids or (doc.filename.casefold() in forced_names if doc.filename else False)
                docs[doc.id] = (doc, assign_document_split(tenant, doc.id, doc.content_hash, forced_test=forced), forced)
            result.documents += len(docs)
            result.golden_test_documents += sum(1 for _, _, forced in docs.values() if forced)
            running_index: dict[str, int] = {}
            for chunk in source.chunks(tenant):
                if chunk.tenant_key != tenant:
                    raise ExportRefused("tenant_mismatch", 5, "a chunk outside the requested tenant")
                entry = docs.get(chunk.document_id)
                if entry is None:
                    _skip(result, "document_not_ready")
                    continue
                doc, split, forced = entry
                if not chunk.text:
                    _skip(result, "empty_text")
                    continue
                language = chunk.language or doc.language or _detect_language(chunk.text)
                if language is None:
                    _skip(result, "language_unknown")
                    continue
                index = chunk.chunk_index
                if index is None:
                    index = running_index.get(doc.id, 0)
                running_index[doc.id] = max(running_index.get(doc.id, 0), index + 1)
                writer.write(
                    ExportedChunk(
                        tenant_key=tenant,
                        document_id=doc.id,
                        chunk_id=chunk.id,
                        chunk_index=index,
                        content_hash=chunk.content_hash or hashlib.sha256(chunk.text.encode("utf-8")).hexdigest(),
                        document_content_hash=doc.content_hash,
                        language=language,
                        split=split,
                        text=chunk.text,
                        token_count=count_tokens(chunk.text),
                        is_golden_test_evidence=forced,
                    )
                )
                result.chunks[split] += 1
        chunks_sha = writer.close()
        manifest = DatasetManifest(
            run_id=run_id,
            purpose=purpose,
            split_rule=FT_SPLIT_RULE,
            tenant_keys=keys,
            chunks=dict(result.chunks),
            counts={},
            files={bundle.CHUNKS_FILE: chunks_sha},
            created_at=_now(),
        )
        bundle.write_manifest(staging, manifest)
        if final_dir.exists():
            raise ExportRefused("run_exists", detail="the run directory already exists")
        os.rename(staging, final_dir)
    except BaseException:
        writer.abort()
        shutil.rmtree(staging, ignore_errors=True)
        raise
    return result


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="python -m rag_eval.finetune export", description=__doc__.split("\n", 1)[0])
    parser.add_argument("--tenant", action="append", default=[], help="tenant key to export (repeat for each tenant)")
    parser.add_argument("--purpose", required=True, choices=["private", "deployment"])
    parser.add_argument("--out", type=Path, default=None, help="bundle root (default eval/out/finetune)")
    parser.add_argument("--run-id", default=None)
    parser.add_argument("--source-dir", type=Path, default=None, help="fixture mode: a directory under eval/fixtures/")
    parser.add_argument("--golden", type=Path, action="append", default=None, help="golden file(s); default fixture + private")
    parser.add_argument("--batch-rows", type=int, default=None)
    parser.add_argument("--config", type=Path, default=None)
    return parser


def _print_result(result: ExportResult) -> None:
    chunks = " ".join(f"{split}={result.chunks[split]}" for split in SPLITS)
    print(
        f"[Finetune] export run_id={result.run_dir.name} tenants={result.tenants} documents={result.documents} "
        f"chunks {chunks} golden_test_documents={result.golden_test_documents}"
    )
    if result.skipped:
        print("[Finetune] skipped " + " ".join(f"{reason}={count}" for reason, count in sorted(result.skipped.items())))
    if result.token_count_estimated:
        print("[Finetune] token_count=estimated (tokenizer unavailable)")


def main(argv: Sequence[str] | None = None, *, client: httpx.Client | None = None) -> int:
    try:
        args = _parser().parse_args(list(sys.argv[1:] if argv is None else argv))
    except SystemExit as exc:
        return int(exc.code or 0)
    if not finetune_enabled():
        print("[Finetune] export refused: RAG_FINETUNE is off", file=sys.stderr)
        return 3
    try:
        check_tenants(args.tenant, args.purpose)
        run_id = bundle.check_run_id(args.run_id or default_run_id())
        out = args.out if args.out is not None else DEFAULT_OUT
        if (Path(out) / run_id).exists():
            raise ExportRefused("run_exists", detail="the run directory already exists")
        config = load_finetune_config(args.config)
        if args.source_dir is not None:
            source = FixtureExportSource(args.source_dir)
        else:
            url = os.environ.get("NEXT_PUBLIC_SUPABASE_URL")
            key = os.environ.get("SUPABASE_SERVICE_ROLE_KEY")
            if not url or not key:
                raise ExportRefused(
                    "supabase_not_configured", detail="NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set"
                )
            batch = args.batch_rows if args.batch_rows is not None else config.export.batch_rows
            if not 1 <= batch <= 10_000:
                raise ExportRefused("batch_rows_invalid", detail="--batch-rows must be 1..10000")
            source = SupabaseExportSource(url, key, client=client, batch_rows=batch)
        result = run_export(
            tenants=args.tenant, purpose=args.purpose, out=out, source=source, run_id=run_id, golden_paths=args.golden
        )
    except ExportRefused as exc:
        print(f"[Finetune] export refused: {exc}", file=sys.stderr)
        return exc.exit_code
    except ValueError as exc:
        print(f"[Finetune] export refused: invalid_argument: {type(exc).__name__}", file=sys.stderr)
        return 2
    _print_result(result)
    return 0
