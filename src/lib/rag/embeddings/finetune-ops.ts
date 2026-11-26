import { env } from '@/lib/env';
import { ModelVersionCardSchema } from '@/lib/rag-eval/contracts.generated';
import { ProfileUnavailableError, listEmbeddingProfiles, refreshAfterOperation } from './active-profile';
import { callGate, callGateRows, type ProfileRefusal } from './profile-ops';

/** Fine-tune operator functions behind `npm run rag:embedding -- ft-*` (06.1 D-22, D-24, D-27..D-30). Service-role RPCs only. */

export type FinetuneSlotId = 'ft-a-1024' | 'ft-b-1024';
export type FinetuneRefusal = ProfileRefusal;

const REFUSAL = /^((?:consent|register|status|bind|clear|release|slot)_refused|tenant_key_invalid)(?:: ([a-z_]+))?/;
const PROBE_COUNT = 3;
const PROBE_DIMS = 1024;
const UNIT_TOLERANCE = 1e-3;

export const FINETUNE_OFF_MESSAGE =
  'RAG_FINETUNE is off: the fine-tune commands refuse (only ft-consent list and ft-models list run); set RAG_FINETUNE=on to use them.';

export function isFinetuneEnabled(): boolean {
  return env.RAG_FINETUNE === 'on';
}

export interface ConsentRow {
  tenantKey: string;
  scope: string;
  evidenceRef: string | null;
  grantedAt: string | null;
  revokedAt: string | null;
}

export interface ModelVersionRow {
  id: string;
  baseModel: string;
  scope: 'deployment' | 'tenant';
  tenantKeys: string[];
  status: string;
  boundSlot: string | null;
  queryPrompt: string;
  documentPrompt: string;
  artifactUri: string | null;
  createdAt: string | null;
}

/** A slot that holds a tainted version, with what the operator must do before clearing it. */
export interface TaintedSlot {
  slot: string;
  versionId: string;
  active: boolean;
  rollbackTarget: boolean;
}

export type GrantResult = { ok: true; tenantKey: string; scope: string; taintedVersions: string[] } | FinetuneRefusal;
export type RevokeResult =
  | { ok: true; tenantKey: string; taintedVersions: string[]; slots: TaintedSlot[]; artifactUris: string[] }
  | FinetuneRefusal;
export type RegisterResult = { ok: true; versionId: string; status: string } | FinetuneRefusal;
export type RetireResult = { ok: true; versionId: string; status: string } | FinetuneRefusal;
export type BindResult = { ok: true; slot: FinetuneSlotId; version: ModelVersionRow } | FinetuneRefusal;
export type ClearResult = { ok: true; slot: FinetuneSlotId; deleted: number; batches: number } | FinetuneRefusal;
export type ReleaseResult = { ok: true; activeProfile: string; droppedPrevious: string | null } | FinetuneRefusal;

/** A card the client refused before any RPC: `reason` is `card_invalid: <code>`. */
export class FinetuneCardInvalidError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(`card_invalid: ${code} (${message})`);
    this.name = 'FinetuneCardInvalidError';
    this.code = code;
  }
}

