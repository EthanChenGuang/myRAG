/**
 * Per-doc-type embedding binding comparison (D-22..D-24). One ingest fixture database (main corpus + domain pack), one scoped re-embed per
 * candidate profile, then three kinds of arm on the same golden file under RAG_PIPELINE=v2 and RAG_DOMAIN_EMBEDDINGS=on: baseline (global
 * profile only), control (domain_control_leg: a second global-model leg filtered to the doc type) and one arm per candidate
 * (embedding_bindings). rag_eval.binding_compare_cli applies the decision rule and writes comparison.json (BindingComparison).
 *
 * Fake mode (default) installs fixture embedders for every catalog model and never reads a vendor key. --live requires VOYAGE_API_KEY
 * (presence only, never printed), prints each candidate's re-embed dry-run cost and stops with exit 4 unless --confirm-cost is given.
 *
 * Exit codes: 0 comparison written, 2 bad arguments, 3 failure, 4 cost not confirmed.
 */
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import type { IngestFixtureBuildState } from './ingest-mode.mts';
import type { EvalRequestOptions } from './run-eval.mts';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const DOMAIN_DIR = path.join(REPO_ROOT, 'eval/fixtures/domain');
const CORPUS_DIR = path.join(REPO_ROOT, 'eval/fixtures/corpus');
const NOISE_PATH = path.join(REPO_ROOT, 'eval/config/noise.json');
const RETRIEVAL_PARAMS_PATH = path.join(REPO_ROOT, 'eval/config/retrieval-params.json');
const DOC_TYPES = ['general', 'financial_report', 'contract_legal', 'invoice_receipt', 'product_technical', 'scanned_image'] as const;
const ACTOR = 'binding-compare-harness';
const FIXTURE_NATIVE_DIMS = 1536;
export const RANK_SOURCE = 'candidates';
const ARM_ENV = { RAG_PIPELINE: 'v2', RAG_EMBEDDING_PROFILES: 'on', RAG_DOMAIN_EMBEDDINGS: 'on' } as const;

/**
 * The ingest fixture has no calibrated similarity floor (the committed fixture calibration covers prechunked mode only), so the legacy
 * 0.65 floor would refuse almost every fixture query and hide every leg difference. Fake runs set an eval-only floor through the eval
 * profile's calibration seam (refusal/floor.ts); live runs keep the profile's own calibration.
 */
export const FIXTURE_CONTEXT_THRESHOLD = 0.01;
export const FIXTURE_FLOOR_NOTE =
  `Fixture run: eval-only similarity floor context_threshold=${FIXTURE_CONTEXT_THRESHOLD} (the ingest fixture has no calibrated floor); refusal rates are not meaningful.`;

export const EXIT_WRITTEN = 0;
export const EXIT_USAGE = 2;
export const EXIT_FAILED = 3;
export const EXIT_COST_NOT_CONFIRMED = 4;

class UsageError extends Error {}

export const DOMAIN_GOLDEN = 'eval/fixtures/domain/golden.jsonl';
export const DEFAULT_BASELINE_RUNS = 3;

export interface BindingCompareArgs {
  /** Null only in the baseline modes, which run the baseline arm alone. */
  docType: (typeof DOC_TYPES)[number] | null;
  candidates: string[] | null;
  golden: string | null;
  outDir: string;
  live: boolean;
  confirmCost: boolean;
  /** Run only the baseline arm and write <out>/baseline/report.json (one run of --record-baseline). */
  baselineOnly: boolean;
  /** Record the domain-pack baseline (D-24): this many --baseline-only runs in separate processes, then rag_eval.baseline record-reports. */
  recordBaseline: string | null;
  runs: number;
}

