import crypto from 'node:crypto';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import type { PGlite } from '@electric-sql/pglite';
import { FIXTURE_USER_ID } from '../../eval/harness/pglite-supabase.mts';
import type { RpcClient, RpcRequest, RpcResponse } from '@/lib/rag/backend/supabase-rpc';
import type { TenantScope } from '@/lib/rag/tenant/scope';

/**
 * 04.2-36, T-04.2-124: through the eval route in multi-tenant mode, a missing identifier is refused with suggestions from the
 * caller's tenant only. The single-tenant route case lives in identifier-filter.test.mts (the deployment mode is per process).
 * Synthetic neutral identifiers only.
 */
type Row = Record<string, unknown>;

const USER_B = '00000000-0000-4000-8000-0000000036b2';
const NO_PATTERNS = async () => ({ expressions: Object.freeze([]) as readonly RegExp[], patternIds: Object.freeze([]) as readonly string[], loadFailed: false });
const FILTER_ON = { RAG_IDENTIFIER_INDEX: 'true', RAG_IDENTIFIER_FILTER: 'true' };

function sqlState(error: unknown): string {
  return typeof (error as { code?: unknown } | null)?.code === 'string' ? (error as { code: string }).code : '';
}

function serviceRpc(db: PGlite): RpcClient {
  return {
    rpc(fn, args) {
      const keys = Object.keys(args);
      const sql = `SELECT * FROM public.${fn}(${keys.map((key, index) => `${key} => $${index + 1}`).join(', ')})`;
      const values = keys.map((key) => {
        const value = args[key];
        return value !== null && typeof value === 'object' && !Array.isArray(value) ? JSON.stringify(value) : value;
      });
      const run = db
        .transaction(async (tx) => {
          await tx.exec('SET LOCAL ROLE service_role');
          return (await tx.query<Row>(sql, values)).rows;
        })
        .then((rows): RpcResponse => ({ data: rows as unknown[], error: null }))
        .catch((error: unknown): RpcResponse => ({ data: null, error: { code: sqlState(error) || 'P0001', message: error instanceof Error ? error.message : String(error) } }));
      const request: RpcRequest = { abortSignal: () => request, then: (onFulfilled, onRejected) => run.then(onFulfilled, onRejected) };
      return request;
    },
  };
}

