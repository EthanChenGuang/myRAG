/**
 * Plan 04.4-22 (D-58): which eval runs RAG_RERANK_LOCAL_STATS=tenant can change, and by how much.
 *
 *   --list [--out <file>]       classify every run config under eval/config/runs/ and every run of every committed phase spec
 *                               (eval/config/phase*.json with a "runs" array) by the reranker the app resolves for the eval, chat,
 *                               embed and voice profiles. Exits 1 when a run cannot be classified.
 *   --compare --name <run> --pool <dir> --tenant <dir> [--mode <fixture mode>]
 *                               paired differences tenant against pool per slice, items whose top context set changed, refusal changes
 *                               and the refusal cells that go stale, from two finished harness run directories; prints one JSON row.
 *
 * The classification calls the app's own resolver (describeReranker under loadRagConfig), never a copy of its rule. Output holds ids,
 * names, counts and metric values only: no query, chunk or lexeme text.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const RUNS_DIR = path.join(REPO_ROOT, 'eval/config/runs');
const CONFIG_DIR = path.join(REPO_ROOT, 'eval/config');
const EVAL_ENV = path.join(REPO_ROOT, 'eval/config/rag-eval-env.json');
const THRESHOLDS = path.join(REPO_ROOT, 'eval/config/refusal-thresholds.json');
export const PROFILES = ['eval', 'chat', 'embed', 'voice'] as const;
type ImpactProfile = (typeof PROFILES)[number];

export type Classification = 'local_bm25' | 'not_affected';

export interface ClassifiedRun {
  source: string;
  name: string;
  classification: Classification;
  reasons: string[];
  providers: Record<ImpactProfile, string>;
  entry_profile: 'eval' | 'voice';
}

interface RawRun {
  name?: unknown;
  base?: unknown;
  env?: unknown;
  overrides?: unknown;
  entry_profile?: unknown;
}

function readJson(file: string): unknown {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function stringRecord(value: unknown): Record<string, string> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, v]) => [key, String(v)]));
}

function rel(file: string): string {
  return path.relative(REPO_ROOT, file).split(path.sep).join('/');
}

/** A run as the harness sees it: the eval pin, then the base run config, then the spec's own env. */
interface ResolvedRun {
  source: string;
  name: string;
  env: Record<string, string>;
  overrides: Record<string, unknown> | null;
  entryProfile: 'eval' | 'voice';
}

function runConfigFile(file: string): ResolvedRun {
  const raw = readJson(file) as RawRun;
  if (typeof raw.name !== 'string') throw new Error(`${rel(file)}: no name`);
  return {
    source: rel(file),
    name: raw.name,
    env: stringRecord(raw.env),
    overrides: raw.overrides && typeof raw.overrides === 'object' ? (raw.overrides as Record<string, unknown>) : null,
    entryProfile: raw.entry_profile === 'voice' ? 'voice' : 'eval',
  };
}

function specRuns(file: string): ResolvedRun[] {
  const spec = readJson(file) as { runs?: unknown; off_env?: unknown };
  if (!Array.isArray(spec.runs)) return [];
  const offEnv = stringRecord(spec.off_env);
  return spec.runs.map((value, index) => {
    const run = value as RawRun & { phase44_off?: unknown; phase42_off?: unknown };
    const name = typeof run.name === 'string' ? run.name : `#${index}`;
    const base = typeof run.base === 'string' && run.base !== '' ? runConfigFile(path.join(REPO_ROOT, run.base)) : null;
    const off = run.phase44_off === true || run.phase42_off === true ? offEnv : {};
    return {
      source: `${rel(file)}#${name}`,
      name,
      env: { ...(base?.env ?? {}), ...off, ...stringRecord(run.env) },
      overrides: base?.overrides ?? null,
      entryProfile: base?.entryProfile ?? 'eval',
    };
  });
}

/** Every run config under eval/config/runs/ and every run of every committed phase spec, in a stable order. */
export function discoverRuns(): ResolvedRun[] {
  const runs = fs
    .readdirSync(RUNS_DIR)
    .filter((name) => name.endsWith('.json'))
    .sort()
    .map((name) => runConfigFile(path.join(RUNS_DIR, name)));
  const specs = fs
    .readdirSync(CONFIG_DIR)
    .filter((name) => /^phase.*\.json$/.test(name))
    .sort()
    .flatMap((name) => specRuns(path.join(CONFIG_DIR, name)));
  return [...runs, ...specs];
}

