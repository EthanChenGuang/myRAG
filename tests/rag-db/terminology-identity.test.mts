import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { NextRequest } from 'next/server';
import { prepareInProcessEval, type InProcessEval } from '../../eval/harness/run-eval.mts';
import { FIXTURE_USER_ID, seedTerminology, type TerminologySeedRow } from '../../eval/harness/pglite-supabase.mts';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const CORPUS_DIR = path.join(REPO_ROOT, 'tests/fixtures/terminology-corpus');
const ROUTE_PATH = '/api/internal/rag/run';

/** User A owns the synthetic corpus; B and C own nothing. Each user is its own tenant key u:<id>. */
const USER_A = FIXTURE_USER_ID;
const USER_B = '00000000-0000-4000-8000-0000000016b1';
const USER_C = '00000000-0000-4000-8000-0000000016c1';
const TENANT_A = `u:${USER_A}`;
const TENANT_B = `u:${USER_B}`;

/** D-37 placeholder terms. S is shared, A1 is user A's workspace entry, B1 is user B's. */
const S = { variant: 'termalpha', canonical: 'term alpha beta', language: 'en' } as const;
const A1 = { variant: 'termgamma', canonical: 'term gamma delta', language: 'en' } as const;
const B1 = { variant: 'vocealfa', canonical: 'termine alfa beta', language: 'it' } as const;

function row(layer: string, entry: { variant: string; canonical: string; language: string }): TerminologySeedRow {
  return { layer, canonical: entry.canonical, variants: [entry.variant], language: entry.language, kind: 'synonym', mode: 'one_way' };
}

const SEED: TerminologySeedRow[] = [row('shared', S), row(TENANT_A, A1), row(TENANT_B, B1)];
const SEEDED_TEXTS = [S, A1, B1].flatMap((entry) => [entry.variant, entry.canonical]);

/** One question per fixture language; each retrieves from the synthetic corpus without any dictionary. */
const GOLDEN = [
  { language: 'en', query: 'What does the term alpha beta name?' },
  { language: 'it', query: 'Che cosa indica il termine alfa beta?' },
  { language: 'zh', query: '术语甲乙丙是什么？' },
] as const;

const ALL_VARIANTS = `${S.variant} ${A1.variant} ${B1.variant}`;

interface Candidate {
  chunk_id: string;
  fused_score?: number;
}

interface TraceBody {
  stage_status: Record<string, string>;
  stage_counts?: Record<string, Record<string, number>>;
  stages?: Array<{ name: string; detail?: string | null }>;
  candidates: Candidate[];
  retrieval_config_hash: string | null;
}

let prepared: InProcessEval;

