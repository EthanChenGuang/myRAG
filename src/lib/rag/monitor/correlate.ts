import type { SupabaseClient } from '@supabase/supabase-js';
import type { ConfigChange } from './alerts-store';

/** The rag_monitor_alert_evidence filter: a row matches when any listed condition holds; `{}` matches every row. */
export interface EvidenceMatch {
  status?: string[];
  outcome?: string[];
  refusal_decision?: string[];
  refusal_reason?: string[];
  feedback_vote?: number[];
  zero_result?: true;
  groundedness_flagged?: true;
}

/** The log rows that make up each rate metric (the same definitions as rag_monitor_aggregate, 0971). */
export const MATCH_BY_RULE: Readonly<Record<string, EvidenceMatch>> = {
  refusal_rate: { outcome: ['refused_no_context'], refusal_decision: ['refuse'] },
  zero_result_rate: { zero_result: true },
  below_threshold_rate: { refusal_reason: ['below_threshold'] },
  not_helpful_rate: { feedback_vote: [-1] },
  groundedness_flagged_rate: { groundedness_flagged: true },
  kb_error_rate: { status: ['error'] },
  kb_degraded_rate: { status: ['degraded'] },
  kb_unavailable_rate: { outcome: ['kb_unavailable'] },
};

export function matchForRule(rule: string): EvidenceMatch {
  return MATCH_BY_RULE[rule] ?? {};
}

export interface WindowConfigChangesInput {
  tenantKey: string;
  language: string;
  /** Start of the evaluation window (inclusive, ISO timestamp). */
  from: string;
  /** End of the evaluation window (exclusive, ISO timestamp). */
  to: string;
  match: EvidenceMatch;
}

export interface WindowConfigChanges {
  configChanges: ConfigChange[];
  sampleTraceIds: string[];
}

const LOOKBACK_MS = 2 * 86_400_000;
const MAX_CHANGES = 50;
const KEY = /^[A-Z][A-Z0-9_]{0,127}$/;
const HASH = /^[a-f0-9]{8,64}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const RECORD_SOURCES = new Set(['config_ui', 'cli', 'release_override', 'local_prerelease', 'profile_activation']);

interface ChangeRecordRow {
  id: string;
  created_at: string;
  source: string;
  changed_keys: string[] | null;
  before_hash: string | null;
  after_hash: string | null;
  retrieval_config_hash: string | null;
}

interface EvidenceResult {
  sample_trace_ids?: unknown;
  config_hash_firsts?: unknown;
}

function iso(value: unknown): string {
  return new Date(String(value)).toISOString();
}

function hashOrNull(value: unknown): string | null {
  return typeof value === 'string' && HASH.test(value) ? value : null;
}

function warn(source: string, error: unknown): void {
  const code = (error as { code?: unknown } | null)?.code;
  console.warn('[Monitor] configuration source unreadable; skipped', { source, code: typeof code === 'string' ? code : null });
}

async function changeRecords(admin: SupabaseClient, from: string, to: string): Promise<ChangeRecordRow[]> {
  const { data, error } = await admin
    .from('rag_config_change_records')
    .select('id, created_at, source, changed_keys, before_hash, after_hash, retrieval_config_hash')
    .gte('created_at', from)
    .lt('created_at', to)
    .order('created_at', { ascending: true })
    .limit(MAX_CHANGES);
  if (error) {
    warn('rag_config_change_records', error);
    return [];
  }
  return (data ?? []) as ChangeRecordRow[];
}

async function activations(
  admin: SupabaseClient,
  table: 'embedding_profiles' | 'chunking_profiles',
  source: 'embedding_profile' | 'chunking_profile',
  from: string,
  to: string,
): Promise<ConfigChange[]> {
  const { data, error } = await admin
    .from(table)
    .select('id, activated_at')
    .gte('activated_at', from)
    .lt('activated_at', to)
    .order('activated_at', { ascending: true })
    .limit(MAX_CHANGES);
  if (error) {
    warn(table, error);
    return [];
  }
  return ((data ?? []) as Array<{ activated_at: string | null }>)
    .filter((row) => row.activated_at)
    .map((row) => ({
      source,
      at: iso(row.activated_at),
      record_id: null,
      before_hash: null,
      after_hash: null,
      changed_keys: [],
      unrecorded: false,
    }));
}

