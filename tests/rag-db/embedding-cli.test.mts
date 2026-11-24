import { after, afterEach, before, beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { embedText } from '../../eval/harness/fixture-embedder.mts';
import { fixtureProcessEnv, startFakeEdge, type FakeEdge } from '../../eval/harness/fake-edge.mts';
import { TWO_TENANT_IDS, createTwoTenantDatabase, type TwoTenantDatabase } from '../../eval/harness/two-tenant.mts';

const LEGACY = 'openai-3-small-1536';
const VOYAGE = 'voyage-4-large-2048';
const VOYAGE_MODEL = 'voyage-4-large';
const QWEN = 'qwen3-8b-2048';
const SEEDED = [LEGACY, 'voyage-4-large-2048', 'voyage-4-large-1024', 'qwen3-8b-2048', 'qwen3-8b-1024'];
const QUERY = 'two tenant isolation canary phrase';
const OPTIONS = { maxResults: 25, fallbackToLowerThreshold: true };

type Row = Record<string, unknown>;

function padded(vector: number[], dims: number): number[] {
  return [...vector, ...new Array<number>(Math.max(0, dims - vector.length)).fill(0)];
}

describe('rag:embedding CLI over the gated pointer flip', () => {
  let fixture: TwoTenantDatabase;
  let edge: FakeEdge;
  let cli: typeof import('@/lib/rag/embeddings/cli');
  let rag: typeof import('@/lib/rag');
  let reembed: typeof import('@/lib/rag/ingest/reembed/run');
  let resolver: typeof import('@/lib/rag/tenant/resolve-chat');
  let supabaseModule: typeof import('@/lib/supabase');
  let ingestDeps: typeof import('@/lib/rag/ingest/deps');
  let ingestConfig: typeof import('@/lib/rag/ingest/config');
  let activeProfile: typeof import('@/lib/rag/embeddings/active-profile');
  let registry: typeof import('@/lib/rag/embeddings/registry');
  let queryDims: number[];

  before(async () => {
    fixture = await createTwoTenantDatabase();
    edge = await startFakeEdge({ db: fixture.db });
    Object.assign(process.env, fixtureProcessEnv(edge.url));
    process.env.NEXT_PUBLIC_MYRAG_DEPLOYMENT_MODE = 'multi-tenant';
    process.env.MYRAG_DEPLOYMENT_MODE = 'multi-tenant';
    cli = await import('@/lib/rag/embeddings/cli');
    rag = await import('@/lib/rag');
    reembed = await import('@/lib/rag/ingest/reembed/run');
    resolver = await import('@/lib/rag/tenant/resolve-chat');
    supabaseModule = await import('@/lib/supabase');
    ingestDeps = await import('@/lib/rag/ingest/deps');
    ingestConfig = await import('@/lib/rag/ingest/config');
    activeProfile = await import('@/lib/rag/embeddings/active-profile');
    registry = await import('@/lib/rag/embeddings/registry');
  });

  after(async () => {
    registry?.resetEmbeddingProvidersForTests();
    ingestDeps?.resetIngestDepsForTests();
    activeProfile?.resetActiveProfileForTests();
    await edge?.close();
    await fixture?.db.close();
  });

  const rows = async (sql: string, params: unknown[] = []): Promise<Row[]> => (await fixture.db.query<Row>(sql, params)).rows;

  function useSwitch(value: 'on' | 'off'): void {
    ingestConfig.resetIngestConfigForTests();
    ingestDeps.setIngestDepsForTests({ ingestEnv: () => ({ RAG_EMBEDDING_PROFILES: value }) });
    activeProfile.resetActiveProfileForTests();
  }

  beforeEach(async () => {
    queryDims = [];
    await fixture.db.query('DELETE FROM embedding_backfill_gaps');
    await fixture.db.query('DELETE FROM embedding_backfill_runs');
    await fixture.db.query('DELETE FROM chunk_embeddings');
    await fixture.db.query(
      "UPDATE embedding_profiles SET status = 'available', activated_at = NULL, activated_by = NULL, previous_active_id = NULL, eval_evidence = NULL",
    );
    await fixture.db.query("UPDATE embedding_profiles SET status = 'active', activated_at = now() - interval '2 hours', activated_by = 'test' WHERE id = $1", [LEGACY]);
    registry.setEmbeddingProvidersForTests({
      voyage: {
        id: 'voyage',
        model: VOYAGE_MODEL,
        maxInputTokens: 8000,
        supportedDims: [1024, 2048],
        normalize: true,
        async embedDocuments(texts, opts) {
          return { vectors: texts.map((text) => padded(embedText(text), opts.dims)), model: VOYAGE_MODEL, host: 'fake-host', usage: { tokens: texts.length } };
        },
        async embedQuery(text, opts) {
          queryDims.push(opts.dims);
          return { vectors: [padded(embedText(text), opts.dims)], model: VOYAGE_MODEL, host: 'fake-host', usage: { tokens: 1 } };
        },
      },
    });
    useSwitch('on');
    edge.calls.length = 0;
  });

  afterEach(() => {
    registry.resetEmbeddingProvidersForTests();
    ingestDeps.resetIngestDepsForTests();
    activeProfile.resetActiveProfileForTests();
  });

  async function run(...argv: string[]): Promise<{ code: number; text: string }> {
    const lines: string[] = [];
    const code = await cli.main(argv, { out: (line) => lines.push(line), err: (line) => lines.push(line) });
    return { code, text: lines.join('\n') };
  }

  const db = () => ingestDeps.getIngestDeps().db() as import('@/lib/rag/backend/supabase-rpc').RpcClient;

  async function backfillVoyage(): Promise<string> {
    const report = await reembed.runReembed({ db: db(), profileId: VOYAGE, batchSize: 8 });
    assert.equal(report.status, 'completed');
    return report.runId;
  }

  async function setEvidence(profileId: string, runId: string, overrides: Record<string, unknown> = {}): Promise<void> {
    const evidence = {
      target_profile: profileId,
      baseline_profile: LEGACY,
      gate_passed: true,
      pre_migration: { passed: true, n: 12 },
      backfill_run_id: runId,
      recorded_at: new Date(Date.now() + 60_000).toISOString(),
      ...overrides,
    };
    await fixture.db.query('UPDATE embedding_profiles SET eval_evidence = $2::jsonb WHERE id = $1', [profileId, JSON.stringify(evidence)]);
  }

  const activeId = async (): Promise<string | undefined> => (await rows("SELECT id FROM embedding_profiles WHERE status = 'active'"))[0]?.id as string | undefined;

  async function retrieve(userId: string | null, organizationId: string | null) {
    const resolved = await resolver.resolveTenantScope({
      requestedOrganizationId: organizationId,
      deploymentMode: 'multi-tenant',
      getUser: async () => (userId ? { id: userId } : null),
      admin: supabaseModule.getSupabaseAdmin(),
      signal: new AbortController().signal,
    });
    assert.ok(resolved.ok && resolved.scope, 'scope must resolve');
    return rag.runRetrieval({ scope: resolved.scope, query: QUERY, profile: 'eval', options: OPTIONS, signal: new AbortController().signal });
  }

  const documentsOf = (result: Awaited<ReturnType<typeof retrieve>>): string[] => [...new Set(result.candidates.map((candidate) => candidate.document_id))].sort();
  const searches = (fn: string): number => edge.calls.filter((call) => call.path.endsWith(`/rpc/${fn}`)).length;

  test('status lists the five seeded profiles with status, dims, storage, completeness per profile and whether evidence exists', async () => {
    const first = (await rows("SELECT id FROM document_chunks WHERE is_current AND status = 'ready' ORDER BY id LIMIT 1"))[0]?.id;
    await fixture.db.query(
      `INSERT INTO chunk_embeddings (chunk_id, profile_id, tenant_key, embedding, embedding_model, dims)
       SELECT c.id, $2, c.tenant_key, array_fill(0.1::float4, ARRAY[2048])::halfvec, $3, 2048 FROM document_chunks c WHERE c.id = $1`,
      [first, VOYAGE, VOYAGE_MODEL],
    );
    await fixture.db.query('UPDATE embedding_profiles SET eval_evidence = $2::jsonb WHERE id = $1', [QWEN, JSON.stringify({ target_profile: QWEN })]);

    const { code, text } = await run('status');
    assert.equal(code, 0, text);
    for (const id of SEEDED) assert.match(text, new RegExp(`profile ${id}\\b`), `${id} is listed`);
    const line = (id: string): string => text.split('\n').find((entry) => entry.includes(`profile ${id} `)) ?? '';
    assert.match(line(LEGACY), /status=active\b.*dims=1536\b.*storage=legacy_column\b/);
    assert.match(line(VOYAGE), /status=available\b.*dims=2048\b.*storage=halfvec\b.*completeness=33\.3%.*evidence=no\b/);
    assert.match(line(QWEN), /completeness=0\.0%.*evidence=yes\b/);
    assert.match(line('voyage-4-large-1024'), /completeness=0\.0%/);
    assert.match(text, /switch: on/);
    assert.match(text, new RegExp(`active: ${LEGACY}`));
    assert.ok(!/sk-|service-role|apikey/i.test(text), 'no key material in the output');
  });

  test('activate on an incomplete profile exits non-zero, prints the named refusal with the missing count and leaves the pointer alone', async () => {
    const { code, text } = await run('activate', VOYAGE);
    assert.notEqual(code, 0);
    assert.match(text, /activation_refused: incomplete/);
    assert.match(text, /\b3 current ready chunks have no vector for profile voyage-4-large-2048/);
    assert.equal(await activeId(), LEGACY);
  });

  test('after a re-embed run and passing evidence activate exits 0, records the actor and refreshes the cached pointer', async () => {
    const runId = await backfillVoyage();
    await setEvidence(VOYAGE, runId);
    assert.equal((await activeProfile.getActiveProfile()).id, LEGACY, 'the pointer is cached before the flip');

    const { code, text } = await run('activate', VOYAGE);
    assert.equal(code, 0, text);
    assert.match(text, new RegExp(`activated ${VOYAGE}`));
    assert.equal(await activeId(), VOYAGE);
    const row = (await rows('SELECT activated_by, previous_active_id FROM embedding_profiles WHERE id = $1', [VOYAGE]))[0] as Row;
    assert.match(String(row.activated_by), /^cli:[A-Za-z0-9._-]+$/);
    assert.equal(row.previous_active_id, LEGACY);
    assert.equal((await activeProfile.getActiveProfile()).id, VOYAGE, 'the in-process pointer cache was refreshed by the flip, not by its TTL');
  });

  test('every gate refusal is shown by name and exits non-zero, and nothing moves until the evidence is right', async () => {
    const runId = await backfillVoyage();
    const variants: Array<[string, () => Promise<void>]> = [
      ['eval_missing', async () => undefined],
      ['eval_target_mismatch', () => setEvidence(VOYAGE, runId, { target_profile: QWEN })],
      ['eval_baseline_mismatch', () => setEvidence(VOYAGE, runId, { baseline_profile: QWEN })],
      ['eval_failed', () => setEvidence(VOYAGE, runId, { gate_passed: false })],
      ['pre_migration_missing', () => setEvidence(VOYAGE, runId, { pre_migration: null })],
      ['eval_run_mismatch', () => setEvidence(VOYAGE, runId, { backfill_run_id: '00000000-0000-4000-8000-00000000dead' })],
      ['eval_stale', () => setEvidence(VOYAGE, runId, { recorded_at: new Date(Date.now() - 3600_000).toISOString() })],
    ];
    for (const [name, arrange] of variants) {
      await arrange();
      const { code, text } = await run('activate', VOYAGE);
      assert.notEqual(code, 0, name);
      assert.match(text, new RegExp(`activation_refused: ${name}\\b`), name);
      assert.equal(await activeId(), LEGACY, `${name} moved nothing`);
    }

    await setEvidence(VOYAGE, runId);
    await fixture.db.query("UPDATE chunk_embeddings SET embedding_model = 'another-model' WHERE profile_id = $1 AND chunk_id = (SELECT min(chunk_id) FROM chunk_embeddings WHERE profile_id = $1)", [VOYAGE]);
    const mismatch = await run('activate', VOYAGE);
    assert.notEqual(mismatch.code, 0);
    assert.match(mismatch.text, /activation_refused: model_mismatch/);
    await fixture.db.query('UPDATE chunk_embeddings SET embedding_model = $2 WHERE profile_id = $1', [VOYAGE, VOYAGE_MODEL]);

    const unknown = await run('activate', 'no-such-profile-1');
    assert.notEqual(unknown.code, 0);
    assert.match(unknown.text, /activation_refused: unknown_profile/);
    const already = await run('activate', LEGACY);
    assert.notEqual(already.code, 0);
    assert.match(already.text, /activation_refused: already_active/);
    assert.equal(await activeId(), LEGACY);
  });

  test('the full cycle: backfill, evidence, activate, retrieval on the new profile, rollback, retrieval on the legacy profile, with the same tenant isolation', async () => {
    const tenants: Array<[string | null, string | null, string]> = [
      [TWO_TENANT_IDS.userA, null, TWO_TENANT_IDS.docA],
      [TWO_TENANT_IDS.userB, null, TWO_TENANT_IDS.docB],
      [TWO_TENANT_IDS.userA, TWO_TENANT_IDS.orgO, TWO_TENANT_IDS.docO],
    ];

    for (const [userId, orgId, expected] of tenants) {
      const result = await retrieve(userId, orgId);
      assert.deepEqual(documentsOf(result), [expected], 'before: the legacy profile answers with the tenant own document');
    }
    assert.equal(searches('match_chunks_by_profile'), 0, 'before the flip no profile search runs');
    assert.ok(searches('match_documents_by_workspace') > 0);

    const rollbackFirst = await run('rollback');
    assert.notEqual(rollbackFirst.code, 0);
    assert.match(rollbackFirst.text, /rollback_refused: no_previous/);

    const runId = await backfillVoyage();
    await setEvidence(VOYAGE, runId);
    const flipped = await run('activate', VOYAGE);
    assert.equal(flipped.code, 0, flipped.text);

    edge.calls.length = 0;
    queryDims.length = 0;
    for (const [userId, orgId, expected] of tenants) {
      const result = await retrieve(userId, orgId);
      assert.equal(result.status, 'ok');
      assert.deepEqual(documentsOf(result), [expected], 'on the new profile each tenant sees only its own document');
    }
    assert.ok(searches('match_chunks_by_profile') >= tenants.length, 'the profile RPC answers after the flip');
    assert.equal(searches('match_documents_by_workspace'), 0, 'and the legacy column is not searched');
    assert.ok(queryDims.length >= tenants.length && queryDims.every((dims) => dims === 2048), 'queries are embedded for the new profile');

    const rolled = await run('rollback');
    assert.equal(rolled.code, 0, rolled.text);
    assert.match(rolled.text, new RegExp(`restored ${LEGACY}`));
    assert.equal(await activeId(), LEGACY);
    assert.equal((await activeProfile.getActiveProfile()).id, LEGACY, 'the cached pointer follows the rollback');

    edge.calls.length = 0;
    for (const [userId, orgId, expected] of tenants) {
      const result = await retrieve(userId, orgId);
      assert.deepEqual(documentsOf(result), [expected], 'after the rollback the legacy profile answers with the same documents');
    }
    assert.equal(searches('match_chunks_by_profile'), 0);
    assert.ok(searches('match_documents_by_workspace') > 0);

    const again = await run('rollback');
    assert.notEqual(again.code, 0, 'a second rollback does not toggle back');
    assert.match(again.text, /rollback_refused: no_previous/);
  });

  test('a rollback to a profile that lost vectors is refused by name', async () => {
    const runId = await backfillVoyage();
    await setEvidence(VOYAGE, runId);
    assert.equal((await run('activate', VOYAGE)).code, 0);
    await fixture.db.query("UPDATE document_chunks SET embedding = NULL WHERE id = (SELECT id FROM document_chunks WHERE is_current AND status = 'ready' ORDER BY id LIMIT 1)");
    const { code, text } = await run('rollback');
    assert.notEqual(code, 0);
    assert.match(text, /rollback_refused: incomplete/);
    assert.equal(await activeId(), VOYAGE, 'the pointer stays where it was');
  });

  test('set-status moves a profile between available, backfilling and retired and never sets active', async () => {
    for (const status of ['backfilling', 'retired', 'available']) {
      const { code, text } = await run('set-status', QWEN, status);
      assert.equal(code, 0, text);
      assert.equal((await rows('SELECT status FROM embedding_profiles WHERE id = $1', [QWEN]))[0]?.status, status);
    }
    const active = await run('set-status', QWEN, 'active');
    assert.notEqual(active.code, 0);
    assert.match(active.text, /activate/);
    assert.equal((await rows('SELECT status FROM embedding_profiles WHERE id = $1', [QWEN]))[0]?.status, 'available');
    assert.equal(await activeId(), LEGACY);

    const onActive = await run('set-status', LEGACY, 'retired');
    assert.notEqual(onActive.code, 0);
    assert.match(onActive.text, /profile_status_refused: profile_is_active/);
    const unknown = await run('set-status', 'no-such-profile-1', 'retired');
    assert.notEqual(unknown.code, 0);
    assert.match(unknown.text, /profile_status_refused: unknown_profile/);
    assert.equal(await activeId(), LEGACY);
  });

  test('bad arguments are refused with usage and exit 2 before the database is touched', async () => {
    for (const argv of [[], ['frobnicate'], ['activate'], ['activate', 'Bad Id!'], ['activate', VOYAGE, 'extra'], ['rollback', 'extra'], ['status', '--x'], ['set-status', QWEN], ['set-status', QWEN, 'nonsense'], ['set-status', QWEN, 'active']]) {
      edge.calls.length = 0;
      const { code, text } = await run(...argv);
      assert.equal(code, 2, `${argv.join(' ') || '(none)'}: ${text}`);
      assert.match(text, /usage:/);
      assert.deepEqual(edge.calls, [], 'no request left the process');
    }
    assert.deepEqual(cli.parseEmbeddingArgs(['status']), { ok: true, command: 'status' });
    assert.deepEqual(cli.parseEmbeddingArgs(['activate', VOYAGE]), { ok: true, command: 'activate', profileId: VOYAGE });
    assert.deepEqual(cli.parseEmbeddingArgs(['rollback']), { ok: true, command: 'rollback' });
    assert.deepEqual(cli.parseEmbeddingArgs(['set-status', QWEN, 'retired']), { ok: true, command: 'set-status', profileId: QWEN, status: 'retired' });
  });

  test('status and the flips say so when the deployment switch is off', async () => {
    useSwitch('off');
    const status = await run('status');
    assert.equal(status.code, 0, status.text);
    assert.match(status.text, /switch: off/);
    assert.match(status.text, /RAG_EMBEDDING_PROFILES is off/);
    const runId = await backfillVoyage();
    await setEvidence(VOYAGE, runId);
    const flipped = await run('activate', VOYAGE);
    assert.equal(flipped.code, 0, flipped.text);
    assert.match(flipped.text, /RAG_EMBEDDING_PROFILES is off/, 'the operator is told queries still use the legacy profile');
  });
});
