import json, sys
E = json.load(open(sys.argv[1]))
MB = 1024 * 1024
# Per-row byte model (PostgreSQL 15/16, pgvector >= 0.7, HNSW m=64, ef_construction=200). See DRY-RUN.md "Size model".
ROW_FIXED = 420        # tuple header + uuid/int/bool/date/text scalar columns of document_chunks
META = 600             # metadata jsonb (section_path, pages, urls, profile ids)
BTREE = 350            # ~9 btree indexes on document_chunks + scopes GIN
LEX_TEXT, LEX_TSV, LEX_GIN = 1.0, 0.8, 0.5   # x content bytes: lexical_text column, lexical_tsv, GIN index
PARENT_FIXED = 230     # document_parents tuple + 2 btree indexes
CE_FIXED = 280         # chunk_embeddings tuple w/o vector + PK + (profile_id, tenant_key) index
VEC = {  # heap (incl. TOAST overhead) + HNSW bytes per vector; HNSW = 8 KB page / elements per page
    'openai-3-small-1536 vector': (6300, 8192, 'legacy column on document_chunks'),
    'qwen3-8b-2048 halfvec': (4250, 8192, 'chunk_embeddings'),
    'qwen3-8b-1024 halfvec': (2150, 4096, 'chunk_embeddings'),
    'it-768 vector (float32)': (3150, 4096, 'new storage needed'),
    'it-768 halfvec': (1600, 2731, 'chunk_embeddings + new profile/index'),
}
def per_vec(name):
    heap, hnsw, where = VEC[name]
    return heap + hnsw + (0 if where.startswith('legacy') else CE_FIXED)

sets = {
    'B (repo default general@1 512/64, legacy chunk set)': dict(n=E['B_chunks'], bytes=E['B_bytes'], parents=0, pbytes=0, embed=E['B_embed_tokens']),
    'A (QRD parents + ~300-tok children, 12% overlap, prefix)': dict(n=E['A_chunks'], bytes=E['A_content_bytes'], parents=E['A_parents'], pbytes=E['parent_text_bytes'], embed=E['A_embed_tokens']),
}
sets['A+B (v2 writes the legacy set and every live profile)'] = {k: sets['A (QRD parents + ~300-tok children, 12% overlap, prefix)'][k] + sets['B (repo default general@1 512/64, legacy chunk set)'][k] for k in ('n', 'bytes', 'parents', 'pbytes', 'embed')}

def base_mb(s):
    rows = s['n'] * (ROW_FIXED + META + BTREE) + s['bytes'] * (1 + LEX_TEXT + LEX_TSV + LEX_GIN)
    par = s['parents'] * PARENT_FIXED + s['pbytes']
    return (rows + par) / MB

combos = [
    ['openai-3-small-1536 vector'],
    ['qwen3-8b-2048 halfvec'],
    ['qwen3-8b-1024 halfvec'],
    ['it-768 vector (float32)'],
    ['it-768 halfvec'],
    ['openai-3-small-1536 vector', 'qwen3-8b-2048 halfvec'],
    ['openai-3-small-1536 vector', 'qwen3-8b-1024 halfvec'],
    ['qwen3-8b-2048 halfvec', 'qwen3-8b-1024 halfvec'],
    ['openai-3-small-1536 vector', 'qwen3-8b-2048 halfvec', 'qwen3-8b-1024 halfvec'],
    ['openai-3-small-1536 vector', 'it-768 halfvec'],
    ['qwen3-8b-1024 halfvec', 'it-768 halfvec'],
]
FIXED_OVERHEAD = 45  # MB: Supabase system schemas + myRAG schema (100+ migrations), documents/versions/jobs rows, small tables
out = {'per_vector_bytes': {k: per_vec(k) for k in VEC}, 'sets': {}}
for sname, s in sets.items():
    b = base_mb(s); rows = []
    for c in combos:
        v = sum(s['n'] * per_vec(x) for x in c) / MB
        tot = FIXED_OVERHEAD + b + v
        rows.append(dict(profiles=' + '.join(c), text_lex_parents_mb=round(b, 1), vectors_mb=round(v, 1), total_mb=round(tot, 1),
                         with_20pct_bloat_mb=round(FIXED_OVERHEAD + (b + v) * 1.2, 1)))
    out['sets'][sname] = dict(chunks=int(s['n']), parents=int(s['parents']), embed_tokens=int(s['embed']), rows=rows)
# costs
price = {'qwen3-8b @ $0.01/MTok (DeepInfra / catalog)': 0.01, 'qwen3-8b @ $0.04/MTok (OpenRouter high)': 0.04, 'openai-3-small @ $0.02/MTok': 0.02}
out['embed_cost_usd'] = {sname: {p: round(s['embed'] / 1e6 * v, 3) for p, v in price.items()} for sname, s in sets.items()}
out['parse_cost_usd'] = {
    'docling sidecar (local)': 0.0,
    'backfill projection at assumed $0.001/page (structured tier, parse-routing.json)': round(E['pages'] * 0.001, 2),
    'LlamaParse premium tier at $0.004/page (parse-routing.json)': round(E['pages'] * 0.004, 2),
}
print(json.dumps(out, indent=1))
