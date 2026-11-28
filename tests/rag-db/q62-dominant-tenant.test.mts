import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import type { PGlite } from '@electric-sql/pglite';
import { buildIngestFixtureDatabase, partitionIngestModeItems } from '../../eval/harness/ingest-mode.mts';
import { createFixtureDatabase, type FixtureDatabase } from '../../eval/harness/pglite-supabase.mts';
import type { KbLanguageShares } from '../../src/lib/rag/query/kb-languages.ts';

/**
 * Plan 06.2-41 (XLG-07, 06.2-VERIFICATION.md R-2, R-3): a third isolated fixture tenant dominated by one language (zh), so XLG-01's
 * share rule raises R8 and enables translate for en and it questions, through the text entry and the voice entry of the eval route.
 */
const ROOT = process.cwd();
const CORPUS_DIR = path.join(ROOT, 'eval/fixtures/corpus');
const DOMINANT_DIR = path.join(ROOT, 'eval/fixtures/q62-dominant-corpus');
const PRECHUNKED_GOLDEN = path.join(ROOT, 'eval/fixtures/golden.jsonl');
const DOMINANT_FILE = /^q62-dom-[a-z-]+\.(zh|en|it)\.md$/;
const DOMINANT_USER_ID = '00000000-0000-4000-8000-0000000006c2';
const Q62_USER_ID = '00000000-0000-4000-8000-0000000006a2';
const EVAL_SECRET = 'q62-dominant-tenant-eval-secret-00000000';
const LAYER_ON = path.join(ROOT, 'eval/config/runs/query-layer-llamaindex.json');
const VOICE_TRANSLATE = path.join(ROOT, 'eval/config/runs/q62-voice-translate.json');
const VOICE_DEFAULT = path.join(ROOT, 'eval/config/runs/q62-voice-no-translate.json');

interface IsolatedTenant {
  db: PGlite;
  tenantKey: string;
  userId: string | null;
  documentIds: Map<string, string>;
  filenames: string[];
}

interface DominantFixture extends FixtureDatabase {
  dominantLanguageTenant?: IsolatedTenant;
}

interface TraceChunk {
  chunk_id: string;
  document_name?: string | null;
}

interface TraceLine {
  item_id: string;
  candidates: TraceChunk[];
  kept: TraceChunk[];
  query_plan: null | {
    gate: { reasons: string[]; transforms: string[] };
    skipped?: Array<{ transform: string; reason: string }>;
  };
  query_transforms?: Array<{ transform: string | null; status: string | null }>;
  stage_status?: Record<string, string>;
}

/** Neutral synthetic probes (the committed items come with Task 3): two cross-language questions and one same-language control. */
function probe(id: string, language: 'en' | 'it' | 'zh', question: string, document: string, quote: string, section: string) {
  return {
    answerable: true,
    category: language === 'zh' ? 'general' : 'cross_lingual',
    conversation: [],
    evidence_language: language === 'zh' ? null : 'zh',
    expected_answer: 'A synthetic fixture fact.',
    gold_evidence: [{ document, quote, section }],
    id,
    language,
    provenance: 'synthetic_fixture',
    question,
    review_status: 'approved',
    split: 'dev',
    tags: ['dominant_language'],
  };
}

const PROBES = [
  probe('dom-probe-en-01', 'en', 'How often is the anemometer at the station calibrated?', 'q62-dom-anemometer.zh.md', '维斯玛站的风速仪每 45 天校准一次', '风速仪校准'),
  probe(
    'dom-probe-it-01',
    'it',
    'Ogni quanto tempo si sostituisce il filtro del sensore di umidità della stazione?',
    'q62-dom-humidity.zh.md',
    '维斯玛站的湿度传感器滤罩每 30 天更换一次',
    '湿度传感器滤罩',
  ),
  probe('dom-probe-zh-01', 'zh', '维斯玛站的数据记录器多久记录一次读数？', 'q62-dom-data-logger.zh.md', '维斯玛站的数据记录器每 15 分钟记录一次全部读数', '数据记录器采样'),
];
const CROSS_PROBES = PROBES.filter((item) => item.language !== 'zh').map((item) => item.id);
const SAME_PROBES = PROBES.filter((item) => item.language === 'zh').map((item) => item.id);

function lines(file: string): string[] {
  return fs
    .readFileSync(file, 'utf8')
    .split('\n')
    .filter((line) => line.trim() !== '');
}

