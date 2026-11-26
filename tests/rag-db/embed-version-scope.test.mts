import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { AsyncLocalStorage } from 'node:async_hooks';
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { PGlite } from '@electric-sql/pglite';
import { loadPinnedEvalEnv } from '../../eval/harness/eval-env.mts';
import { fixtureProcessEnv, startFakeEdge, type FakeEdge } from '../../eval/harness/fake-edge.mts';
import { embedText } from '../../eval/harness/fixture-embedder.mts';
import { createFixtureDatabase } from '../../eval/harness/pglite-supabase.mts';
import { TWO_TENANT_IDS, createTwoTenantDatabase } from '../../eval/harness/two-tenant.mts';

// Next.js creates its request stores from a global AsyncLocalStorage when its modules load; every Next import below is dynamic.
(globalThis as { AsyncLocalStorage?: unknown }).AsyncLocalStorage ??= AsyncLocalStorage;

/**
 * D-12, D-40, D-58 (RESEARCH open question 2): embedded chat honours `retrievalFilters.versions` only while RAG_VERSION_SCOPE and
 * RAG_EMBED_VERSION_SCOPE are both on, and then only inside the embed's own tenant (RAG_EMBED_TENANT, never the body). The embed route
 * runs in process against a fixture database behind the fake edge, with a fake model whose request body shows the context it was given.
 * Each deployment mode runs in its own child process (multi-tenant seeds two tenants). All text is synthetic and neutral.
 */
const SELF = fileURLToPath(import.meta.url);
const REPO_ROOT = path.resolve(path.dirname(SELF), '../..');
const CORPUS_DIR = path.join(REPO_ROOT, 'eval/fixtures/corpus');
const MODE_ENV = 'EMBED_VERSION_SCOPE_MODE';
const MODE = process.env[MODE_ENV];
const OPENROUTER_COMPLETIONS = 'https://openrouter.ai/api/v1/chat/completions';
const LONG_TIMER_MS = 60_000;

const TERM = 'vantrelquor';
const QUESTION = `The ${TERM} threshold value is units per cycle?`;
const OLD_TEXT = `The ${TERM} threshold value is seven units per cycle.`;
const NEW_TEXT = `The ${TERM} threshold value is nine units per cycle.`;
const FOREIGN_OLD = `The ${TERM} threshold value for each cycle is eleven units, ${TERM} threshold value cycle ${TERM}.`;
const FOREIGN_NEW = `The ${TERM} threshold value is thirteen units per cycle.`;

interface Lineage {
  oldDoc: string;
  newDoc: string;
  oldChunk: string;
  newChunk: string;
  draftDoc: string;
  draftChunk: string;
}

interface NextScope {
  workAsyncStorage: { run<T>(store: unknown, fn: () => T): T };
  workUnitAsyncStorage: { run<T>(store: unknown, fn: () => T): T };
  RequestCookies: new (headers: Headers) => unknown;
}

type RouteModule = { POST: (request: Request) => Promise<Response> };

function vec(text: string): string {
  return `[${embedText(text).join(',')}]`;
}