/** Hashes that some change record names, at any time: a first appearance of one of them is not an unrecorded change. */
async function recordedHashes(admin: SupabaseClient, hashes: string[]): Promise<Set<string>> {
  if (hashes.length === 0) return new Set();
  const { data, error } = await admin
    .from('rag_config_change_records')
    .select('retrieval_config_hash')
    .in('retrieval_config_hash', hashes)
    .limit(hashes.length * 10);
  if (error) {
    warn('rag_config_change_records', error);
    return new Set();
  }
  return new Set(((data ?? []) as Array<{ retrieval_config_hash: string | null }>).map((row) => row.retrieval_config_hash ?? ''));
}

/**
 * What changed in an alert's window (D-27): change records and embedding and chunking profile activations from the window
 * start minus two days to its end, and every first appearance of a retrieval_config_hash for the tenant in that span;
 * a hash that no change record names is listed with `unrecorded: true`. Also returns up to ten sample trace ids of the
 * tenant's rows in the window that match the rule. Ids, key names and hashes only.
 */
export async function windowConfigChanges(admin: SupabaseClient, input: WindowConfigChangesInput): Promise<WindowConfigChanges> {
  const lookbackFrom = new Date(Date.parse(input.from) - LOOKBACK_MS).toISOString();

  const { data, error } = await admin.rpc('rag_monitor_alert_evidence', {
    p_tenant_key: input.tenantKey,
    p_language: input.language,
    p_from: input.from,
    p_to: input.to,
    p_match: input.match,
    p_limit: 10,
  });
  let evidence: EvidenceResult = {};
  if (error) warn('rag_monitor_alert_evidence', error);
  else if (data && typeof data === 'object') evidence = data as EvidenceResult;

  const sampleTraceIds = Array.isArray(evidence.sample_trace_ids)
    ? evidence.sample_trace_ids.filter((id): id is string => typeof id === 'string').slice(0, 10)
    : [];
  const firsts = Array.isArray(evidence.config_hash_firsts)
    ? (evidence.config_hash_firsts as Array<{ hash?: unknown; first_at?: unknown }>)
        .map((entry) => ({ hash: hashOrNull(entry.hash), at: entry.first_at }))
        .filter((entry): entry is { hash: string; at: unknown } => entry.hash !== null && entry.at != null)
    : [];

  const records = await changeRecords(admin, lookbackFrom, input.to);
  const changes: ConfigChange[] = records
    .filter((row) => RECORD_SOURCES.has(row.source) && UUID.test(row.id))
    .map((row) => ({
      source: row.source as ConfigChange['source'],
      at: iso(row.created_at),
      record_id: row.id,
      before_hash: hashOrNull(row.before_hash),
      after_hash: hashOrNull(row.after_hash),
      changed_keys: (row.changed_keys ?? []).filter((key) => KEY.test(key)),
      unrecorded: false,
    }));
  changes.push(...(await activations(admin, 'embedding_profiles', 'embedding_profile', lookbackFrom, input.to)));
  changes.push(...(await activations(admin, 'chunking_profiles', 'chunking_profile', lookbackFrom, input.to)));

  const recorded = await recordedHashes(
    admin,
    firsts.map((entry) => entry.hash),
  );
  for (const entry of firsts) {
    if (recorded.has(entry.hash)) continue;
    changes.push({
      source: 'retrieval_log',
      at: iso(entry.at),
      record_id: null,
      before_hash: null,
      after_hash: entry.hash,
      changed_keys: [],
      unrecorded: true,
    });
  }

  changes.sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));
  return { configChanges: changes.slice(0, MAX_CHANGES), sampleTraceIds };
}