function isDominantLine(line: string): boolean {
  return ((JSON.parse(line) as { tags?: string[] }).tags ?? []).includes('dominant_language');
}

function writeGolden(dir: string, name: string, content: string[]): string {
  const file = path.join(dir, name);
  fs.writeFileSync(file, `${content.join('\n')}\n`);
  return file;
}

function readTraces(file: string): Map<string, TraceLine> {
  const traces = new Map<string, TraceLine>();
  for (const line of lines(file)) {
    const trace = JSON.parse(line) as TraceLine;
    traces.set(trace.item_id, trace);
  }
  return traces;
}

interface SmokeRun {
  traces: Map<string, TraceLine>;
  corpusSha256: string;
}

/** One run-smoke in a fresh process: the app modules keep the first edge and environment they saw. */
function runSmoke(goldenPath: string, outDir: string, extra: string[] = []): SmokeRun {
  const run = spawnSync(
    process.execPath,
    ['--import', 'tsx', 'eval/harness/run-smoke.mts', '--golden', goldenPath, '--no-gate', '--out', outDir, ...extra],
    { cwd: ROOT, encoding: 'utf8', timeout: 900_000, env: { ...process.env } },
  );
  assert.equal(run.status, 0, `run-smoke failed: ${run.stderr.slice(-2000)}`);
  const manifest = JSON.parse(fs.readFileSync(path.join(outDir, 'run.json'), 'utf8')) as { corpus_sha256: string };
  return { traces: readTraces(path.join(outDir, 'traces.jsonl')), corpusSha256: manifest.corpus_sha256 };
}

const chunkIds = (chunks: TraceChunk[]): string[] => chunks.map((chunk) => chunk.chunk_id);

function assertFromDominantTenant(trace: TraceLine | undefined, id: string): void {
  assert.ok(trace, `${id} has a trace`);
  // v2 candidates may carry no document name; every kept chunk does.
  const named = [...trace.candidates.filter((chunk) => (chunk.document_name ?? '') !== ''), ...trace.kept];
  for (const chunk of named) {
    assert.match(String(chunk.document_name ?? ''), DOMINANT_FILE, `${id}: chunk ${chunk.chunk_id} comes from the dominant-language tenant`);
  }
}

function assertR8(traces: Map<string, TraceLine>, label: string): void {
  for (const id of CROSS_PROBES) {
    const trace = traces.get(id);
    assertFromDominantTenant(trace, id);
    assert.ok(trace?.query_plan, `${label} ${id} has a query plan`);
    assert.ok(trace.query_plan.gate.reasons.includes('R8_LANGUAGE_MISMATCH'), `${label} ${id} raises R8`);
    assert.ok(trace.query_plan.gate.transforms.includes('translate'), `${label} ${id} asks for translate`);
    const translate = (trace.query_transforms ?? []).filter((entry) => entry.transform === 'translate');
    assert.ok(translate.length > 0 && translate.every((entry) => entry.status === 'ok'), `${label} ${id} runs translate`);
    assert.equal(trace.stage_status?.translate, 'ok', `${label} ${id} translate stage`);
    assert.ok(!(trace.query_plan.skipped ?? []).some((entry) => entry.reason === 'disabled_for_profile'), `${label} ${id} translate not disabled`);
  }
  for (const id of SAME_PROBES) {
    const trace = traces.get(id);
    assertFromDominantTenant(trace, id);
    assert.ok(trace?.query_plan, `${label} ${id} has a query plan`);
    assert.ok(!trace.query_plan.gate.reasons.includes('R8_LANGUAGE_MISMATCH'), `${label} ${id} raises no R8`);
    assert.ok(!(trace.query_transforms ?? []).some((entry) => entry.transform === 'translate'), `${label} ${id} runs no translate`);
  }
}

async function sharesOf(tenant: IsolatedTenant): Promise<KbLanguageShares> {
  const rows = await tenant.db.query<{ language: string; share: number | string }>('SELECT language, share FROM public.rag_tenant_language_shares($1)', [
    tenant.tenantKey,
  ]);
  return Object.fromEntries(rows.rows.map((row) => [row.language, Number(row.share)])) as KbLanguageShares;
}

