import re
import uuid
from pathlib import Path
from typing import Protocol

import httpx
from pydantic import BaseModel, ConfigDict

from rag_eval.corpus import CORPUS_LANGUAGES, load_corpus

PAGE_SIZE = 1000
ID_BATCH = 100
_STORED_PREFIX = re.compile(r"^Document: .*?\. Chunk \d+ of \d+\. Content: ", re.DOTALL)
_PLAIN_SUFFIXES = {".md", ".txt"}


class WorkspaceDocument(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)

    id: str
    filename: str
    chunks: list[str]


class WorkspaceSource(Protocol):
    def documents(self) -> list[WorkspaceDocument]: ...


class DirectoryWorkspaceSource:
    def __init__(self, path: Path | str):
        self.path = Path(path)

    def documents(self) -> list[WorkspaceDocument]:
        root = self.path
        if not root.is_dir():
            raise FileNotFoundError(f"source directory not found: {root.name}")
        corpus_root, only_language = root, None
        if root.name in CORPUS_LANGUAGES and not any((root / lang).is_dir() for lang in CORPUS_LANGUAGES):
            corpus_root, only_language = root.parent, root.name

        documents: list[WorkspaceDocument] = []
        seen: set[Path] = set()
        for doc in load_corpus(corpus_root):
            resolved = (corpus_root / doc.relpath).resolve()
            if only_language is not None and doc.language != only_language:
                continue
            seen.add(resolved)
            if doc.chunks:
                documents.append(
                    WorkspaceDocument(id=doc.relpath, filename=doc.filename, chunks=[chunk.text for chunk in doc.chunks])
                )
        for file in sorted(root.rglob("*")):
            if not file.is_file() or file.suffix.lower() not in _PLAIN_SUFFIXES or file.resolve() in seen:
                continue
            text = file.read_bytes().decode("utf-8", errors="replace").replace("\r\n", "\n").strip()
            if text:
                documents.append(WorkspaceDocument(id=file.relative_to(root).as_posix(), filename=file.name, chunks=[text]))
        return sorted(documents, key=lambda doc: (doc.filename, doc.id))


_MISSING_COLUMN_CODES = {"42703", "PGRST204"}


def _error_code(response: httpx.Response) -> str | None:
    try:
        body = response.json()
    except ValueError:
        return None
    return str(body.get("code")) if isinstance(body, dict) and body.get("code") is not None else None


def _as_uuid(value: str, label: str) -> str:
    try:
        return str(uuid.UUID(str(value)))
    except ValueError as exc:
        raise ValueError(f"{label} must be a UUID") from exc


class SupabaseWorkspaceSource:
    def __init__(
        self,
        url: str,
        service_key: str,
        *,
        organization_id: str | None = None,
        user_id: str | None = None,
        single_tenant: bool = False,
        client: httpx.Client | None = None,
    ):
        scopes = [organization_id is not None, user_id is not None, bool(single_tenant)]
        if sum(scopes) != 1:
            raise ValueError("exactly one of organization_id, user_id or single_tenant=True is required")
        self._single_tenant = bool(single_tenant)
        self._filters: dict[str, str] = {}
        if organization_id is not None:
            self._filters["organization_id"] = f"eq.{_as_uuid(organization_id, 'organization_id')}"
        elif user_id is not None:
            self._filters["user_id"] = f"eq.{_as_uuid(user_id, 'user_id')}"
            self._filters["organization_id"] = "is.null"
        else:
            self._filters["organization_id"] = "is.null"
        self._base = url.rstrip("/") + "/rest/v1"
        self._headers = {"apikey": service_key, "Authorization": f"Bearer {service_key}"}
        self._client = client or httpx.Client(timeout=60.0)

    def _probe(self, table: str, params: dict[str, str]) -> httpx.Response:
        try:
            return self._client.get(f"{self._base}/{table}", params={**params, "limit": "1"}, headers=self._headers)
        except httpx.HTTPError as exc:
            raise RuntimeError(f"Supabase request on {table} failed: {type(exc).__name__}") from None

    def _assert_single_tenant(self) -> None:
        owners = self._probe("documents", {"select": "user_id"})
        if owners.status_code == 200:
            raise RuntimeError(
                "--single-tenant refused: documents.user_id exists, so this is a multi-tenant database; use --org or --user"
            )
        if owners.status_code != 400 or _error_code(owners) not in _MISSING_COLUMN_CODES:
            raise RuntimeError(
                f"--single-tenant refused: could not confirm a single-tenant schema (HTTP {owners.status_code})"
            )
        orgs = self._probe("documents", {"select": "id", "organization_id": "not.is.null"})
        if orgs.status_code != 200:
            raise RuntimeError(
                f"--single-tenant refused: could not confirm a single-tenant schema (HTTP {orgs.status_code})"
            )
        if orgs.json():
            raise RuntimeError(
                "--single-tenant refused: documents belong to an organization, so this is a multi-tenant database; use --org"
            )

    def _get(self, table: str, params: dict[str, str]) -> list[dict]:
        rows: list[dict] = []
        offset = 0
        while True:
            page_params = {**params, "limit": str(PAGE_SIZE), "offset": str(offset)}
            try:
                response = self._client.get(f"{self._base}/{table}", params=page_params, headers=self._headers)
                response.raise_for_status()
            except httpx.HTTPStatusError as exc:
                raise RuntimeError(f"Supabase request on {table} failed with HTTP {exc.response.status_code}") from None
            except httpx.HTTPError as exc:
                raise RuntimeError(f"Supabase request on {table} failed: {type(exc).__name__}") from None
            page = response.json()
            rows.extend(page)
            if len(page) < PAGE_SIZE:
                return rows
            offset += PAGE_SIZE

    def documents(self) -> list[WorkspaceDocument]:
        if self._single_tenant:
            self._assert_single_tenant()
        doc_rows = self._get("documents", {"select": "id,filename", "order": "id.asc", **self._filters})
        names = {str(row["id"]): str(row["filename"]) for row in doc_rows}
        ids = sorted(names)
        chunks: dict[str, list[tuple[int, str, str]]] = {doc_id: [] for doc_id in ids}
        for start in range(0, len(ids), ID_BATCH):
            batch = ids[start : start + ID_BATCH]
            rows = self._get(
                "document_chunks",
                {
                    "select": "id,document_id,content,metadata",
                    "document_id": f"in.({','.join(batch)})",
                    "order": "id.asc",
                },
            )
            for row in rows:
                doc_id = str(row.get("document_id"))
                if doc_id not in chunks:
                    continue
                metadata = row.get("metadata") if isinstance(row.get("metadata"), dict) else {}
                index = metadata.get("chunk_index")
                order = index if isinstance(index, int) else 10**9
                chunks[doc_id].append((order, str(row["id"]), _STORED_PREFIX.sub("", str(row["content"]), count=1)))
        documents = [
            WorkspaceDocument(id=doc_id, filename=names[doc_id], chunks=[text for _, _, text in sorted(chunks[doc_id])])
            for doc_id in ids
            if chunks[doc_id]
        ]
        return sorted(documents, key=lambda doc: (doc.filename, doc.id))
