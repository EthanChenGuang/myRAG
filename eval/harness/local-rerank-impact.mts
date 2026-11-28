/**
 * Plan 04.4-22 (D-58): which eval runs RAG_RERANK_LOCAL_STATS=tenant can change, and by how much.
 *
 *   --list [--out <file>]       classify every run config under eval/config/runs/ and every run of every committed phase spec
 *                               (eval/config/phase*.json with a "runs" array) by the reranker the app resolves for the eval, chat,
 *                               embed and voice profiles. Exits 1 when a run cannot be classified.
 *   --compare --pool <dir> --tenant <dir> --mode <fixture mode>
 *                               slice changes tenant against pool, slices beyond the noise floor, items whose top context set changed,
 *                               refusal changes and all-zero rerank items, from two finished harness run directories; one JSON row.
 *   --report --gate-runs <dir> --impact-runs <dir> --out <dir>
 *                               impact.json and impact.md for every local_bm25 configuration (exit 1 when one was not measured).
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

interface MetricCell {
  n?: number;
  value: number | null;
}

type MetricBlock = Record<string, MetricCell | null | undefined>;

interface Report {
  overall: MetricBlock;
  by_language?: Record<string, MetricBlock>;
  by_category?: Record<string, MetricBlock>;
  items: Array<{ item_id: string; refused: boolean }>;
  golden_manifest_sha256?: string;
  golden_set_version?: number;
}

interface TraceRow {
  item_id: string;
  kept?: Array<{ chunk_id: string }>;
  candidates?: Array<{ chunk_id: string; rerank_score: number | null }>;
}

const NOISE = path.join(REPO_ROOT, 'eval/config/noise.json');
/** The slice rule of the pinned Phase 4.4 spec (no_slice_drop_rule v2). */
const MIN_GATE_N = 10;

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

function slicesOf(report: Report): Map<string, MetricBlock> {
  const out = new Map<string, MetricBlock>([['overall', report.overall]]);
  for (const [key, block] of Object.entries(report.by_language ?? {})) out.set(`language:${key}`, block);
  for (const [key, block] of Object.entries(report.by_category ?? {})) out.set(`category:${key}`, block);
  return out;
}

/** Items whose reranked candidates all scored 0 (every raw score at or below 0, so the pool maximum normalizes them to 0). */
export function allZeroItems(traces: Map<string, TraceRow>): { items: number; all_zero: number } {
  let items = 0;
  let zero = 0;
  for (const row of traces.values()) {
    const scores = (row.candidates ?? []).map((c) => c.rerank_score).filter((v): v is number => typeof v === 'number');
    if (scores.length === 0) continue;
    items += 1;
    if (scores.every((v) => v === 0)) zero += 1;
  }
  return { items, all_zero: zero };
}

export interface ImpactComparison {
  fixture_mode: string;
  items: number;
  overall: Array<{ metric: string; pool: number | null; tenant: number | null }>;
  slices_changed: number;
  slices_beyond_band: string[];
  top_context_changed: number;
  refusal_changed: number;
  all_zero_rerank: { pool: number; tenant: number; items: number };
  golden_manifest_sha256: string | null;
}

