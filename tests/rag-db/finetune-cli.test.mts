import { after, afterEach, before, beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fixtureProcessEnv, startFakeEdge, type FakeEdge } from '../../eval/harness/fake-edge.mts';
import { TWO_TENANT_IDS, createTwoTenantDatabase, type TwoTenantDatabase } from '../../eval/harness/two-tenant.mts';
import { fakeSlotVector, startFakeEmbeddingEndpoints, type FakeEmbeddingEndpoints } from '../helpers/fake-embedding-endpoints';

const SLOT_A = 'ft-a-1024';
const SLOT_B = 'ft-b-1024';
const TENANT_A = `u:${TWO_TENANT_IDS.userA}`;
const TENANT_B = `u:${TWO_TENANT_IDS.userB}`;
const VERSION_A = 'ft-widget-model-a1';
const QUERY_PROMPT = 'Instruct: find the passage that answers the question\nQuery: ';
const DOCUMENT_PROMPT = 'passage: ';
const PROBE_TEXTS = ['first neutral probe sentence about widgets', 'second neutral probe sentence about gadgets', 'third neutral probe sentence about gizmos'];
const ROLES = ['query', 'document', 'query'] as const;
const PRUNE_ARGV = (tenant: string) => ['uv', 'run', '--directory', 'eval', 'python', '-m', 'rag_eval.finetune', 'prune', '--tenant', tenant];

type Row = Record<string, unknown>;

function unit(vector: number[]): number[] {
  const norm = Math.sqrt(vector.reduce((sum, x) => sum + x * x, 0));
  return vector.map((x) => x / norm);
}

function metrics() {
  const slice = { n: 12, recall_at_10: 0.8, mrr_at_10: 0.6, ndcg_at_10: 0.65 };
  const model = { overall: slice, by_language: { en: slice }, by_pair: {}, by_source: { synthetic: slice } };
  return { passed: true, noise_band: 0.01, reasons: [], deltas: [], models: { base: model, production: model, finetuned: model } };
}

function card(id: string, scope: 'deployment' | 'tenant', tenantKeys: string[], overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const vectors = PROBE_TEXTS.map((text, index) => unit(fakeSlotVector(`${ROLES[index] === 'query' ? QUERY_PROMPT : DOCUMENT_PROMPT}${text}`)));
  return {
    id,
    base_model: 'example-org/example-embedding',
    base_revision: 'a'.repeat(40),
    dims: 1024,
    scope,
    tenant_keys: [...tenantKeys].sort(),
    dataset_manifest_sha256: 'b'.repeat(64),
    training_config_sha256: 'c'.repeat(64),
    query_prompt: QUERY_PROMPT,
    document_prompt: DOCUMENT_PROMPT,
    offline: metrics(),
    status: 'candidate',
    probe: { texts: PROBE_TEXTS, query_prompt: QUERY_PROMPT, document_prompt: DOCUMENT_PROMPT, vectors },
    artifact_uri: `s3://models-bucket/${id}`,
    ...overrides,
  };
}