async function assertDominantTenant(fixture: DominantFixture, tenantKey: string): Promise<void> {
  const tenant = fixture.dominantLanguageTenant;
  assert.ok(tenant, 'the build exposes its dominant-language tenant');
  assert.equal(tenant.tenantKey, tenantKey);
  const docs = await tenant.db.query<{ filename: string; status: string; tenant_key: string; language: string | null }>(
    'SELECT filename, status, tenant_key, language FROM documents ORDER BY filename',
  );
  assert.equal(docs.rows.length, 10);
  for (const row of docs.rows) {
    assert.match(row.filename, DOMINANT_FILE);
    assert.equal(row.status, 'ready', row.filename);
    assert.equal(row.tenant_key, tenantKey, row.filename);
    assert.equal(row.language, row.filename.split('.').at(-2), `${row.filename} language`);
  }
  const shares = await sharesOf(tenant);
  assert.ok((shares.zh ?? 0) >= 0.8, `zh share ${shares.zh}`);
  assert.ok((shares.en ?? 0) > 0 && (shares.en ?? 0) <= 0.2, `en share ${shares.en}`);
  assert.ok((shares.it ?? 0) > 0 && (shares.it ?? 0) <= 0.2, `it share ${shares.it}`);
  // Loaded after the fixture build: the app modules read their environment on first import.
  const { translationTargets } = await import('../../src/lib/rag/query/kb-languages.ts');
  assert.deepEqual(translationTargets('en', shares), ['zh']);
  assert.deepEqual(translationTargets('it', shares), ['zh']);
  assert.deepEqual(translationTargets('zh', shares), []);

  const mainDocs = await fixture.db.query<{ n: number }>("SELECT count(*)::int AS n FROM documents WHERE filename LIKE 'q62-dom-%'");
  assert.equal(mainDocs.rows[0]?.n, 0, 'the main fixture tenant holds no dominant-language document');
  const foreign = await tenant.db.query<{ n: number }>("SELECT count(*)::int AS n FROM documents WHERE filename NOT LIKE 'q62-dom-%'");
  assert.equal(foreign.rows[0]?.n, 0, 'the dominant-language tenant holds no other document');
}

async function closeFixture(fixture: (DominantFixture & { q62Tenant?: IsolatedTenant }) | undefined): Promise<void> {
  if (!fixture) return;
  await fixture.dominantLanguageTenant?.db.close().catch(() => undefined);
  await fixture.q62Tenant?.db.close().catch(() => undefined);
  await fixture.edge?.close();
  await fixture.db.close().catch(() => undefined);
}

describe('routing and corpus', () => {
  test('dominant_language-tagged items go to the dominant-language tenant only; table_split and q62 keep their groups and order', () => {
    const items = [
      { id: 'a', category: 'general' },
      { id: 'b', category: 'cross_lingual', tags: ['dominant_language'] },
      { id: 'c', category: 'scoped_compound' },
      { id: 'd', category: 'table_split' },
      { id: 'e', category: 'general', tags: ['dominant_language', 'phase62'] },
      { id: 'f', category: 'no_answer', tags: ['off_domain'] },
      { id: 'g', category: 'cross_lingual' },
    ];
    const routed = partitionIngestModeItems(items) as Record<string, Array<{ id: string }>>;
    assert.deepEqual(routed.main.map((item) => item.id), ['a', 'g']);
    assert.deepEqual(routed.tableSplit.map((item) => item.id), ['d']);
    assert.deepEqual((routed.q62 ?? []).map((item) => item.id), ['c', 'f']);
    assert.deepEqual((routed.dominantLanguage ?? []).map((item) => item.id), ['b', 'e']);
  });

  test('the corpus is synthetic, dominated by zh (at least 80%), with en and it at most 20% each', () => {
    const count = (language: string) => fs.readdirSync(path.join(DOMINANT_DIR, language)).filter((name) => name.endsWith('.md')).length;
    const zh = count('zh');
    const en = count('en');
    const it = count('it');
    const total = zh + en + it;
    assert.ok(total >= 10, `${total} documents`);
    assert.ok(zh / total >= 0.8 && en >= 1 && it >= 1 && en / total <= 0.2 && it / total <= 0.2, `zh ${zh}, en ${en}, it ${it}`);
  });
});

