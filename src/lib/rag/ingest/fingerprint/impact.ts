import {
  FingerprintImpactSchema,
  IngestFingerprintPartsSchema,
  type FingerprintImpact,
  type IngestFingerprintParts,
} from '@/lib/rag-eval/contracts.generated';
import { canonicalJson } from '@/lib/rag-eval/trace';
import { rpcRows, type RpcClient } from '../../backend/supabase-rpc';
import { getIngestDeps } from '../deps';
import { expectedFingerprintFor, getSettingsClassification, ingestionKeysOf, type RebuildMechanism } from '../fingerprint';
import { loadProcessingProfiles } from '../profiles/load';
import { isTenantKey } from '../writer';

export type ImpactDocType = FingerprintImpact['by_mechanism'][number]['doc_type'];

/** Every rebuild mechanism, in the order the answer lists them (D-11). */
export const REBUILD_MECHANISMS: readonly RebuildMechanism[] = ['reparse', 'rechunk', 'relex', 'reembed', 'recaption', 'retranslate', 'rescan'];
const DOC_TYPES: readonly ImpactDocType[] = FingerprintImpactSchema.shape.by_mechanism.element.shape.doc_type.options;
const RPC_GROUPS = 'rag_fingerprint_groups';

/** Query-side, but it travels with RAG_SUPPORTED_LANGUAGES when the language set is recomputed. */
const LANGUAGE_COMPANION = 'RAG_PRIMARY_LANGUAGE';

export class FingerprintImpactError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = 'FingerprintImpactError';
  }
}

/** One row of rag_fingerprint_groups: current ready documents sharing a doc type, stored fingerprint and stored parts. */
export interface FingerprintGroup {
  docType: string;
  fingerprint: string | null;
  parts: unknown;
  documents: number;
}

export interface FingerprintReadOptions {
  db?: RpcClient | null;
  /** One tenant's documents; null or absent counts every tenant (deployment-wide settings). */
  tenantKey?: string | null;
  signal?: AbortSignal;
}

function toCount(value: unknown): number {
  const count = typeof value === 'string' ? Number(value) : value;
  return typeof count === 'number' && Number.isInteger(count) && count >= 0 ? count : 0;
}

function asGroup(row: unknown): FingerprintGroup | null {
  if (typeof row !== 'object' || row === null) return null;
  const record = row as Record<string, unknown>;
  return {
    docType: typeof record.doc_type === 'string' ? record.doc_type : 'general',
    fingerprint: typeof record.ingest_fingerprint === 'string' ? record.ingest_fingerprint : null,
    parts: record.parts ?? null,
    documents: toCount(record.documents),
  };
}

/** Reads the aggregated groups with the service-role client; counts only, no document id. */
export async function loadFingerprintGroups(options: FingerprintReadOptions = {}): Promise<FingerprintGroup[]> {
  const tenantKey = options.tenantKey ?? null;
  if (tenantKey !== null && !isTenantKey(tenantKey)) throw new FingerprintImpactError('invalid_tenant_key');
  const db = options.db === undefined ? (getIngestDeps().db() as RpcClient | null) : options.db;
  if (!db) throw new FingerprintImpactError('admin_client_unavailable');
  let request = db.rpc(RPC_GROUPS, { p_tenant_key: tenantKey });
  if (options.signal) request = request.abortSignal(options.signal);
  const response = await request;
  if (response.error) throw new FingerprintImpactError('rpc_failed');
  return rpcRows(response.data)
    .map(asGroup)
    .filter((group): group is FingerprintGroup => group !== null);
}

const repeatByProfile = (() => {
  let cache: Map<string, boolean> | null = null;
  return (profileId: string): boolean | null => {
    if (!cache) cache = new Map(loadProcessingProfiles().profiles.map((profile) => [profile.id, profile.chunker.repeat_table_header]));
    return cache.get(profileId) ?? null;
  };
})();

/**
 * The parts as they act on the stored output. RAG_TABLE_HEADER_REPEAT only matters through the effective header flag (D-19): `profile` on
 * a profile that already repeats headers produces the same chunks as `always`, so both compare equal. An unknown profile keeps the raw value.
 */
function effectiveView(parts: IngestFingerprintParts): string {
  const raw = parts.switches.table_header_repeat;
  const profileRepeat = repeatByProfile(parts.processing_profile_id);
  const header = raw === 'always' || profileRepeat === true ? 'repeat' : profileRepeat === false ? 'no_repeat' : raw;
  const { assumed_defaults: _assumed, ...rest } = parts;
  return canonicalJson({ ...rest, switches: { ...parts.switches, table_header_repeat: header } });
}

function pick(values: Record<string, string>, names: string[]): Record<string, string> {
  const picked: Record<string, string> = {};
  for (const name of names) if (Object.prototype.hasOwnProperty.call(values, name)) picked[name] = values[name] as string;
  return picked;
}

