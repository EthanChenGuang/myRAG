import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { buildIngestFixtureDatabase } from '../../eval/harness/ingest-mode.mts';
import { FIXTURE_USER_ID, type FixtureDatabase } from '../../eval/harness/pglite-supabase.mts';
import { runEval } from '../../eval/harness/run-eval.mts';
import { parseRunConfig, RunConfigError } from '../../eval/harness/run-config.mts';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const CORPUS_DIR = path.join(REPO_ROOT, 'eval/fixtures/corpus');
const INGEST_GOLDEN = path.join(REPO_ROOT, 'eval/fixtures/ingest/golden-ingest.jsonl');
const PROFILE_ID = 'p256-1024-contract_legal';
const CONTRACT_ITEM = 'ingest-contract-exception-zh';

const PROFILE = {
  id: PROFILE_ID,
  doc_type: 'contract_legal',
  child_tokens: 256,
  parent_mode: 'structure',
  parent_tokens: 1024,
  status: 'building',
  preset: '256/1024',
};

const V2_ENV = { RAG_PIPELINE: 'v2' };

type Row = Record<string, unknown>;

const tmpDirs: string[] = [];
function makeTmpDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'eval-chunking-profiles-'));
  tmpDirs.push(dir);
  return dir;
}

after(() => {
  for (const dir of tmpDirs) fs.rmSync(dir, { recursive: true, force: true });
});

function rejects(raw: unknown, message: string | RegExp): void {
  assert.throws(
    () => parseRunConfig(raw, 'inline'),
    (error: unknown) =>
      error instanceof RunConfigError && (typeof message === 'string' ? error.message === message : message.test(error.message)),
  );
}

describe('chunking_profiles in a run config', () => {
  test('a valid list is parsed and kept beside env and overrides', () => {
    const config = parseRunConfig(
      { name: 'seeded', env: V2_ENV, overrides: { chunking_profile_by_doc_type: { contract_legal: PROFILE_ID } }, chunking_profiles: [PROFILE] },
      'inline',
    );
    assert.deepEqual(config.chunkingProfiles, [PROFILE]);
    assert.deepEqual(config.overrides?.chunking_profile_by_doc_type, { contract_legal: PROFILE_ID });
  });

  test('a run config without the key has no chunkingProfiles field', () => {
    const config = parseRunConfig({ name: 'plain', env: V2_ENV }, 'inline');
    assert.equal('chunkingProfiles' in config, false);
  });

  test('chunking_profiles needs RAG_PIPELINE=v2 in the env overlay', () => {
    rejects({ name: 'no-v2', env: {}, chunking_profiles: [PROFILE] }, '[Eval Harness] chunking_profiles needs RAG_PIPELINE=v2');
    rejects({ name: 'legacy', env: { RAG_PIPELINE: 'legacy' }, chunking_profiles: [PROFILE] }, '[Eval Harness] chunking_profiles needs RAG_PIPELINE=v2');
  });

  test('entries that fail the ChunkingProfile schema or its hard rules are rejected', () => {
    const bad: Array<Record<string, unknown>> = [
      { ...PROFILE, parent_tokens: 300 },
      { ...PROFILE, parent_mode: 'fixed', parent_tokens: null },
      { ...PROFILE, doc_type: 'memo' },
      { ...PROFILE, extra: 1 },
      { ...PROFILE, status: 'active' },
      { ...PROFILE, id: 'legacy' },
    ];
    for (const entry of bad) {
      rejects({ name: 'bad', env: V2_ENV, chunking_profiles: [entry] }, /^\[Eval Harness\] run-config chunking_profiles/);
    }
    rejects({ name: 'dup', env: V2_ENV, chunking_profiles: [PROFILE, PROFILE] }, /^\[Eval Harness\] run-config chunking_profiles/);
    rejects({ name: 'not-list', env: V2_ENV, chunking_profiles: PROFILE }, /^\[Eval Harness\] run-config chunking_profiles/);
  });

  test('an override naming a profile that is not seeded for that doc type is rejected', () => {
    rejects(
      { name: 'x', env: V2_ENV, overrides: { chunking_profile_by_doc_type: { contract_legal: 'nope' } }, chunking_profiles: [PROFILE] },
      /^\[Eval Harness\] run-config overrides\.chunking_profile_by_doc_type/,
    );
    rejects(
      { name: 'x', env: V2_ENV, overrides: { chunking_profile_by_doc_type: { general: PROFILE_ID } }, chunking_profiles: [PROFILE] },
      /^\[Eval Harness\] run-config overrides\.chunking_profile_by_doc_type/,
    );
    rejects(
      { name: 'x', env: V2_ENV, overrides: { chunking_profile_by_doc_type: { memo: 'legacy' } } },
      /^\[Eval Harness\] run-config overrides\.chunking_profile_by_doc_type/,
    );
  });
});

