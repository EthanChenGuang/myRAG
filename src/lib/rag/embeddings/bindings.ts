import { BindingActivationEvidenceSchema } from '@/lib/rag-eval/contracts.generated';
import { rpcRows } from '../backend/supabase-rpc';
import { getRagDeps } from '../deps';
import { getIngestDeps } from '../ingest/deps';
import { loadIngestConfig } from '../ingest/config';
import {
  PROFILE_CACHE_TTL_MS,
  ProfileUnavailableError,
  getActiveProfile,
  getEmbeddingProfileById,
  requireRegistryClient,
  type EmbeddingProfile,
} from './active-profile';

export type BindingStatus = 'available' | 'backfilling' | 'active' | 'retired';

/** A scoped profile: holds vectors only for chunks whose doc type is in docTypes. */
export interface BindingProfile extends EmbeddingProfile {
  docTypes: string[];
}

export interface EffectiveBinding {
  bindingId: string;
  docType: string;
  /** Null for a deployment-wide binding. */
  tenantKey: string | null;
  profile: BindingProfile;
  /** The evidence names another global profile than the active one: query time skips the binding until it is re-proven (D-12). */
  stale: boolean;
}

export interface BindingTarget {
  bindingId: string;
  docType: string;
  tenantKey: string | null;
  profile: BindingProfile;
  role: 'active' | 'backfilling';
}

export interface BindingRow {
  id: string;
  docType: string;
  tenantKey: string | null;
  profileId: string;
  status: BindingStatus;
  previousBindingId: string | null;
  hasEvidence: boolean;
  baselineGlobalProfile: string | null;
  activatedAt: string | null;
  activatedBy: string | null;
  createdAt: string | null;
  createdBy: string | null;
}

interface ResolvedBinding extends BindingRow {
  profile: BindingProfile;
}

interface Snapshot {
  at: number;
  bindings: ResolvedBinding[];
  byDocType: Map<string, ResolvedBinding[]>;
}

const READ_TIMEOUT_MS = 5_000;
const LIST_BINDINGS_RPC = 'rag_list_embedding_bindings';
const LIST_SCOPES_RPC = 'rag_list_embedding_profile_scopes';
const STATUSES: readonly string[] = ['available', 'backfilling', 'active', 'retired'];
/** The doc types a binding may name: the evidence contract's enum, the same list the SQL checks. */
export const BINDING_DOC_TYPES = BindingActivationEvidenceSchema.shape.doc_type.options;
const DOC_TYPES: readonly string[] = BINDING_DOC_TYPES;

let cache: Snapshot | null = null;
let inflight: Promise<Snapshot> | null = null;
let generation = 0;

/** RAG_DOMAIN_EMBEDDINGS, already forced off by the config loader while RAG_EMBEDDING_PROFILES is off. */
export function isDomainEmbeddingsEnabled(): boolean {
  return loadIngestConfig(getIngestDeps().ingestEnv()).domainEmbeddings === 'on';
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function nullableString(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function isKnownDocType(value: unknown): value is string {
  return typeof value === 'string' && DOC_TYPES.includes(value);
}

/** The D-07 key of a binding: one doc type for one tenant, or deployment-wide. */
export function bindingKey(row: Pick<BindingRow, 'docType' | 'tenantKey'>): string {
  return JSON.stringify([row.docType, row.tenantKey]);
}

function docTypeList(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  const out = value.filter((entry): entry is string => typeof entry === 'string' && DOC_TYPES.includes(entry));
  return out.length === value.length && out.length > 0 ? out : null;
}

export function parseBindingRow(raw: unknown): BindingRow | null {
  const row = asRecord(raw);
  if (!row) return null;
  const { id, doc_type: docType, tenant_key: tenantKey, profile_id: profileId, status } = row;
  if (typeof id !== 'string' || id === '' || typeof profileId !== 'string' || profileId === '') return null;
  if (!isKnownDocType(docType)) return null;
  if (tenantKey !== null && (typeof tenantKey !== 'string' || tenantKey === '')) return null;
  if (typeof status !== 'string' || !STATUSES.includes(status)) return null;
  return {
    id,
    docType,
    tenantKey,
    profileId,
    status: status as BindingStatus,
    previousBindingId: nullableString(row.previous_binding_id),
    hasEvidence: row.has_evidence === true,
    baselineGlobalProfile: nullableString(row.baseline_global_profile),
    activatedAt: nullableString(row.activated_at),
    activatedBy: nullableString(row.activated_by),
    createdAt: nullableString(row.created_at),
    createdBy: nullableString(row.created_by),
  };
}

async function readRpc(fn: string): Promise<unknown[]> {
  const client = requireRegistryClient();
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new ProfileUnavailableError('read_timeout'));
    }, READ_TIMEOUT_MS);
  });
  let response;
  try {
    response = await Promise.race([Promise.resolve(client.rpc(fn, {}).abortSignal(controller.signal)), timeout]);
  } catch (error) {
    if (error instanceof ProfileUnavailableError) throw error;
    throw new ProfileUnavailableError('read_failed');
  } finally {
    clearTimeout(timer);
  }
  if (response.error) throw new ProfileUnavailableError('read_failed', response.error.code ?? null);
  return rpcRows(response.data);
}

/** Every binding row, read fresh. For operator views; the app path goes through the cached snapshot. */
export async function listBindingRows(): Promise<BindingRow[]> {
  const rows: BindingRow[] = [];
  for (const raw of await readRpc(LIST_BINDINGS_RPC)) {
    const row = parseBindingRow(raw);
    if (row) rows.push(row);
  }
  return rows;
}