export function parseBindingCompareArgs(argv: string[]): BindingCompareArgs {
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      options: {
        'doc-type': { type: 'string' },
        candidates: { type: 'string' },
        golden: { type: 'string' },
        out: { type: 'string' },
        live: { type: 'boolean', default: false },
        'confirm-cost': { type: 'boolean', default: false },
        'baseline-only': { type: 'boolean', default: false },
        'record-baseline': { type: 'string' },
        runs: { type: 'string' },
      },
      strict: true,
    });
  } catch (error) {
    throw new UsageError(error instanceof Error ? error.message : String(error));
  }
  const { values } = parsed;
  const baselineOnly = values['baseline-only'] === true;
  const recordBaseline = values['record-baseline'] ? path.resolve(values['record-baseline']) : null;
  const baselineMode = baselineOnly || recordBaseline !== null;
  if (baselineOnly && recordBaseline !== null) throw new UsageError('--baseline-only and --record-baseline are exclusive');
  const docType = values['doc-type']?.trim() ?? '';
  if (!(DOC_TYPES as readonly string[]).includes(docType) && !(baselineMode && docType === '')) {
    throw new UsageError(`--doc-type is required and must be one of ${DOC_TYPES.join(', ')}`);
  }
  if (baselineMode && (values.live || values.candidates)) throw new UsageError('the baseline modes take neither --live nor --candidates');
  const runs = values.runs === undefined ? DEFAULT_BASELINE_RUNS : Number(values.runs);
  if (!Number.isInteger(runs) || runs < DEFAULT_BASELINE_RUNS) throw new UsageError(`--runs must be an integer >= ${DEFAULT_BASELINE_RUNS}`);
  const candidates = values.candidates
    ? values.candidates
        .split(',')
        .map((entry) => entry.trim())
        .filter(Boolean)
    : null;
  if (candidates !== null && candidates.length === 0) throw new UsageError('--candidates names no profile');
  return {
    docType: docType === '' ? null : (docType as BindingCompareArgs['docType'] & string),
    candidates,
    golden: values.golden ? path.resolve(values.golden) : null,
    outDir: path.resolve(values.out ?? path.join('eval/out/binding-compare', docType || 'domain-baseline')),
    live: values.live === true,
    confirmCost: values['confirm-cost'] === true,
    baselineOnly,
    recordBaseline,
    runs,
  };
}

function runPython(module: string, args: string[]): number {
  const result = spawnSync('uv', ['run', '--directory', path.join(REPO_ROOT, 'eval'), 'python', '-m', module, ...args], {
    stdio: 'inherit',
    cwd: REPO_ROOT,
    env: { ...process.env, PATH: `/home/ubuntu/.local/bin:${process.env.PATH ?? ''}` },
  });
  if (result.error) throw result.error;
  return result.status ?? EXIT_FAILED;
}

function sha256(...parts: Array<string | Buffer>): string {
  const hash = crypto.createHash('sha256');
  parts.forEach((part, index) => {
    if (index > 0) hash.update(Buffer.from([0]));
    hash.update(part);
  });
  return hash.digest('hex');
}