export async function classifyRun(run: ResolvedRun): Promise<ClassifiedRun> {
  const { loadRagConfig, resetRagConfigForTests } = await import('../../src/lib/rag/config.ts');
  const { describeReranker } = await import('../../src/lib/rag/rerank/select.ts');
  const pin = stringRecord(readJson(EVAL_ENV));
  resetRagConfigForTests();
  const config = loadRagConfig({ ...pin, ...run.env });
  const overrides = (run.overrides ?? undefined) as Parameters<typeof describeReranker>[3];
  const providers = Object.fromEntries(
    PROFILES.map((profile) => [profile, config.pipeline === 'v2' ? describeReranker(config, profile, 'en', overrides).id : 'legacy_pipeline']),
  ) as Record<ImpactProfile, string>;
  const reasons: string[] = [];
  if (config.pipeline !== 'v2') reasons.push('legacy_pipeline: no v2 rerank stage');
  const configured = config.v2.reranker;
  const local = PROFILES.filter((profile) => providers[profile] === 'local_bm25');
  if (local.length > 0) {
    if (configured === 'local_bm25') reasons.push('explicit: RAG_RERANKER=local_bm25');
    else if (configured === 'auto' && !config.v2.hasCohereKey) reasons.push('auto_without_key: RAG_RERANKER=auto with an empty COHERE_API_KEY');
    else if (configured === 'auto') reasons.push(`auto: local_bm25 for ${local.join(', ')} (no hosted reranker for that profile)`);
    else reasons.push(`eval override: local_bm25 for ${local.join(', ')}`);
    if (run.entryProfile === 'voice') reasons.push('voice entry run');
  } else if (config.pipeline === 'v2') {
    reasons.push(`reranker ${[...new Set(PROFILES.map((p) => providers[p]))].join(', ')} for every profile`);
  }
  return {
    source: run.source,
    name: run.name,
    classification: local.length > 0 ? 'local_bm25' : 'not_affected',
    reasons,
    providers,
    entry_profile: run.entryProfile,
  };
}

// ---------- comparison of two finished run directories

interface SliceMetricValue {
  value: number | null;
  n?: number;
}

interface Report {
  overall: Record<string, SliceMetricValue | number | null>;
  slices?: Record<string, Record<string, SliceMetricValue | number | null>>;
  items: Array<{ item_id: string; refused: boolean }>;
}

interface TraceRow {
  item_id: string;
  kept?: Array<{ chunk_id: string }>;
  candidates?: Array<{ chunk_id: string; rerank_score: number | null }>;
}

const SLICE_METRICS = ['recall_at_5', 'recall_at_10', 'mrr', 'correct_refusal_rate', 'false_refusal_rate'];

function metricValue(value: SliceMetricValue | number | null | undefined): number | null {
  if (value === null || value === undefined) return null;
  return typeof value === 'number' ? value : value.value;
}

function readTraces(dir: string): Map<string, TraceRow> {
  const file = path.join(dir, 'traces.jsonl');
  const out = new Map<string, TraceRow>();
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    if (line.trim() === '') continue;
    const row = JSON.parse(line) as TraceRow;
    out.set(row.item_id, row);
  }
  return out;
}

function staleCells(): number {
  const data = readJson(THRESHOLDS) as { cells?: Array<{ provider?: string }> };
  return (data.cells ?? []).filter((cell) => cell.provider === 'local_bm25').length;
}

export interface ImpactComparison {
  name: string;
  fixture_mode: string | null;
  slices: Array<{ slice: string; metric: string; pool: number | null; tenant: number | null; delta: number | null }>;
  items: number;
  top_context_changed: number;
  refusal_changed: number;
  stale_refusal_cells: number;
}