describe('identifier not found through the eval route (multi-tenant, two tenants, 04.2-36)', () => {
  const CORPUS_DIR = path.resolve(import.meta.dirname, '../../eval/fixtures/corpus');
  let prepared: Awaited<ReturnType<typeof import('../../eval/harness/run-eval.mts').prepareInProcessEval>>;
  let db: PGlite;
  let configModule: typeof import('../../src/lib/rag/config.ts');
  let scopeA: TenantScope;
  let scopeB: TenantScope;

  async function withEnv<T>(overrides: Record<string, string>, fn: () => Promise<T>): Promise<T> {
    const previous = Object.fromEntries(Object.keys(overrides).map((key) => [key, process.env[key]]));
    Object.assign(process.env, overrides);
    configModule.resetRagConfigForTests();
    try {
      return await fn();
    } finally {
      for (const [key, value] of Object.entries(previous)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      configModule.resetRagConfigForTests();
    }
  }

  async function seed(owner: 'A' | 'B', texts: string[]): Promise<void> {
    const documentId = crypto.randomUUID();
    await db.query(
      `INSERT INTO documents (id, filename, content, status, is_current, version, provisional, lineage_id, content_hash, user_id)
       VALUES ($1, 'entries.md', $2, 'ready', true, 1, false, $1, $3, $4)`,
      [documentId, texts.join('\n'), crypto.randomUUID(), owner === 'A' ? FIXTURE_USER_ID : USER_B],
    );
    for (const [index, text] of texts.entries()) {
      await db.query(
        `INSERT INTO document_chunks (id, document_id, content, metadata, chunk_index, chunking_profile_id, is_current, status, provisional)
         VALUES ($1, $2, $3, '{}'::jsonb, $4, 'legacy', true, 'ready', false)`,
        [crypto.randomUUID(), documentId, text, index],
      );
    }
    const { createIngestWriter } = await import('../../src/lib/rag/ingest/writer.ts');
    const { indexDocumentForLookup } = await import('../../src/lib/rag/ingest/write-indexers.ts');
    const scope = owner === 'A' ? scopeA : scopeB;
    const signal = new AbortController().signal;
    const report = await indexDocumentForLookup({
      writer: createIngestWriter({ db: serviceRpc(db), scope, signal }),
      scope,
      documentId,
      tables: false,
      identifiers: true,
      signal,
      loadPatterns: NO_PATTERNS,
    });
    assert.deepEqual(report.warnings, [], 'indexed without warnings');
  }

  async function ask(userId: string, query: string) {
    const { NextRequest } = await import('next/server');
    const response = await withEnv(FILTER_ON, () =>
      prepared.POST(
        new NextRequest('http://localhost/api/internal/rag/run', {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-rag-eval-secret': prepared.secret },
          body: JSON.stringify({ schema_version: 1, query, rag_mode: 'strict', options: { user_id: userId } }),
        }),
      ),
    );
    assert.equal(response.status, 200);
    return (await response.json()) as { refused: boolean; refusal_reason: string | null; identifier?: { suggestions: string[]; asked: number; resolved: number } };
  }

  before(async () => {
    const { prepareInProcessEval } = await import('../../eval/harness/run-eval.mts');
    prepared = await prepareInProcessEval({
      corpusDir: CORPUS_DIR,
      deploymentMode: 'multi-tenant',
      allowedScopes: [`user:${USER_B}`],
      envOverrides: { RAG_PIPELINE: 'v2', RAG_LEXICAL_SEARCH: 'true', RAG_RERANKER: 'none', RAG_IDENTIFIER_INDEX: 'false', RAG_IDENTIFIER_FILTER: 'false' },
    });
    db = prepared.fixtureDb as PGlite;
    configModule = await import('../../src/lib/rag/config.ts');
    const { resetRetrievalBackendForTests } = await import('../../src/lib/rag/backend/registry.ts');
    const { verifyV2Startup, resetV2StartupForTests } = await import('../../src/lib/rag/v2/startup.ts');
    resetRetrievalBackendForTests();
    resetV2StartupForTests();
    await verifyV2Startup();

    const { mintScope } = await import('../../src/lib/rag/tenant/scope.ts');
    scopeA = mintScope('personal', FIXTURE_USER_ID, null);
    scopeB = mintScope('personal', USER_B, null);
    await db.query('INSERT INTO auth.users (id, email) VALUES ($1, $2) ON CONFLICT DO NOTHING', [USER_B, 'fixture-user-b@example.invalid']);
    await seed('A', ['Vorpel entry KT-58213 lists the quandry settings.']);
    await seed('B', ['Tenant two entry KT-58219 looks alike.', 'Tenant two entry KT-58216 is private to its tenant.']);
  });

  after(async () => {
    await prepared?.close();
  });

  test("tenant A: refused with A's identifier only, never one that only tenant B holds", async () => {
    const trace = await ask(FIXTURE_USER_ID, 'What does entry KT-58217 say?');
    assert.equal(trace.refused, true);
    assert.equal(trace.refusal_reason, 'identifier_not_found');
    const suggestions = trace.identifier?.suggestions ?? [];
    assert.ok(suggestions.includes('KT-58213'), JSON.stringify(suggestions));
    assert.ok(!suggestions.includes('KT-58219') && !suggestions.includes('KT-58216'), JSON.stringify(suggestions));
  });

  test("tenant B: refused with B's identifiers only, never tenant A's", async () => {
    const trace = await ask(USER_B, 'What does entry KT-58217 say?');
    assert.equal(trace.refusal_reason, 'identifier_not_found');
    const suggestions = trace.identifier?.suggestions ?? [];
    assert.ok(suggestions.length >= 1 && suggestions.length <= 3, JSON.stringify(suggestions));
    assert.ok(!suggestions.includes('KT-58213'), JSON.stringify(suggestions));
    assert.ok(suggestions.every((value) => value === 'KT-58219' || value === 'KT-58216'), JSON.stringify(suggestions));
  });
});