export function compareRuns(poolDir: string, tenantDir: string, fixtureMode: string): ImpactComparison {
  const pool = readJson(path.join(poolDir, 'report.json')) as Report;
  const tenant = readJson(path.join(tenantDir, 'report.json')) as Report;
  const noise = readJson(NOISE) as { floor: number; metrics: Record<string, 'higher' | 'lower'> };
  const poolSlices = slicesOf(pool);
  let changed = 0;
  const beyond: string[] = [];
  for (const [slice, block] of slicesOf(tenant)) {
    const before = poolSlices.get(slice);
    for (const [metric, direction] of Object.entries(noise.metrics)) {
      const a = block?.[metric];
      const b = before?.[metric];
      if (!a || !b || a.value === null || b.value === null) continue;
      if (a.value !== b.value) changed += 1;
      const worse = direction === 'higher' ? b.value - a.value : a.value - b.value;
      if (worse > noise.floor && (a.n ?? 0) >= MIN_GATE_N) beyond.push(`${slice}:${metric} ${b.value.toFixed(4)} -> ${a.value.toFixed(4)} (n ${a.n})`);
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
  const zeroPool = allZeroItems(poolTraces);
  const zeroTenant = allZeroItems(tenantTraces);
  return {
    fixture_mode: fixtureMode,
    items: tenant.items.length,
    overall: ['recall_at_5', 'recall_at_10', 'mrr', 'correct_refusal_rate', 'false_refusal_rate'].map((metric) => ({
      metric,
      pool: pool.overall[metric]?.value ?? null,
      tenant: tenant.overall[metric]?.value ?? null,
    })),
    slices_changed: changed,
    slices_beyond_band: beyond,
    top_context_changed: topChanged,
    refusal_changed: refusalChanged,
    all_zero_rerank: { pool: zeroPool.all_zero, tenant: zeroTenant.all_zero, items: zeroTenant.items },
    golden_manifest_sha256: tenant.golden_manifest_sha256 ?? null,
  };
}

// ---------- the impact report

const PIN_ENV = (): Record<string, string> => stringRecord(readJson(EVAL_ENV));

/** Runs grouped by their effective configuration (environment without values equal to the eval pin, overrides, entry profile). */
export async function groupedRuns(): Promise<Array<{ key: string; index: number; rep: string; runs: ClassifiedRun[] }>> {
  const pin = PIN_ENV();
  const groups = new Map<string, { key: string; index: number; rep: string; runs: ClassifiedRun[] }>();
  for (const run of discoverRuns()) {
    const classified = await classifyRun(run);
    if (classified.classification !== 'local_bm25') continue;
    const env = Object.fromEntries(Object.entries(run.env).filter(([k, v]) => pin[k] !== v).sort());
    const key = JSON.stringify([env, run.overrides, run.entryProfile]);
    let group = groups.get(key);
    if (!group) {
      group = { key, index: groups.size, rep: run.source, runs: [] };
      groups.set(key, group);
    }
    if (!group.rep.startsWith('eval/config/runs/') && run.source.startsWith('eval/config/runs/')) group.rep = run.source;
    group.runs.push(classified);
  }
  return [...groups.values()];
}

/** Where a group's two arms were run: the gate's own arms for the gate's configurations, else <impact>/gNN-<arm>-<mode>. */
function armDirs(rep: string, index: number, mode: string, gateRoot: string, impactRoot: string): { pool: string; tenant: string } | null {
  const gate: Record<string, string> = {
    'eval/config/runs/v2-default.json': 'v2-default',
    'eval/config/runs/v2-lexical-bm25-on.json': 'v2-bm25',
    'eval/config/phase44-local-rerank-stats-comparison.json#voice-pool-prechunked': 'voice',
  };
  const tag = gate[rep];
  if (tag) {
    if (tag === 'voice' && mode !== 'prechunked') return null;
    return { pool: path.join(gateRoot, `${tag}-pool-${mode}`), tenant: path.join(gateRoot, `${tag}-tenant-${mode}`) };
  }
  const key = `g${String(index).padStart(2, '0')}`;
  return { pool: path.join(impactRoot, `${key}-pool-${mode}`), tenant: path.join(impactRoot, `${key}-tenant-${mode}`) };
}

export async function impactReport(gateRoot: string, impactRoot: string): Promise<Record<string, unknown>> {
  const classified: ClassifiedRun[] = [];
  for (const run of discoverRuns()) classified.push(await classifyRun(run));
  const groups = await groupedRuns();
  const measured: Record<string, unknown>[] = [];
  for (const group of groups) {
    const evalProvider = group.runs[0]?.providers.eval;
    const entry = group.runs[0]?.entry_profile;
    const base = { group: group.index, representative: group.rep, sources: group.runs.map((run) => run.source) };
    if (group.rep.endsWith('-local-stats-tenant.json')) {
      measured.push({ ...base, status: 'is_tenant_arm', note: 'the tenant arm of the gate itself (phase44-local-rerank-stats-comparison.json)' });
      continue;
    }
    if (entry !== 'voice' && evalProvider !== 'local_bm25') {
      measured.push({ ...base, status: 'voice_profile_only', note: `eval profile reranker ${evalProvider}; only the voice profile resolves to local_bm25, measured by the gate's voice arm` });
      continue;
    }
    const modes: ImpactComparison[] = [];
    const missing: string[] = [];
    for (const mode of ['prechunked', 'ingest']) {
      const dirs = armDirs(group.rep, group.index, mode, gateRoot, impactRoot);
      if (!dirs) continue;
      if (!fs.existsSync(path.join(dirs.pool, 'report.json')) || !fs.existsSync(path.join(dirs.tenant, 'report.json'))) {
        missing.push(mode);
        continue;
      }
      modes.push(compareRuns(dirs.pool, dirs.tenant, mode));
    }
    measured.push({ ...base, status: missing.length === 0 ? 'measured' : 'not_measured', ...(missing.length ? { missing_modes: missing } : {}), modes });
  }
  return {
    schema_version: 1,
    stale_refusal_cells: staleCells(),
    counts: {
      runs: classified.length,
      local_bm25: classified.filter((run) => run.classification === 'local_bm25').length,
      not_affected: classified.filter((run) => run.classification === 'not_affected').length,
      groups: groups.length,
    },
    runs: classified,
    groups: measured,
  };
}

export function impactMarkdown(report: Record<string, unknown>): string {
  const counts = report.counts as Record<string, number>;
  const groups = report.groups as Array<Record<string, unknown>>;
  const lines = [
    '# RAG_RERANK_LOCAL_STATS=tenant: impact on every keyless v2 run (plan 04.4-22, D-58)',
    '',
    `Runs classified: ${counts.runs} (${counts.local_bm25} resolve to local_bm25 for at least one profile, ${counts.not_affected} not affected); ${counts.groups} effective configurations among the local_bm25 runs. Refusal cells that go stale: ${String(report.stale_refusal_cells)} (no cell is keyed to local_bm25, and local_bm25 scores are relative, so no cell applies in either mode).`,
    '',
    'Each row compares the tenant arm with the pool arm of the same run configuration (ids, counts and metric values only). "Beyond band" uses the noise floor with n at least 10, as the pinned Phase 4.4 slice rule; it is reported here, not gated.',
    '',
    '| Group | Representative | Runs | Mode | Recall@10 pool → tenant | Slices changed | Beyond band | Top context changed | Refusal changed | All-zero rerank pool / tenant |',
    '| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |',
  ];
  for (const group of groups) {
    const sources = (group.sources as string[]).length;
    if (group.status !== 'measured') {
      lines.push(`| ${String(group.group)} | \`${String(group.representative)}\` | ${sources} | — | ${String(group.status)}: ${String(group.note ?? (group.missing_modes as string[] | undefined)?.join(', ') ?? '')} | | | | | |`);
      continue;
    }
    for (const mode of group.modes as ImpactComparison[]) {
      const r10 = mode.overall.find((m) => m.metric === 'recall_at_10');
      const fmt = (v: number | null | undefined) => (v === null || v === undefined ? '—' : v.toFixed(4));
      lines.push(
        `| ${String(group.group)} | \`${String(group.representative)}\` | ${sources} | ${mode.fixture_mode} | ${fmt(r10?.pool)} → ${fmt(r10?.tenant)} | ${mode.slices_changed} | ${mode.slices_beyond_band.length ? mode.slices_beyond_band.join('; ') : 'none'} | ${mode.top_context_changed} of ${mode.items} | ${mode.refusal_changed} | ${mode.all_zero_rerank.pool} / ${mode.all_zero_rerank.tenant} of ${mode.all_zero_rerank.items} |`,
      );
    }
  }
  lines.push('', 'Not affected runs and the reason for each are listed in impact.json (`runs`, classification `not_affected`).', '');
  return lines.join('\n');
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
      report: { type: 'boolean' },
      out: { type: 'string' },
      pool: { type: 'string' },
      tenant: { type: 'string' },
      mode: { type: 'string' },
      'gate-runs': { type: 'string' },
      'impact-runs': { type: 'string' },
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
    if (!values.pool || !values.tenant || !values.mode) {
      console.error('usage: --compare --pool <dir> --tenant <dir> --mode <fixture mode>');
      return 2;
    }
    process.stdout.write(`${JSON.stringify(compareRuns(values.pool, values.tenant, values.mode))}\n`);
    return 0;
  }
  if (values.report) {
    if (!values['gate-runs'] || !values['impact-runs'] || !values.out) {
      console.error('usage: --report --gate-runs <dir> --impact-runs <dir> --out <dir>');
      return 2;
    }
    const report = await impactReport(path.resolve(values['gate-runs']), path.resolve(values['impact-runs']));
    const out = path.resolve(values.out);
    fs.mkdirSync(out, { recursive: true });
    fs.writeFileSync(path.join(out, 'impact.json'), `${JSON.stringify(report, null, 2)}\n`);
    fs.writeFileSync(path.join(out, 'impact.md'), impactMarkdown(report));
    const groups = report.groups as Array<{ status: string }>;
    const notMeasured = groups.filter((g) => g.status === 'not_measured').length;
    console.error(`[Local Rerank Impact] ${groups.length} groups, ${notMeasured} not measured`);
    return notMeasured === 0 ? 0 : 1;
  }
  console.error('usage: local-rerank-impact.mts --list [--out <file>] | --compare ... | --report --gate-runs <dir> --impact-runs <dir> --out <dir>');
  return 2;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exit(await main());
}
