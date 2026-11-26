import httpx
import pytest

from rag_eval.corpus import load_corpus
from rag_eval.draft import sources
from rag_eval.draft.sources import DirectoryWorkspaceSource, SupabaseWorkspaceSource
from rag_eval.paths import REPO_ROOT

ORG = "11111111-1111-4111-8111-111111111111"
USER = "22222222-2222-4222-8222-222222222222"
KEY = "test-service-key-not-real-0001"
URL = "https://example-project.supabase.co"


MISSING_USER_ID = {"code": "42703", "message": "column documents.user_id does not exist"}


class Recorder:
    def __init__(self, documents, chunks, *, multi_tenant: bool = False):
        self.documents = documents
        self.chunks = chunks
        self.multi_tenant = multi_tenant
        self.requests: list[httpx.Request] = []

    def handler(self, request: httpx.Request) -> httpx.Response:
        self.requests.append(request)
        params = request.url.params
        offset = int(params.get("offset", "0"))
        limit = int(params.get("limit", "1000"))
        if request.url.path.endswith("/documents"):
            rows = self.documents
            if "user_id" in params.get("select", "").split(","):
                if not self.multi_tenant:
                    return httpx.Response(400, json=MISSING_USER_ID)
                rows = [{"user_id": row.get("user_id")} for row in rows]
            if params.get("organization_id") == "not.is.null":
                rows = [row for row in rows if row.get("organization_id")]
            elif params.get("organization_id") == "is.null":
                rows = [row for row in rows if not row.get("organization_id")]
        else:
            wanted = set(params["document_id"].removeprefix("in.(").removesuffix(")").split(","))
            rows = [row for row in self.chunks if row["document_id"] in wanted or row["document_id"].startswith("foreign")]
        return httpx.Response(200, json=rows[offset : offset + limit])

    def source(self, **scope):
        client = httpx.Client(transport=httpx.MockTransport(self.handler))
        return SupabaseWorkspaceSource(URL, KEY, client=client, **scope)

    def of(self, table: str) -> list[httpx.Request]:
        return [r for r in self.requests if r.url.path.endswith(f"/{table}")]


def _chunk(doc: str, index: int, text: str, chunk_id: str | None = None) -> dict:
    return {
        "id": chunk_id or f"{doc}-c{index}",
        "document_id": doc,
        "content": f"Document: f.md. Chunk {index + 1} of 2. Content: {text}",
        "metadata": {"chunk_index": index},
    }


def test_zero_scopes_is_refused():
    with pytest.raises(ValueError, match="exactly one"):
        SupabaseWorkspaceSource(URL, KEY)


def test_two_scopes_are_refused():
    with pytest.raises(ValueError, match="exactly one"):
        SupabaseWorkspaceSource(URL, KEY, organization_id=ORG, user_id=USER)
    with pytest.raises(ValueError, match="exactly one"):
        SupabaseWorkspaceSource(URL, KEY, organization_id=ORG, single_tenant=True)


def test_scope_values_must_be_uuids():
    with pytest.raises(ValueError, match="UUID"):
        SupabaseWorkspaceSource(URL, KEY, organization_id="x&or=(id.not.is.null)")


def test_organization_scope_filters_every_documents_request():
    rec = Recorder([{"id": "d1", "filename": "a.md"}], [_chunk("d1", 0, "alpha text")])
    rec.source(organization_id=ORG).documents()
    docs_requests = rec.of("documents")
    assert docs_requests
    for request in docs_requests:
        assert request.url.params["organization_id"] == f"eq.{ORG}"
        assert "user_id" not in request.url.params


def test_personal_scope_filters_user_and_null_organization():
    rec = Recorder([{"id": "d1", "filename": "a.md"}], [_chunk("d1", 0, "alpha text")])
    rec.source(user_id=USER).documents()
    for request in rec.of("documents"):
        assert request.url.params["user_id"] == f"eq.{USER}"
        assert request.url.params["organization_id"] == "is.null"


