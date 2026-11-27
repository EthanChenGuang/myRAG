import { afterEach, describe, expect, it } from 'vitest';
import type { RpcClient } from '@/lib/rag/backend/supabase-rpc';
import { createPgvectorBackend } from '@/lib/rag/backend/pgvector';
import { loadRagConfig, resetRagConfigForTests } from '@/lib/rag/config';
import { resetRagDepsForTests, setRagDepsForTests } from '@/lib/rag/deps';
import { identifierSuggestions, resolveQueryIdentifiers } from '@/lib/rag/retrieval/identifiers';
import { tableLookup } from '@/lib/rag/retrieval/table-lookup';
import { AccessScopeMissingError, mintAccessScope } from '@/lib/rag/tenant/access';
import { mintScope, withAccess, type TenantScope } from '@/lib/rag/tenant/scope';

// Phase 4.3 plan 11 (D-11, D-30): the TypeScript callers of the Phase 3.2 and 4.2 legs (hybrid_search_translations, rag_table_lookup,
// rag_identifier_resolve, rag_identifier_candidates) send accessRpcArgs(scopeAccessFilter(scope)); an off scope sends today's arguments.

const USER = '00000000-0000-4000-8000-0000000000a1';
const GROUP = 'g:00000000-0000-4000-8000-0000000000f1';

function recorder(rows: Record<string, unknown>[] = []) {
  const calls: Array<{ fn: string; args: Record<string, unknown> }> = [];
  const client = {
    rpc(fn: string, args: Record<string, unknown>) {
      calls.push({ fn, args });
      return { abortSignal: async () => ({ data: rows, error: null }) };
    },
  } as unknown as RpcClient;
  return { client, calls };
}

const offScope = (): TenantScope => mintScope('personal', USER, null);
const keyedScope = (): TenantScope => withAccess(offScope(), mintAccessScope('keys', ['all', GROUP]));
const adminScope = (): TenantScope => withAccess(offScope(), mintAccessScope('admin_all', []));
const signal = () => new AbortController().signal;

type Leg = (scope: TenantScope, client: RpcClient) => Promise<unknown>;

const LEGS: Record<string, Leg> = {
  hybrid_search_translations: (scope, client) =>
    createPgvectorBackend({ adminClient: () => client, getConfig: () => loadRagConfig({ RAG_PIPELINE: 'v2' }) }).searchTranslations!({
      scope,
      embeddingProfileId: 'openai-3-small-1536',
      language: 'en',
      denseVector: null,
      lexicalTokens: ['term'],
      filters: { currentOnly: true },
      denseLimit: 0,
      lexicalLimit: 5,
      signal: signal(),
    }),
  rag_table_lookup: (scope, client) => tableLookup(scope, ['cellalpha', 'cellbeta'], { min_cells: 2, limit: 5 }, { client, signal: signal() }),
  rag_identifier_resolve: (scope, client) => resolveQueryIdentifiers(scope, 'Where is QX-41071?', [], { client, signal: signal() }),
  rag_identifier_candidates: (scope, client) => identifierSuggestions(scope, ['qx41071'], { client, signal: signal() }),
};

afterEach(() => {
  resetRagConfigForTests();
  resetRagDepsForTests();
});

describe('access arguments on the Phase 3.2 and 4.2 legs (04.3-11)', () => {
  for (const [fn, run] of Object.entries(LEGS)) {
    it(`${fn}: off sends no access argument; keys and admin_all add exactly the two`, async () => {
      const off = recorder();
      await run(offScope(), off.client);
      const keyed = recorder();
      await run(keyedScope(), keyed.client);
      const admin = recorder();
      await run(adminScope(), admin.client);

      const offArgs = off.calls.find((call) => call.fn === fn)!.args;
      expect('p_access_keys' in offArgs).toBe(false);
      expect('p_access_all' in offArgs).toBe(false);
      const { p_access_keys, p_access_all, ...rest } = keyed.calls.find((call) => call.fn === fn)!.args;
      expect(rest).toEqual(offArgs);
      expect(p_access_keys).toEqual(['all', GROUP]);
      expect(p_access_all).toBe(false);
      const adminArgs = admin.calls.find((call) => call.fn === fn)!.args;
      expect([adminArgs.p_access_keys, adminArgs.p_access_all]).toEqual([['all'], true]);
    });
  }

  it('an unresolved scope fails closed while RAG_DOC_ACCESS_GROUPS is on (no call is made)', async () => {
    setRagDepsForTests({ ragEnv: () => ({ RAG_DOC_ACCESS_GROUPS: 'on' }) } as never);
    resetRagConfigForTests();
    for (const fn of ['rag_table_lookup', 'rag_identifier_resolve']) {
      const { client, calls } = recorder();
      await expect(LEGS[fn]!(offScope(), client)).rejects.toBeInstanceOf(AccessScopeMissingError);
      expect(calls).toHaveLength(0);
    }
    const suggestions = recorder();
    await expect(LEGS.rag_identifier_candidates!(offScope(), suggestions.client)).resolves.toEqual([]);
    expect(suggestions.calls).toHaveLength(0);
  });
});