async function postEval(query: string, itemId: string, options: { userId?: string; disabledStages?: string[] } = {}) {
  const req = new NextRequest(`http://localhost${ROUTE_PATH}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-rag-eval-secret': prepared.secret },
    body: JSON.stringify({
      schema_version: 1,
      query,
      item_id: itemId,
      rag_mode: 'strict',
      options: {
        user_id: options.userId ?? USER_A,
        ...(options.disabledStages ? { disabled_stages: options.disabledStages } : {}),
      },
    }),
  });
  const res = await prepared.POST(req);
  const json = (await res.json()) as TraceBody;
  assert.equal(res.status, 200, JSON.stringify(json).slice(0, 500));
  return json;
}

/** The app env is a snapshot taken at import; the switch is flipped per request through the deps seam. */
async function withTerminology<T>(value: 'true' | 'false', fn: () => Promise<T>): Promise<T> {
  const deps = await import('../../src/lib/rag/deps.ts');
  const previous = deps.getRagDeps().ragEnv;
  deps.setRagDepsForTests({ ragEnv: () => ({ ...previous(), RAG_TERMINOLOGY: value }) });
  try {
    return await fn();
  } finally {
    deps.setRagDepsForTests({ ragEnv: previous });
  }
}

async function invalidate(): Promise<void> {
  const { invalidateTerminologyCache } = await import('../../src/lib/rag/terminology/load.ts');
  invalidateTerminologyCache('all');
}

function ranking(body: TraceBody) {
  return body.candidates.map((row) => ({ chunk_id: row.chunk_id, fused_score: row.fused_score ?? null }));
}

/** The stage's effective version from its counts (the eval route returns counts, not the detail): s<shared>[.w<workspace>]. */
function versionOf(body: TraceBody): string {
  const counts = body.stage_counts?.terminology;
  if (!counts) return '';
  return counts.workspace_version > 0 ? `s${counts.shared_version}.w${counts.workspace_version}` : `s${counts.shared_version}`;
}

/** matches=<n> as the stage detail spells it. */
function matchesOf(body: TraceBody): string {
  return `matches=${body.stage_counts?.terminology?.matches ?? 'none'}`;
}

/** The unseeded baseline, taken before any dictionary row exists. */
const unseeded = new Map<string, TraceBody>();

before(async () => {
  prepared = await prepareInProcessEval({
    corpusDir: CORPUS_DIR,
    deploymentMode: 'multi-tenant',
    allowedScopes: [`user:${USER_B}`, `user:${USER_C}`],
    // The baseline is taken on a database without any dictionary row; the fixture dictionary (04.1.1-10) is not seeded here.
    terminologySeed: [],
    // D-36: pipeline and languages set explicitly, never the shipped default.
    envOverrides: {
      RAG_PIPELINE: 'v2',
      RAG_LEXICAL_SEARCH: 'true',
      RAG_SUPPORTED_LANGUAGES: 'zh,en,it',
      RAG_PRIMARY_LANGUAGE: 'en',
      RAG_TERMINOLOGY: 'false',
    },
  });
  const { resetRetrievalBackendForTests } = await import('../../src/lib/rag/backend/registry.ts');
  const { verifyV2Startup, resetV2StartupForTests } = await import('../../src/lib/rag/v2/startup.ts');
  resetRetrievalBackendForTests();
  resetV2StartupForTests();
  await verifyV2Startup();

  for (const item of GOLDEN) {
    unseeded.set(item.language, await withTerminology('false', () => postEval(item.query, `unseeded-${item.language}`)));
  }
  unseeded.set('variants', await withTerminology('false', () => postEval(ALL_VARIANTS, 'unseeded-variants')));
  await seedTerminology(prepared.fixtureDb, SEED);
  await invalidate();
});

after(async () => {
  await prepared?.close();
});

describe('terminology off is today, on is recorded in the hash (04.1.1-16, D-21)', () => {
  test('the unseeded baseline retrieves candidates for every golden question', () => {
    for (const item of GOLDEN) {
      const body = unseeded.get(item.language)!;
      assert.equal(body.stage_status.terminology, 'disabled');
      assert.ok(body.candidates.length > 0, `${item.language}: no candidates`);
      assert.equal(typeof body.retrieval_config_hash, 'string');
    }
  });

  for (const item of [...GOLDEN.map((golden) => golden.language), 'variants']) {
    test(`${item}: off on the seeded database equals the unseeded run (candidates, order, scores, hash)`, async () => {
      const baseline = unseeded.get(item)!;
      const query = item === 'variants' ? ALL_VARIANTS : GOLDEN.find((golden) => golden.language === item)!.query;
      const off = await withTerminology('false', () => postEval(query, `seeded-off-${item}`));
      assert.equal(off.stage_status.terminology, 'disabled');
      assert.deepEqual(ranking(off), ranking(baseline));
      assert.equal(off.retrieval_config_hash, baseline.retrieval_config_hash);
    });
  }

  test('on changes the hash; on with terminology in the eval request disabled_stages equals off', async () => {
    const query = GOLDEN[0].query;
    const off = unseeded.get('en')!;
    const on = await withTerminology('true', () => postEval(query, 'hash-on'));
    assert.equal(on.stage_status.terminology, 'ok');
    assert.notEqual(on.retrieval_config_hash, off.retrieval_config_hash);
    const disabled = await withTerminology('true', () => postEval(query, 'hash-disabled', { disabledStages: ['terminology'] }));
    assert.equal(disabled.stage_status.terminology, 'disabled');
    assert.equal(disabled.retrieval_config_hash, off.retrieval_config_hash);
    assert.deepEqual(ranking(disabled), ranking(off));
  });

  test('a shared-layer version bump changes the hash again', async () => {
    const query = GOLDEN[0].query;
    await invalidate();
    const before = await withTerminology('true', () => postEval(query, 'bump-before'));
    await prepared.fixtureDb.query("UPDATE public.rag_term_layers SET version = version + 1 WHERE layer_key = 'shared'");
    await invalidate();
    const afterBump = await withTerminology('true', () => postEval(query, 'bump-after'));
    try {
      assert.equal(afterBump.stage_status.terminology, 'ok');
      assert.notEqual(versionOf(afterBump), versionOf(before));
      assert.notEqual(afterBump.retrieval_config_hash, before.retrieval_config_hash);
    } finally {
      await prepared.fixtureDb.query("UPDATE public.rag_term_layers SET version = version - 1 WHERE layer_key = 'shared'");
      await invalidate();
    }
  });

  test('no serialized stage carries a seeded variant or canonical', async () => {
    const on = await withTerminology('true', () => postEval(ALL_VARIANTS, 'privacy'));
    assert.equal(on.stage_status.terminology, 'ok');
    const serialized = JSON.stringify({ stages: on.stages ?? [], stage_counts: on.stage_counts ?? {} });
    for (const text of SEEDED_TEXTS) assert.ok(!serialized.includes(text), `trace carries ${text}`);
  });
});

describe('the loader reads only the caller tenant layer (04.1.1-16, TERM-01, T-0411-13)', () => {
  const sharedVersion = 1;

  test('user B: matches=2 (S and B1), version s<n>.w1, a term:0 list, nothing from A1', async () => {
    await invalidate();
    const body = await withTerminology('true', () => postEval(ALL_VARIANTS, 'tenant-b', { userId: USER_B }));
    assert.equal(body.stage_status.terminology, 'ok');
    assert.equal(matchesOf(body), 'matches=2');
    assert.equal(versionOf(body), `s${sharedVersion}.w1`);
    assert.notEqual(body.stage_counts?.search?.term, undefined, 'the term:0 list ran');
    const onlyA1 = await withTerminology('true', () => postEval(A1.variant, 'tenant-b-a1', { userId: USER_B }));
    assert.equal(onlyA1.stage_counts?.terminology?.matches, 0, "user B matched user A's entry");
  });

  test('user A: matches=2 (S and A1), nothing from B1; its own workspace version', async () => {
    await prepared.fixtureDb.query('UPDATE public.rag_term_layers SET version = 3 WHERE layer_key = $1', [TENANT_A]);
    await invalidate();
    try {
      const body = await withTerminology('true', () => postEval(ALL_VARIANTS, 'tenant-a', { userId: USER_A }));
      assert.equal(body.stage_status.terminology, 'ok');
      assert.equal(matchesOf(body), 'matches=2');
      assert.notEqual(body.stage_counts?.search?.term, undefined, 'the term:0 list ran');
      assert.equal(versionOf(body), `s${sharedVersion}.w3`, "user A's request read another tenant's layer version");
      const onlyB1 = await withTerminology('true', () => postEval(B1.variant, 'tenant-a-b1', { userId: USER_A }));
      assert.equal(onlyB1.stage_counts?.terminology?.matches, 0, "user A matched user B's entry");
      const onlyS = await withTerminology('true', () => postEval(S.variant, 'tenant-a-s', { userId: USER_A }));
      assert.equal(onlyS.stage_counts?.terminology?.matches, 1, 'user A missed the shared entry');
    } finally {
      await prepared.fixtureDb.query('UPDATE public.rag_term_layers SET version = 1 WHERE layer_key = $1', [TENANT_A]);
      await invalidate();
    }
  });

  test('user C without a workspace layer: matches=1 (S only), version s<n>.w0', async () => {
    await invalidate();
    const body = await withTerminology('true', () => postEval(ALL_VARIANTS, 'tenant-c', { userId: USER_C }));
    assert.equal(body.stage_status.terminology, 'ok');
    assert.equal(matchesOf(body), 'matches=1');
    // w0: no workspace layer; the effective version string then omits the workspace part (04.1.1-05 load.ts).
    assert.equal(body.stage_counts?.terminology?.workspace_version, 0);
    assert.equal(body.stage_counts?.terminology?.shared_version, sharedVersion);
    assert.equal(versionOf(body), `s${sharedVersion}`);
  });
});