def test_single_tenant_scope_must_be_explicit_and_filters_null_organization():
    rec = Recorder([{"id": "d1", "filename": "a.md"}], [_chunk("d1", 0, "alpha text")])
    docs = rec.source(single_tenant=True).documents()
    assert [doc.filename for doc in docs] == ["a.md"]
    reads = [r for r in rec.of("documents") if r.url.params.get("select") == "id,filename"]
    assert reads
    for request in reads:
        assert request.url.params["organization_id"] == "is.null"


def test_single_tenant_scope_is_refused_on_a_multi_tenant_database():
    documents = [
        {"id": "d1", "filename": "a.md", "user_id": USER, "organization_id": None},
        {"id": "d2", "filename": "b.md", "user_id": "33333333-3333-4333-8333-333333333333", "organization_id": None},
    ]
    rec = Recorder(documents, [_chunk("d1", 0, "user one text"), _chunk("d2", 0, "user two text")], multi_tenant=True)
    with pytest.raises(RuntimeError, match="--single-tenant refused"):
        rec.source(single_tenant=True).documents()
    assert not rec.of("document_chunks")
    assert all(r.url.params.get("select") != "id,filename" for r in rec.of("documents"))


def test_single_tenant_scope_is_refused_even_with_one_multi_tenant_owner():
    documents = [{"id": "d1", "filename": "a.md", "user_id": USER, "organization_id": None}]
    rec = Recorder(documents, [_chunk("d1", 0, "only user text")], multi_tenant=True)
    with pytest.raises(RuntimeError, match="multi-tenant"):
        rec.source(single_tenant=True).documents()
    assert not rec.of("document_chunks")


def test_single_tenant_scope_is_refused_when_documents_belong_to_an_organization():
    documents = [
        {"id": "d1", "filename": "a.md", "organization_id": None},
        {"id": "d2", "filename": "b.md", "organization_id": ORG},
    ]
    rec = Recorder(documents, [_chunk("d1", 0, "a"), _chunk("d2", 0, "b")])
    with pytest.raises(RuntimeError, match="organization"):
        rec.source(single_tenant=True).documents()
    assert not rec.of("document_chunks")


@pytest.mark.parametrize(
    "response",
    [
        httpx.Response(401, json={"message": "invalid key"}),
        httpx.Response(400, json={"code": "PGRST100", "message": "parse error"}),
        httpx.Response(500, text="boom"),
    ],
)
def test_single_tenant_scope_is_refused_when_the_schema_cannot_be_confirmed(response):
    requests: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        requests.append(request)
        return response

    client = httpx.Client(transport=httpx.MockTransport(handler))
    with pytest.raises(RuntimeError, match="could not confirm"):
        SupabaseWorkspaceSource(URL, KEY, single_tenant=True, client=client).documents()
    assert len(requests) == 1
    assert requests[0].url.params["limit"] == "1"


def test_chunk_requests_name_only_returned_document_ids_in_batches_of_100():
    documents = [{"id": f"d{i:03d}", "filename": f"f{i:03d}.md"} for i in range(250)]
    chunks = [_chunk(row["id"], 0, f"text {row['id']}") for row in documents]
    rec = Recorder(documents, chunks)
    docs = rec.source(organization_id=ORG).documents()
    assert len(docs) == 250
    returned = {row["id"] for row in documents}
    chunk_requests = rec.of("document_chunks")
    assert len(chunk_requests) == 3
    seen: set[str] = set()
    for request in chunk_requests:
        ids = request.url.params["document_id"].removeprefix("in.(").removesuffix(")").split(",")
        assert len(ids) <= 100
        assert set(ids) <= returned
        seen.update(ids)
    assert seen == returned


def test_foreign_chunk_rows_are_dropped():
    rec = Recorder(
        [{"id": "d1", "filename": "a.md"}],
        [_chunk("d1", 0, "own text"), _chunk("foreign-doc", 0, "other tenant secret", chunk_id="x1")],
    )
    docs = rec.source(organization_id=ORG).documents()
    assert [doc.filename for doc in docs] == ["a.md"]
    assert docs[0].chunks == ["own text"]


