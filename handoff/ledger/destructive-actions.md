## 2026-11-26 ~23:15Z prod ppvywaxrycaxrtrrditl — owner-requested delete of old duplicate CV
- documents.id dc833db3-ffd6-41be-99f4-08e672a8f63e (ChenG_CV.pdf, created 2026-11-25 21:07Z, tenant u:3ebd4f30-..., legacy writer, source_key legacy:<id>, 15 chunks, no original_path)
- Kept: c752666d-c91d-4233-a404-003b93721176 (ChenG_CV.pdf 2026-11-26, 19 chunks)
- Method: same as DELETE /api/documents/[id]: delete document_chunks of lineage, then documents row(s) of lineage in tenant.
- Backup: source PDF still with owner; no storage object existed.
## 2026-11-26 ~23:20Z prod — owner-requested delete of AI-answer note
- documents.id 8c032eaa-8ebf-403e-b796-79718b362c0b ("# Duration at Oracle Italia…" .md, 1 chunk, saved AI answer with stale date). Same method as DELETE /api/documents/[id].
- storage.objects rows for 8c032eaa (original.md, parse.md) deleted via SQL; underlying blob may remain orphaned in bucket rag-originals.
## 2026-11-26T23:43Z prod — owner-requested cleanup of preview versioning test: lineage 5b72765c-842a-4c24-bb93-ce0c2a02d739 (version-test.txt v1+v2, 2 chunks), 4 storage.objects rows in rag-originals. Test data only.
