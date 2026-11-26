import { createHash } from 'node:crypto';

/** The query surface of a PGlite database (or any client with the same shape). */
export interface SeedDb {
  query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<{ rows: T[] }>;
}

export type SeedChannel = 'chat' | 'embed' | 'voice';
export type SeedRagMode = 'strict' | 'balanced' | 'flexible' | 'bypass';
export type SeedScoreKind = 'rerank' | 'similarity';

/**
 * Exact counts of one cell. The row kinds refused, error, degraded and zeroResult are disjoint; belowThreshold is a subset of
 * refused (refusal reason below_threshold, the rest below_similarity_floor) and kbUnavailable a subset of error (status error,
 * outcome kb_unavailable). Votes, groundedness flags and judge scores are spread over the rows independently of the kind.
 */
export interface SeedCounts {
  refused?: number;
  belowThreshold?: number;
  error?: number;
  kbUnavailable?: number;
  degraded?: number;
  zeroResult?: number;
  helpful?: number;
  notHelpful?: number;
  groundednessFlagged?: number;
  judged?: number;
}

export interface SeedDistribution {
  mean: number;
  spread: number;
}

export interface SeedCell {
  tenantKey: string;
  /** UTC day, YYYY-MM-DD. */
  day: string;
  /** A language code, or null for an undetected language. */
  language: string | null;
  ragMode: SeedRagMode | null;
  channel: SeedChannel;
  rows: number;
  counts?: SeedCounts;
  /** Top kept candidate score per row with candidates; kind rerank adds a rerank_score. Default similarity 0.7 +/- 0.1. */
  topScore?: SeedDistribution & { kind: SeedScoreKind };
  /** Default 400 ms +/- 200 ms. */
  latencyMs?: SeedDistribution;
  retrievalConfigHash?: string | null;
  /** doc_type of the document behind every kept candidate of the cell; default general. */
  docType?: string;
  /** Online judge scores of a judged row; default faithfulness 0.75, answer_relevance 0.5. */
  judgeScores?: { faithfulness: number; answer_relevance: number };
  /** Seconds after 00:00:00 UTC of the day for the first row; rows follow one second apart. Default 3600. */
  startSecond?: number;
}

export interface SeedSpec {
  /** Every random draw derives from this string: the same spec gives the same rows. */
  seed: string;
  cells: readonly SeedCell[];
  /** First trace number; trace ids are trace-<n>. Default 1. */
  firstTrace?: number;
}

export interface SeededRow {
  traceId: string;
  cellIndex: number;
  tenantKey: string;
  createdAt: string;
  kind: 'answered' | 'refused' | 'below_threshold' | 'error' | 'kb_unavailable' | 'degraded' | 'zero_result';
  vote: 1 | -1 | null;
  groundednessFlagged: boolean;
  judged: boolean;
  scoreKind: SeedScoreKind | null;
  score: number | null;
  latencyMs: number;
  documentId: string | null;
}

export interface SeedResult {
  rows: SeededRow[];
  nextTrace: number;
}

/** The exact count for a rate of a total: round half up, so seedRate(total, rate) / total is the closest share. */
export function seedRate(total: number, rate: number): number {
  if (!Number.isInteger(total) || total < 0) throw new Error(`[Seed] total must be a non-negative integer: ${total}`);
  if (!Number.isFinite(rate) || rate < 0 || rate > 1) throw new Error(`[Seed] rate must be within 0 and 1: ${rate}`);
  return Math.floor(total * rate + 0.5);
}