def test_chunks_are_ordered_by_chunk_index_and_stored_prefix_is_removed():
    rec = Recorder(
        [{"id": "d1", "filename": "a.md"}],
        [_chunk("d1", 1, "second part"), _chunk("d1", 0, "first part")],
    )
    docs = rec.source(single_tenant=True).documents()
    assert docs[0].chunks == ["first part", "second part"]


def test_paging_uses_limit_and_offset(monkeypatch):
    monkeypatch.setattr(sources, "PAGE_SIZE", 2)
    documents = [{"id": f"d{i}", "filename": f"f{i}.md"} for i in range(5)]
    chunks = [_chunk(row["id"], 0, f"text {row['id']}") for row in documents]
    rec = Recorder(documents, chunks)
    docs = rec.source(organization_id=ORG).documents()
    assert len(docs) == 5
    offsets = [r.url.params["offset"] for r in rec.of("documents")]
    assert offsets == ["0", "2", "4"]


def test_service_key_only_in_headers():
    rec = Recorder([{"id": "d1", "filename": "a.md"}], [_chunk("d1", 0, "alpha text")])
    rec.source(organization_id=ORG).documents()
    assert rec.requests
    for request in rec.requests:
        assert KEY not in str(request.url)
        assert request.headers["apikey"] == KEY
        assert request.headers["authorization"] == f"Bearer {KEY}"


def test_http_failure_message_carries_no_key_or_content():
    def failing(request: httpx.Request) -> httpx.Response:
        return httpx.Response(500, text="secret customer text")

    client = httpx.Client(transport=httpx.MockTransport(failing))
    source = SupabaseWorkspaceSource(URL, KEY, organization_id=ORG, client=client)
    with pytest.raises(RuntimeError) as excinfo:
        source.documents()
    assert KEY not in str(excinfo.value)
    assert "secret customer text" not in str(excinfo.value)


# Plan 04.2-37: 36 Phase 4.2 documents in en and zh, 37 in it (30 generated copies of a template each).
def test_directory_source_matches_corpus_output_for_one_language():
    docs = DirectoryWorkspaceSource(REPO_ROOT / "eval" / "fixtures" / "corpus" / "en").documents()
    expected = [d for d in load_corpus(REPO_ROOT / "eval" / "fixtures" / "corpus") if d.language == "en"]
    assert len(docs) == 7 + 36
    assert sorted(d.id for d in docs) == sorted(d.relpath for d in expected)
    by_relpath = {d.relpath: d for d in expected}
    for doc in docs:
        assert doc.chunks == [chunk.text for chunk in by_relpath[doc.id].chunks]


def test_directory_source_reads_every_language_and_plain_files(tmp_path):
    docs = DirectoryWorkspaceSource(REPO_ROOT / "eval" / "fixtures" / "corpus").documents()
    assert len(docs) == 19 + 36 + 36 + 37
    (tmp_path / "notes.txt").write_text("A plain note about widgets.", encoding="utf-8")
    (tmp_path / "empty.md").write_text("  \n", encoding="utf-8")
    plain = DirectoryWorkspaceSource(tmp_path).documents()
    assert [(d.filename, d.chunks) for d in plain] == [("notes.txt", ["A plain note about widgets."])]


def test_directory_source_does_not_read_a_corpus_template_as_a_plain_file(tmp_path):
    (tmp_path / "en").mkdir()
    meta = '{"generate":{"count":2,"name":"copy-{n}.en.md","substitutions":[],"template_id":"t-en"}}'
    (tmp_path / "en" / "passage.template.en.md").write_text(f"<!-- fixture-meta {meta} -->\n## Heading\n\nShared text.\n", encoding="utf-8")
    docs = DirectoryWorkspaceSource(tmp_path).documents()
    assert sorted(d.id for d in docs) == ["en/copy-01.en.md", "en/copy-02.en.md"]


def test_directory_source_with_no_documents_is_empty(tmp_path):
    assert DirectoryWorkspaceSource(tmp_path).documents() == []