describe('npm run test-rag with chunking_profiles', () => {
  function runSmoke(config: unknown, extra: string[] = []) {
    const dir = makeTmpDir();
    const file = path.join(dir, 'run.json');
    fs.writeFileSync(file, JSON.stringify(config));
    return spawnSync(process.execPath, ['--import', 'tsx', 'eval/harness/run-smoke.mts', '--run-config', file, '--no-gate', '--out', path.join(dir, 'out'), ...extra], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
    });
  }

  test('prechunked mode exits 2 before any request', () => {
    const result = runSmoke({ name: 'seeded', env: V2_ENV, chunking_profiles: [PROFILE] });
    assert.equal(result.status, 2, result.stderr);
    assert.match(result.stderr, /\[Eval Harness\] chunking_profiles needs --fixture-mode ingest/);
  });

  test('a run config without RAG_PIPELINE=v2 exits 2 before any ingestion', () => {
    const result = runSmoke({ name: 'seeded', env: {}, chunking_profiles: [PROFILE] }, ['--fixture-mode', 'ingest']);
    assert.equal(result.status, 2, result.stderr);
    assert.match(result.stderr, /\[Eval Harness\] chunking_profiles needs RAG_PIPELINE=v2/);
    assert.doesNotMatch(result.stdout, /wrote \d+ trace/);
  });

  test('a profile whose child exceeds the embedding input exits 2 before any ingestion', () => {
    const tooBig = { ...PROFILE, id: 'huge-contract_legal', child_tokens: 9000, parent_tokens: 36000, preset: 'custom' };
    const result = runSmoke({ name: 'seeded', env: V2_ENV, chunking_profiles: [tooBig] }, ['--fixture-mode', 'ingest', '--golden', INGEST_GOLDEN]);
    assert.equal(result.status, 2, result.stderr);
    assert.match(result.stderr, /\[Eval Harness\] chunking profile huge-contract_legal is invalid: child_exceeds_embedding_input/);
    assert.doesNotMatch(result.stdout, /wrote \d+ trace/);
  });
});

