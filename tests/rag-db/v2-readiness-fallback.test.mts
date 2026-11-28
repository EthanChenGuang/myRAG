import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, afterEach, before, beforeEach, describe, mock, test } from 'node:test';
import assert from 'node:assert/strict';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import type { PGlite } from '@electric-sql/pglite';
import { fixtureProcessEnv, startFakeEdge, type FakeEdge } from '../../eval/harness/fake-edge.mts';
import { createEmptyFixtureDatabase, createFixtureDatabase } from '../../eval/harness/pglite-supabase.mts';
import { embedText } from '../../eval/harness/fixture-embedder.mts';

type Profile = 'chat' | 'embed' | 'voice' | 'eval';
type RetrievalResult = import('@/lib/rag').RetrievalResult;

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const PROFILES: Profile[] = ['chat', 'embed', 'voice', 'eval'];
/** A fixture-corpus question the legacy pipeline answers in the smoke tier (golden item en-compound-001). */
const QUERY = 'What are the refund windows for annual plans and for monthly plans?';
const OPTIONS = { maxResults: 25, fallbackToLowerThreshold: true };
const LANGUAGE_VARIABLES = ['RAG_SUPPORTED_LANGUAGES', 'RAG_PRIMARY_LANGUAGE'] as const;
const CI_LANGUAGES = { RAG_SUPPORTED_LANGUAGES: 'zh,en,it', RAG_PRIMARY_LANGUAGE: 'en' } as const;
const D01_VARIABLES = ['RAG_LEXICAL_SEARCH', 'RAG_RERANKER', 'RAG_REFUSAL_THRESHOLD', 'RAG_REFUSAL_FLOOR'] as const;
const CONFIG_ERROR_PREFIX = '[RAG Config] a Phase 4 database function is missing';

/** The Phase 3.2 startup line, read from its source so the test never retypes it. */
const STARTUP_LINE = (() => {
  const source = fs.readFileSync(path.join(REPO_ROOT, 'src/lib/rag/lang/startup.ts'), 'utf8');
  const match = /console\.warn\('(\[RAG Languages\] not configured[^']*)'\)/.exec(source);
  assert.ok(match, 'the Phase 3.2 startup line is in src/lib/rag/lang/startup.ts');
  return match[1];
})();

