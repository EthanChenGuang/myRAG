import crypto from 'node:crypto';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import type { PGlite } from '@electric-sql/pglite';
import { FIXTURE_USER_ID, createEmptyFixtureDatabase, type DeploymentMode } from '../../eval/harness/pglite-supabase.mts';
import type { RpcClient, RpcRequest, RpcResponse } from '@/lib/rag/backend/supabase-rpc';
import type { TenantScope } from '@/lib/rag/tenant/scope';

/**
 * RET-16 identifier filter (D-31, D-51): resolve in the tenant, filter every leg before ranking, fall back once, not-found with
 * same-tenant suggestions. Synthetic neutral identifiers only; look-alikes differ by one or two characters, or only by separators or case.
 */
type Row = Record<string, unknown>;

const USER_B = '00000000-0000-4000-8000-0000000027b1';
const MODES: DeploymentMode[] = ['multi-tenant', 'single-tenant'];
const NO_PATTERNS = async () => ({ expressions: Object.freeze([]) as readonly RegExp[], patternIds: Object.freeze([]) as readonly string[], loadFailed: false });

function sqlState(error: unknown): string {
  return typeof (error as { code?: unknown } | null)?.code === 'string' ? (error as { code: string }).code : '';
}

function serviceRpc(db: PGlite, calls?: string[]): RpcClient {
  return {
    rpc(fn, args) {
      calls?.push(fn);
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

function failingRpc(calls: string[]): RpcClient {
  return {
    rpc(fn) {
      calls.push(fn);
      const response: RpcResponse = { data: null, error: { code: '42883', message: 'function does not exist' } };
      const request: RpcRequest = { abortSignal: () => request, then: (onFulfilled, onRejected) => Promise.resolve(response).then(onFulfilled, onRejected) };
      return request;
    },
  };
}

describe('identifier filter through runRetrieval (single-tenant, D-31, D-51)', () => {
  const CORPUS_DIR = path.resolve(import.meta.dirname, '../../eval/fixtures/corpus');
  const X = 'KT-58213';
  const ONE_EDIT = 'KT-58218';
  const TWO_EDIT_LONG = 'KTX-582130';
  const TEXTS = {
    x: `Vorpel register entry ${X} lists the quandry settings of the north wing.`,
    xTwo: `Second vorpel page: entry ${X} keeps its quandry settings unchanged.`,
    near: `Vorpel register entry ${ONE_EDIT} lists the quandry settings of the south wing.`,
    plain: 'Vorpel register general notes about quandry settings without any entry code.',
    longNear: `Vorpel register entry ${TWO_EDIT_LONG} lists quandry settings of the east wing.`,
    unreachable: 'Hidden page with entry HY-77120 and nothing else.',
  };
  let prepared: Awaited<ReturnType<typeof import('../../eval/harness/run-eval.mts').prepareInProcessEval>>;
  let db: PGlite;
  let configModule: typeof import('../../src/lib/rag/config.ts');
  const chunkOf: Record<string, string> = {};

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

  const FILTER_ON = { RAG_IDENTIFIER_INDEX: 'true', RAG_IDENTIFIER_FILTER: 'true' };
  const FILTER_OFF = { RAG_IDENTIFIER_INDEX: 'false', RAG_IDENTIFIER_FILTER: 'false' };

  async function run(query: string, env: Record<string, string>, ragMode: 'strict' | 'balanced' = 'balanced') {
    const { runRetrieval } = await import('../../src/lib/rag/index.ts');
    const { mintScope } = await import('../../src/lib/rag/tenant/scope.ts');
    return withEnv(env, async () =>
      runRetrieval({
        scope: mintScope('single', null, null),
        query,
        profile: 'eval',
        signal: new AbortController().signal,
        options: { ragMode },
      } as Parameters<typeof runRetrieval>[0]),
    );
  }

  async function insertChunk(documentId: string, content: string, index: number, options: { embed?: boolean } = {}): Promise<string> {
    const { embedText } = await import('../../eval/harness/fixture-embedder.mts');
    const id = crypto.randomUUID();
    const hash = crypto.createHash('sha256').update(content).digest('hex');
    const reachable = options.embed !== false;
    await db.query(
      `INSERT INTO document_chunks (id, document_id, content, embedding, lexical_text, tenant_key, is_current, status, chunk_index, provisional, content_hash)
       VALUES ($1, $2, $3, $4::vector, $5, 's:default', true, 'ready', $6, false, $7)`,
      [id, documentId, content, reachable ? `[${embedText(content).join(',')}]` : null, reachable ? content : null, index, hash],
    );
    return id;
  }

  before(async () => {
    const { prepareInProcessEval } = await import('../../eval/harness/run-eval.mts');
    prepared = await prepareInProcessEval({
      corpusDir: CORPUS_DIR,
      deploymentMode: 'single-tenant',
      envOverrides: { RAG_PIPELINE: 'v2', RAG_LEXICAL_SEARCH: 'true', RAG_RERANKER: 'none', ...FILTER_OFF },
    });
    db = prepared.fixtureDb as PGlite;
    configModule = await import('../../src/lib/rag/config.ts');
    const { resetRetrievalBackendForTests } = await import('../../src/lib/rag/backend/registry.ts');
    const { verifyV2Startup, resetV2StartupForTests } = await import('../../src/lib/rag/v2/startup.ts');
    resetRetrievalBackendForTests();
    resetV2StartupForTests();
    await verifyV2Startup();

    const { mintScope } = await import('../../src/lib/rag/tenant/scope.ts');
    const { createIngestWriter } = await import('../../src/lib/rag/ingest/writer.ts');
    const { indexDocumentForLookup } = await import('../../src/lib/rag/ingest/write-indexers.ts');
    const scope = mintScope('single', null, null);
    for (const [name, content] of Object.entries(TEXTS)) {
      const documentId = crypto.randomUUID();
      await db.query(
        `INSERT INTO documents (id, filename, content, lineage_id, is_current, status, content_hash) VALUES ($1, $2, $3, $1, true, 'ready', $4)`,
        [documentId, `vorpel-${name}.md`, content, crypto.createHash('sha256').update(content).digest('hex')],
      );
      chunkOf[name] = await insertChunk(documentId, content, 0, { embed: name !== 'unreachable' });
      const signal = new AbortController().signal;
      await indexDocumentForLookup({ writer: createIngestWriter({ db: serviceRpc(db), scope, signal }), scope, documentId, tables: false, identifiers: true, signal, loadPatterns: NO_PATTERNS });
    }
  });

  after(async () => {
    await prepared?.close();
  });

  test('switch off: no identifier stage; the look-alike reaches the candidates as today', async () => {
    const off = await run(`What does entry ${X} say about the quandry settings?`, FILTER_OFF);
    assert.ok(!off.stages.some((stage) => stage.name === 'identifier_resolve' || stage.name === 'identifier_guard'));
    assert.ok(off.candidates.some((candidate) => candidate.chunk_id === chunkOf.near), 'the look-alike is a candidate with the switch off');
    assert.equal(off.identifierSuggestions, undefined);
  });

  test('filter on: every candidate carries the asked identifier in another spelling; the detail carries counts only', async () => {
    for (const spelling of ['kt_58213', 'Kt.58213']) {
      const on = await run(`What does entry ${spelling} say about the quandry settings?`, { ...FILTER_ON, RAG_EXACT_ID_LOOKUP: 'true' });
      const stage = on.stages.find((entry) => entry.name === 'identifier_resolve');
      assert.equal(stage?.status, 'ok', JSON.stringify(stage));
      assert.equal(stage?.detail, 'asked=1 found=1 filtered=true');
      const lacking = on.candidates.filter((candidate) => !/KT-58213/u.test(candidate.content)).map((candidate) => candidate.chunk_id);
      assert.deepEqual(lacking, [], `candidates lacking ${X}: ${lacking.join(',')}`);
      assert.ok(on.candidates.some((candidate) => candidate.chunk_id === chunkOf.x));
      assert.ok(on.candidates.some((candidate) => candidate.chunk_id === chunkOf.xTwo));
      for (const record of on.stages) assert.ok(!/kt|58213/iu.test(record.detail ?? ''), `no identifier in ${record.name} detail`);
    }
  });

  test('filter on: a question without identifiers equals the switch-off candidates and order', async () => {
    const query = 'How are the quandry settings of the vorpel register organised?';
    const off = await run(query, FILTER_OFF);
    const on = await run(query, FILTER_ON);
    assert.deepEqual(
      on.candidates.map((candidate) => [candidate.chunk_id, candidate.fused_score]),
      off.candidates.map((candidate) => [candidate.chunk_id, candidate.fused_score]),
    );
    assert.equal(on.stages.find((entry) => entry.name === 'identifier_resolve')?.detail, 'asked=0 found=0 filtered=false');
  });

  test('a filtered search with no result reruns unfiltered once and records identifier_filter_fallback', async () => {
    const on = await run('What does entry HY-77120 say about the quandry settings?', FILTER_ON);
    const search = on.stages.filter((entry) => entry.name === 'search');
    assert.ok(search.some((entry) => (entry.detail ?? '').includes('identifier_filter_fallback')), JSON.stringify(search));
    assert.ok(on.candidates.length > 0, 'the unfiltered search found candidates');
  });

  test('not found, strict: empty result, refusal reason identifier_not_found, same-tenant suggestions, nothing kept', async () => {
    const strict = await run('What does entry KT-58217 say about the quandry settings?', FILTER_ON, 'strict');
    assert.equal(strict.status, 'empty');
    assert.equal(strict.reason, 'identifier_not_found');
    assert.equal(strict.refusalCandidate, true);
    assert.deepEqual(strict.kept, []);
    assert.equal(strict.context, '');
    assert.ok(Array.isArray(strict.identifierSuggestions));
    assert.ok(strict.identifierSuggestions!.length <= 3);
    assert.ok(strict.identifierSuggestions!.includes(X), JSON.stringify(strict.identifierSuggestions));
    assert.equal(strict.identifierFilter?.asked, 1);
    assert.equal(strict.identifierFilter?.resolved, 0);
  });

  test('not found, balanced: near-miss chunks are dropped by the guard and the context carries the suggestion line', async () => {
    const balanced = await run('What does entry KT-58217 say about the quandry settings?', FILTER_ON, 'balanced');
    assert.notEqual(balanced.reason, 'identifier_not_found');
    const guard = balanced.stages.find((entry) => entry.name === 'identifier_guard');
    assert.equal(guard?.status, 'ok', JSON.stringify(guard));
    assert.ok((guard?.counts?.dropped ?? 0) >= 2, JSON.stringify(guard));
    for (const name of ['x', 'xTwo', 'near']) {
      assert.ok(!balanced.kept.some((chunk) => chunk.chunk_id === chunkOf[name]), `${name} dropped as a near-miss`);
    }
    assert.ok(balanced.context.includes(X), 'the suggestion line names the closest identifier');
  });

  test('found: the guard keeps chunks carrying the asked identifier and counts drops; the long two-edit neighbour is dropped', async () => {
    const on = await run(`Compare entry ${X} with KTX-582131 quandry settings`, FILTER_ON);
    const guard = on.stages.find((entry) => entry.name === 'identifier_guard');
    assert.equal(guard?.status, 'ok');
    assert.ok(on.kept.some((chunk) => chunk.chunk_id === chunkOf.x));
    assert.ok(!on.kept.some((chunk) => chunk.chunk_id === chunkOf.longNear));
  });

  test('a resolve failure skips the filter, degrades the stage with a fixed code, and the request completes', async () => {
    await db.exec('ALTER FUNCTION public.rag_identifier_resolve(text, text[]) RENAME TO rag_identifier_resolve_hidden');
    try {
      const failed = await run(`What does entry ${X} say about the quandry settings?`, FILTER_ON);
      const stage = failed.stages.find((entry) => entry.name === 'identifier_resolve');
      assert.equal(stage?.status, 'degraded', JSON.stringify(stage));
      assert.equal(stage?.detail, 'identifier_resolve_failed');
      assert.ok(failed.candidates.some((candidate) => candidate.chunk_id === chunkOf.near), 'unfiltered');
    } finally {
      await db.exec('ALTER FUNCTION public.rag_identifier_resolve_hidden(text, text[]) RENAME TO rag_identifier_resolve');
    }
  });

  test('the filter switch on with the index switch off filters nothing', async () => {
    const out = await run(`What does entry ${X} say about the quandry settings?`, { RAG_IDENTIFIER_INDEX: 'false', RAG_IDENTIFIER_FILTER: 'true' });
    assert.ok(!out.stages.some((stage) => stage.name === 'identifier_resolve'));
    assert.ok(out.candidates.some((candidate) => candidate.chunk_id === chunkOf.near));
  });
});

// Module-level cases after the end-to-end block: the app reads its deployment mode once, at the first import (single-tenant here).
for (const mode of MODES) {
  const multi = mode === 'multi-tenant';

  describe(`resolveQueryIdentifiers and identifierSuggestions (${mode}, D-31, D-51, T-04.2-99)`, () => {
    let db: PGlite;
    let identifiers: typeof import('@/lib/rag/retrieval/identifiers');
    let scopeA: TenantScope;
    let scopeB: TenantScope | null = null;

    async function seed(owner: 'A' | 'B', texts: string[], patterns: readonly RegExp[] = []): Promise<string> {
      const documentId = crypto.randomUUID();
      const columns = ['id', 'filename', 'content', 'status', 'is_current', 'version', 'provisional', 'lineage_id', 'content_hash'];
      const values: unknown[] = [documentId, 'entries.md', texts.join('\n'), 'ready', true, 1, false, documentId, crypto.randomUUID()];
      if (multi) {
        columns.push('user_id');
        values.push(owner === 'A' ? FIXTURE_USER_ID : USER_B);
      }
      await db.query(`INSERT INTO documents (${columns.join(', ')}) VALUES (${columns.map((_, i) => `$${i + 1}`).join(', ')})`, values);
      for (const [index, text] of texts.entries()) {
        await db.query(
          `INSERT INTO document_chunks (id, document_id, content, metadata, chunk_index, chunking_profile_id, is_current, status, provisional)
           VALUES ($1, $2, $3, '{}'::jsonb, $4, 'legacy', true, 'ready', false)`,
          [crypto.randomUUID(), documentId, text, index],
        );
      }
      const { createIngestWriter } = await import('@/lib/rag/ingest/writer');
      const { indexDocumentForLookup } = await import('@/lib/rag/ingest/write-indexers');
      const scope = owner === 'A' ? scopeA : scopeB!;
      const signal = new AbortController().signal;
      const report = await indexDocumentForLookup({
        writer: createIngestWriter({ db: serviceRpc(db), scope, signal }),
        scope,
        documentId,
        tables: false,
        identifiers: true,
        signal,
        loadPatterns: async () => ({ expressions: Object.freeze([...patterns]), patternIds: Object.freeze(patterns.map((_, i) => `p${i}`)), loadFailed: false }),
      });
      assert.deepEqual(report.warnings, [], 'indexed without warnings');
      return documentId;
    }

    before(async () => {
      db = (await createEmptyFixtureDatabase({ deploymentMode: mode })).db;
      identifiers = await import('@/lib/rag/retrieval/identifiers');
      const { mintScope } = await import('@/lib/rag/tenant/scope');
      scopeA = multi ? mintScope('personal', FIXTURE_USER_ID, null) : mintScope('single', null, null);
      if (multi) {
        await db.query('INSERT INTO auth.users (id, email) VALUES ($1, $2)', [USER_B, 'fixture-user-b@example.invalid']);
        scopeB = mintScope('personal', USER_B, null);
      }
      await seed('A', ['Vorpel entry KT-58213 lists the quandry settings.', 'Vorpel entry KT-58218 lists other quandry settings.']);
      await seed('A', ['Brenlow entry MX-40771 holds a plain note.']);
      if (multi) await seed('B', ['Tenant two entry ZQ-90314 is private to its tenant.', 'Tenant two entry KT-58219 looks alike.']);
    });

    after(async () => {
      await db?.close();
    });

    test('an identifier in another spelling resolves to its stored form; separators, case and width do not matter', async () => {
      for (const spelling of ['KT-58213', 'kt_58213', 'kt.58213', 'ＫＴ－５８２１３']) {
        const out = await identifiers.resolveQueryIdentifiers(scopeA, `What does entry ${spelling} say?`, [], { client: serviceRpc(db), signal: new AbortController().signal });
        assert.deepEqual(out.asked.map((entry) => entry.norm), ['kt58213'], spelling);
        assert.deepEqual(out.found, ['kt58213'], spelling);
        assert.deepEqual(out.missing, [], spelling);
      }
    });

    test('a question without identifiers makes no call', async () => {
      const calls: string[] = [];
      const out = await identifiers.resolveQueryIdentifiers(scopeA, 'How are the quandry settings listed in the year 2024?', [], { client: serviceRpc(db, calls), signal: new AbortController().signal });
      assert.deepEqual(out, { asked: [], found: [], missing: [] });
      assert.deepEqual(calls, []);
    });

    test('a missing identifier is reported missing; suggestions are the closest identifiers of the same tenant only', async () => {
      const out = await identifiers.resolveQueryIdentifiers(scopeA, 'What does entry KT-58217 say?', [], { client: serviceRpc(db), signal: new AbortController().signal });
      assert.deepEqual(out.found, []);
      assert.deepEqual(out.missing, ['kt58217']);
      const suggestions = await identifiers.identifierSuggestions(scopeA, out.missing, { client: serviceRpc(db), signal: new AbortController().signal });
      assert.ok(suggestions.length >= 1 && suggestions.length <= 3, JSON.stringify(suggestions));
      assert.deepEqual(suggestions.slice(0, 2), ['KT-58213', 'KT-58218']);
      assert.ok(!suggestions.includes('KT-58219'), "never another tenant's identifier");
    });

    test("an identifier only tenant B has is missing for tenant A and found for B", { skip: !multi }, async () => {
      const forA = await identifiers.resolveQueryIdentifiers(scopeA, 'Where is ZQ-90314 described?', [], { client: serviceRpc(db), signal: new AbortController().signal });
      assert.deepEqual(forA.found, []);
      assert.deepEqual(forA.missing, ['zq90314']);
      const suggestionsA = await identifiers.identifierSuggestions(scopeA, ['zq90314', 'kt58219'], { client: serviceRpc(db), signal: new AbortController().signal });
      assert.ok(!suggestionsA.includes('ZQ-90314') && !suggestionsA.includes('KT-58219'), JSON.stringify(suggestionsA));
      const forB = await identifiers.resolveQueryIdentifiers(scopeB!, 'Where is ZQ-90314 described?', [], { client: serviceRpc(db), signal: new AbortController().signal });
      assert.deepEqual(forB.found, ['zq90314']);
    });

    test('a tenant-pattern identifier with no digit resolves for its tenant only', async () => {
      const pattern = /\bWAND[A-Z]{3}\b/giu;
      await seed('A', ['The wandorx register holds the plain note.'], [pattern]);
      const withPattern = await identifiers.resolveQueryIdentifiers(scopeA, 'What is WANDORX about?', [pattern], { client: serviceRpc(db), signal: new AbortController().signal });
      assert.deepEqual(withPattern.found, ['wandorx']);
      const withoutPattern = await identifiers.resolveQueryIdentifiers(scopeA, 'What is WANDORX about?', [], { client: serviceRpc(db), signal: new AbortController().signal });
      assert.deepEqual(withoutPattern.asked, [], 'a word without a digit is no built-in identifier');
      if (scopeB) {
        const forB = await identifiers.resolveQueryIdentifiers(scopeB, 'What is WANDORX about?', [pattern], { client: serviceRpc(db), signal: new AbortController().signal });
        assert.deepEqual(forB.found, []);
        assert.deepEqual(forB.missing, ['wandorx']);
      }
    });

    test('at most 16 identifiers are resolved; a resolve failure raises RetrievalBackendError; a suggestion failure returns none', async () => {
      const many = Array.from({ length: 20 }, (_, index) => `QR-${String(10000 + index)}`).join(' ');
      const out = await identifiers.resolveQueryIdentifiers(scopeA, `Compare ${many}`, [], { client: serviceRpc(db), signal: new AbortController().signal });
      assert.equal(out.asked.length, 16);
      const calls: string[] = [];
      const { RetrievalBackendError } = await import('@/lib/rag/backend/supabase-rpc');
      await assert.rejects(
        () => identifiers.resolveQueryIdentifiers(scopeA, 'What does KT-58213 say?', [], { client: failingRpc(calls), signal: new AbortController().signal }),
        (error: unknown) => error instanceof RetrievalBackendError,
      );
      assert.deepEqual(await identifiers.identifierSuggestions(scopeA, ['kt58217'], { client: failingRpc(calls), signal: new AbortController().signal }), []);
    });
  });
}
