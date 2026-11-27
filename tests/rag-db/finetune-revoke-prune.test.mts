import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fixtureProcessEnv, startFakeEdge, type FakeEdge } from '../../eval/harness/fake-edge.mts';
import { TWO_TENANT_IDS, createTwoTenantDatabase, type TwoTenantDatabase } from '../../eval/harness/two-tenant.mts';
import { fakeSlotVector, startFakeEmbeddingEndpoints, type FakeEmbeddingEndpoints } from '../helpers/fake-embedding-endpoints';

// 06.1-18 Task 2 (FT-10, D-29, D-31): the revoke -> prune path end to end. `ft-consent revoke --prune-root <dir>` prints the retention command and
// runs it with the real spawn (no injected runner), so the Python prune deletes the revoked tenant's text-bearing bundle files and keeps manifests.

const SLOT_A = 'ft-a-1024';
const TENANT_A = `u:${TWO_TENANT_IDS.userA}`;
const TENANT_B = `u:${TWO_TENANT_IDS.userB}`;
const VERSION_A = 'ft-prune-model-a1';
const QUERY_PROMPT = 'Instruct: find the passage that answers the question\nQuery: ';
const DOCUMENT_PROMPT = 'passage: ';
const PROBE_TEXTS = ['first neutral probe sentence about widgets', 'second neutral probe sentence about gadgets', 'third neutral probe sentence about gizmos'];
const ROLES = ['query', 'document', 'query'] as const;
const SENTENCE = 'a neutral synthetic sentence about entry nine';

const TEXT_FILES = [
  'chunks.jsonl',
  'queries.raw.jsonl',
  'queries.kept.jsonl',
  'pairs.mined.jsonl',
  'train_ntuple.jsonl',
  'dev.jsonl',
  'vectors/u_x.ft-a-1024.f32',
  'vectors/u_x.ft-a-1024.rows.jsonl',
  'cache/generate/ab.json',
  'kit/train_ntuple.jsonl',
] as const;
const KEPT_FILES = ['card.json', 'filter-report.json', 'manifest.json', 'mining-report.json', 'offline-eval.json'] as const;

type Row = Record<string, unknown>;

function unit(vector: number[]): number[] {
  const norm = Math.sqrt(vector.reduce((sum, x) => sum + x * x, 0));
  return vector.map((x) => x / norm);
}

function card(id: string, tenantKeys: string[]): Record<string, unknown> {
  const slice = { n: 12, recall_at_10: 0.8, mrr_at_10: 0.6, ndcg_at_10: 0.65 };
  const model = { overall: slice, by_language: { en: slice }, by_pair: {}, by_source: { synthetic: slice } };
  const vectors = PROBE_TEXTS.map((text, index) => unit(fakeSlotVector(`${ROLES[index] === 'query' ? QUERY_PROMPT : DOCUMENT_PROMPT}${text}`)));
  return {
    id,
    base_model: 'example-org/example-embedding',
    base_revision: 'a'.repeat(40),
    dims: 1024,
    scope: 'deployment',
    tenant_keys: [...tenantKeys].sort(),
    dataset_manifest_sha256: 'b'.repeat(64),
    training_config_sha256: 'c'.repeat(64),
    query_prompt: QUERY_PROMPT,
    document_prompt: DOCUMENT_PROMPT,
    offline: { passed: true, noise_band: 0.01, reasons: [], deltas: [], models: { base: model, production: model, finetuned: model } },
    status: 'candidate',
    probe: { texts: PROBE_TEXTS, query_prompt: QUERY_PROMPT, document_prompt: DOCUMENT_PROMPT, vectors },
    artifact_uri: `s3://models-bucket/${id}`,
  };
}

/** A bundle as the Python side writes it: manifest.json (DatasetManifest) plus text-bearing files and reports, all holding one neutral sentence. */
function writeBundle(root: string, runId: string, tenants: string[]): string {
  const runDir = path.join(root, runId);
  fs.mkdirSync(runDir, { recursive: true });
  const manifest = {
    counts: {},
    created_at: '2026-11-26T12:00:00Z',
    files: {},
    purpose: tenants.length === 1 ? 'private' : 'deployment',
    run_id: runId,
    split_rule: 'ft-sha256-first8hex-mod100-80-10-10',
    tenant_keys: [...tenants].sort(),
  };
  fs.writeFileSync(path.join(runDir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  for (const name of [...TEXT_FILES, ...KEPT_FILES.filter((file) => file !== 'manifest.json')]) {
    const file = path.join(runDir, name);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, SENTENCE);
  }
  return runDir;
}

function remaining(runDir: string): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else out.push(path.relative(runDir, full).split(path.sep).join('/'));
    }
  };
  walk(runDir);
  return out.sort();
}