/** mulberry32 seeded from sha256(seed, salt), the same generator as the backfill sampler. */
function seededRandom(seed: string, salt: string): () => number {
  let state = createHash('sha256').update(seed).update('\u0000').update(salt).digest().readUInt32LE(0);
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A UUID derived from the seed and a name, so seeded ids are stable across runs. */
export function seedUuid(seed: string, name: string): string {
  const hex = createHash('sha256').update(seed).update('\u0000').update(name).digest('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

function shuffle<T>(items: T[], random: () => number): T[] {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i -= 1) {
    const j = Math.floor(random() * (i + 1));
    [out[i], out[j]] = [out[j] as T, out[i] as T];
  }
  return out;
}

/** Rounded to 4 decimals so the stored number has an exact decimal form. */
function draw(random: () => number, distribution: SeedDistribution): number {
  return Math.round((distribution.mean + (random() * 2 - 1) * distribution.spread) * 10000) / 10000;
}

function count(value: number | undefined, name: string, cellIndex: number): number {
  const n = value ?? 0;
  if (!Number.isInteger(n) || n < 0) throw new Error(`[Seed] cell ${cellIndex}: ${name} must be a non-negative integer`);
  return n;
}

const TENANT_KEY = /^(s:default|[uo]:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/;
const DAY = /^\d{4}-\d{2}-\d{2}$/;

function rowKinds(cell: SeedCell, cellIndex: number): SeededRow['kind'][] {
  const c = cell.counts ?? {};
  const refused = count(c.refused, 'refused', cellIndex);
  const belowThreshold = count(c.belowThreshold, 'belowThreshold', cellIndex);
  const error = count(c.error, 'error', cellIndex);
  const kbUnavailable = count(c.kbUnavailable, 'kbUnavailable', cellIndex);
  const degraded = count(c.degraded, 'degraded', cellIndex);
  const zeroResult = count(c.zeroResult, 'zeroResult', cellIndex);
  if (belowThreshold > refused) throw new Error(`[Seed] cell ${cellIndex}: belowThreshold exceeds refused`);
  if (kbUnavailable > error) throw new Error(`[Seed] cell ${cellIndex}: kbUnavailable exceeds error`);
  const special = refused + error + degraded + zeroResult;
  if (special > cell.rows) throw new Error(`[Seed] cell ${cellIndex}: refused, error, degraded and zeroResult exceed rows`);
  return [
    ...Array<SeededRow['kind']>(belowThreshold).fill('below_threshold'),
    ...Array<SeededRow['kind']>(refused - belowThreshold).fill('refused'),
    ...Array<SeededRow['kind']>(kbUnavailable).fill('kb_unavailable'),
    ...Array<SeededRow['kind']>(error - kbUnavailable).fill('error'),
    ...Array<SeededRow['kind']>(degraded).fill('degraded'),
    ...Array<SeededRow['kind']>(zeroResult).fill('zero_result'),
    ...Array<SeededRow['kind']>(cell.rows - special).fill('answered'),
  ];
}

function flags(total: number, n: number, random: () => number): boolean[] {
  return shuffle(
    Array.from({ length: total }, (_, i) => i < n),
    random,
  );
}

async function hasColumn(db: SeedDb, table: string, column: string): Promise<boolean> {
  const result = await db.query<{ present: boolean }>(
    "SELECT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = $1 AND column_name = $2) AS present",
    [table, column],
  );
  return result.rows[0]?.present === true;
}

interface TenantOwner {
  userId: string;
  organizationId: string | null;
}

async function ensureOwner(db: SeedDb, seed: string, tenantKey: string): Promise<TenantOwner> {
  const [prefix, id] = tenantKey.split(':') as [string, string];
  const userId = prefix === 'u' ? id : seedUuid(seed, `owner:${tenantKey}`);
  await db.query('INSERT INTO auth.users (id, email) VALUES ($1, $2) ON CONFLICT (id) DO NOTHING', [userId, `seed-${userId.slice(0, 8)}@example.invalid`]);
  if (prefix !== 'o') return { userId, organizationId: null };
  await db.query(
    'INSERT INTO public.organizations (id, name, slug, owner_id) VALUES ($1, $2, $3, $4) ON CONFLICT (id) DO NOTHING',
    [id, `seed-org-${id.slice(0, 8)}`, `seed-org-${id}`, userId],
  );
  return { userId, organizationId: id };
}

async function ensureDocument(db: SeedDb, seed: string, tenantKey: string, owner: TenantOwner, docType: string): Promise<string> {
  const id = seedUuid(seed, `document:${tenantKey}:${docType}`);
  const columns: [string, unknown][] = [
    ['id', id],
    ['filename', `seed-${docType}.txt`],
    ['content', 'seed document'],
  ];
  if (await hasColumn(db, 'documents', 'user_id')) columns.push(['user_id', owner.userId]);
  if (owner.organizationId) columns.push(['organization_id', owner.organizationId]);
  if (await hasColumn(db, 'documents', 'doc_type')) columns.push(['doc_type', docType]);
  const names = columns.map(([name]) => name).join(', ');
  const placeholders = columns.map((_, index) => `$${index + 1}`).join(', ');
  await db.query(`INSERT INTO public.documents (${names}) VALUES (${placeholders}) ON CONFLICT (id) DO NOTHING`, columns.map(([, value]) => value));
  return id;
}

/**
 * Inserts deterministic rag_retrieval_log rows (plus matching rag_answer_records and rag_online_judge_scores rows where the cell
 * asks for them) with exact per-cell counts. Rows carry trace ids trace-<n> and the masked query placeholder q-<n>, never text.
 */
export async function seedRetrievalLog(db: SeedDb, spec: SeedSpec): Promise<SeedResult> {
  let trace = spec.firstTrace ?? 1;
  const owners = new Map<string, TenantOwner>();
  const out: SeededRow[] = [];
  const answerRecords = await hasColumn(db, 'rag_answer_records', 'trace_id');
  const judgeScores = await hasColumn(db, 'rag_online_judge_scores', 'trace_id');

  for (const [cellIndex, cell] of spec.cells.entries()) {
    if (!TENANT_KEY.test(cell.tenantKey)) throw new Error(`[Seed] cell ${cellIndex}: bad tenant key`);
    if (!DAY.test(cell.day)) throw new Error(`[Seed] cell ${cellIndex}: day must be YYYY-MM-DD`);
    if (!Number.isInteger(cell.rows) || cell.rows < 0) throw new Error(`[Seed] cell ${cellIndex}: rows must be a non-negative integer`);
    const c = cell.counts ?? {};
    const helpful = count(c.helpful, 'helpful', cellIndex);
    const notHelpful = count(c.notHelpful, 'notHelpful', cellIndex);
    const flagged = count(c.groundednessFlagged, 'groundednessFlagged', cellIndex);
    const judged = count(c.judged, 'judged', cellIndex);
    if (helpful + notHelpful > cell.rows || flagged > cell.rows || judged > cell.rows) {
      throw new Error(`[Seed] cell ${cellIndex}: votes, flags or judged exceed rows`);
    }
    if ((flagged > 0 && !answerRecords) || (judged > 0 && !judgeScores)) {
      throw new Error(`[Seed] cell ${cellIndex}: answer records or judge scores table missing`);
    }

    let owner = owners.get(cell.tenantKey);
    if (!owner) {
      owner = await ensureOwner(db, spec.seed, cell.tenantKey);
      owners.set(cell.tenantKey, owner);
    }
    const documentId = await ensureDocument(db, spec.seed, cell.tenantKey, owner, cell.docType ?? 'general');

    const random = seededRandom(spec.seed, `cell:${cellIndex}`);
    const kinds = shuffle(rowKinds(cell, cellIndex), random);
    const votes = shuffle(
      Array.from({ length: cell.rows }, (_, i) => (i < helpful ? 1 : i < helpful + notHelpful ? -1 : null) as 1 | -1 | null),
      random,
    );
    const flaggedRows = flags(cell.rows, flagged, random);
    const judgedRows = flags(cell.rows, judged, random);
    const scoreSpec = cell.topScore ?? { kind: 'similarity' as const, mean: 0.7, spread: 0.1 };
    const latencySpec = cell.latencyMs ?? { mean: 400, spread: 200 };
    const judge = cell.judgeScores ?? { faithfulness: 0.75, answer_relevance: 0.5 };
    const dayStart = Date.parse(`${cell.day}T00:00:00Z`) + (cell.startSecond ?? 3600) * 1000;

    for (let i = 0; i < cell.rows; i += 1) {
      const n = trace;
      trace += 1;
      const traceId = `trace-${n}`;
      const kind = kinds[i] as SeededRow['kind'];
      const createdAt = new Date(dayStart + i * 1000).toISOString();
      const latency = Math.max(0, Math.round(draw(random, latencySpec)));
      const withCandidates = kind === 'answered' || kind === 'degraded';
      const score = withCandidates ? draw(random, scoreSpec) : null;
      const candidates = withCandidates
        ? [
            {
              chunk_id: seedUuid(spec.seed, `chunk:${n}:1`),
              document_id: documentId,
              rank: 1,
              similarity: scoreSpec.kind === 'similarity' ? score : 0.5,
              kept: true,
              ...(scoreSpec.kind === 'rerank' ? { rerank_score: score } : {}),
            },
            {
              chunk_id: seedUuid(spec.seed, `chunk:${n}:2`),
              document_id: documentId,
              rank: 2,
              similarity: 0.1,
              kept: false,
            },
          ]
        : [];
      const status =
        kind === 'error' || kind === 'kb_unavailable' ? 'error' : kind === 'degraded' ? 'degraded' : kind === 'answered' ? 'ok' : 'empty';
      const outcome =
        kind === 'refused' || kind === 'below_threshold'
          ? 'refused_no_context'
          : kind === 'kb_unavailable'
            ? 'kb_unavailable'
            : kind === 'error'
              ? 'degraded_answer'
              : 'answered';
      const refusalDecision = kind === 'refused' || kind === 'below_threshold' ? 'refuse' : null;
      const refusalReason = kind === 'below_threshold' ? 'below_threshold' : kind === 'refused' ? 'below_similarity_floor' : null;
      const vote = votes[i] ?? null;

      await db.query(
        `INSERT INTO public.rag_retrieval_log (
           trace_id, user_id, organization_id, channel, rag_mode, pipeline, retrieval_config_hash, query_language, query_masked,
           status, refusal_decision, refusal_reason, outcome, candidates, candidate_count, top_score, latency_ms,
           feedback_vote, feedback_kind, feedback_at, created_at
         ) VALUES ($1, $2, $3, $4, $5, 'v2', $6, $7, $8, $9, $10, $11, $12, $13::jsonb, $14, $15, $16, $17, $18, $19, $20)`,
        [
          traceId,
          owner.userId,
          owner.organizationId,
          cell.channel,
          cell.ragMode,
          cell.retrievalConfigHash === undefined ? 'cfg-seed' : cell.retrievalConfigHash,
          cell.language,
          `q-${n}`,
          status,
          refusalDecision,
          refusalReason,
          outcome,
          JSON.stringify(candidates),
          candidates.length,
          score,
          latency,
          vote,
          vote === null ? null : 'answer',
          vote === null ? null : createdAt,
          createdAt,
        ],
      );

      if (flaggedRows[i]) {
        await db.query(
          `INSERT INTO public.rag_answer_records (id, user_id, organization_id, trace_id, rag_mode, groundedness, created_at)
           VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7)`,
          [seedUuid(spec.seed, `answer:${n}`), owner.userId, owner.organizationId, traceId, cell.ragMode ?? 'strict', JSON.stringify({ label: 'possibly_unreliable' }), createdAt],
        );
      }
      if (judgedRows[i]) {
        for (const metric of ['faithfulness', 'answer_relevance'] as const) {
          await db.query(
            'INSERT INTO public.rag_online_judge_scores (tenant_key, trace_id, metric, score, judge_id) VALUES ($1, $2, $3, $4, $5)',
            [cell.tenantKey, traceId, metric, judge[metric], 'seed-judge'],
          );
        }
      }

      out.push({
        traceId,
        cellIndex,
        tenantKey: cell.tenantKey,
        createdAt,
        kind,
        vote,
        groundednessFlagged: flaggedRows[i] === true,
        judged: judgedRows[i] === true,
        scoreKind: score === null ? null : scoreSpec.kind,
        score,
        latencyMs: latency,
        documentId: withCandidates ? documentId : null,
      });
    }
  }

  return { rows: out, nextTrace: trace };
}