describe('rag:embedding ft-* commands over the fine-tune registry', () => {
  let fixture: TwoTenantDatabase;
  let edge: FakeEdge;
  let endpoints: FakeEmbeddingEndpoints;
  let cli: typeof import('@/lib/rag/embeddings/cli');
  let slotModule: typeof import('@/lib/rag/embeddings/finetune-slot');
  let activeProfile: typeof import('@/lib/rag/embeddings/active-profile');
  let workDir: string;
  let switchOn = true;
  let commands: string[][] = [];
  let commandExit = 0;

  before(async () => {
    fixture = await createTwoTenantDatabase();
    edge = await startFakeEdge({ db: fixture.db });
    endpoints = await startFakeEmbeddingEndpoints();
    Object.assign(process.env, fixtureProcessEnv(edge.url));
    process.env.NEXT_PUBLIC_MYRAG_DEPLOYMENT_MODE = 'multi-tenant';
    process.env.MYRAG_DEPLOYMENT_MODE = 'multi-tenant';
    process.env.RAG_FINETUNE = 'on';
    process.env.RAG_FT_SLOT_A_BASE_URL = endpoints.urls.ft;
    process.env.RAG_FT_SLOT_A_MODEL = VERSION_A;
    process.env.RAG_FT_SLOT_A_QUERY_PROMPT = QUERY_PROMPT;
    process.env.RAG_FT_SLOT_A_DOCUMENT_PROMPT = DOCUMENT_PROMPT;
    process.env.RAG_FT_EMBED_API_KEY = 'ft-endpoint-placeholder-secret-0000';
    cli = await import('@/lib/rag/embeddings/cli');
    slotModule = await import('@/lib/rag/embeddings/finetune-slot');
    activeProfile = await import('@/lib/rag/embeddings/active-profile');
    workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'finetune-cli-'));
  });

  after(async () => {
    activeProfile?.resetActiveProfileForTests();
    await endpoints?.stop();
    await edge?.close();
    await fixture?.db.close();
    if (workDir) fs.rmSync(workDir, { recursive: true, force: true });
  });

  const rows = async (sql: string, params: unknown[] = []): Promise<Row[]> => (await fixture.db.query<Row>(sql, params)).rows;

  beforeEach(async () => {
    switchOn = true;
    commands = [];
    commandExit = 0;
    for (const slot of [SLOT_A, SLOT_B]) await fixture.db.query("SELECT * FROM rag_finetune_clear_slot($1, 'test', 10000)", [slot]);
    await fixture.db.query('DELETE FROM embedding_model_versions');
    await fixture.db.query('DELETE FROM rag_finetune_consent');
    slotModule.resetFinetuneProbeCacheForTests();
    endpoints.setFtSalt('');
    activeProfile.resetActiveProfileForTests();
    edge.calls.length = 0;
  });

  afterEach(() => {
    activeProfile.resetActiveProfileForTests();
  });

  async function run(...argv: string[]): Promise<{ code: number; text: string }> {
    const lines: string[] = [];
    const code = await cli.main(argv, { out: (line) => lines.push(line), err: (line) => lines.push(line) }, undefined, {
      finetuneEnabled: () => switchOn,
      runCommand: async (command) => {
        commands.push(command);
        return commandExit;
      },
    });
    return { code, text: lines.join('\n') };
  }

  function writeCard(value: Record<string, unknown>): string {
    const file = path.join(workDir, `${String(value.id)}-${Math.random().toString(16).slice(2)}.json`);
    fs.writeFileSync(file, JSON.stringify(value));
    return file;
  }

  const rpcCalls = (fn: string): number => edge.calls.filter((call) => call.path.endsWith(`/rpc/${fn}`)).length;
  const versionRow = async (id: string): Promise<Row | undefined> => (await rows('SELECT status, bound_slot FROM embedding_model_versions WHERE id = $1', [id]))[0];
  const slotRow = async (id: string): Promise<Row | undefined> => (await rows('SELECT model, status, eval_evidence, query_instruction FROM embedding_profiles WHERE id = $1', [id]))[0];

  async function registerAndBind(tenant = TENANT_A, version = VERSION_A): Promise<void> {
    assert.equal((await run('ft-consent', 'grant', tenant, '--scope', 'deployment', '--ref', 'TICKET-1001')).code, 0);
    const registered = await run('ft-models', 'register', writeCard(card(version, 'deployment', [tenant])));
    assert.equal(registered.code, 0, registered.text);
    const bound = await run('ft-bind', SLOT_A, version);
    assert.equal(bound.code, 0, bound.text);
  }

  test('grant, register, bind and list; revoke taints the version, drops the slot evidence and prints the next steps', async () => {
    await registerAndBind();
    const consent = await run('ft-consent', 'list');
    assert.equal(consent.code, 0, consent.text);
    assert.match(consent.text, new RegExp(`${TENANT_A}.*scope=deployment.*evidence_ref=TICKET-1001`));
    const models = await run('ft-models', 'list');
    assert.equal(models.code, 0, models.text);
    assert.match(models.text, new RegExp(`${VERSION_A}.*status=bound.*slot=${SLOT_A}`));
    assert.deepEqual(await versionRow(VERSION_A), { status: 'bound', bound_slot: SLOT_A });
    const slot = await slotRow(SLOT_A);
    assert.equal(slot?.model, VERSION_A);
    assert.equal(slot?.query_instruction, QUERY_PROMPT);

    await fixture.db.query('UPDATE embedding_profiles SET eval_evidence = $2::jsonb WHERE id = $1', [SLOT_A, JSON.stringify({ target_profile: SLOT_A })]);
    assert.ok((await slotRow(SLOT_A))?.eval_evidence, 'the slot holds evidence before the revocation');

    const revoked = await run('ft-consent', 'revoke', TENANT_A);
    assert.equal(revoked.code, 0, revoked.text);
    assert.match(revoked.text, new RegExp(`tainted.*${VERSION_A}`));
    assert.ok(revoked.text.includes(`npm run rag:embedding -- ft-clear ${SLOT_A}`), revoked.text);
    assert.ok(revoked.text.includes(`uv run --directory eval python -m rag_eval.finetune prune --tenant ${TENANT_A}`), revoked.text);
    assert.ok(revoked.text.includes(`s3://models-bucket/${VERSION_A}`), 'the artifact location to delete is listed');
    assert.deepEqual(commands, [], 'without --prune-root nothing is run');
    assert.equal((await versionRow(VERSION_A))?.status, 'tainted');
    assert.equal((await slotRow(SLOT_A))?.eval_evidence, null, 'revocation dropped the slot evidence');
    assert.equal((await rows('SELECT scope FROM rag_finetune_consent WHERE tenant_key = $1', [TENANT_A]))[0]?.scope, 'none');
  });

  test('revoke of an active slot names the rollback before the clear', async () => {
    await registerAndBind();
    await fixture.db.query("UPDATE embedding_profiles SET status = 'available' WHERE status = 'active'");
    await fixture.db.query("UPDATE embedding_profiles SET eval_evidence = '{}'::jsonb, status = 'active' WHERE id = $1", [SLOT_A]);
    try {
      const revoked = await run('ft-consent', 'revoke', TENANT_A);
      assert.equal(revoked.code, 0, revoked.text);
      assert.match(revoked.text, /ACTIVE/);
      const rollback = revoked.text.indexOf('npm run rag:embedding -- rollback');
      const clear = revoked.text.indexOf(`npm run rag:embedding -- ft-clear ${SLOT_A}`);
      assert.ok(rollback >= 0 && clear > rollback, revoked.text);
    } finally {
      await fixture.db.query("UPDATE embedding_profiles SET status = 'available' WHERE id = $1", [SLOT_A]);
      await fixture.db.query("UPDATE embedding_profiles SET status = 'active' WHERE id = 'openai-3-small-1536'");
    }
  });

  test('revoke --prune-root runs exactly the prune command and reports its exit code', async () => {
    assert.equal((await run('ft-consent', 'grant', TENANT_A, '--ref', 'TICKET-1002')).code, 0);
    const root = path.join(workDir, 'bundles');
    commandExit = 0;
    const ok = await run('ft-consent', 'revoke', TENANT_A, '--prune-root', root);
    assert.equal(ok.code, 0, ok.text);
    assert.deepEqual(commands, [[...PRUNE_ARGV(TENANT_A), '--root', root]]);
    assert.match(ok.text, /prune exited with 0/);
    assert.ok(ok.text.includes(`--tenant ${TENANT_A} --root ${root}`));

    commands = [];
    commandExit = 3;
    const failed = await run('ft-consent', 'revoke', TENANT_A, '--prune-root', root);
    assert.equal(failed.code, 1, failed.text);
    assert.match(failed.text, /prune exited with 3/);
    assert.equal(commands.length, 1);
  });

  test('register refuses a card naming a tenant without consent, and a card the schema rejects before any RPC', async () => {
    assert.equal((await run('ft-consent', 'grant', TENANT_A, '--scope', 'deployment', '--ref', 'TICKET-1003')).code, 0);
    const refused = await run('ft-models', 'register', writeCard(card('ft-widget-model-ab', 'deployment', [TENANT_A, TENANT_B])));
    assert.equal(refused.code, 1, refused.text);
    assert.match(refused.text, /register_refused: consent/);
    assert.equal(await versionRow('ft-widget-model-ab'), undefined);

    edge.calls.length = 0;
    for (const bad of [
      card('ft-widget-model-u1', 'deployment', [TENANT_A], { artifact_uri: 's3://user:secret@models-bucket/x' }),
      card('ft-widget-model-u2', 'deployment', [TENANT_A], { artifact_uri: 's3://models-bucket/x?token=abc' }),
      card('ft-widget-model-u3', 'deployment', [TENANT_A], { artifact_uri: 's3://models-bucket/x#frag' }),
      card('ft-widget-model-u4', 'deployment', [TENANT_A], { dims: 768 }),
      card('ft-widget-model-u5', 'tenant', [TENANT_A, TENANT_B]),
      card('ft-widget-model-u6', 'deployment', [TENANT_A], { probe: { texts: PROBE_TEXTS, query_prompt: 'other: ', document_prompt: DOCUMENT_PROMPT, vectors: [[1], [1], [1]] } }),
    ]) {
      const result = await run('ft-models', 'register', writeCard(bad));
      assert.equal(result.code, 2, `${String(bad.id)}: ${result.text}`);
      assert.ok(!result.text.includes('secret'), 'the credential is not echoed');
    }
    const missing = await run('ft-models', 'register', path.join(workDir, 'no-such-card.json'));
    assert.equal(missing.code, 2, missing.text);
    assert.equal(rpcCalls('rag_finetune_register_model'), 0, 'no invalid card reached the database');
  });

  test('ft-bind refuses a tenant-scope version before any bind RPC and names --doc-types', async () => {
    assert.equal((await run('ft-consent', 'grant', TENANT_A, '--ref', 'TICKET-1004')).code, 0);
    assert.equal((await run('ft-models', 'register', writeCard(card('ft-widget-private-a', 'tenant', [TENANT_A])))).code, 0);
    edge.calls.length = 0;
    const result = await run('ft-bind', SLOT_A, 'ft-widget-private-a');
    assert.equal(result.code, 1, result.text);
    assert.match(result.text, /--doc-types/);
    assert.equal(rpcCalls('rag_finetune_bind_slot'), 0);
    assert.equal((await slotRow(SLOT_A))?.model, 'unbound');
  });

  test('bind refusals from SQL are printed with their reason', async () => {
    await registerAndBind();
    assert.equal((await run('ft-models', 'register', writeCard(card('ft-widget-model-a2', 'deployment', [TENANT_A])))).code, 0);
    const again = await run('ft-bind', SLOT_A, 'ft-widget-model-a2');
    assert.equal(again.code, 1, again.text);
    assert.match(again.text, /bind_refused: slot_bound/);
    const unknown = await run('ft-bind', SLOT_B, 'ft-widget-unknown-1');
    assert.equal(unknown.code, 1, unknown.text);
    assert.match(unknown.text, /bind_refused: unknown_version/);
  });

  test('ft-clear loops in batches until the slot is empty and retires the version', async () => {
    await registerAndBind();
    await fixture.db.query(
      `INSERT INTO chunk_embeddings (chunk_id, profile_id, tenant_key, embedding, embedding_model, dims)
       SELECT c.id, $1, c.tenant_key, array_fill(0.03125::float4, ARRAY[1024])::halfvec, $2, 1024 FROM document_chunks c`,
      [SLOT_A, VERSION_A],
    );
    const stored = Number((await rows('SELECT count(*)::int AS n FROM chunk_embeddings WHERE profile_id = $1', [SLOT_A]))[0]?.n);
    assert.ok(stored >= 3, 'the slot holds several vectors');
    edge.calls.length = 0;
    const cleared = await run('ft-clear', SLOT_A, '--batch', '1');
    assert.equal(cleared.code, 0, cleared.text);
    assert.equal(rpcCalls('rag_finetune_clear_slot'), stored);
    assert.match(cleared.text, new RegExp(`cleared ${SLOT_A}: ${stored} vectors deleted`));
    assert.equal(Number((await rows('SELECT count(*)::int AS n FROM chunk_embeddings WHERE profile_id = $1', [SLOT_A]))[0]?.n), 0);
    assert.equal((await slotRow(SLOT_A))?.model, 'unbound');
    assert.deepEqual(await versionRow(VERSION_A), { status: 'retired', bound_slot: null });
  });

  test('ft-models retire and ft-release-rollback', async () => {
    assert.equal((await run('ft-consent', 'grant', TENANT_A, '--scope', 'deployment', '--ref', 'TICKET-1005')).code, 0);
    assert.equal((await run('ft-models', 'register', writeCard(card('ft-widget-model-r1', 'deployment', [TENANT_A])))).code, 0);
    const retired = await run('ft-models', 'retire', 'ft-widget-model-r1');
    assert.equal(retired.code, 0, retired.text);
    assert.equal((await versionRow('ft-widget-model-r1'))?.status, 'retired');
    const twice = await run('ft-models', 'retire', 'ft-widget-model-r1');
    assert.equal(twice.code, 1);
    assert.match(twice.text, /status_refused: transition/);

    const released = await run('ft-release-rollback', '--ack', 'drop-rollback');
    assert.equal(released.code, 0, released.text);
    assert.match(released.text, /active profile openai-3-small-1536 has no rollback target/);
  });

  test('with RAG_FINETUNE off every ft-* command except the two lists refuses before any RPC', async () => {
    switchOn = false;
    for (const argv of [
      ['ft-consent', 'grant', TENANT_A, '--ref', 'TICKET-1006'],
      ['ft-consent', 'revoke', TENANT_A],
      ['ft-models', 'register', writeCard(card('ft-widget-model-off', 'deployment', [TENANT_A]))],
      ['ft-models', 'retire', VERSION_A],
      ['ft-bind', SLOT_A, VERSION_A],
      ['ft-clear', SLOT_A],
      ['ft-release-rollback', '--ack', 'drop-rollback'],
      ['ft-check', SLOT_A],
    ]) {
      edge.calls.length = 0;
      const result = await run(...argv);
      assert.equal(result.code, 1, `${argv.join(' ')}: ${result.text}`);
      assert.match(result.text, /RAG_FINETUNE is off/);
      assert.deepEqual(edge.calls, [], `${argv.join(' ')} sent no request`);
    }
    assert.deepEqual(await rows('SELECT * FROM rag_finetune_consent'), []);
    for (const argv of [['ft-consent', 'list'], ['ft-models', 'list']]) {
      const result = await run(...argv);
      assert.equal(result.code, 0, `${argv.join(' ')}: ${result.text}`);
    }
  });
});