describe('ft-consent revoke --prune-root runs the printed prune command end to end', () => {
  let fixture: TwoTenantDatabase;
  let edge: FakeEdge;
  let endpoints: FakeEmbeddingEndpoints;
  let cli: typeof import('@/lib/rag/embeddings/cli');
  let activeProfile: typeof import('@/lib/rag/embeddings/active-profile');
  let workDir: string;

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
    activeProfile = await import('@/lib/rag/embeddings/active-profile');
    workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'finetune-revoke-prune-'));
  });

  after(async () => {
    activeProfile?.resetActiveProfileForTests();
    await endpoints?.stop();
    await edge?.close();
    await fixture?.db.close();
    if (workDir) fs.rmSync(workDir, { recursive: true, force: true });
  });

  const rows = async (sql: string, params: unknown[] = []): Promise<Row[]> => (await fixture.db.query<Row>(sql, params)).rows;

  async function run(...argv: string[]): Promise<{ code: number; text: string }> {
    const lines: string[] = [];
    const code = await cli.main(argv, { out: (line) => lines.push(line), err: (line) => lines.push(line) }, undefined, { finetuneEnabled: () => true });
    return { code, text: lines.join('\n') };
  }

  test('the revoked tenant loses its text-bearing files, manifests and reports stay, the other tenant is untouched', async () => {
    const cardFile = path.join(workDir, 'card.json');
    fs.writeFileSync(cardFile, JSON.stringify(card(VERSION_A, [TENANT_A])));
    assert.equal((await run('ft-consent', 'grant', TENANT_A, '--scope', 'deployment', '--ref', 'TICKET-1001')).code, 0);
    const registered = await run('ft-models', 'register', cardFile);
    assert.equal(registered.code, 0, registered.text);
    const bound = await run('ft-bind', SLOT_A, VERSION_A);
    assert.equal(bound.code, 0, bound.text);

    const root = path.join(workDir, 'bundles');
    const ownRun = writeBundle(root, 'run-tenant-a', [TENANT_A]);
    const sharedRun = writeBundle(root, 'run-shared', [TENANT_A, TENANT_B]);
    const otherRun = writeBundle(root, 'run-tenant-b', [TENANT_B]);
    const otherBefore = remaining(otherRun);
    assert.deepEqual(remaining(ownRun), [...TEXT_FILES, ...KEPT_FILES].sort());

    const revoked = await run('ft-consent', 'revoke', TENANT_A, '--prune-root', root);
    assert.equal(revoked.code, 0, revoked.text);
    const printed = revoked.text.split('\n').find((line) => line.startsWith('[Embedding] retention: '));
    assert.equal(
      printed,
      `[Embedding] retention: uv run --directory eval python -m rag_eval.finetune prune --tenant ${TENANT_A} --root ${root}`,
      'the printed command is the one that ran',
    );
    assert.match(revoked.text, /prune exited with 0/);

    for (const runDir of [ownRun, sharedRun]) assert.deepEqual(remaining(runDir), [...KEPT_FILES].sort(), `${path.basename(runDir)} keeps only manifests and reports`);
    for (const dir of ['vectors', 'kit', 'cache']) assert.ok(!fs.existsSync(path.join(ownRun, dir)), `${dir}/ is removed`);
    assert.deepEqual(remaining(otherRun), otherBefore, 'a bundle of tenant B only is untouched');
    assert.ok(!revoked.text.includes(SENTENCE), 'no bundle text reaches the CLI output');

    assert.equal((await rows('SELECT scope FROM rag_finetune_consent WHERE tenant_key = $1', [TENANT_A]))[0]?.scope, 'none');
    assert.equal((await rows('SELECT status FROM embedding_model_versions WHERE id = $1', [VERSION_A]))[0]?.status, 'tainted');
  });
});