describe('ingest mode: the dominant-language tenant loads through ingest() with the same language shares', () => {
  let fixture: DominantFixture | undefined;

  before(async () => {
    fixture = (await buildIngestFixtureDatabase({
      deploymentMode: 'single-tenant',
      corpusDir: CORPUS_DIR,
      processEnv: { RAG_EVAL_SECRET: EVAL_SECRET },
      dominantLanguage: true,
    } as Parameters<typeof buildIngestFixtureDatabase>[0])) as DominantFixture;
  });

  after(async () => {
    await closeFixture(fixture);
  });

  test('the tenant holds its 10 documents and zh dominates its language shares; the main tenant holds none of them', async () => {
    assert.ok(fixture);
    await assertDominantTenant(fixture, 's:default');
  });
});

describe('prechunked mode: the dominant-language tenant is isolated and leaves the old items unchanged', () => {
  let tmp: string;
  let without: SmokeRun;
  let withDominant: SmokeRun;
  const fixtures: DominantFixture[] = [];

  before(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'q62-dominant-prechunked-'));
    const old = lines(PRECHUNKED_GOLDEN).filter((line) => !isDominantLine(line));
    without = runSmoke(writeGolden(tmp, 'old.jsonl', old), path.join(tmp, 'without'));
    withDominant = runSmoke(writeGolden(tmp, 'with.jsonl', [...old, ...PROBES.map((item) => JSON.stringify(item))]), path.join(tmp, 'with'));
  });

  after(async () => {
    for (const fixture of fixtures) await closeFixture(fixture);
    if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
  });

  test('every old item retrieves the same chunk ids in the same order; a run without tagged items does not load the tenant', () => {
    assert.ok(without.traces.size > 0);
    assert.notEqual(withDominant.corpusSha256, without.corpusSha256, 'only the run with tagged items loads the tenant');
    const probeIds = new Set(PROBES.map((item) => item.id));
    assert.deepEqual([...withDominant.traces.keys()].filter((id) => !probeIds.has(id)).sort(), [...without.traces.keys()].sort());
    for (const [id, beforeLoad] of without.traces) {
      const afterLoad = withDominant.traces.get(id);
      assert.ok(afterLoad, `${id} has a trace in both runs`);
      assert.deepEqual(chunkIds(afterLoad.candidates), chunkIds(beforeLoad.candidates), `${id} candidates`);
      assert.deepEqual(chunkIds(afterLoad.kept), chunkIds(beforeLoad.kept), `${id} kept`);
    }
    for (const item of PROBES) assertFromDominantTenant(withDominant.traces.get(item.id), item.id);
  });

  for (const deploymentMode of ['single-tenant', 'multi-tenant'] as const) {
    test(`${deploymentMode}: the tenant holds its 10 documents, zh dominates its language shares, the main and q62 tenants hold none of them`, async () => {
      const fixture = (await createFixtureDatabase({
        deploymentMode,
        corpusDir: CORPUS_DIR,
        fixtureMode: 'prechunked',
        q62: true,
        dominantLanguage: true,
      } as Parameters<typeof createFixtureDatabase>[0])) as DominantFixture & { q62Tenant?: IsolatedTenant };
      fixtures.push(fixture);
      await assertDominantTenant(fixture, deploymentMode === 'multi-tenant' ? `u:${DOMINANT_USER_ID}` : 's:default');
      assert.ok(fixture.q62Tenant, 'the q62 tenant loads beside it');
      const q62Docs = await fixture.q62Tenant.db.query<{ n: number }>("SELECT count(*)::int AS n FROM documents WHERE filename LIKE 'q62-dom-%'");
      assert.equal(q62Docs.rows[0]?.n, 0, 'the q62 tenant holds no dominant-language document');
      const dominantQ62 = await fixture.dominantLanguageTenant!.db.query<{ n: number }>(
        "SELECT count(*)::int AS n FROM documents WHERE filename LIKE 'q62-%' AND filename NOT LIKE 'q62-dom-%'",
      );
      assert.equal(dominantQ62.rows[0]?.n, 0, 'the dominant-language tenant holds no q62 document');
      if (deploymentMode === 'multi-tenant') assert.notEqual(fixture.dominantLanguageTenant!.tenantKey, `u:${Q62_USER_ID}`);
    });
  }
});