function setVariable(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

async function dropFunction(db: PGlite, name: string): Promise<void> {
  const signatures = await db.query<{ signature: string }>(
    "SELECT p.oid::regprocedure::text AS signature FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'public' AND p.proname = $1",
    [name],
  );
  assert.ok(signatures.rows.length > 0, `${name} exists before it is dropped`);
  for (const row of signatures.rows) await db.query(`DROP FUNCTION ${row.signature}`);
  const left = await db.query<{ n: number }>("SELECT count(*)::int AS n FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'public' AND p.proname = $1", [name]);
  assert.equal(left.rows[0]?.n, 0, `${name} is gone`);
}

const fallbackOf = (result: RetrievalResult) => result.stages.filter((stage) => stage.name === 'pipeline_fallback').map((stage) => stage.detail);
const comparable = (result: RetrievalResult) => ({
  status: result.status,
  reason: result.reason,
  candidates: result.candidates,
  context: result.context,
  usedDocuments: result.usedDocuments,
  sourceImages: result.sourceImages,
  voice: result.voice ?? null,
});

describe('shipped retrieval default (legacy) on a database without hybrid_search_chunks, single-tenant', () => {
  let db: PGlite;
  let edge: FakeEdge;
  let client: SupabaseClient;
  let rag: typeof import('@/lib/rag');
  let scope: import('@/lib/rag/tenant/scope').TenantScope;
  let depsModule: typeof import('@/lib/rag/deps');
  let configModule: typeof import('@/lib/rag/config');
  let registryModule: typeof import('@/lib/rag/backend/registry');
  let readinessModule: typeof import('@/lib/rag/v2/readiness');
  let settingsModule: typeof import('@/lib/rag/lang/settings');
  let startupModule: typeof import('@/lib/rag/lang/startup');
  let resolveModule: typeof import('@/lib/rag/lang/resolve');
  const previousEnv = { ...process.env } as Record<string, string | undefined>;
  let errors: string[] = [];
  let warnings: string[] = [];

  // A dropped function is answered 404 before the edge records the call, so an attempt shows up in edge.errors instead.
  const hybridCalls = () =>
    edge.calls.filter((call) => call.path.endsWith('/rpc/hybrid_search_chunks')).length +
    edge.errors.filter((error) => error.url.includes('/rpc/hybrid_search_chunks')).length;

  function resetState(): void {
    configModule.resetRagConfigForTests();
    readinessModule.resetV2ReadinessForTests();
    settingsModule.resetLanguageSettingsForTests();
    startupModule.resetLanguageStartupCheckForTests();
    registryModule.resetRetrievalBackendForTests();
  }

  function configure(pipeline: 'legacy' | 'v2' | undefined, languages: boolean): void {
    setVariable('RAG_PIPELINE', pipeline);
    for (const name of LANGUAGE_VARIABLES) setVariable(name, languages ? CI_LANGUAGES[name] : undefined);
    resetState();
  }

  const run = (profile: Profile) => rag.runRetrieval({ scope, query: QUERY, profile, options: OPTIONS, signal: new AbortController().signal });

  before(async () => {
    const fixture = await createFixtureDatabase({ deploymentMode: 'single-tenant', corpusDir: path.join(REPO_ROOT, 'eval/fixtures/corpus') });
    db = fixture.db;
    await dropFunction(db, 'hybrid_search_chunks');
    edge = await startFakeEdge({ db });
    const processEnv = fixtureProcessEnv(edge.url);
    Object.assign(process.env, processEnv);
    process.env.NEXT_PUBLIC_MYRAG_DEPLOYMENT_MODE = 'single-tenant';
    process.env.MYRAG_DEPLOYMENT_MODE = 'single-tenant';
    for (const name of D01_VARIABLES) delete process.env[name];
    rag = await import('@/lib/rag');
    depsModule = await import('@/lib/rag/deps');
    configModule = await import('@/lib/rag/config');
    registryModule = await import('@/lib/rag/backend/registry');
    readinessModule = await import('@/lib/rag/v2/readiness');
    settingsModule = await import('@/lib/rag/lang/settings');
    startupModule = await import('@/lib/rag/lang/startup');
    resolveModule = await import('@/lib/rag/lang/resolve');
    const { mintScope } = await import('@/lib/rag/tenant/scope');
    scope = mintScope('single', null, null);
    client = createClient(edge.url, processEnv.SUPABASE_SERVICE_ROLE_KEY as string, { auth: { persistSession: false, autoRefreshToken: false } });
    // The pipeline and language variables are read from process.env by the real readers; only the clients are faked.
    depsModule.setRagDepsForTests({ adminClient: () => client, embedder: async (text) => embedText(text) });
  });

  beforeEach(() => {
    errors = [];
    warnings = [];
    mock.method(console, 'error', (...args: unknown[]) => void errors.push(args.map(String).join(' ')));
    mock.method(console, 'warn', (...args: unknown[]) => void warnings.push(args.map(String).join(' ')));
    mock.method(console, 'log', () => undefined);
    mock.method(console, 'info', () => undefined);
  });

  afterEach(() => {
    mock.restoreAll();
  });

  after(async () => {
    depsModule?.resetRagDepsForTests();
    if (configModule) resetState();
    await edge?.close();
    await db?.close();
    for (const name of Object.keys(process.env)) {
      if (!(name in previousEnv)) delete process.env[name];
    }
    Object.assign(process.env, previousEnv);
  });

  async function explicitLegacy(profile: Profile, languages: boolean): Promise<RetrievalResult> {
    configure('legacy', languages);
    return run(profile);
  }

  test('implicit default serves legacy without hybrid_search_chunks: same result as explicit legacy, no fallback, no [RAG Config] error', async () => {
    for (const profile of PROFILES) {
      const expected = await explicitLegacy(profile, true);
      assert.equal(expected.status, 'ok', `${profile}: explicit legacy status ${expected.status} (${expected.reason})`);
      assert.ok(expected.candidates.length > 0 || (expected.voice?.results ?? []).length > 0, `${profile}: explicit legacy finds the corpus`);
      configure(undefined, true);
      const calls = hybridCalls();
      const actual = await run(profile);
      assert.deepEqual(comparable(actual), comparable(expected), `${profile}: the unset pipeline equals explicit legacy`);
      assert.deepEqual(fallbackOf(actual), [], `${profile}: legacy is the shipped default, not a fallback`);
      assert.equal(hybridCalls(), calls, `${profile}: hybrid_search_chunks is never called`);
      assert.equal(readinessModule.resolveEffectivePipeline().pipeline, 'legacy');
      assert.equal(readinessModule.resolveEffectivePipeline().source, 'default');
    }
    assert.deepEqual(errors.filter((line) => line.startsWith(CONFIG_ERROR_PREFIX)), []);
    assert.equal(readinessModule.isV2Available(), true, 'nothing marks v2 unavailable on the legacy default');
  });

  test('explicit v2 fails loudly without hybrid_search_chunks: status error, reason backend_error, on every profile', async () => {
    for (const profile of PROFILES) {
      configure('v2', true);
      const calls = hybridCalls();
      const result = await run(profile);
      assert.equal(result.status, 'error', `${profile}: status ${result.status}`);
      assert.equal(result.reason, 'backend_error', `${profile}: reason ${result.reason}`);
      assert.ok(hybridCalls() > calls, `${profile}: v2 asked for hybrid_search_chunks`);
      assert.deepEqual(fallbackOf(result), [], `${profile}: an explicit v2 never falls back`);
    }
    assert.deepEqual(errors.filter((line) => line.startsWith(CONFIG_ERROR_PREFIX)), [], 'an explicit v2 does not take the implicit-default fallback');
  });

  test('implicit default serves legacy until the languages are chosen: every profile equals explicit legacy, no language read, no startup line', async () => {
    for (const profile of PROFILES) {
      const expected = await explicitLegacy(profile, false);
      configure(undefined, false);
      let reads = 0;
      settingsModule.setLanguageSettingsTrapForTests(() => {
        reads += 1;
        throw new Error('[Readiness Test] the language settings were read on the legacy default');
      });
      try {
        assert.equal(startupModule.verifyLanguageSettingsAtStartup()?.servedLegacyBecauseUnset, false);
        assert.equal(startupModule.verifyLanguageSettingsAtStartup(), null, 'the startup check runs once per process');
        const calls = hybridCalls();
        for (let index = 0; index < 3; index += 1) {
          const actual = await run(profile);
          assert.deepEqual(comparable(actual), comparable(expected), `${profile} request ${index + 1}: equals explicit legacy`);
          assert.deepEqual(fallbackOf(actual), [], `${profile}: no ${resolveModule.LANGUAGES_NOT_CONFIGURED} fallback on the legacy default`);
          assert.notEqual(actual.reason, resolveModule.LANGUAGES_NOT_CONFIGURED);
        }
        assert.equal(hybridCalls(), calls, `${profile}: hybrid_search_chunks is never called`);
        assert.equal(reads, 0, `${profile}: the legacy default reads no language settings`);
      } finally {
        settingsModule.setLanguageSettingsTrapForTests(null);
      }
    }
    assert.equal(warnings.filter((line) => line.includes(STARTUP_LINE)).length, 0, 'the Phase 3.2 startup line is for a defaulted v2 only');
  });

  test('explicit v2 without languages reports languages_not_configured on every profile and nothing throws', async () => {
    for (const profile of PROFILES) {
      configure('v2', false);
      const calls = hybridCalls();
      const result = await run(profile);
      assert.equal(result.status, 'error', `${profile}: status ${result.status}`);
      assert.equal(result.reason, resolveModule.LANGUAGES_NOT_CONFIGURED, `${profile}: reason ${result.reason}`);
      assert.equal(hybridCalls(), calls, `${profile}: no search before the language check`);
    }
  });

  test('implicit default with the languages set still runs legacy: the shipped default is legacy (not flipped)', async () => {
    for (const profile of PROFILES) {
      const expected = await explicitLegacy(profile, true);
      configure(undefined, true);
      const calls = hybridCalls();
      const actual = await run(profile);
      assert.deepEqual(comparable(actual), comparable(expected), `${profile}: equals explicit legacy`);
      assert.equal(hybridCalls(), calls, `${profile}: no v2 search`);
    }
    configure(undefined, true);
    assert.equal(startupModule.verifyLanguageSettingsAtStartup()?.servedLegacyBecauseUnset, false);
    assert.equal(warnings.filter((line) => line.includes(STARTUP_LINE)).length, 0);
  });

  test('the fixture edge saw no unsupported request', () => {
    assert.deepEqual(edge.errors.filter((error) => !error.url.includes('/rpc/hybrid_search_chunks')), []);
  });
});

describe('shipped ingest default on a database without the chunking-profile function, single-tenant', () => {
  let db: PGlite;
  let edge: FakeEdge;
  let uninstall: (() => Promise<void>) | undefined;
  let rag: typeof import('@/lib/rag');
  let scope: import('@/lib/rag/tenant/scope').TenantScope;
  let configModule: typeof import('@/lib/rag/config');
  let readinessModule: typeof import('@/lib/rag/v2/readiness');
  let settingsModule: typeof import('@/lib/rag/lang/settings');
  let ingestConfig: typeof import('@/lib/rag/ingest/config');
  const previousEnv = { ...process.env } as Record<string, string | undefined>;
  let errors: string[] = [];
  let sequence = 0;
  const TEXT = '# Service terms\n\nThe service terms describe how a request is handled, how long it takes and who answers it.\n';

  const profileListCalls = () =>
    edge.calls.filter((call) => call.path.endsWith('/rpc/rag_list_chunking_profiles')).length +
    edge.errors.filter((error) => error.url.includes('/rpc/rag_list_chunking_profiles')).length;

  function configure(pipeline: 'legacy' | 'v2' | undefined): void {
    setVariable('RAG_PIPELINE', pipeline);
    for (const name of LANGUAGE_VARIABLES) setVariable(name, CI_LANGUAGES[name]);
    configModule.resetRagConfigForTests();
    readinessModule.resetV2ReadinessForTests();
    settingsModule.resetLanguageSettingsForTests();
    ingestConfig.resetIngestConfigForTests();
  }

  const ingestOne = () =>
    rag.submitIngest({
      scope,
      source: 'config_upload',
      sourceKey: `readiness-fallback-${++sequence}.md`,
      filename: `readiness-fallback-${sequence}.md`,
      mimeType: 'text/markdown',
      text: TEXT.replace('Service terms', `Service terms ${sequence}`),
      signal: new AbortController().signal,
    } as unknown as Parameters<typeof rag.submitIngest>[0]);

  before(async () => {
    const empty = await createEmptyFixtureDatabase({ deploymentMode: 'single-tenant' });
    db = empty.db;
    await dropFunction(db, 'rag_list_chunking_profiles');
    edge = await startFakeEdge({ db });
    Object.assign(process.env, fixtureProcessEnv(edge.url));
    process.env.NEXT_PUBLIC_MYRAG_DEPLOYMENT_MODE = 'single-tenant';
    process.env.MYRAG_DEPLOYMENT_MODE = 'single-tenant';
    for (const name of D01_VARIABLES) delete process.env[name];
    const { INGEST_MODE_ENV, fixtureAdminClient, installIngestFakes } = await import('../../eval/harness/ingest-fakes.mts');
    const fakes = await installIngestFakes({ db: fixtureAdminClient(edge.url), env: INGEST_MODE_ENV });
    uninstall = fakes.uninstall;
    rag = await import('@/lib/rag');
    configModule = await import('@/lib/rag/config');
    readinessModule = await import('@/lib/rag/v2/readiness');
    settingsModule = await import('@/lib/rag/lang/settings');
    ingestConfig = await import('@/lib/rag/ingest/config');
    const { mintScope } = await import('@/lib/rag/tenant/scope');
    scope = mintScope('single', null, null);
  });

  beforeEach(() => {
    errors = [];
    mock.method(console, 'error', (...args: unknown[]) => void errors.push(args.map(String).join(' ')));
    mock.method(console, 'warn', () => undefined);
    mock.method(console, 'log', () => undefined);
    mock.method(console, 'info', () => undefined);
  });

  afterEach(() => {
    mock.restoreAll();
  });

  after(async () => {
    await uninstall?.();
    configModule?.resetRagConfigForTests();
    readinessModule?.resetV2ReadinessForTests();
    settingsModule?.resetLanguageSettingsForTests();
    ingestConfig?.resetIngestConfigForTests();
    await edge?.close();
    await db?.close();
    for (const name of Object.keys(process.env)) {
      if (!(name in previousEnv)) delete process.env[name];
    }
    Object.assign(process.env, previousEnv);
  });

  test('implicit default ingests without the chunking-profile function: the unified ingest completes with legacy chunks only', async () => {
    configure(undefined);
    const calls = profileListCalls();
    const result = (await ingestOne()) as { status: string; documentId?: string; chunkCount?: number };
    assert.notEqual(result.status, 'failed', `status ${result.status}`);
    assert.ok((result.chunkCount ?? 0) > 0, 'legacy chunks were written');
    const chunks = await db.query<{ n: number }>('SELECT count(*)::int AS n FROM document_chunks WHERE document_id = $1', [result.documentId]);
    assert.equal(chunks.rows[0]?.n, result.chunkCount);
    const profiled = await db.query<{ n: number }>(
      'SELECT count(*)::int AS n FROM document_chunks WHERE document_id = $1 AND chunking_profile_id <> $2',
      [result.documentId, 'legacy'],
    );
    assert.equal(profiled.rows[0]?.n, 0, 'no non-legacy profile chunk');
    assert.equal(profileListCalls(), calls, 'the legacy default never lists chunking profiles');
    assert.deepEqual(errors.filter((line) => line.startsWith(CONFIG_ERROR_PREFIX)), []);
  });

  test('explicit v2 ingest fails without the chunking-profile function: chunking_profiles_unavailable', async () => {
    configure('v2');
    const calls = profileListCalls();
    const result = (await ingestOne()) as { status: string; error?: unknown; reason?: unknown };
    assert.equal(result.status, 'failed', `status ${result.status}`);
    assert.match(JSON.stringify(result), /chunking_profiles_unavailable/);
    assert.ok(profileListCalls() > calls, 'v2 asked for the chunking profiles');
    assert.equal(readinessModule.isV2Available(), true, 'an explicit v2 does not take the implicit-default fallback');
  });
});
