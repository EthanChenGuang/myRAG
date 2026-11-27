import { describe, expect, it } from 'vitest';
import type { RpcClient } from '@/lib/rag/backend/supabase-rpc';
import { resolveHitSources } from '@/lib/rag/cache/sources';
import type { CacheHit } from '@/lib/rag/cache/types';
import { mintScope, scopeKey } from '@/lib/rag/tenant/scope';
import { cachedAnswer } from './fixtures';

const USER_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const DOC_FOREIGN = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const DOC_OWN = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const SCOPE_B = mintScope('personal', USER_B, null);

/** rag_cache_resolve_sources answering the given rows for the request's tenant; every call is recorded. */
function resolver(rows: Array<{ document_id: string; name: string; version: number }>) {
  const calls: Array<{ fn: string; args: Record<string, unknown> }> = [];
  const client = {
    rpc(fn: string, args: Record<string, unknown>) {
      calls.push({ fn, args });
      const response = Promise.resolve({ data: fn === 'rag_cache_resolve_sources' ? rows : [], error: null });
      return Object.assign(response, { abortSignal: () => response });
    },
  } as unknown as RpcClient;
  return { client, calls };
}

function hitWith(sources: Array<{ document_id: string; version: number }>): CacheHit {
  return {
    entryId: 'entry-1',
    distance: 0.01,
    answer: cachedAnswer({
      sources: sources.map((source) => ({ ...source, name: 'placeholder.md' })),
      source_versions: sources.map((source) => ({ document_id: source.document_id, version: source.version })),
    }),
  };
}

describe('cache hit source re-check under the request scope (CACHE-01, plan 07-28)', () => {
  it("a citation-free hit whose sources are another tenant's documents is unresolved under the request scope", async () => {
    const rpc = resolver([]);
    const resolved = await resolveHitSources(SCOPE_B, hitWith([{ document_id: DOC_FOREIGN, version: 1 }]), { client: rpc.client });
    expect(resolved).toEqual({ kind: 'unresolved' });
    expect(rpc.calls).toEqual([{ fn: 'rag_cache_resolve_sources', args: { p_tenant_key: scopeKey(SCOPE_B), p_document_ids: [DOC_FOREIGN] } }]);
  });

  it("a hit naming one own and one foreign document (source versions only) is unresolved", async () => {
    const rpc = resolver([{ document_id: DOC_OWN, name: 'own.md', version: 2 }]);
    const hit: CacheHit = {
      entryId: 'entry-3',
      distance: 0.01,
      answer: cachedAnswer({
        source_versions: [
          { document_id: DOC_OWN, version: 2 },
          { document_id: DOC_FOREIGN, version: 1 },
        ],
      }),
    };
    expect(await resolveHitSources(SCOPE_B, hit, { client: rpc.client })).toEqual({ kind: 'unresolved' });
    expect(rpc.calls[0]?.args).toEqual({ p_tenant_key: scopeKey(SCOPE_B), p_document_ids: [DOC_OWN, DOC_FOREIGN] });
  });

  it("a citation-free hit whose sources are the request tenant's current documents is served with the current names", async () => {
    const rpc = resolver([{ document_id: DOC_OWN, name: 'own-current.md', version: 2 }]);
    const resolved = await resolveHitSources(SCOPE_B, hitWith([{ document_id: DOC_OWN, version: 2 }]), { client: rpc.client });
    expect(resolved.kind).toBe('hit');
    if (resolved.kind === 'hit') expect(resolved.hit.answer.sources).toEqual([{ document_id: DOC_OWN, name: 'own-current.md', version: 2 }]);
  });

  it('a hit with no citation and no source (a refusal) makes no call', async () => {
    const rpc = resolver([]);
    const hit: CacheHit = { entryId: 'entry-2', distance: 0.01, answer: cachedAnswer({ is_refusal: true }) };
    expect(await resolveHitSources(SCOPE_B, hit, { client: rpc.client })).toEqual({ kind: 'hit', hit });
    expect(rpc.calls).toEqual([]);
  });
});