describe('R8 fires on the dominant-language tenant (v2, query layer on)', () => {
  let tmp: string;

  before(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'q62-dominant-r8-'));
  });

  after(() => {
    if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
  });

  /** A main-tenant item runs first, so the KB-share cache of `s:default` is filled with the main tenant's shares before the probes. */
  const golden = () => writeGolden(tmp, `probes-${crypto.randomUUID()}.jsonl`, [lines(PRECHUNKED_GOLDEN)[0]!, ...PROBES.map((item) => JSON.stringify(item))]);

  test('text entry, single-tenant: en and it questions raise R8 and run translate (target zh); the zh question does not', () => {
    const run = runSmoke(golden(), path.join(tmp, 'text'), ['--run-config', LAYER_ON]);
    assertR8(run.traces, 'text');
  });

  test('text entry, multi-tenant: the same with the tenant under its own reserved fixture user', () => {
    const run = runSmoke(golden(), path.join(tmp, 'text-multi'), ['--run-config', LAYER_ON, '--deployment-mode', 'multi-tenant']);
    assertR8(run.traces, 'text multi-tenant');
  });

  test('voice entry with translate in RAG_QUERY_VOICE_TRANSFORMS: en and it questions raise R8 and run translate', () => {
    const run = runSmoke(golden(), path.join(tmp, 'voice'), ['--run-config', VOICE_TRANSLATE]);
    assertR8(run.traces, 'voice');
  });

  test('voice entry with the default list: translate never runs', () => {
    const run = runSmoke(golden(), path.join(tmp, 'voice-default'), ['--run-config', VOICE_DEFAULT]);
    for (const item of PROBES) {
      const trace = run.traces.get(item.id);
      assertFromDominantTenant(trace, item.id);
      assert.ok(!(trace?.query_transforms ?? []).some((entry) => entry.transform === 'translate'), `${item.id} runs no translate`);
      assert.notEqual(trace?.stage_status?.translate, 'ok', `${item.id} translate stage`);
    }
  });
});

describe('R8 smoke over the committed dominant_language items (Task 3)', () => {
  let tmp: string;
  let committed: string[];

  before(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'q62-dominant-committed-'));
    committed = lines(PRECHUNKED_GOLDEN).filter(isDominantLine);
  });

  after(() => {
    if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
  });

  /** Per pair, the committed items on which R8 fired and translate produced a zh variant; zero for a pair fails. */
  function assertTranslatedPerPair(traces: Map<string, TraceLine & { query_plan: { variants?: Array<{ kind: string; language: string }> } | null }>, label: string) {
    const fired = new Map<string, number>();
    for (const line of committed) {
      const item = JSON.parse(line) as { id: string; language: string; evidence_language: string | null };
      const trace = traces.get(item.id);
      assertFromDominantTenant(trace, item.id);
      const r8 = trace?.query_plan?.gate.reasons.includes('R8_LANGUAGE_MISMATCH') ?? false;
      if (item.evidence_language === null) {
        assert.equal(r8, false, `${label} ${item.id}: a zh control raises no R8`);
        continue;
      }
      const translated = (trace?.query_plan?.variants ?? []).some((variant) => variant.kind === 'translated' && variant.language === 'zh');
      if (r8 && translated) fired.set(`${item.language}->zh`, (fired.get(`${item.language}->zh`) ?? 0) + 1);
    }
    for (const pair of ['en->zh', 'it->zh']) assert.ok((fired.get(pair) ?? 0) > 0, `${label}: R8 and a zh translation on at least one ${pair} item`);
  }

  test('at least 3 items per pair and 2 zh controls are committed', () => {
    const parsed = committed.map((line) => JSON.parse(line) as { language: string; evidence_language: string | null });
    assert.ok(parsed.filter((item) => item.language === 'en' && item.evidence_language === 'zh').length >= 3);
    assert.ok(parsed.filter((item) => item.language === 'it' && item.evidence_language === 'zh').length >= 3);
    assert.ok(parsed.filter((item) => item.language === 'zh' && item.evidence_language === null).length >= 2);
  });

  test('text entry with the query layer on: R8 fires and translate yields a zh variant for each pair', () => {
    const run = runSmoke(writeGolden(tmp, 'text.jsonl', committed), path.join(tmp, 'text'), ['--run-config', LAYER_ON]);
    assertTranslatedPerPair(run.traces as never, 'text');
  });

  test('voice-translate arm: R8 fires and translate yields a zh variant for each pair', () => {
    const run = runSmoke(writeGolden(tmp, 'voice.jsonl', committed), path.join(tmp, 'voice'), ['--run-config', VOICE_TRANSLATE]);
    assertTranslatedPerPair(run.traces as never, 'voice');
  });
});
