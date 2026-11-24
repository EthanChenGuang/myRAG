import { after, afterEach, before, beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { SupabaseClient } from '@supabase/supabase-js';
import { fixtureProcessEnv, startFakeEdge, type FakeEdge } from '../../eval/harness/fake-edge.mts';
import { TWO_TENANT_IDS, createTwoTenantDatabase, type TwoTenantDatabase } from '../../eval/harness/two-tenant.mts';
import type { RpcClient } from '@/lib/rag/backend/supabase-rpc';
import type { TenantScope } from '@/lib/rag/tenant/scope';

const PROFILE = 'p256-1024';
const ACTOR = '00000000-0000-4000-8000-0000000000aa';
const UNIQUE_TERM = 'zqxlegacyupload';

type Row = Record<string, unknown>;

interface Tenant {
  key: string;
  userId: string;
}

const A: Tenant = { key: `u:${TWO_TENANT_IDS.userA}`, userId: TWO_TENANT_IDS.userA };
const B: Tenant = { key: `u:${TWO_TENANT_IDS.userB}`, userId: TWO_TENANT_IDS.userB };

function decisionOf(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    build_run_id: null,
    chosen_on: { recall_at_k: 0.9 },
    decided_by: 'tester',
    doc_type: 'contract_legal',
    gate_passed: true,
    profile_id: PROFILE,
    recorded_at: '2026-11-25T00:00:00Z',
    report_hash: 'b'.repeat(64),
    source: 'fixture',
    ...over,
  };
}

function contractText(label: string, extra = ''): string {
  return [
    `# Supply Agreement ${label}`,
    '',
    '## 1. Definitions',
    '',
    `In this agreement ${label} means the buyer and the supplier of forklifts and pallets named in the schedule.`,
    '',
    '## 2. Warranty',
    '',
    `The supplier warrants every forklift of ${label} for twelve months. The sole exception to the warranty of ${label} is damage caused by misuse.`,
    '',
    '## 3. Termination',
    '',
    `Either party may terminate ${label} with ninety days of written notice when the other party breaches a material clause. ${extra}`,
    '',
  ].join('\n');
}