export function compareRuns(name: string, poolDir: string, tenantDir: string, fixtureMode: string | null): ImpactComparison {
  const pool = readJson(path.join(poolDir, 'report.json')) as Report;
  const tenant = readJson(path.join(tenantDir, 'report.json')) as Report;
  const sliceNames = ['overall', ...Object.keys(tenant.slices ?? {}).sort()];
  const slices: ImpactComparison['slices'] = [];
  for (const slice of sliceNames) {
    const a = slice === 'overall' ? pool.overall : pool.slices?.[slice];
    const b = slice === 'overall' ? tenant.overall : tenant.slices?.[slice];
    for (const metric of SLICE_METRICS) {
      const p = metricValue(a?.[metric]);
      const t = metricValue(b?.[metric]);
      const delta = p === null || t === null ? null : t - p;
      if (slice === 'overall' || (delta !== null && delta !== 0)) slices.push({ slice, metric, pool: p, tenant: t, delta });
    }
  }
  const poolTraces = readTraces(poolDir);
  const tenantTraces = readTraces(tenantDir);
  let topChanged = 0;
  for (const [id, row] of tenantTraces) {
    const before = (poolTraces.get(id)?.kept ?? []).map((c) => c.chunk_id).sort().join(',');
    const after = (row.kept ?? []).map((c) => c.chunk_id).sort().join(',');
    if (before !== after) topChanged += 1;
  }
  const refusedBefore = new Map(pool.items.map((item) => [item.item_id, item.refused]));
  const refusalChanged = tenant.items.filter((item) => refusedBefore.has(item.item_id) && refusedBefore.get(item.item_id) !== item.refused).length;
  return {
    name,
    fixture_mode: fixtureMode,
    slices,
    items: tenant.items.length,
    top_context_changed: topChanged,
    refusal_changed: refusalChanged,
    stale_refusal_cells: staleCells(),
  };
}

/**
 * Inversions among the candidates two runs share, per item (gate (c) of the 04.4-22 spec computes the same in Python): a pair of chunks
 * ordered strictly by rerank score in one run and strictly the other way in the other. Ties are not orderings.
 */
export function rerankInversions(a: Map<string, TraceRow>, b: Map<string, TraceRow>): { items: number; pairs: number; inversions: number } {
  let items = 0;
  let pairs = 0;
  let inversions = 0;
  for (const [id, rowA] of a) {
    const rowB = b.get(id);
    if (!rowB) continue;
    const scoreA = new Map((rowA.candidates ?? []).filter((c) => typeof c.rerank_score === 'number').map((c) => [c.chunk_id, c.rerank_score as number]));
    const scoreB = new Map((rowB.candidates ?? []).filter((c) => typeof c.rerank_score === 'number').map((c) => [c.chunk_id, c.rerank_score as number]));
    const common = [...scoreA.keys()].filter((key) => scoreB.has(key)).sort();
    if (common.length < 2) continue;
    items += 1;
    for (let i = 0; i < common.length; i += 1) {
      for (let j = i + 1; j < common.length; j += 1) {
        const x = common[i] as string;
        const y = common[j] as string;
        const da = (scoreA.get(x) as number) - (scoreA.get(y) as number);
        const db = (scoreB.get(x) as number) - (scoreB.get(y) as number);
        if (da === 0 || db === 0) continue;
        pairs += 1;
        if (Math.sign(da) !== Math.sign(db)) inversions += 1;
      }
    }
  }
  return { items, pairs, inversions };
}

export { readTraces };

async function main(): Promise<number> {
  const { values } = parseArgs({
    options: {
      list: { type: 'boolean' },
      compare: { type: 'boolean' },
      out: { type: 'string' },
      name: { type: 'string' },
      pool: { type: 'string' },
      tenant: { type: 'string' },
      mode: { type: 'string' },
    },
  });
  if (values.list) {
    const classified: ClassifiedRun[] = [];
    const failures: string[] = [];
    for (const run of discoverRuns()) {
      try {
        classified.push(await classifyRun(run));
      } catch (error) {
        failures.push(`${run.source}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    const report = {
      schema_version: 1,
      runs: classified,
      counts: {
        local_bm25: classified.filter((run) => run.classification === 'local_bm25').length,
        not_affected: classified.filter((run) => run.classification === 'not_affected').length,
        unclassified: failures.length,
      },
      unclassified: failures,
    };
    const text = `${JSON.stringify(report, null, 2)}\n`;
    if (values.out) fs.writeFileSync(path.resolve(values.out), text);
    else process.stdout.write(text);
    console.error(`[Local Rerank Impact] ${report.counts.local_bm25} local_bm25, ${report.counts.not_affected} not affected, ${failures.length} unclassified`);
    return failures.length === 0 ? 0 : 1;
  }
  if (values.compare) {
    if (!values.name || !values.pool || !values.tenant) {
      console.error('usage: --compare --name <run> --pool <dir> --tenant <dir> [--mode <fixture mode>]');
      return 2;
    }
    process.stdout.write(`${JSON.stringify(compareRuns(values.name, values.pool, values.tenant, values.mode ?? null))}\n`);
    return 0;
  }
  console.error('usage: local-rerank-impact.mts --list [--out <file>] | --compare --name <run> --pool <dir> --tenant <dir> [--mode <mode>]');
  return 2;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exit(await main());
}