function fakeCompletion(): Response {
  const encoder = new TextEncoder();
  const chunk = (delta: Record<string, unknown>, finish: string | null) =>
    `data: ${JSON.stringify({ id: 'fake-completion', object: 'chat.completion.chunk', created: 0, model: 'fake-model', choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
  const parts = [chunk({ role: 'assistant', content: 'A neutral ' }, null), chunk({ content: 'answer.' }, null), chunk({}, 'stop'), 'data: [DONE]\n\n'];
  return new Response(
    new ReadableStream({
      start(controller) {
        for (const part of parts) controller.enqueue(encoder.encode(part));
        controller.close();
      },
    }),
    { status: 200, headers: { 'content-type': 'text/event-stream' } },
  );
}

if (MODE === undefined) {
  describe('embedded chat and versions in both deployment modes', () => {
    for (const mode of ['single-tenant', 'multi-tenant'] as const) {
      test(mode, () => {
        // NODE_TEST_CONTEXT makes a nested node --test skip its files, so the child must not inherit it.
        const { NODE_TEST_CONTEXT: _context, ...parentEnv } = process.env;
        const result = spawnSync(process.execPath, ['--import', 'tsx', '--test', '--test-reporter=tap', SELF], {
          cwd: REPO_ROOT,
          encoding: 'utf8',
          env: { ...parentEnv, [MODE_ENV]: mode },
          timeout: 600_000,
        });
        const output = `${result.stdout}\n${result.stderr}`;
        const failures = output.split('\n').filter((line) => /not ok|AssertionError|expected|actual|found|Error/.test(line)).slice(0, 80).join('\n');
        assert.equal(result.status, 0, failures || output.slice(-2000));
        const passed = Number(/^# pass (\d+)$/m.exec(output)?.[1] ?? '0');
        assert.ok(passed > 0, `the child ran no tests:\n${output.slice(-2000)}`);
        assert.match(output, /^# fail 0$/m);
      });
    }
  });
} else {
  const mode = MODE as 'single-tenant' | 'multi-tenant';
  const multi = mode === 'multi-tenant';
  const ownKey = multi ? `u:${TWO_TENANT_IDS.userA}` : 's:default';
  const ownUser = multi ? TWO_TENANT_IDS.userA : null;
  let db: PGlite;
  let edge: FakeEdge;
  let next: NextScope;
  let embedRoute: RouteModule;
  let configModule: typeof import('../../src/lib/rag/config.ts');
  let own: Lineage;
  let foreign: Lineage | null = null;
  const prompts: string[] = [];
  const originalFetch = globalThis.fetch;
  const realSetTimeout = globalThis.setTimeout;
  const originalLog = console.log;
  const originalWarn = console.warn;
  const originalError = console.error;
  const savedEnv = { ...process.env };

  async function seedLineage(tenant: { key: string; userId: string | null }, oldText: string, newText: string): Promise<Lineage> {
    const lineage = crypto.randomUUID();
    const ids: Lineage = {
      oldDoc: crypto.randomUUID(),
      newDoc: crypto.randomUUID(),
      oldChunk: crypto.randomUUID(),
      newChunk: crypto.randomUUID(),
      draftDoc: crypto.randomUUID(),
      draftChunk: crypto.randomUUID(),
    };
    const draftText = `${oldText} Provisional draft wording.`;
    const versions = [
      { doc: ids.newDoc, chunk: ids.newChunk, text: newText, version: 3, current: true, supersededBy: null, provisional: false, from: '2026-04-01', to: null },
      { doc: ids.oldDoc, chunk: ids.oldChunk, text: oldText, version: 1, current: false, supersededBy: ids.newDoc, provisional: false, from: '2026-01-01', to: '2026-03-31' },
      { doc: ids.draftDoc, chunk: ids.draftChunk, text: draftText, version: 2, current: false, supersededBy: ids.newDoc, provisional: true, from: '2026-02-01', to: '2026-03-31' },
    ];
    for (const v of versions) {
      const columns: [string, unknown, string?][] = [
        ['id', v.doc],
        ['filename', `synthetic-lineage-${lineage.slice(0, 8)}-v${v.version}.md`],
        ['content', v.text],
        ['lineage_id', lineage],
        ['version', v.version],
        ['is_current', v.current],
        ['status', 'ready'],
        ['superseded_by', v.supersededBy],
        ['provisional', v.provisional],
        ['content_hash', crypto.createHash('sha256').update(v.text).digest('hex')],
        ['effective_from', v.from, 'date'],
        ['effective_to', v.to, 'date'],
        ...(tenant.userId ? [['user_id', tenant.userId] as [string, unknown]] : []),
      ];
      await db.query(
        `INSERT INTO documents (${columns.map(([name]) => name).join(', ')})
         VALUES (${columns.map(([, , cast], index) => (cast ? `$${index + 1}::${cast}` : `$${index + 1}`)).join(', ')})`,
        columns.map(([, value]) => value),
      );
      await db.query(
        `INSERT INTO document_chunks (id, document_id, content, embedding, lexical_text, tenant_key, is_current, status, chunk_index, provisional)
         VALUES ($1, $2, $3, $4::vector, $3, $5, $6, 'ready', 0, $7)`,
        [v.chunk, v.doc, v.text, v.current ? vec(v.text) : null, tenant.key, v.current, v.provisional],
      );
    }
    return ids;
  }

  async function inRequest(handler: () => Promise<Response>): Promise<Response> {
    const workStore = { route: '/api/embed-version-scope-test', afterContext: { after: () => undefined } };
    const requestStore = { type: 'request', phase: 'render', cookies: new next.RequestCookies(new Headers()) };
    return next.workAsyncStorage.run(workStore, () => next.workUnitAsyncStorage.run(requestStore, handler));
  }

  interface Turn {
    status: number;
    body: string;
    prompt: string | null;
  }

  async function postEmbed(extra: Record<string, unknown> = {}): Promise<Turn> {
    const before = prompts.length;
    const request = new Request('http://localhost/api/embed/chat', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-forwarded-for': '203.0.113.9' },
      body: JSON.stringify({ messages: [{ role: 'user', content: QUESTION }], ...extra }),
    });
    const response = await inRequest(() => embedRoute.POST(request));
    const body = await response.text();
    return { status: response.status, body, prompt: prompts.length > before ? prompts[prompts.length - 1]! : null };
  }

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

  /** The pipeline run the embed route makes, in process, to read the search stage record and the sources. */
  async function embedRetrieval(retrievalFilters?: Record<string, unknown>) {
    const rag = await import('../../src/lib/rag/index.ts');
    const { mintScope } = await import('../../src/lib/rag/tenant/scope.ts');
    const parsed = rag.parseRetrievalFilters(retrievalFilters);
    assert.ok(parsed.ok);
    return rag.runRetrieval({
      scope: ownUser ? mintScope('personal', ownUser, null) : mintScope('single', null, null),
      query: QUESTION,
      profile: 'embed',
      channel: 'embed',
      options: { ragMode: 'balanced', webSearchEnabled: false },
      signal: new AbortController().signal,
      ...(parsed.filters ? { retrievalFilters: parsed.filters } : {}),
    });
  }

  const searchDetail = (result: { stages: Array<{ name: string; detail?: string }> }) =>
    result.stages.filter((stage) => stage.name === 'search').map((stage) => stage.detail ?? '').join(';');

  const SWITCH_OFF = { RAG_VERSION_SCOPE: 'false', RAG_EMBED_VERSION_SCOPE: 'false' };
  const EMBED_SWITCH_OFF = { RAG_VERSION_SCOPE: 'true', RAG_EMBED_VERSION_SCOPE: 'false' };
  const BOTH_ON = { RAG_VERSION_SCOPE: 'true', RAG_EMBED_VERSION_SCOPE: 'true' };
  const ALL = { retrievalFilters: { versions: 'all' } };

  before(async () => {
    const fixture = multi
      ? await createTwoTenantDatabase()
      : await createFixtureDatabase({ deploymentMode: 'single-tenant', corpusDir: CORPUS_DIR });
    db = fixture.db;
    edge = await startFakeEdge({ db });

    const env = process.env as Record<string, string | undefined>;
    for (const name of Object.keys(env)) {
      if (name.startsWith('RAG_') || name.startsWith('NEXT_PUBLIC_RAG_') || name.startsWith('LANGFUSE_')) delete env[name];
    }
    Object.assign(env, loadPinnedEvalEnv());
    Object.assign(env, fixtureProcessEnv(edge.url));
    env.NODE_ENV = 'test';
    env.NEXT_PUBLIC_MYRAG_DEPLOYMENT_MODE = mode;
    env.OPENAI_EMBEDDING_MODEL = 'text-embedding-3-small';
    env.NEXT_PUBLIC_EMBED_ENABLED = 'true';
    env.NEXT_PUBLIC_EMBED_ALLOWED_DOMAINS = '*';
    env.EMBED_RATE_LIMIT = '100000';
    env.RAG_PIPELINE = 'v2';
    env.RAG_LEXICAL_SEARCH = 'true';
    env.RAG_RERANKER = 'none';
    env.RAG_EXACT_ID_LOOKUP = 'false';
    if (multi) env.RAG_EMBED_TENANT = ownKey;

    globalThis.fetch = async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      if (url.split('?')[0] === OPENROUTER_COMPLETIONS) {
        prompts.push(typeof init?.body === 'string' ? init.body : '');
        return fakeCompletion();
      }
      return originalFetch(input, init);
    };
    console.log = () => undefined;
    console.warn = () => undefined;
    console.error = () => undefined;
    globalThis.setTimeout = ((handler: TimerHandler, delay?: number, ...rest: unknown[]) => {
      const timer = realSetTimeout(handler as () => void, delay, ...rest) as unknown as NodeJS.Timeout;
      return typeof delay === 'number' && delay >= LONG_TIMER_MS ? timer.unref() : timer;
    }) as unknown as typeof setTimeout;

    const workStorage = (await import('next/dist/server/app-render/work-async-storage.external.js')) as unknown as Pick<NextScope, 'workAsyncStorage'>;
    const unitStorage = (await import('next/dist/server/app-render/work-unit-async-storage.external.js')) as unknown as Pick<NextScope, 'workUnitAsyncStorage'>;
    const cookies = (await import('next/dist/server/web/spec-extension/cookies.js')) as unknown as Pick<NextScope, 'RequestCookies'>;
    next = { ...workStorage, ...unitStorage, ...cookies };

    const realSetInterval = globalThis.setInterval;
    globalThis.setInterval = ((...args: Parameters<typeof setInterval>) => realSetInterval(...args).unref()) as typeof setInterval;
    try {
      embedRoute = (await import('../../src/app/api/embed/chat/route.ts')) as unknown as RouteModule;
    } finally {
      globalThis.setInterval = realSetInterval;
    }
    configModule = await import('../../src/lib/rag/config.ts');
    const { resetRetrievalBackendForTests } = await import('../../src/lib/rag/backend/registry.ts');
    const { verifyV2Startup, resetV2StartupForTests } = await import('../../src/lib/rag/v2/startup.ts');
    configModule.resetRagConfigForTests();
    resetRetrievalBackendForTests();
    resetV2StartupForTests();
    await verifyV2Startup();

    own = await seedLineage({ key: ownKey, userId: ownUser }, OLD_TEXT, NEW_TEXT);
    if (multi) foreign = await seedLineage({ key: `u:${TWO_TENANT_IDS.userB}`, userId: TWO_TENANT_IDS.userB }, FOREIGN_OLD, FOREIGN_NEW);
  });

  after(async () => {
    globalThis.fetch = originalFetch;
    globalThis.setTimeout = realSetTimeout;
    console.log = originalLog;
    console.warn = originalWarn;
    console.error = originalError;
    await edge?.close();
    await db?.close().catch(() => undefined);
    const env = process.env as Record<string, string | undefined>;
    for (const name of Object.keys(env)) if (!(name in savedEnv)) delete env[name];
    Object.assign(env, savedEnv);
  });

  describe(`embed route and versions (${mode})`, () => {
    test('RAG_VERSION_SCOPE off: versions all is ignored (versions_ignored), current text only, same prompt and stream as without the field', async () => {
      const plain = await withEnv(SWITCH_OFF, () => postEmbed());
      const asked = await withEnv(SWITCH_OFF, () => postEmbed(ALL));
      assert.equal(plain.status, 200);
      assert.equal(asked.status, 200);
      assert.ok(plain.prompt?.includes('nine units'), 'the current version reaches the model');
      assert.equal(asked.prompt, plain.prompt);
      assert.ok(!asked.prompt?.includes('seven units'));
      assert.equal(asked.body.replace(/"id":"[^"]*"/g, ''), plain.body.replace(/"id":"[^"]*"/g, ''));
      const result = await withEnv(SWITCH_OFF, () => embedRetrieval({ versions: 'all' }));
      assert.ok(searchDetail(result).split(/[;,]/).includes('versions_ignored'), searchDetail(result));
      assert.ok(!result.kept.some((chunk) => chunk.chunk_id === own.oldChunk));
      assert.ok(result.usedDocuments.every((doc) => doc.isCurrent === undefined));
    });

    test('RAG_VERSION_SCOPE on, RAG_EMBED_VERSION_SCOPE off (default): embed still ignores versions while the chat channel honours it', async () => {
      const plain = await withEnv(EMBED_SWITCH_OFF, () => postEmbed());
      const asked = await withEnv(EMBED_SWITCH_OFF, () => postEmbed(ALL));
      assert.equal(asked.status, 200);
      assert.equal(asked.prompt, plain.prompt);
      assert.ok(!asked.prompt?.includes('seven units'));
      assert.equal(asked.body.replace(/"id":"[^"]*"/g, ''), plain.body.replace(/"id":"[^"]*"/g, ''));
      const result = await withEnv(EMBED_SWITCH_OFF, () => embedRetrieval({ versions: 'all' }));
      assert.ok(searchDetail(result).split(/[;,]/).includes('versions_ignored'), searchDetail(result));
      assert.ok(!result.kept.some((chunk) => chunk.chunk_id === own.oldChunk));

      const rag = await import('../../src/lib/rag/index.ts');
      const { mintScope } = await import('../../src/lib/rag/tenant/scope.ts');
      const chat = await withEnv(EMBED_SWITCH_OFF, () =>
        rag.runRetrieval({
          scope: ownUser ? mintScope('personal', ownUser, null) : mintScope('single', null, null),
          query: QUESTION,
          profile: 'chat',
          options: { ragMode: 'balanced', webSearchEnabled: false },
          signal: new AbortController().signal,
          retrievalFilters: { versionScope: 'all' },
        }),
      );
      assert.ok(chat.candidates.some((candidate) => candidate.chunk_id === own.oldChunk), 'the chat channel reaches the superseded version');
    });

    test('both switches on: the superseded version of the own tenant only, never a provisional one, never another tenant', async () => {
      const asked = await withEnv(BOTH_ON, () => postEmbed(ALL));
      assert.equal(asked.status, 200);
      assert.ok(asked.prompt?.includes('seven units'), 'the superseded version reaches the model');
      assert.ok(!asked.prompt?.includes('Provisional draft wording'));
      assert.ok(!asked.prompt?.includes('eleven units') && !asked.prompt?.includes('thirteen units'), 'no text of another tenant');
      const result = await withEnv(BOTH_ON, () => embedRetrieval({ versions: 'all' }));
      assert.ok(!searchDetail(result).split(/[;,]/).includes('versions_ignored'), searchDetail(result));
      const ids = new Set(result.candidates.map((candidate) => candidate.chunk_id));
      assert.ok(ids.has(own.oldChunk), 'superseded own version retrieved');
      assert.ok(!ids.has(own.draftChunk), 'provisional version never returned');
      if (foreign) {
        for (const id of [foreign.oldChunk, foreign.newChunk, foreign.draftChunk]) assert.ok(!ids.has(id), `foreign chunk ${id}`);
        const foreignDocs = new Set([foreign.oldDoc, foreign.newDoc, foreign.draftDoc]);
        assert.ok(result.usedDocuments.every((doc) => !foreignDocs.has(doc.id)));
      }
      const superseded = result.usedDocuments.find((doc) => doc.id === own.oldDoc);
      assert.ok(superseded, 'the superseded version is a used document');
      assert.equal(superseded.isCurrent, false);
      assert.equal(superseded.version, 1);
    });

    test('a body field naming another tenant is refused as today; the tenant comes only from the widget configuration', async () => {
      const otherTenant = multi ? `u:${TWO_TENANT_IDS.userB}` : `u:${TWO_TENANT_IDS.userA}`;
      const refused = await withEnv(BOTH_ON, () => postEmbed({ ...ALL, tenant: otherTenant }));
      assert.equal(refused.status, 403);
      assert.equal(refused.prompt, null);
      if (multi) {
        const named = await withEnv(BOTH_ON, () => postEmbed({ ...ALL, userId: TWO_TENANT_IDS.userB }));
        assert.equal(named.status, 200);
        assert.ok(!named.prompt?.includes('eleven units') && !named.prompt?.includes('thirteen units'));
      }
    });

    test('a malformed versions value answers 400 on the versions path', async () => {
      const bad = await withEnv(BOTH_ON, () => postEmbed({ retrievalFilters: { versions: { from: '2026-05-01', to: '2026-01-01' } } }));
      assert.equal(bad.status, 400);
      const parsed = JSON.parse(bad.body) as { details: Array<{ path: string }> };
      assert.equal(parsed.details[0]?.path, 'versions');
    });
  });
}