describe('profile-ops with fake deps', () => {
  let ops: typeof import('@/lib/rag/chunking/profile-ops');
  let depsModule: typeof import('@/lib/rag/deps');
  let activeModule: typeof import('@/lib/rag/chunking/active');
  const calls: Array<{ fn: string; args: Record<string, unknown>; signal: AbortSignal | null }> = [];
  let handler: (fn: string, args: Record<string, unknown>) => { data?: unknown[] | null; error?: { message: string; code?: string } | null };

  function fakeAdmin(): SupabaseClient {
    return {
      rpc(fn: string, args: Record<string, unknown>) {
        const entry = { fn, args, signal: null as AbortSignal | null };
        calls.push(entry);
        const request = {
          abortSignal(signal: AbortSignal) {
            entry.signal = signal;
            return request;
          },
          then(resolve: (value: unknown) => unknown, reject?: (reason: unknown) => unknown) {
            const result = handler(fn, args);
            return Promise.resolve({ data: result.data ?? null, error: result.error ?? null }).then(resolve, reject);
          },
        };
        return request;
      },
    } as unknown as SupabaseClient;
  }

  before(async () => {
    ops = await import('@/lib/rag/chunking/profile-ops');
    depsModule = await import('@/lib/rag/deps');
    activeModule = await import('@/lib/rag/chunking/active');
  });

  beforeEach(() => {
    calls.length = 0;
    handler = () => ({ data: [] });
    depsModule.setRagDepsForTests({ adminClient: () => fakeAdmin() });
    activeModule.resetActiveChunkingProfilesForTests();
  });

  afterEach(() => {
    depsModule.resetRagDepsForTests();
    activeModule.resetActiveChunkingProfilesForTests();
  });

  const listCalls = (): number => calls.filter((call) => call.fn === 'rag_list_chunking_profiles').length;

  test('activateChunkingProfile resolves on success, passes actor and doc type, and refreshes the active cache once', async () => {
    handler = (fn) =>
      fn === 'rag_activate_chunking_profile'
        ? { data: [{ activated_profile: PROFILE, previous_profile: 'legacy', doc_type: 'contract_legal', changed: true }] }
        : { data: [{ id: PROFILE, doc_type: 'contract_legal', is_active: true }] };
    const result = await ops.activateChunkingProfile(PROFILE, { docType: 'contract_legal', actor: ACTOR });
    assert.deepEqual(result, { activated: PROFILE, previous: 'legacy', docType: 'contract_legal', changed: true });
    const activate = calls.find((call) => call.fn === 'rag_activate_chunking_profile');
    assert.deepEqual(activate?.args, { p_profile_id: PROFILE, p_actor: ACTOR, p_doc_type: 'contract_legal' });
    assert.equal(listCalls(), 1, 'the active chunking-profile cache was refreshed once');
    assert.deepEqual(await activeModule.getActiveChunkingProfiles(), { contract_legal: PROFILE });
  });

  test('a raised chunking_activation_refused:eval_failed becomes ChunkingActivationRefused with reason eval_failed; other errors are not refusals', async () => {
    handler = () => ({ error: { message: 'chunking_activation_refused:eval_failed', code: '55000' } });
    await assert.rejects(ops.activateChunkingProfile(PROFILE), (error: unknown) => {
      assert.ok(error instanceof ops.ChunkingActivationRefused);
      assert.equal((error as InstanceType<typeof ops.ChunkingActivationRefused>).reason, 'eval_failed');
      return true;
    });
    assert.equal(listCalls(), 0, 'a refusal flips nothing, so the cache is not refreshed');

    handler = () => ({ error: { message: 'canceling statement due to statement timeout', code: '57014' } });
    await assert.rejects(ops.activateChunkingProfile(PROFILE), (error: unknown) => {
      assert.ok(!(error instanceof ops.ChunkingActivationRefused), 'a timeout is not a refusal');
      assert.equal((error as { code?: string }).code, '57014');
      return true;
    });
    handler = () => ({ error: { message: 'invalid_decision: gate_passed must be a boolean', code: '22023' } });
    await assert.rejects(ops.activateChunkingProfile(PROFILE), (error: unknown) => !(error instanceof ops.ChunkingActivationRefused));
  });

  test('rollbackChunkingProfile maps no_previous to a refusal and refreshes the cache after a flip', async () => {
    handler = () => ({ error: { message: 'chunking_activation_refused:no_previous', code: '55000' } });
    await assert.rejects(ops.rollbackChunkingProfile('contract_legal'), (error: unknown) => error instanceof ops.ChunkingActivationRefused && error.reason === 'no_previous');
    assert.equal(listCalls(), 0);
    handler = (fn) =>
      fn === 'rag_rollback_chunking_profile'
        ? { data: [{ restored_profile: 'legacy', rolled_back_profile: PROFILE, doc_type: 'contract_legal' }] }
        : { data: [] };
    const result = await ops.rollbackChunkingProfile('contract_legal', { actor: ACTOR });
    assert.deepEqual(result, { restored: 'legacy', rolledBack: PROFILE, docType: 'contract_legal' });
    assert.deepEqual(calls.find((call) => call.fn === 'rag_rollback_chunking_profile')?.args, { p_doc_type: 'contract_legal', p_actor: ACTOR });
    assert.equal(listCalls(), 1);
  });

  test('with no admin client every op rejects with admin_unavailable and makes no call', async () => {
    depsModule.setRagDepsForTests({ adminClient: () => null });
    const attempts: Array<() => Promise<unknown>> = [
      () => ops.listChunkingProfiles(),
      () => ops.getChunkingCoverage(),
      () => ops.createChunkingProfile({ id: PROFILE, docType: 'contract_legal', childTokens: 256, parentMode: 'structure', parentTokens: 1024, preset: '256/1024' }),
      () => ops.recordChunkingDecision(decisionOf()),
      () => ops.activateChunkingProfile(PROFILE),
      () => ops.rollbackChunkingProfile('contract_legal'),
    ];
    for (const attempt of attempts) {
      await assert.rejects(attempt(), (error: unknown) => (error as { code?: string }).code === 'admin_unavailable');
    }
    assert.equal(calls.length, 0);
  });

  test('recordChunkingDecision validates with ChunkingDecisionSchema before the RPC; an invalid decision is rejected without a call', async () => {
    for (const bad of [{}, decisionOf({ gate_passed: 'yes' }), decisionOf({ report_hash: 'short' }), decisionOf({ doc_type: 'memo' }), { ...decisionOf(), extra: 1 }]) {
      await assert.rejects(ops.recordChunkingDecision(bad), (error: unknown) => error instanceof ops.ChunkingInputError);
    }
    assert.equal(calls.length, 0);
    handler = () => ({ data: [{ profile_id: PROFILE, doc_type: 'contract_legal' }] });
    const stored = await ops.recordChunkingDecision(decisionOf());
    assert.deepEqual(stored, { profileId: PROFILE, docType: 'contract_legal' });
    assert.equal(calls.length, 1);
    assert.equal(calls[0]?.fn, 'rag_record_chunking_decision');
    assert.equal(calls[0]?.args.p_profile_id, PROFILE);
  });

  test('getChunkingCoverage and listChunkingProfiles return typed rows; an aborted signal rejects after the call', async () => {
    handler = (fn) =>
      fn === 'rag_chunking_coverage'
        ? { data: [{ doc_type: 'contract_legal', profile_id: PROFILE, is_active: true, current_ready_documents: 3, documents_with_children: 2, missing_documents: 1 }] }
        : {
            data: [
              {
                id: PROFILE, doc_type: 'contract_legal', child_tokens: 256, parent_mode: 'structure', parent_tokens: 1024, status: 'active', preset: '256/1024',
                previous_active_id: 'legacy', is_active: true, created_at: '2026-11-25T00:00:00Z', activated_at: '2026-11-25T01:00:00Z', activated_by: 'cli',
              },
            ],
          };
    assert.deepEqual(await ops.getChunkingCoverage(), [
      { docType: 'contract_legal', profileId: PROFILE, isActive: true, currentReadyDocuments: 3, documentsWithChildren: 2, missingDocuments: 1 },
    ]);
    const listed = await ops.listChunkingProfiles();
    assert.equal(listed[0]?.id, PROFILE);
    assert.equal(listed[0]?.previousActiveId, 'legacy');
    assert.equal(listed[0]?.childTokens, 256);

    const controller = new AbortController();
    controller.abort(new Error('stop'));
    await assert.rejects(ops.getChunkingCoverage({ signal: controller.signal }), /stop/);
    assert.equal(calls.at(-1)?.signal, controller.signal, 'the caller signal is passed to the request');
  });
});

