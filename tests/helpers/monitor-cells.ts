import type { MonitorDailyCell } from '@/lib/rag-eval/contracts.generated';
import { LATENCY_BIN_EDGES_MS, TOP_SCORE_BINS } from '@/lib/rag/monitor/stats';

export const TENANT_A = 'u:00000000-0000-4000-8000-00000000000a';
export const TENANT_B = 'u:00000000-0000-4000-8000-00000000000b';

type CountField =
  | 'refused'
  | 'kb_unavailable'
  | 'degraded'
  | 'error'
  | 'zero_result'
  | 'below_threshold'
  | 'helpful'
  | 'not_helpful'
  | 'judged'
  | 'groundedness_flagged';

type PerDay<T> = T | ((dayIndex: number) => T);

export interface TopScoreSeed {
  /** Centre of the score distribution, 0 to 1. */
  center: number;
  rows: number;
}

export interface CellSeed {
  tenantKey?: string;
  language?: string;
  ragMode?: MonitorDailyCell['rag_mode'];
  channel?: MonitorDailyCell['channel'];
  docType?: string;
  /** YYYY-MM-DD of day index 1. */
  firstDay: string;
  days: number;
  rows: PerDay<number>;
  /** Share of `rows`, rounded to the nearest count. */
  rates?: Partial<Record<Exclude<CountField, 'helpful' | 'not_helpful' | 'judged'>, PerDay<number>>>;
  /** Absolute counts per day. */
  counts?: Partial<Record<CountField, PerDay<number>>>;
  /** Mean judge score per metric for the judged rows. */
  judgeMeans?: Record<string, PerDay<number>>;
  topScore?: Partial<Record<'rerank' | 'similarity', PerDay<TopScoreSeed>>>;
  /** Index into LATENCY_BIN_EDGES_MS bins holding every latency row of the day; defaults to bin 3. */
  latencyBin?: PerDay<number>;
  /** Latency rows per day; defaults to `rows`. */
  latencyRows?: PerDay<number>;
}

function at<T>(value: PerDay<T>, dayIndex: number): T {
  return typeof value === 'function' ? (value as (i: number) => T)(dayIndex) : value;
}

export function dayOf(firstDay: string, dayIndex: number): string {
  const date = new Date(`${firstDay}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + dayIndex - 1);
  return date.toISOString().slice(0, 10);
}

const SPREAD = [1, 2, 3, 4, 3, 2, 1];

/** A deterministic peaked histogram over the twenty score bins centred on `center`. */
export function scoreHistogram(seed: TopScoreSeed): { bins: number[]; underflow: number; overflow: number } {
  const bins = new Array<number>(TOP_SCORE_BINS).fill(0);
  const centre = Math.min(TOP_SCORE_BINS - 1, Math.max(0, Math.floor(seed.center * TOP_SCORE_BINS)));
  const weight = SPREAD.reduce((a, b) => a + b, 0);
  let placed = 0;
  SPREAD.forEach((w, offset) => {
    const bin = Math.min(TOP_SCORE_BINS - 1, Math.max(0, centre + offset - 3));
    const count = Math.floor((seed.rows * w) / weight);
    bins[bin] += count;
    placed += count;
  });
  bins[centre] += seed.rows - placed;
  return { bins, underflow: 0, overflow: 0 };
}

/** Builds one cell per day from seeded rates and histograms; the same seed always gives the same cells. */
export function buildDailyCells(seed: CellSeed): MonitorDailyCell[] {
  const cells: MonitorDailyCell[] = [];
  for (let i = 1; i <= seed.days; i += 1) {
    const rows = at(seed.rows, i);
    const count = (field: CountField): number => {
      const absolute = seed.counts?.[field];
      if (absolute !== undefined) return at(absolute, i);
      const rate = (seed.rates as Record<string, PerDay<number>> | undefined)?.[field];
      return rate !== undefined ? Math.round(at(rate, i) * rows) : 0;
    };
    const judged = count('judged');
    const judgeSums: Record<string, number> = {};
    for (const [metric, mean] of Object.entries(seed.judgeMeans ?? {})) judgeSums[metric] = at(mean, i) * judged;
    const latency = new Array<number>(LATENCY_BIN_EDGES_MS.length + 1).fill(0);
    latency[at(seed.latencyBin ?? 3, i)] = at(seed.latencyRows ?? rows, i);
    const topScore: MonitorDailyCell['top_score_hist'] = {};
    for (const kind of ['rerank', 'similarity'] as const) {
      const spec = seed.topScore?.[kind];
      if (spec !== undefined) topScore[kind] = scoreHistogram(at(spec, i));
    }
    cells.push({
      tenant_key: seed.tenantKey ?? TENANT_A,
      day: dayOf(seed.firstDay, i),
      language: seed.language ?? 'it',
      rag_mode: seed.ragMode ?? 'strict',
      channel: seed.channel ?? 'chat',
      doc_type: seed.docType ?? 'generic',
      retrievals: rows,
      refused: count('refused'),
      kb_unavailable: count('kb_unavailable'),
      degraded: count('degraded'),
      error: count('error'),
      zero_result: count('zero_result'),
      below_threshold: count('below_threshold'),
      helpful: count('helpful'),
      not_helpful: count('not_helpful'),
      judged,
      judge_score_sums: judgeSums,
      groundedness_flagged: count('groundedness_flagged'),
      top_score_hist: topScore,
      latency_hist: { bins: latency },
    });
  }
  return cells;
}