const str = (row: Record<string, unknown>, key: string): string | null => (typeof row[key] === 'string' ? (row[key] as string) : null);
const strings = (value: unknown): string[] => (Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string') : []);

function malformed(): never {
  throw new ProfileUnavailableError('rpc_failed', 'malformed_response');
}

function toVersion(row: Record<string, unknown>): ModelVersionRow {
  const id = str(row, 'id');
  const scope = str(row, 'scope');
  if (!id || (scope !== 'deployment' && scope !== 'tenant')) malformed();
  return {
    id,
    baseModel: str(row, 'base_model') ?? '',
    scope,
    tenantKeys: strings(row.tenant_keys),
    status: str(row, 'status') ?? '',
    boundSlot: str(row, 'bound_slot'),
    queryPrompt: str(row, 'query_prompt') ?? '',
    documentPrompt: str(row, 'document_prompt') ?? '',
    artifactUri: str(row, 'artifact_uri'),
    createdAt: str(row, 'created_at'),
  };
}

export async function listConsent(): Promise<ConsentRow[]> {
  const outcome = await callGateRows('rag_finetune_list_consent', {}, REFUSAL);
  if ('refusal' in outcome) throw new ProfileUnavailableError('rpc_failed', outcome.refusal.reason);
  return outcome.rows.map((row) => {
    const tenantKey = str(row, 'tenant_key');
    const scope = str(row, 'scope');
    if (!tenantKey || !scope) malformed();
    return { tenantKey, scope, evidenceRef: str(row, 'evidence_ref'), grantedAt: str(row, 'granted_at'), revokedAt: str(row, 'revoked_at') };
  });
}

/** The registry without probe vectors. */
export async function listModels(): Promise<ModelVersionRow[]> {
  const outcome = await callGateRows('rag_finetune_list_models', { p_include_probe: false }, REFUSAL);
  if ('refusal' in outcome) throw new ProfileUnavailableError('rpc_failed', outcome.refusal.reason);
  return outcome.rows.map(toVersion);
}

async function setConsent(tenantKey: string, scope: string, evidenceRef: string | null, actor: string) {
  const outcome = await callGate('rag_finetune_set_consent', { p_tenant_key: tenantKey, p_scope: scope, p_evidence_ref: evidenceRef, p_actor: actor }, REFUSAL);
  if ('refusal' in outcome) return outcome;
  return { taintedVersions: strings(outcome.row.tainted_versions), scope: str(outcome.row, 'scope') ?? scope };
}

/** Grants private or deployment consent. Narrowing deployment to private taints the tenant's deployment-scope versions (D-29). */
export async function grantConsent(tenantKey: string, scope: 'private' | 'deployment', evidenceRef: string, actor: string): Promise<GrantResult> {
  const outcome = await setConsent(tenantKey, scope, evidenceRef, actor);
  if ('refusal' in outcome) return outcome.refusal;
  return { ok: true, tenantKey, scope: outcome.scope, taintedVersions: outcome.taintedVersions };
}

/**
 * Revokes consent (scope none). SQL taints every version trained on the tenant in the same transaction and drops their non-active
 * slot evidence; this then reports where those versions are bound so the operator can roll back and clear.
 */
export async function revokeConsent(tenantKey: string, actor: string): Promise<RevokeResult> {
  const outcome = await setConsent(tenantKey, 'none', null, actor);
  if ('refusal' in outcome) return outcome.refusal;
  await refreshAfterOperation();
  const versions = (await listModels()).filter((version) => version.status === 'tainted' && version.tenantKeys.includes(tenantKey));
  const profiles = await listEmbeddingProfiles();
  const active = profiles.find((profile) => profile.status === 'active');
  const slots: TaintedSlot[] = versions
    .filter((version) => version.boundSlot !== null)
    .map((version) => ({
      slot: version.boundSlot as string,
      versionId: version.id,
      active: active?.id === version.boundSlot,
      rollbackTarget: active?.previousActiveId === version.boundSlot,
    }));
  const tainted = [...new Set([...outcome.taintedVersions, ...versions.map((version) => version.id)])].sort();
  const artifactUris = versions.map((version) => version.artifactUri).filter((uri): uri is string => uri !== null);
  return { ok: true, tenantKey, taintedVersions: tainted, slots, artifactUris };
}

function invalid(code: string, message: string): never {
  throw new FinetuneCardInvalidError(code, message);
}

/**
 * The card checks the generated schema cannot carry, mirroring the Python model (06.1-02): an artifact location without
 * credentials, status matching the offline gate, probe prompts equal to the card's, sorted unique tenant keys, unit probe vectors.
 */
export function validateModelCard(raw: unknown): Record<string, unknown> {
  const parsed = ModelVersionCardSchema.safeParse(raw);
  if (!parsed.success) {
    const fields = [...new Set(parsed.error.issues.map((issue) => issue.path.join('.') || '(card)'))].slice(0, 5).join(', ');
    invalid('schema', `fields: ${fields}`);
  }
  const card = parsed.data as unknown as Record<string, unknown> & {
    artifact_uri: string;
    status: string;
    offline: { passed: boolean };
    query_prompt: string;
    document_prompt: string;
    tenant_keys: string[];
    probe: { query_prompt: string; document_prompt: string; vectors: number[][] };
  };
  let location: URL;
  try {
    location = new URL(card.artifact_uri);
  } catch {
    invalid('artifact_uri', 'scheme://location without userinfo, query string or fragment');
  }
  if (!card.artifact_uri.includes('://') || location.username || location.password || location.search || location.hash || card.artifact_uri.includes('@')) {
    invalid('artifact_uri', 'scheme://location without userinfo, query string or fragment');
  }
  if (card.status === 'rejected_offline' || !card.offline.passed) invalid('offline_gate', 'the card failed the offline evaluation');
  if (card.probe.query_prompt !== card.query_prompt || card.probe.document_prompt !== card.document_prompt) {
    invalid('probe_prompts', 'the probe prompts must equal the card prompts');
  }
  const sorted = [...new Set(card.tenant_keys)].sort();
  if (sorted.length !== card.tenant_keys.length || sorted.some((key, index) => key !== card.tenant_keys[index])) {
    invalid('tenant_keys', 'tenant keys must be sorted and unique');
  }
  if (card.probe.vectors.length !== PROBE_COUNT) invalid('probe_vectors', 'three probe vectors');
  for (const vector of card.probe.vectors) {
    if (vector.length !== PROBE_DIMS || !vector.every((x) => Number.isFinite(x))) invalid('probe_vectors', 'three vectors of 1024 numbers');
    const norm = Math.sqrt(vector.reduce((sum, x) => sum + x * x, 0));
    if (Math.abs(norm - 1) > UNIT_TOLERANCE) invalid('probe_vectors', 'unit length');
  }
  return card;
}

/** Validates the card client-side (throws FinetuneCardInvalidError) and registers it; SQL re-checks everything, consent included. */
export async function registerModel(raw: unknown, actor: string): Promise<RegisterResult> {
  const card = validateModelCard(raw);
  const outcome = await callGate('rag_finetune_register_model', { p_card: card, p_actor: actor }, REFUSAL);
  if ('refusal' in outcome) return outcome.refusal;
  const versionId = str(outcome.row, 'version_id');
  const status = str(outcome.row, 'version_status');
  if (!versionId || !status) malformed();
  return { ok: true, versionId, status };
}

export async function retireModel(versionId: string, actor: string): Promise<RetireResult> {
  const outcome = await callGate('rag_finetune_set_model_status', { p_version_id: versionId, p_status: 'retired', p_actor: actor }, REFUSAL);
  if ('refusal' in outcome) return outcome.refusal;
  return { ok: true, versionId: str(outcome.row, 'version_id') ?? versionId, status: str(outcome.row, 'version_status') ?? 'retired' };
}

/**
 * Binds a registered version to an unscoped slot. A tenant-scope version is refused here before any bind RPC: it is bound only with
 * its doc types through the scoped bind (06.1-20). The SQL refusal is the real guard (D-35).
 */
export async function bindSlot(slot: FinetuneSlotId, versionId: string, actor: string): Promise<BindResult> {
  const version = (await listModels()).find((entry) => entry.id === versionId);
  if (version?.scope === 'tenant') {
    return {
      ok: false,
      reason: 'bind_refused: tenant_scope_requires_scoping',
      detail: `bind_refused: tenant_scope_requires_scoping (${versionId} is a tenant-scope version: it needs --doc-types, the scoped bind of 06.1-20)`,
    };
  }
  const outcome = await callGate('rag_finetune_bind_slot', { p_slot: slot, p_version: versionId, p_actor: actor }, REFUSAL);
  if ('refusal' in outcome) return outcome.refusal;
  if (!version) malformed();
  await refreshAfterOperation();
  return { ok: true, slot, version: { ...version, status: 'bound', boundSlot: slot, queryPrompt: str(outcome.row, 'query_instruction') ?? version.queryPrompt } };
}

/** Deletes a free slot's vectors batch by batch until it is empty and unbound; a refusal stops the loop. */
export async function clearSlot(
  slot: FinetuneSlotId,
  actor: string,
  batch: number,
  onBatch?: (progress: { deleted: number; remaining: number }) => void,
): Promise<ClearResult> {
  let deleted = 0;
  let batches = 0;
  for (;;) {
    const outcome = await callGate('rag_finetune_clear_slot', { p_slot: slot, p_actor: actor, p_limit: batch }, REFUSAL);
    if ('refusal' in outcome) return outcome.refusal;
    batches += 1;
    const step = Number(outcome.row.deleted ?? 0);
    const remaining = Number(outcome.row.remaining ?? 0);
    if (!Number.isFinite(step) || !Number.isFinite(remaining)) malformed();
    deleted += step;
    onBatch?.({ deleted, remaining });
    if (outcome.row.cleared === true) break;
    if (step === 0) throw new ProfileUnavailableError('rpc_failed', 'clear_made_no_progress');
  }
  await refreshAfterOperation();
  return { ok: true, slot, deleted, batches };
}

/** Drops the active profile's rollback target (explicit acknowledgement), so that slot becomes free to clear or rebind. */
export async function releaseRollback(actor: string, ack: 'drop-rollback'): Promise<ReleaseResult> {
  const outcome = await callGate('rag_finetune_release_rollback', { p_actor: actor, p_ack: ack }, REFUSAL);
  if ('refusal' in outcome) return outcome.refusal;
  const activeProfile = str(outcome.row, 'active_profile');
  if (!activeProfile) malformed();
  await refreshAfterOperation();
  return { ok: true, activeProfile, droppedPrevious: str(outcome.row, 'dropped_previous') };
}

/** `ft-a-1024` → `A`, for the RAG_FT_SLOT_<X>_* variables. */
export function slotLetter(slot: FinetuneSlotId): 'A' | 'B' {
  return slot === 'ft-a-1024' ? 'A' : 'B';
}

/**
 * What the operator sets and runs after a bind. Prompts are written as dotenv double-quoted values. No key is printed. A scoped slot
 * (06.1-20) is filled by the tenant-filtered binding backfill of 3.1.1 instead of the global re-embed.
 */
export function bindGuidance(slot: FinetuneSlotId, version: Pick<ModelVersionRow, 'id' | 'queryPrompt' | 'documentPrompt'>, scopedTenantKey?: string): string[] {
  const letter = slotLetter(slot);
  const backfill = scopedTenantKey
    ? `npm run rag:reembed -- --profile ${slot} --tenant ${scopedTenantKey} (the 3.1.1 tenant-filtered binding backfill)`
    : `npm run rag:reembed -- --profile ${slot}`;
  return [
    `set in .env.local for slot ${slot} (RAG_FT_SLOT_${letter}_BASE_URL and RAG_FT_EMBED_API_KEY stay as configured):`,
    `  RAG_FT_SLOT_${letter}_MODEL=${version.id}`,
    `  RAG_FT_SLOT_${letter}_QUERY_PROMPT=${JSON.stringify(version.queryPrompt)}`,
    `  RAG_FT_SLOT_${letter}_DOCUMENT_PROMPT=${JSON.stringify(version.documentPrompt)}`,
    `then: npm run rag:embedding -- ft-check ${slot} must pass before ${backfill}`,
  ];
}

/** The retention command for a revoked tenant (D-31); `root` adds --root. */
export function pruneCommand(tenantKey: string, root: string | null): string[] {
  return ['uv', 'run', '--directory', 'eval', 'python', '-m', 'rag_eval.finetune', 'prune', '--tenant', tenantKey, ...(root ? ['--root', root] : [])];
}