describe('rag:chunking over the gated pointer flip', () => {
  let fixture: TwoTenantDatabase;
  let edge: FakeEdge;
  let childEnv: Record<string, string> = {};
  let rag: typeof import('@/lib/rag');
  let ragConfig: typeof import('@/lib/rag/config');
  let cliModule: typeof import('@/lib/rag/chunking/cli');
  let rechunk: typeof import('@/lib/rag/ingest/rechunk/run');
  let ingestModule: typeof import('@/lib/rag/ingest');
  let ingestConfig: typeof import('@/lib/rag/ingest/config');
  let ingestDeps: typeof import('@/lib/rag/ingest/deps');
  let activeProfile: typeof import('@/lib/rag/embeddings/active-profile');
  let objectStore: typeof import('@/lib/rag/ingest/object-store');
  let scopeModule: typeof import('@/lib/rag/tenant/scope');
  let activeChunking: typeof import('@/lib/rag/chunking/active');
  let store: import('../helpers/fake-object-store').FakeObjectStore;
  const docs = { a1: '', b1: '' };
  const realFetch = globalThis.fetch;
  const outbound: string[] = [];

  const rows = async (sql: string, params: unknown[] = []): Promise<Row[]> => (await fixture.db.query<Row>(sql, params)).rows;
  const db = () => ingestDeps.getIngestDeps().db() as RpcClient;
  const scopeOf = (tenant: Tenant): TenantScope => scopeModule.mintScope('personal', tenant.userId, null);
  const scopeFor = async (tenantKey: string): Promise<TenantScope | null> => (tenantKey === A.key ? scopeOf(A) : tenantKey === B.key ? scopeOf(B) : null);

  function useEnv(pipeline: 'v2' | 'legacy'): void {
    process.env.RAG_PIPELINE = pipeline;
    ragConfig.resetRagConfigForTests();
    ingestConfig.resetIngestConfigForTests();
    ingestDeps.setIngestDepsForTests({ ingestEnv: () => ({ RAG_EMBEDDING_PROFILES: 'off' }) });
    activeProfile.resetActiveProfileForTests();
  }

  async function upload(tenant: Tenant, label: string, extra = ''): Promise<string> {
    const result = await ingestModule.ingest({
      scope: scopeOf(tenant),
      source: 'config_upload',
      sourceKey: `root/${label}.md`,
      text: contractText(label, extra),
      filename: `${label}.md`,
      mimeType: 'text/markdown',
      docType: 'contract_legal',
      signal: new AbortController().signal,
    });
    assert.equal(result.status, 'ready', `${label} ingests`);
    return String(result.documentId);
  }

  before(async () => {
    const emptyCorpus = fs.mkdtempSync(path.join(os.tmpdir(), 'chunking-cli-corpus-'));
    try {
      fixture = await createTwoTenantDatabase({ corpusDir: emptyCorpus });
    } finally {
      fs.rmdirSync(emptyCorpus);
    }
    edge = await startFakeEdge({ db: fixture.db });
    childEnv = fixtureProcessEnv(edge.url);
    Object.assign(process.env, childEnv);
    process.env.NEXT_PUBLIC_MYRAG_DEPLOYMENT_MODE = 'multi-tenant';
    process.env.MYRAG_DEPLOYMENT_MODE = 'multi-tenant';
    globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      if (!url.startsWith(edge.url)) outbound.push(url);
      return realFetch(input, init);
    }) as typeof fetch;
    rag = await import('@/lib/rag');
    ragConfig = await import('@/lib/rag/config');
    cliModule = await import('@/lib/rag/chunking/cli');
    rechunk = await import('@/lib/rag/ingest/rechunk/run');
    ingestModule = await import('@/lib/rag/ingest');
    ingestConfig = await import('@/lib/rag/ingest/config');
    ingestDeps = await import('@/lib/rag/ingest/deps');
    activeProfile = await import('@/lib/rag/embeddings/active-profile');
    objectStore = await import('@/lib/rag/ingest/object-store');
    scopeModule = await import('@/lib/rag/tenant/scope');
    activeChunking = await import('@/lib/rag/chunking/active');
    store = (await import('../helpers/fake-object-store')).createFakeObjectStore();
    objectStore.setObjectStoreForTests(store);
    useEnv('v2');
    docs.a1 = await upload(A, 'chunking-a1');
    docs.b1 = await upload(B, 'chunking-b1');
  });

  after(async () => {
    globalThis.fetch = realFetch;
    delete process.env.RAG_PIPELINE;
    ragConfig?.resetRagConfigForTests();
    objectStore?.resetObjectStoreForTests();
    ingestDeps?.resetIngestDepsForTests();
    await edge?.close();
    await fixture?.db.close();
  });

  beforeEach(async () => {
    await fixture.db.exec(`
      DELETE FROM chunking_build_gaps;
      DELETE FROM chunking_build_runs;
      DELETE FROM chunk_embeddings WHERE chunk_id IN (SELECT id FROM document_chunks WHERE chunking_profile_id <> 'legacy');
      DELETE FROM document_chunks WHERE chunking_profile_id <> 'legacy';
      DELETE FROM document_parents;
      DELETE FROM chunking_profiles WHERE id <> 'legacy';
      UPDATE chunking_profiles SET status = 'active', previous_active_id = NULL, activated_by = 'migration' WHERE id = 'legacy';
      DELETE FROM document_chunks WHERE document_id IN (SELECT id FROM documents WHERE source_key LIKE 'root/chunking-late-%');
      DELETE FROM documents WHERE source_key LIKE 'root/chunking-late-%';
    `);
    useEnv('v2');
    await activeChunking.refreshActiveChunkingProfiles();
    outbound.length = 0;
  });

  afterEach(() => {
    activeProfile.resetActiveProfileForTests();
  });

  const cli = async (argv: string[]) => {
    const lines: string[] = [];
    const code = await cliModule.main(argv, { out: (line) => lines.push(line), err: (line) => lines.push(line) });
    return { code, text: lines.join('\n') };
  };

  async function spawnCli(args: string[], env: Record<string, string | undefined> = {}): Promise<{ code: number | null; stdout: string; stderr: string }> {
    const { spawn } = await import('node:child_process');
    const merged: Record<string, string | undefined> = { ...process.env, ...childEnv, ...env };
    for (const key of Object.keys(merged)) if (merged[key] === undefined) delete merged[key];
    return new Promise((resolve, reject) => {
      const child = spawn(process.execPath, ['--import', 'tsx', 'src/lib/rag/chunking/cli.ts', ...args], { env: merged as NodeJS.ProcessEnv, stdio: ['ignore', 'pipe', 'pipe'] });
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (chunk: Buffer) => (stdout += chunk.toString('utf8')));
      child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString('utf8')));
      const timer = setTimeout(() => {
        child.kill('SIGKILL');
        reject(new Error('the CLI did not finish in 90 s'));
      }, 90_000);
      child.on('error', reject);
      child.on('close', (code) => {
        clearTimeout(timer);
        resolve({ code, stdout, stderr });
      });
    });
  }

  const tmpFiles: string[] = [];
  function writeDecision(over: Record<string, unknown> = {}): string {
    const file = path.join(os.tmpdir(), `chunking-decision-${crypto.randomUUID()}.json`);
    fs.writeFileSync(file, JSON.stringify(decisionOf(over)));
    tmpFiles.push(file);
    return file;
  }
  after(() => {
    for (const file of tmpFiles) fs.rmSync(file, { force: true });
  });

  const idsOf = async (profileId: string): Promise<Set<string>> =>
    new Set((await rows('SELECT id::text FROM document_chunks WHERE chunking_profile_id = $1', [profileId])).map((row) => String(row.id)));

  async function search(tenant: Tenant, query: string) {
    return rag.runRetrieval({
      scope: scopeOf(tenant),
      query,
      profile: 'eval',
      options: { maxResults: 25, fallbackToLowerThreshold: true },
      signal: new AbortController().signal,
    });
  }

  const EXCEPTION_QUESTION = 'What is the sole exception to the warranty of the supplier?';

  async function buildActive(): Promise<string> {
    const created = await spawnCli(['create', PROFILE, '--doc-type', 'contract_legal', '--preset', '256/1024']);
    assert.equal(created.code, 0, `${created.stdout}\n${created.stderr}`);
    const report = await rechunk.runRechunk({ db: db(), profileId: PROFILE, scopeFor });
    assert.equal(report.status, 'completed', JSON.stringify(report.gaps));
    const recorded = await spawnCli(['record-decision', writeDecision({ build_run_id: report.runId })]);
    assert.equal(recorded.code, 0, `${recorded.stdout}\n${recorded.stderr}`);
    const activated = await spawnCli(['activate', PROFILE]);
    assert.equal(activated.code, 0, `${activated.stdout}\n${activated.stderr}`);
    return report.runId;
  }

  test('full cycle: create, rechunk, record a passing decision, activate, search the children, roll back, search the legacy chunks', async () => {
    const created = await spawnCli(['create', PROFILE, '--doc-type', 'contract_legal', '--preset', '256/1024']);
    assert.equal(created.code, 0, `${created.stdout}\n${created.stderr}`);
    assert.equal((await rows(`SELECT status FROM chunking_profiles WHERE id = $1`, [PROFILE]))[0]?.status, 'building');

    const early = await spawnCli(['activate', PROFILE]);
    assert.equal(early.code, 3, 'a gate refusal exits 3');
    assert.match(`${early.stdout}\n${early.stderr}`, /not_ready/);

    const report = await rechunk.runRechunk({ db: db(), profileId: PROFILE, scopeFor });
    assert.equal(report.status, 'completed');
    assert.equal(report.profileStatus, 'ready');

    const unproven = await spawnCli(['activate', PROFILE]);
    assert.equal(unproven.code, 3);
    assert.match(`${unproven.stdout}\n${unproven.stderr}`, /no_evidence/);

    const recorded = await spawnCli(['record-decision', writeDecision({ build_run_id: report.runId })]);
    assert.equal(recorded.code, 0, `${recorded.stdout}\n${recorded.stderr}`);
    const activated = await spawnCli(['activate', PROFILE, '--actor', ACTOR]);
    assert.equal(activated.code, 0, `${activated.stdout}\n${activated.stderr}`);
    assert.match(activated.stdout, new RegExp(`activated ${PROFILE}`));
    assert.equal((await rows(`SELECT activated_by FROM chunking_profiles WHERE id = $1`, [PROFILE]))[0]?.activated_by, ACTOR);

    const children = await idsOf(PROFILE);
    const legacy = await idsOf('legacy');
    assert.ok(children.size > 0);
    for (const tenant of [A, B]) {
      const result = await search(tenant, EXCEPTION_QUESTION);
      assert.ok(result.candidates.length > 0, `${tenant.key} found nothing after activation`);
      assert.ok(result.candidates.every((candidate) => children.has(candidate.chunk_id)), `${tenant.key} still got a legacy chunk after activation`);
      const own = new Set((await rows('SELECT id::text FROM document_chunks WHERE tenant_key = $1', [tenant.key])).map((row) => String(row.id)));
      assert.ok(result.candidates.every((candidate) => own.has(candidate.chunk_id)), `${tenant.key} received a chunk of another tenant`);
    }

    const rolledBack = await spawnCli(['rollback', 'contract_legal']);
    assert.equal(rolledBack.code, 0, `${rolledBack.stdout}\n${rolledBack.stderr}`);
    assert.match(rolledBack.stdout, /restored legacy/);
    const afterRollback = await search(A, EXCEPTION_QUESTION);
    assert.ok(afterRollback.candidates.length > 0);
    assert.ok(afterRollback.candidates.every((candidate) => legacy.has(candidate.chunk_id)), 'a profile child was returned after the rollback');
    assert.equal(Number((await rows('SELECT count(*)::int AS n FROM document_chunks WHERE chunking_profile_id = $1', [PROFILE]))[0]?.n), children.size, 'rollback kept every row');

    const again = await spawnCli(['rollback', 'contract_legal']);
    assert.equal(again.code, 3);
    assert.match(`${again.stdout}\n${again.stderr}`, /no_previous/);
    assert.ok(!/service-role|fixture-service-role|apikey/i.test(`${created.stdout}${activated.stdout}${again.stderr}`), 'no key material in the output');
    assert.deepEqual(outbound, [], 'nothing left for anything but the fixture edge');
  });

  test('legacy-mode upload under an active profile stays retrievable and is counted missing', async () => {
    await buildActive();
    const profileChildren = await idsOf(PROFILE);

    useEnv('legacy');
    const late = await upload(A, 'chunking-late-a', `A clause about ${UNIQUE_TERM} equipment.`);
    useEnv('v2');
    await activeChunking.refreshActiveChunkingProfiles();

    assert.equal(Number((await rows('SELECT count(*)::int AS n FROM document_chunks WHERE document_id = $1 AND chunking_profile_id = $2', [late, PROFILE]))[0]?.n), 0, 'a legacy-mode upload writes no profile children');
    const legacyOfLate = new Set((await rows('SELECT id::text FROM document_chunks WHERE document_id = $1', [late])).map((row) => String(row.id)));
    assert.ok(legacyOfLate.size > 0);

    const own = await search(A, `${UNIQUE_TERM} equipment clause`);
    const lateHits = own.candidates.filter((candidate) => candidate.document_id === late);
    assert.ok(lateHits.length > 0, 'the legacy-mode upload is not retrievable under the active profile');
    assert.ok(lateHits.every((candidate) => legacyOfLate.has(candidate.chunk_id)), 'its hits are its legacy chunks');
    const foreign = await search(B, `${UNIQUE_TERM} equipment clause`);
    assert.ok(foreign.candidates.every((candidate) => candidate.document_id !== late), 'the other tenant received the document');

    const { getChunkingCoverage } = await import('@/lib/rag/chunking/profile-ops');
    const coverage = (await getChunkingCoverage()).find((row) => row.docType === 'contract_legal' && row.profileId === PROFILE);
    assert.equal(coverage?.missingDocuments, 1);
    assert.equal(coverage?.isActive, true);
    const status = await cli(['status']);
    assert.equal(status.code, 0, status.text);
    assert.match(status.text, new RegExp(`missing from active profile: 1 \\(served from legacy chunks; run npm run rag:rechunk -- --profile ${PROFILE}\\)`));

    const filled = await rechunk.runRechunk({ db: db(), profileId: PROFILE, scopeFor });
    assert.equal(filled.status, 'completed');
    assert.equal(filled.documentsWritten, 1, 'only the late upload is built');
    const after = (await getChunkingCoverage()).find((row) => row.docType === 'contract_legal' && row.profileId === PROFILE);
    assert.equal(after?.missingDocuments, 0);
    const afterStatus = await cli(['status']);
    assert.ok(!/missing from active profile/.test(afterStatus.text), afterStatus.text);
    const rebuilt = await search(A, `${UNIQUE_TERM} equipment clause`);
    const rebuiltIds = await idsOf(PROFILE);
    const hitsOfLate = rebuilt.candidates.filter((candidate) => candidate.document_id === late);
    assert.ok(hitsOfLate.length > 0 && hitsOfLate.every((candidate) => rebuiltIds.has(candidate.chunk_id)), 'after rechunk the same search returns profile children');
    assert.ok(profileChildren.size > 0);
  });

  test('status prints, per doc type, every profile with status, sizes, completeness, open gaps and whether a passing decision is recorded', async () => {
    await spawnCli(['create', PROFILE, '--doc-type', 'contract_legal', '--preset', '256/1024']);
    let status = await cli(['status']);
    assert.equal(status.code, 0, status.text);
    assert.match(status.text, /doc type contract_legal: active legacy/);
    assert.match(status.text, new RegExp(`profile ${PROFILE} status=building child=256 parent=structure/1024 completeness=0/2 \\(0\\.0%\\) open_gaps=0 decision=none`));
    assert.match(status.text, /profile legacy status=active .*completeness=2\/2/);

    const failing = writeDecision({ gate_passed: false });
    assert.equal((await cli(['record-decision', failing])).code, 0);
    status = await cli(['status']);
    assert.match(status.text, new RegExp(`profile ${PROFILE} .*decision=failed`));
    assert.equal((await cli(['record-decision', writeDecision()])).code, 0);
    status = await cli(['status']);
    assert.match(status.text, new RegExp(`profile ${PROFILE} .*decision=passed`));

    const run = crypto.randomUUID();
    await fixture.db.query(`INSERT INTO chunking_build_runs (id, profile_id, doc_type, status) VALUES ($1, $2, 'contract_legal', 'incomplete')`, [run, PROFILE]);
    await fixture.db.query(`INSERT INTO chunking_build_gaps (run_id, document_id, reason) VALUES ($1, $2, 'no_parse_output')`, [run, docs.a1]);
    status = await cli(['status']);
    assert.match(status.text, new RegExp(`profile ${PROFILE} .*open_gaps=1`));
    assert.ok(!/service-role|fixture-service-role|apikey/i.test(status.text));
  });

  test('create validates with validateChunkingProfile: warnings are printed, errors exit 2 and nothing is created', async () => {
    const warned = await cli(['create', 'wide-1', '--doc-type', 'contract_legal', '--preset', '256/2048']);
    assert.equal(warned.code, 0, warned.text);
    assert.match(warned.text, /warning: top_k_parent_over_budget/);
    assert.equal((await rows(`SELECT status FROM chunking_profiles WHERE id = 'wide-1'`))[0]?.status, 'building');

    const tooBig = await cli(['create', 'huge-1', '--doc-type', 'contract_legal', '--preset', 'custom', '--child-tokens', '9000', '--parent-mode', 'none']);
    assert.equal(tooBig.code, 2, tooBig.text);
    assert.match(tooBig.text, /child_exceeds_embedding_input/);
    const small = await cli(['create', 'small-1', '--doc-type', 'contract_legal', '--preset', 'custom', '--child-tokens', '256', '--parent-mode', 'fixed', '--parent-tokens', '400']);
    assert.equal(small.code, 2, small.text);
    assert.match(small.text, /parent_below_twice_child/);
    assert.equal(Number((await rows(`SELECT count(*)::int AS n FROM chunking_profiles WHERE id IN ('huge-1', 'small-1')`))[0]?.n), 0);
  });

  test('wrong arguments exit 2 with a usage line; a non-uuid actor exits 2; a bad decision file exits 2', async () => {
    for (const argv of [
      [],
      ['unknown'],
      ['status', 'extra'],
      ['create'],
      ['create', 'x-1'],
      ['create', 'X-1', '--doc-type', 'contract_legal', '--preset', '256/1024'],
      ['create', 'x-1', '--doc-type', 'contract_legal', '--preset', 'huge'],
      ['activate'],
      ['activate', PROFILE, '--actor', 'not-a-uuid'],
      ['activate', PROFILE, '--doc-type'],
      ['rollback'],
      ['rollback', 'Contract Legal'],
      ['rollback', 'contract_legal', '--actor', 'nope'],
      ['record-decision'],
    ]) {
      const { code, text } = await cli(argv);
      assert.equal(code, 2, `${argv.join(' ')}: ${text}`);
      assert.match(text, /usage: npm run rag:chunking/);
    }
    const missing = await cli(['record-decision', path.join(os.tmpdir(), 'chunking-no-such-file.json')]);
    assert.equal(missing.code, 2, missing.text);
    const invalid = path.join(os.tmpdir(), `chunking-invalid-${crypto.randomUUID()}.json`);
    fs.writeFileSync(invalid, JSON.stringify({ gate_passed: 'maybe' }));
    tmpFiles.push(invalid);
    const rejected = await cli(['record-decision', invalid]);
    assert.equal(rejected.code, 2, rejected.text);
  });

  test('the CLI refuses to run without SUPABASE_SERVICE_ROLE_KEY and never prints key values', async () => {
    const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
    delete process.env.SUPABASE_SERVICE_ROLE_KEY;
    edge.calls.length = 0;
    try {
      const { code, text } = await cli(['status']);
      assert.equal(code, 1, text);
      assert.match(text, /SUPABASE_SERVICE_ROLE_KEY/);
      assert.ok(!text.includes(String(key)), 'the key value was printed');
    } finally {
      process.env.SUPABASE_SERVICE_ROLE_KEY = key;
    }
    assert.equal(edge.calls.length, 0, 'nothing was asked of the database');
  });
});