/** The proposed values grouped by the mechanism of their ingestion-side key; the primary language travels with the language set. */
function proposalsByMechanism(proposed: Record<string, string>): Map<RebuildMechanism, Record<string, string>> {
  const byMechanism = new Map<RebuildMechanism, string[]>();
  for (const { name, mechanism } of ingestionKeysOf(proposed)) {
    const names = byMechanism.get(mechanism) ?? [];
    names.push(name);
    if (name === 'RAG_SUPPORTED_LANGUAGES' && Object.prototype.hasOwnProperty.call(proposed, LANGUAGE_COMPANION)) names.push(LANGUAGE_COMPANION);
    byMechanism.set(mechanism, names);
  }
  const ordered = new Map<RebuildMechanism, Record<string, string>>();
  for (const mechanism of REBUILD_MECHANISMS) {
    const names = byMechanism.get(mechanism);
    if (names) ordered.set(mechanism, pick(proposed, names));
  }
  return ordered;
}

function toDocType(value: string): ImpactDocType {
  return (DOC_TYPES as readonly string[]).includes(value) ? (value as ImpactDocType) : 'general';
}

export interface ImpactCounts {
  ingestionKeys: string[];
  mechanisms: RebuildMechanism[];
  affected: Map<RebuildMechanism, Map<ImpactDocType, number>>;
  withoutFingerprint: number;
  totalCurrent: number;
}

/**
 * D-11: per mechanism and doc type, the current ready documents whose stored parts would change under the proposed values. Each mechanism is
 * evaluated with its own keys only; a change no single mechanism explains goes to the first mechanism of the proposal. Documents without a
 * fingerprint (or with unreadable parts) are counted apart and never as affected or unaffected.
 */
export function countImpact(groups: readonly FingerprintGroup[], proposed: Record<string, string>): ImpactCounts {
  const ingestionKeys = ingestionKeysOf(proposed).map((key) => key.name);
  const proposals = proposalsByMechanism(proposed);
  const mechanisms = [...proposals.keys()];
  const all = mechanisms.length > 0 ? Object.assign({}, ...proposals.values()) as Record<string, string> : {};
  const affected = new Map<RebuildMechanism, Map<ImpactDocType, number>>(
    mechanisms.map((mechanism) => [mechanism, new Map(DOC_TYPES.map((docType) => [docType, 0]))]),
  );
  let withoutFingerprint = 0;
  let totalCurrent = 0;

  for (const group of groups) {
    totalCurrent += group.documents;
    const parsed = group.fingerprint === null ? null : IngestFingerprintPartsSchema.safeParse(group.parts);
    if (!parsed || !parsed.success) {
      withoutFingerprint += group.documents;
      continue;
    }
    if (mechanisms.length === 0) continue;
    const stored = effectiveView(parsed.data);
    const docType = toDocType(group.docType);
    let explained = false;
    for (const [mechanism, values] of proposals) {
      if (effectiveView(expectedFingerprintFor(parsed.data, values).parts) === stored) continue;
      const counts = affected.get(mechanism) as Map<ImpactDocType, number>;
      counts.set(docType, (counts.get(docType) ?? 0) + group.documents);
      explained = true;
    }
    if (!explained && effectiveView(expectedFingerprintFor(parsed.data, all).parts) !== stored) {
      const counts = affected.get(mechanisms[0] as RebuildMechanism) as Map<ImpactDocType, number>;
      counts.set(docType, (counts.get(docType) ?? 0) + group.documents);
    }
  }
  return { ingestionKeys, mechanisms, affected, withoutFingerprint, totalCurrent };
}

/** The FingerprintImpact answer (UI-SPEC 8.1): every mechanism of the proposal with every doc type, zero included; aggregates only. */
export function impactFromGroups(groups: readonly FingerprintGroup[], proposed: Record<string, string>): FingerprintImpact {
  const counts = countImpact(groups, proposed);
  const byMechanism: FingerprintImpact['by_mechanism'] = [];
  for (const mechanism of counts.mechanisms) {
    for (const [docType, count] of counts.affected.get(mechanism) ?? []) byMechanism.push({ mechanism, doc_type: docType, affected: count });
  }
  return FingerprintImpactSchema.parse({
    ingestion_keys: counts.ingestionKeys,
    by_mechanism: byMechanism,
    without_fingerprint: counts.withoutFingerprint,
    total_current: counts.totalCurrent,
  });
}

/** POST /api/rag/admin/ingest-fingerprint/impact: how many stored documents the proposed values would leave on previous settings. */
export async function computeFingerprintImpact(proposed: Record<string, string>, options: FingerprintReadOptions = {}): Promise<FingerprintImpact> {
  return impactFromGroups(await loadFingerprintGroups(options), proposed);
}

/** A setting the impact route accepts: a classified RAG_* variable of the env manifest (D-09). */
export function isSettingName(name: string): boolean {
  return getSettingsClassification().entries.some((entry) => entry.name === name);
}