function fileSha256(file: string): string {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function padded(vector: number[], dims: number): number[] {
  return [...vector, ...new Array<number>(Math.max(0, dims - vector.length)).fill(0)];
}

interface DomainDocument {
  relpath: string;
  filename: string;
  docType: string;
  content: string;
}

/** The domain pack's documents with the doc type its manifest names; the fixture-meta line must agree (eval/fixtures/domain, 03.1.1-11). */
async function loadDomainPack(): Promise<{ documents: DomainDocument[]; sha256: string }> {
  const manifest = JSON.parse(fs.readFileSync(path.join(DOMAIN_DIR, 'manifest.json'), 'utf8')) as { documents: Record<string, string> };
  const { loadCorpus } = await import('./corpus.mts');
  const corpus = loadCorpus(path.join(DOMAIN_DIR, 'corpus'));
  const documents: DomainDocument[] = [];
  for (const doc of corpus.documents) {
    const docType = manifest.documents[doc.relpath];
    if (!docType) throw new Error(`[Binding Compare] ${doc.relpath} is not in the domain manifest`);
    if (doc.docType !== docType) throw new Error(`[Binding Compare] ${doc.relpath}: manifest says ${docType}, fixture-meta says ${doc.docType}`);
    documents.push({ relpath: doc.relpath, filename: doc.filename, docType, content: doc.content });
  }
  const listed = Object.keys(manifest.documents).sort();
  const loaded = documents.map((doc) => doc.relpath).sort();
  if (JSON.stringify(listed) !== JSON.stringify(loaded)) throw new Error('[Binding Compare] the domain manifest and corpus disagree');
  return { documents, sha256: corpus.corpusSha256 };
}

/** Fixture embedders for every Voyage model of the catalog, keyed provider:model, padded to the requested dims. No key is read. */
async function installFixtureEmbedders(): Promise<void> {
  const registry = await import('../../src/lib/rag/embeddings/registry');
  const { EMBEDDING_MODEL_CATALOG } = await import('../../src/lib/rag/embeddings/catalog');
  const { embedText } = await import('./fixture-embedder.mts');
  const providers: Record<string, import('../../src/lib/rag/embeddings/types').EmbeddingProvider> = {};
  for (const entry of EMBEDDING_MODEL_CATALOG) {
    if (entry.provider !== 'voyage') continue;
    const model = entry.model;
    providers[`voyage:${model}`] = {
      id: 'voyage',
      model,
      maxInputTokens: entry.maxInputTokens,
      supportedDims: [...entry.supportedDims],
      normalize: true,
      async embedDocuments(texts, opts) {
        return { vectors: texts.map((text) => padded(embedText(text, Math.min(opts.dims, FIXTURE_NATIVE_DIMS)), opts.dims)), model, host: 'fixture-embedder', usage: { tokens: texts.length } };
      },
      async embedQuery(text, opts) {
        return { vectors: [padded(embedText(text, Math.min(opts.dims, FIXTURE_NATIVE_DIMS)), opts.dims)], model, host: 'fixture-embedder', usage: { tokens: 1 } };
      },
    };
  }
  registry.setEmbeddingProvidersForTests(providers as never);
}

/**
 * Main golden + ingest-only items + the domain pack. table_split items are left out: they run only against the isolated table_split
 * tenants, which this one-database build does not load.
 */
function defaultGolden(
  outDir: string,
  merge: (paths: string[], outPath: string) => string,
  ingestPaths: () => string[],
  partition: <T extends { category: string }>(items: T[]) => { main: T[]; tableSplit: T[] },
): string {
  const merged = merge(
    [...ingestPaths(), 'eval/fixtures/domain/golden.jsonl'].map((file) => path.join(REPO_ROOT, file)),
    path.join(outDir, 'golden.all.jsonl'),
  );
  const lines = fs.readFileSync(merged, 'utf8').split('\n').filter((line) => line.trim() !== '');
  const items = lines.map((line) => ({ line, category: (JSON.parse(line) as { category: string }).category }));
  const out = path.join(outDir, 'golden.merged.jsonl');
  fs.writeFileSync(out, `${partition(items).main.map((item) => item.line).join('\n')}\n`);
  return out;
}

interface CandidateProfile {
  id: string;
  provider: string;
  model: string;
  dims: number;
}

type Db = { query: <T = Record<string, unknown>>(sql: string, params?: unknown[]) => Promise<{ rows: T[] }> };

async function scopedCandidates(db: Db, docType: string, wanted: string[] | null): Promise<CandidateProfile[]> {
  const { rows } = await db.query<{ id: string; provider: string; model: string; dims: number }>(
    'SELECT id, provider, model, dims FROM public.embedding_profiles WHERE doc_types IS NOT NULL AND $1 = ANY (doc_types) ORDER BY id',
    [docType],
  );
  if (wanted === null) {
    if (rows.length === 0) throw new UsageError(`no scoped profile covers ${docType}`);
    return rows;
  }
  const unknown = wanted.filter((id) => !rows.some((row) => row.id === id));
  if (unknown.length > 0) throw new UsageError(`not a scoped profile for ${docType}: ${unknown.join(', ')}`);
  return rows.filter((row) => wanted.includes(row.id));
}

async function stageBinding(db: Db, docType: string, profileId: string, status: 'backfilling' | 'available'): Promise<string> {
  const created = await db.query<{ binding_id: string }>('SELECT binding_id FROM public.rag_create_embedding_binding($1, NULL, $2, $3)', [
    docType,
    profileId,
    ACTOR,
  ]);
  const bindingId = created.rows[0]?.binding_id;
  if (!bindingId) throw new Error(`[Binding Compare] binding for ${profileId} was not created`);
  await db.query('SELECT * FROM public.rag_set_embedding_binding_status($1, $2, $3)', [bindingId, status, ACTOR]);
  return bindingId;
}

/** --record-baseline: N separate processes of --baseline-only, so the recorded spread proves determinism across processes. */
function recordDomainBaseline(args: BindingCompareArgs, out: string): number {
  const reports: string[] = [];
  for (let index = 1; index <= args.runs; index += 1) {
    const runDir = path.join(args.outDir, `run-${index}`);
    const child = spawnSync(
      'npx',
      ['tsx', fileURLToPath(import.meta.url), '--baseline-only', '--out', runDir, ...(args.golden ? ['--golden', args.golden] : [])],
      { cwd: REPO_ROOT, stdio: ['ignore', 'ignore', 'inherit'], env: process.env },
    );
    if (child.status !== 0) {
      console.error(`[Binding Compare] baseline run ${index} exited with code ${child.status ?? 'null'}`);
      return EXIT_FAILED;
    }
    reports.push(path.join(runDir, 'baseline', 'report.json'));
    console.log(`[Binding Compare] baseline run ${index}/${args.runs} done`);
  }
  return runPython('rag_eval.baseline', ['record-reports', ...reports.flatMap((report) => ['--report', report]), '--out', out]);
}

async function main(argv: string[]): Promise<number> {
  const args = parseBindingCompareArgs(argv);
  fs.mkdirSync(args.outDir, { recursive: true });
  if (args.recordBaseline !== null) return recordDomainBaseline(args, args.recordBaseline);

  // Live mode only: the key must be present. Its value is kept in memory and never printed; fake mode never reads it.
  let liveVoyageKey: string | null = null;
  if (args.live) {
    const { config: loadDotenv } = await import('dotenv');
    loadDotenv({ path: path.join(REPO_ROOT, '.env.local'), quiet: true });
    liveVoyageKey = process.env.VOYAGE_API_KEY?.trim() || null;
    if (!liveVoyageKey) {
      console.error('[Binding Compare] --live needs VOYAGE_API_KEY (presence is checked; the value is never printed)');
      return EXIT_USAGE;
    }
  }
  const restoreLiveVendor = (): void => {
    if (liveVoyageKey === null) return;
    process.env.VOYAGE_API_KEY = liveVoyageKey;
    delete process.env.VOYAGE_BASE_URL;
  };

  if (!process.env.RAG_EVAL_SECRET || process.env.RAG_EVAL_SECRET.length < 32) {
    process.env.RAG_EVAL_SECRET = crypto.randomBytes(24).toString('hex');
  }
  (process.env as Record<string, string>).NODE_ENV = 'test';

  const domain = await loadDomainPack();
  const ingestMode = await import('./ingest-mode.mts');
  const { mergeGoldenFiles, ingestModeGoldenPaths, partitionIngestModeItems, buildIngestFixtureDatabase } = ingestMode;

  const full = await buildIngestFixtureDatabase({
    deploymentMode: 'single-tenant',
    corpusDir: CORPUS_DIR,
    includeTypedFixtures: true,
    processEnv: { RAG_EMBEDDING_PROFILES: 'on', RAG_EVAL_SECRET: process.env.RAG_EVAL_SECRET },
    onAfterCorpusSlice: async (state: IngestFixtureBuildState) => {
      const { ingest } = await import('@/lib/rag/ingest');
      const { buildSourceKey } = await import('@/lib/rag/ingest/identity');
      for (const doc of domain.documents) {
        const result = await ingest({
          scope: state.scope,
          source: 'config_upload',
          sourceKey: buildSourceKey('config_upload', { filename: doc.filename }),
          text: doc.content,
          filename: doc.filename,
          mimeType: 'text/markdown',
          docType: doc.docType as import('@/lib/rag/ingest/profiles/load').DocType,
          signal: new AbortController().signal,
        });
        if (result.status !== 'ready') throw new Error(`[Binding Compare] domain document ${doc.relpath} ended ${result.status}`);
      }
    },
  });

  const { fixtureAdminClient } = await import('./ingest-fakes.mts');
  const { applyFixtureProcessEnv } = await import('./process-env.mts');
  const reembed = await import('../../src/lib/rag/ingest/reembed/run.ts');
  const deps = await import('../../src/lib/rag/deps');
  const edge = full.buildState.edge;
  const db = full.db as unknown as Db;
  // Reports carry the hash of everything ingested: the main ingest corpus and the domain pack.
  const corpusSha256 = sha256(full.corpusSha256 ?? '', domain.sha256);
  (full as { corpusSha256?: string }).corpusSha256 = corpusSha256;

  let inProcess: Awaited<ReturnType<(typeof import('./run-eval.mts'))['prepareInProcessEval']>> | undefined;
  try {
    applyFixtureProcessEnv({
      edgeUrl: edge.url,
      deploymentMode: 'single-tenant',
      extra: { ...ARM_ENV, RAG_EVAL_SECRET: process.env.RAG_EVAL_SECRET },
      vendorEmbeddingRoutes: true,
    });
    restoreLiveVendor();
    if (!args.live) await installFixtureEmbedders();
    deps.resetRagDepsForTests();

    const docType = args.docType;
    const candidates = docType === null ? [] : await scopedCandidates(db, docType, args.candidates);
    const { EMBEDDING_CATALOG_VERSION, catalogEntry } = await import('../../src/lib/rag/embeddings/catalog');
    const catalog: Record<string, { model: string; usd_per_million_tokens: number; supported_languages: string[] }> = {};
    for (const candidate of candidates) {
      const entry = catalogEntry(candidate.provider, candidate.model);
      if (!entry) throw new Error(`[Binding Compare] ${candidate.id}: ${candidate.provider}/${candidate.model} is not in the catalog`);
      catalog[candidate.id] = {
        model: entry.model,
        usd_per_million_tokens: entry.usdPerMillionTokens,
        supported_languages: [...entry.supportedLanguages],
      };
    }

    if (args.live) {
      let total = 0;
      for (const candidate of candidates) {
        const dry = await reembed.dryRunReembed({ db: fixtureAdminClient(edge.url), profileId: candidate.id });
        total += dry.cost.totals.usd;
        console.log(
          `[Binding Compare] dry run ${candidate.id} (${dry.model}, scope ${dry.scope?.join(',') ?? 'all'}): ` +
            `${dry.cost.totals.chunks} chunks, ${dry.cost.totals.tokens} tokens, USD ${dry.cost.totals.usd.toFixed(4)}` +
            `${dry.cost.estimated ? ' (estimate)' : ''}`,
        );
      }
      console.log(`[Binding Compare] total re-embed cost USD ${total.toFixed(4)} at catalog prices`);
      if (!args.confirmCost) {
        console.log('[Binding Compare] re-run with --confirm-cost to embed');
        return EXIT_COST_NOT_CONFIRMED;
      }
    }

    const runIds: string[] = [];
    for (const candidate of candidates) {
      const bindingId = await stageBinding(db, docType as string, candidate.id, 'backfilling');
      const report = await reembed.runReembed({
        db: fixtureAdminClient(edge.url),
        profileId: candidate.id,
        batchSize: 32,
        actor: ACTOR,
        signal: new AbortController().signal,
      });
      if (report.status !== 'completed') throw new Error(`[Binding Compare] re-embed for ${candidate.id} failed: ${report.reason ?? 'unknown'}`);
      const outOfScope = await db.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM public.chunk_embeddings e
         JOIN public.document_chunks c ON c.id = e.chunk_id JOIN public.documents d ON d.id = c.document_id
         JOIN public.embedding_profiles p ON p.id = e.profile_id
         WHERE e.profile_id = $1 AND NOT (COALESCE(c.doc_type, d.doc_type) = ANY (p.doc_types))`,
        [candidate.id],
      );
      if ((outOfScope.rows[0]?.n ?? 0) !== 0) throw new Error(`[Binding Compare] re-embed of ${candidate.id} wrote out-of-scope vectors`);
      await db.query('SELECT * FROM public.rag_set_embedding_binding_status($1, $2, $3)', [bindingId, 'available', ACTOR]);
      runIds.push(`${candidate.id}=${report.runId}`);
      console.log(`[Binding Compare] re-embedded ${candidate.id}: ${report.chunksEmbedded} chunks (run ${report.runId})`);
    }
    deps.resetRagDepsForTests();

    const goldenPath =
      args.golden ??
      (args.baselineOnly
        ? path.join(REPO_ROOT, DOMAIN_GOLDEN)
        : defaultGolden(args.outDir, mergeGoldenFiles, ingestModeGoldenPaths, partitionIngestModeItems));

    const runEvalModule = await import('./run-eval.mts');
    inProcess = await runEvalModule.prepareInProcessEval({
      corpusDir: CORPUS_DIR,
      deploymentMode: 'single-tenant',
      fixtureMode: 'ingest',
      ingestFixture: full,
      envOverrides: { ...ARM_ENV },
    });
    restoreLiveVendor();
    if (!args.live) {
      await installFixtureEmbedders();
      const floor = await import('../../src/lib/rag/refusal/floor.ts');
      floor.setEvalScoreCalibration({ context_threshold: FIXTURE_CONTEXT_THRESHOLD });
    }

    const scoreArm = async (name: string, requestOptions: EvalRequestOptions): Promise<string> => {
      const armDir = path.join(args.outDir, name);
      const result = await runEvalModule.runEval({
        goldenPath,
        corpusDir: CORPUS_DIR,
        outDir: armDir,
        deploymentMode: 'single-tenant',
        fixtureMode: 'ingest',
        requestOptions,
        tier: 'smoke',
        ingestFixture: full,
        retainInProcess: inProcess,
      });
      // Threshold-free candidate list: the similarity floor reads the global profile only (D-20), so the kept list would hide leg effects.
      const code = runPython('rag_eval.runner', [
        'score',
        '--traces',
        result.tracesPath,
        '--golden',
        goldenPath,
        '--manifest',
        result.runPath,
        '--out',
        armDir,
        '--rank-source',
        RANK_SOURCE,
      ]);
      if (code !== 0) throw new Error(`[Binding Compare] scoring failed for arm ${name}`);
      return path.join(armDir, 'report.json');
    };

    const baselineReport = await scoreArm('baseline', {});
    if (args.baselineOnly || docType === null) return EXIT_WRITTEN;
    const controlReport = await scoreArm('control', { domain_control_leg: docType });
    const candidateReports: string[] = [];
    for (const candidate of candidates) {
      const report = await scoreArm(`candidate-${candidate.id}`, { embedding_bindings: { [docType]: candidate.id } });
      candidateReports.push(`${candidate.id}=${path.relative(REPO_ROOT, report)}`);
    }

    const { rows: active } = await db.query<{ id: string }>("SELECT id FROM public.embedding_profiles WHERE status = 'active'");
    const baselineProfile = active[0]?.id;
    if (!baselineProfile || active.length !== 1) throw new Error('[Binding Compare] the fixture database has no single active global profile');

    const hashesPath = path.join(args.outDir, 'hashes.json');
    fs.writeFileSync(
      hashesPath,
      `${JSON.stringify(
        {
          corpus_sha256: corpusSha256,
          golden_sha256: fileSha256(goldenPath),
          noise_sha256: fileSha256(NOISE_PATH),
          retrieval_params_hash: fileSha256(RETRIEVAL_PARAMS_PATH),
          catalog_version: EMBEDDING_CATALOG_VERSION,
        },
        null,
        2,
      )}\n`,
    );
    const catalogPath = path.join(args.outDir, 'catalog.json');
    fs.writeFileSync(catalogPath, `${JSON.stringify(catalog, null, 2)}\n`);

    return runPython('rag_eval.binding_compare_cli', [
      '--doc-type',
      docType,
      '--baseline-profile',
      baselineProfile,
      '--baseline',
      path.relative(REPO_ROOT, baselineReport),
      '--control',
      path.relative(REPO_ROOT, controlReport),
      ...candidateReports.flatMap((entry) => ['--candidate', entry]),
      '--golden',
      goldenPath,
      '--noise',
      NOISE_PATH,
      ...runIds.flatMap((entry) => ['--reembed-run', entry]),
      '--hashes-json',
      hashesPath,
      '--catalog-json',
      catalogPath,
      ...(args.live ? [] : ['--fixture-embedder', '--note', FIXTURE_FLOOR_NOTE]),
      '--out',
      path.join(args.outDir, 'comparison.json'),
    ]);
  } finally {
    await inProcess?.close().catch(() => undefined);
    await full.db.close().catch(() => undefined);
    await full.edge?.close().catch(() => undefined);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (error: unknown) => {
      if (error instanceof UsageError) {
        console.error(`[Binding Compare] ${error.message}`);
        process.exit(EXIT_USAGE);
      }
      console.error(`[Binding Compare] FAILED: ${error instanceof Error ? error.message : String(error)}`);
      process.exit(EXIT_FAILED);
    },
  );
}
