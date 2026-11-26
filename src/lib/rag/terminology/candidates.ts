import { callTerminologyRpc, count, text, type TerminologyAdminFailed } from './admin';

/** D-26: one mined candidate as the review list returns it (the tenant key stays server side). */
export interface TerminologyCandidate {
  id: string;
  term: string;
  language: string;
  support: number;
  /** Up to 3 already-masked example queries; empty once the candidate has not been seen for 30 days. */
  examples: string[];
  corpus_df: number;
  status: 'pending' | 'accepted' | 'dismissed';
  source: string;
  entry_id: string | null;
  first_seen: string | null;
  last_seen: string | null;
  decided_by: string | null;
  decided_at: string | null;
}

export type ListTerminologyCandidatesResult =
  | { ok: true; items: TerminologyCandidate[]; limit: number; offset: number; nextOffset: number | null }
  | TerminologyAdminFailed;

export type DecideTerminologyCandidateResult =
  | { ok: true; candidateId: string; status: 'accepted' | 'dismissed'; entryId: string | null }
  | TerminologyAdminFailed;

const PAGE = 100;
const DEFAULT_LIMIT = 50;
const STATUSES = new Set(['pending', 'accepted', 'dismissed']);

type Row = Record<string, unknown>;

function timeOf(row: Row, key: string): string | null {
  const value = row[key];
  const parsed = value instanceof Date ? value : typeof value === 'string' ? new Date(value) : null;
  return parsed !== null && !Number.isNaN(parsed.getTime()) ? parsed.toISOString() : null;
}

function candidateOf(row: Row): TerminologyCandidate | null {
  const id = text(row, 'id');
  const term = text(row, 'term');
  const language = text(row, 'language');
  const status = text(row, 'status');
  if (!id || !term || !language || !status || !STATUSES.has(status)) return null;
  return {
    id,
    term,
    language,
    support: count(row, 'support'),
    examples: Array.isArray(row.examples) ? row.examples.filter((item): item is string => typeof item === 'string').slice(0, 3) : [],
    corpus_df: count(row, 'corpus_df'),
    status: status as TerminologyCandidate['status'],
    source: text(row, 'source') ?? 'miss_log',
    entry_id: text(row, 'entry_id'),
    first_seen: timeOf(row, 'first_seen'),
    last_seen: timeOf(row, 'last_seen'),
    decided_by: text(row, 'decided_by'),
    decided_at: timeOf(row, 'decided_at'),
  };
}

/**
 * D-26: one page of the pending candidates of a tenant, by support. rag_term_list_candidates checks the actor and the tenant key in SQL
 * and orders pending rows first, so the pending rows of a page are contiguous; nextOffset is set while a page holds only pending rows.
 */
export async function listTerminologyCandidates(input: {
  /** The admin the route guard verified. */
  actorUserId: string;
  /** The tenant key of the admin's resolved workspace scope (s:default in single-tenant mode). */
  tenantKey: string;
  limit?: number;
  offset?: number;
  signal: AbortSignal;
}): Promise<ListTerminologyCandidatesResult> {
  const limit = Math.min(Math.max(Math.trunc(input.limit ?? DEFAULT_LIMIT), 1), PAGE);
  const offset = Math.max(Math.trunc(input.offset ?? 0), 0);
  const result = await callTerminologyRpc(
    'rag_term_list_candidates',
    { p_actor: input.actorUserId, p_layer_key: input.tenantKey, p_limit: limit, p_offset: offset },
    input.signal,
  );
  if (!result.ok) return result;
  const rows = result.rows.map(candidateOf).filter((row): row is TerminologyCandidate => row !== null);
  const items = rows.filter((row) => row.status === 'pending');
  const nextOffset = result.rows.length === limit && items.length === limit ? offset + limit : null;
  return { ok: true, items, limit, offset, nextOffset };
}

/**
 * D-26, D-06: dismisses a pending candidate or accepts it with an entry of its tenant layer or of the shared layer. The SQL checks the
 * actor's admin rights over the candidate's tenant (another tenant's candidate or entry is not_found) and writes the audit row.
 */
export async function decideTerminologyCandidate(input: {
  actorUserId: string;
  candidateId: string;
  action: 'dismiss' | 'accept';
  entryId?: string | null;
  signal: AbortSignal;
}): Promise<DecideTerminologyCandidateResult> {
  const result = await callTerminologyRpc(
    'rag_term_decide_candidate',
    {
      p_actor: input.actorUserId,
      p_candidate_id: input.candidateId,
      p_action: input.action,
      p_entry_id: input.action === 'accept' ? (input.entryId ?? null) : null,
    },
    input.signal,
  );
  if (!result.ok) return result;
  const row = result.rows[0];
  const candidateId = row ? text(row, 'candidate_id') : null;
  const status = row ? text(row, 'status') : null;
  if (!row || !candidateId || (status !== 'accepted' && status !== 'dismissed')) return { ok: false, reason: 'unavailable' };
  return { ok: true, candidateId, status, entryId: text(row, 'entry_id') };
}