describe('seeded profiles in an ingest-mode build and eval run', () => {
  let fixture: FixtureDatabase;
  const rows = async (sql: string, params: unknown[] = []): Promise<Row[]> => (await fixture.db.query<Row>(sql, params)).rows;

  before(async () => {
    const config = parseRunConfig({ name: 'seeded', env: V2_ENV, chunking_profiles: [PROFILE] }, 'inline');
    // The app reads its environment when the ingest code first imports it, so the eval endpoint settings go into the build env.
    const evalEnv = { RAG_EVAL_SECRET: 'e'.repeat(48), RAG_EVAL_ALLOWED_SCOPES: `user:${FIXTURE_USER_ID}` };
    process.env.RAG_EVAL_SECRET = evalEnv.RAG_EVAL_SECRET;
    fixture = await buildIngestFixtureDatabase({
      deploymentMode: 'single-tenant',
      corpusDir: CORPUS_DIR,
      corpusRange: { start: 0, end: 0 },
      processEnv: { ...evalEnv, ...config.env },
      chunkingProfiles: config.chunkingProfiles,
    });
  });

  after(async () => {
    await fixture?.edge?.close();
    await fixture?.db.close();
  });

  test('the profile row is seeded as building and ingestion fills it beside the legacy chunks', async () => {
    const [profile] = await rows('SELECT id, doc_type, child_tokens, parent_mode, parent_tokens, status, preset FROM chunking_profiles WHERE id = $1', [PROFILE_ID]);
    assert.ok(profile, 'seeded row');
    assert.equal(profile.status, 'building');
    assert.equal(profile.doc_type, 'contract_legal');
    assert.equal(Number(profile.child_tokens), 256);
    assert.equal(Number(profile.parent_tokens), 1024);
    assert.deepEqual(fixture.seededChunkingProfiles, [PROFILE_ID]);

    const [doc] = await rows("SELECT id FROM documents WHERE filename = 'contract-zh.pdf'");
    assert.ok(doc, 'contract document');
    const [children] = await rows(
      'SELECT count(*)::int AS n FROM document_chunks WHERE document_id = $1 AND chunking_profile_id = $2 AND is_current',
      [doc.id, PROFILE_ID],
    );
    const [parents] = await rows('SELECT count(*)::int AS n FROM document_parents WHERE document_id = $1 AND chunking_profile_id = $2', [doc.id, PROFILE_ID]);
    const [legacy] = await rows(
      "SELECT count(*)::int AS n FROM document_chunks WHERE document_id = $1 AND chunking_profile_id = 'legacy' AND is_current",
      [doc.id],
    );
    assert.ok(Number(children.n) > 0, 'profile children');
    assert.ok(Number(parents.n) > 0, 'profile parents');
    assert.ok(Number(legacy.n) > 0, 'legacy chunks');

    const [otherTypes] = await rows(
      "SELECT count(*)::int AS n FROM document_chunks c JOIN documents d ON d.id = c.document_id WHERE d.doc_type <> 'contract_legal' AND c.chunking_profile_id <> 'legacy'",
    );
    assert.equal(Number(otherTypes.n), 0, 'no other doc type gets profile rows');
  });

  async function evalRun(raw: Record<string, unknown>) {
    const dir = makeTmpDir();
    const goldenPath = path.join(dir, 'contract.jsonl');
    const line = fs
      .readFileSync(INGEST_GOLDEN, 'utf8')
      .split('\n')
      .find((entry) => entry.trim() !== '' && (JSON.parse(entry) as { id: string }).id === CONTRACT_ITEM);
    assert.ok(line, CONTRACT_ITEM);
    fs.writeFileSync(goldenPath, `${line}\n`);
    const result = await runEval({
      goldenPath,
      corpusDir: CORPUS_DIR,
      outDir: path.join(dir, 'out'),
      deploymentMode: 'single-tenant',
      fixtureMode: 'ingest',
      ingestFixture: fixture,
      runConfig: parseRunConfig(raw, 'inline'),
    });
    const trace = JSON.parse(fs.readFileSync(result.tracesPath, 'utf8').trim()) as {
      kept: Array<{ chunk_id: string; document_name?: string | null }>;
      candidates: Array<{ chunk_id: string; document_name?: string | null }>;
    };
    return { result, trace };
  }

  async function contractChunkIds(profileId: string): Promise<Set<string>> {
    const list = await rows(
      "SELECT c.id FROM document_chunks c JOIN documents d ON d.id = c.document_id WHERE d.filename = 'contract-zh.pdf' AND c.chunking_profile_id = $1",
      [profileId],
    );
    return new Set(list.map((row) => String(row.id)));
  }

  test('the override retrieves the profile children for the contract; without it the legacy rows come back', async () => {
    const profileIds = await contractChunkIds(PROFILE_ID);
    const legacyIds = await contractChunkIds('legacy');

    const seeded = await evalRun({
      name: 'seeded',
      env: V2_ENV,
      overrides: { chunking_profile_by_doc_type: { contract_legal: PROFILE_ID } },
      chunking_profiles: [PROFILE],
    });
    const seededContract = seeded.trace.candidates.filter((chunk) => profileIds.has(chunk.chunk_id) || legacyIds.has(chunk.chunk_id));
    assert.ok(seededContract.length > 0, 'contract candidates with the override');
    assert.ok(seededContract.every((chunk) => profileIds.has(chunk.chunk_id)), 'only profile children for the contract');

    const plain = await evalRun({ name: 'plain', env: V2_ENV });
    const plainContract = plain.trace.candidates.filter((chunk) => profileIds.has(chunk.chunk_id) || legacyIds.has(chunk.chunk_id));
    assert.ok(plainContract.length > 0, 'contract candidates without the override');
    assert.ok(plainContract.every((chunk) => legacyIds.has(chunk.chunk_id)), 'only legacy rows without the override');

    assert.deepEqual(seeded.result.manifest.run_config?.chunking_profiles, [PROFILE]);
    assert.equal(plain.result.manifest.run_config?.chunking_profiles, undefined);
  });

  test('the seeded profiles enter the run config hash', async () => {
    const overrides = { chunking_profile_by_doc_type: { contract_legal: PROFILE_ID } };
    const withProfiles = await evalRun({ name: 'seeded', env: V2_ENV, overrides, chunking_profiles: [PROFILE] });
    const withoutProfiles = await evalRun({ name: 'seeded', env: V2_ENV, overrides });
    assert.notEqual(withProfiles.result.manifest.run_config_hash, withoutProfiles.result.manifest.run_config_hash);
  });

  test('runEval refuses chunking_profiles the ingest fixture was not built with', async () => {
    const other = { ...PROFILE, id: 'p128-512-contract_legal', child_tokens: 128, parent_tokens: 512, preset: '128/512' };
    await assert.rejects(evalRun({ name: 'x', env: V2_ENV, chunking_profiles: [other] }), RunConfigError);
  });

  test('runEval refuses chunking_profiles in prechunked mode and for --base-url', async () => {
    const dir = makeTmpDir();
    const goldenPath = path.join(dir, 'g.jsonl');
    fs.writeFileSync(goldenPath, `${fs.readFileSync(INGEST_GOLDEN, 'utf8').split('\n')[0]}\n`);
    const runConfig = parseRunConfig({ name: 'x', env: V2_ENV, chunking_profiles: [PROFILE] }, 'inline');
    const common = { goldenPath, corpusDir: CORPUS_DIR, outDir: path.join(dir, 'out'), deploymentMode: 'single-tenant' as const, runConfig };
    await assert.rejects(runEval({ ...common, fixtureMode: 'prechunked' }), /chunking_profiles needs --fixture-mode ingest/);
    await assert.rejects(runEval({ ...common, baseUrl: 'https://example.invalid' }), RunConfigError);
  });
});
