import type { SupabaseClient } from '@supabase/supabase-js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fetchServableChunks } from '@/lib/rag/feedback-loop/review-access';

// T-04.3-131 (G6): while access groups are on, fetchServableChunks serves no text when the live visibility check cannot run.

const CHUNK = '00000000-0000-4000-8000-00000000c6a1';
const DOC = '00000000-0000-4000-8000-00000000c6d1';
const EXPERT = '00000000-0000-4000-8000-00000000c6e1';

function fakeAdmin(options: { rpcError?: boolean } = {}) {
  const tables: string[] = [];
  const rpcs: string[] = [];
  const rows: Record<string, Record<string, unknown>[]> = {
    document_chunks: [{ id: CHUNK, document_id: DOC, content: 'Synthetic sentence.', section_path: [], tenant_key: 's:default', is_current: true, status: 'ready' }],
    documents: [{ id: DOC, filename: 'sample.txt', tenant_key: 's:default', is_current: true, status: 'ready' }],
  };
  const query = (table: string) => {
    const chain = {
      select: () => chain,
      in: () => chain,
      eq: () => chain,
      then: (resolve: (value: unknown) => unknown) => resolve({ data: rows[table] ?? [], error: null }),
    };
    return chain;
  };
  const client = {
    from: (table: string) => {
      tables.push(table);
      return query(table);
    },
    rpc: (name: string) => {
      rpcs.push(name);
      const result = Promise.resolve(options.rpcError ? { data: null, error: { code: 'PGRST500', message: 'failed' } } : { data: [], error: null });
      return Object.assign(result, { abortSignal: () => result });
    },
  };
  return { client: client as unknown as SupabaseClient, tables, rpcs };
}

beforeEach(() => {
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('fetchServableChunks fails closed while access is on', () => {
  it('reads no chunk text without a viewer', async () => {
    const admin = fakeAdmin();
    const served = await fetchServableChunks(admin.client, 's:default', [CHUNK], { accessOn: () => true });
    expect(served.size).toBe(0);
    expect(admin.tables).not.toContain('document_chunks');
  });

  it('reads no chunk text when the access lookup fails', async () => {
    const admin = fakeAdmin({ rpcError: true });
    const served = await fetchServableChunks(admin.client, 's:default', [CHUNK], { accessOn: () => true, viewer: { kind: 'expert', userId: EXPERT } });
    expect(served.size).toBe(0);
    expect(admin.tables).not.toContain('document_chunks');
  });

  it('reads as today while access is off, with no visibility call', async () => {
    const admin = fakeAdmin();
    const served = await fetchServableChunks(admin.client, 's:default', [CHUNK], { accessOn: () => false });
    expect([...served.keys()]).toEqual([CHUNK]);
    expect(admin.rpcs).toEqual([]);
  });
});