/** The doc types each scoped profile serves, read fresh, for operator views. Unscoped profiles are absent. */
export async function listProfileScopes(): Promise<Record<string, string[]>> {
  const out: Record<string, string[]> = {};
  for (const raw of await readRpc(LIST_SCOPES_RPC)) {
    const row = asRecord(raw);
    const docTypes = docTypeList(row?.doc_types);
    if (row && typeof row.id === 'string' && docTypes) out[row.id] = docTypes;
  }
  return out;
}

async function resolveProfile(id: string, scopes: Map<string, string[]>): Promise<BindingProfile | null> {
  const docTypes = scopes.get(id);
  if (!docTypes) return null;
  try {
    return { ...(await getEmbeddingProfileById(id)), docTypes };
  } catch (error) {
    if (error instanceof ProfileUnavailableError) throw error;
    return null;
  }
}

async function readSnapshot(): Promise<ResolvedBinding[]> {
  const [bindingRows, scopeRows] = await Promise.all([readRpc(LIST_BINDINGS_RPC), readRpc(LIST_SCOPES_RPC)]);
  const scopes = new Map<string, string[]>();
  for (const raw of scopeRows) {
    const row = asRecord(raw);
    const docTypes = docTypeList(row?.doc_types);
    if (row && typeof row.id === 'string' && docTypes) scopes.set(row.id, docTypes);
  }

  const bindings: ResolvedBinding[] = [];
  for (const raw of bindingRows) {
    const isActive = asRecord(raw)?.status === 'active';
    const row = parseBindingRow(raw);
    const profile = row ? await resolveProfile(row.profileId, scopes) : null;
    if (row && profile && profile.docTypes.includes(row.docType)) {
      bindings.push({ ...row, profile });
    } else if (isActive) {
      throw new ProfileUnavailableError('malformed_active_profile');
    }
  }
  return bindings;
}

function startRead(): Promise<Snapshot> {
  const startedGeneration = generation;
  const at = getRagDeps().now();
  const run = readSnapshot()
    .then((bindings) => {
      const byDocType = new Map<string, ResolvedBinding[]>();
      for (const row of bindings) byDocType.set(row.docType, [...(byDocType.get(row.docType) ?? []), row]);
      const snapshot: Snapshot = { at, bindings, byDocType };
      if (startedGeneration === generation) cache = snapshot;
      return snapshot;
    })
    .finally(() => {
      if (inflight === run) inflight = null;
    });
  inflight = run;
  return run;
}

async function snapshot(): Promise<Snapshot> {
  if (cache) {
    const age = getRagDeps().now() - cache.at;
    if (age >= 0 && age < PROFILE_CACHE_TTL_MS) return cache;
  }
  return inflight ?? startRead();
}

function invalidate(): void {
  generation += 1;
  cache = null;
  inflight = null;
}

/** A tenant row applies only to its own tenant; a deployment row (tenant_key NULL) to every tenant. */
function appliesTo(row: BindingRow, tenantKey: string): boolean {
  return row.tenantKey === null || row.tenantKey === tenantKey;
}

/**
 * Per doc type, the binding that applies to this tenant: an active tenant-specific binding over an active deployment-wide one (D-07).
 * Off returns [] with no database read. Stale bindings are returned flagged; query time skips them (D-12).
 */
export async function getEffectiveBindings(tenantKey: string): Promise<EffectiveBinding[]> {
  if (!isDomainEmbeddingsEnabled()) return [];
  const { bindings } = await snapshot();
  const byDocType = new Map<string, ResolvedBinding>();
  for (const row of bindings) {
    if (row.status !== 'active' || !appliesTo(row, tenantKey)) continue;
    const current = byDocType.get(row.docType);
    if (!current || (current.tenantKey === null && row.tenantKey !== null)) byDocType.set(row.docType, row);
  }
  if (byDocType.size === 0) return [];
  const globalId = (await getActiveProfile()).id;
  return [...byDocType.values()]
    .sort((left, right) => left.docType.localeCompare(right.docType))
    .map((row) => ({
      bindingId: row.id,
      docType: row.docType,
      tenantKey: row.tenantKey,
      profile: row.profile,
      stale: row.baselineGlobalProfile !== globalId,
    }));
}

/**
 * The binding profiles ingestion writes for a doc type and tenant (D-15): active and backfilling bindings of the tenant row and of the
 * deployment-wide row, one entry per profile; the active role, then the tenant row, wins a tie.
 */
export async function getBindingTargets(docType: string, tenantKey: string): Promise<BindingTarget[]> {
  if (!isDomainEmbeddingsEnabled()) return [];
  const forDocType = (await snapshot()).byDocType.get(docType) ?? [];
  const rank = (row: BindingRow): number => (row.status === 'active' ? 0 : 2) + (row.tenantKey === null ? 1 : 0);
  const candidates = forDocType
    .filter((row) => (row.status === 'active' || row.status === 'backfilling') && appliesTo(row, tenantKey))
    .sort((left, right) => rank(left) - rank(right) || left.profileId.localeCompare(right.profileId));
  const seen = new Set<string>();
  const targets: BindingTarget[] = [];
  for (const row of candidates) {
    if (seen.has(row.profileId)) continue;
    seen.add(row.profileId);
    targets.push({ bindingId: row.id, docType: row.docType, tenantKey: row.tenantKey, profile: row.profile, role: row.status as 'active' | 'backfilling' });
  }
  return targets;
}

/** Drops the cache; the next read goes to the registry. Called after every binding operation. */
export async function refreshBindings(): Promise<void> {
  invalidate();
  if (!isDomainEmbeddingsEnabled()) return;
  await startRead();
}

/** After a gate operation: never throws, at worst leaves the cache empty. */
export async function refreshBindingsAfterOperation(): Promise<void> {
  try {
    await refreshBindings();
  } catch {
    invalidate();
  }
}

export function resetBindingsForTests(): void {
  invalidate();
}
