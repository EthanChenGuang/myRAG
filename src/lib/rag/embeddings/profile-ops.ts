import type { RpcError } from '../backend/supabase-rpc';
import type { EmbeddingProfile, StartupVerdict } from './active-profile';
import {
  LEGACY_PROFILE,
  ProfileUnavailableError,
  getStartupVerdict,
  isEmbeddingProfilesEnabled,
  listEmbeddingProfiles,
  refreshAfterOperation,
  requireRegistryClient,
} from './active-profile';

export interface ProfileRefusal {
  ok: false;
  /** The gate's own prefix and code, for example `activation_refused: incomplete`. */
  reason: string;
  /** The full message the SQL function raised. */
  detail: string;
}

export interface EmbeddingProfileStatus {
  switch: 'off' | 'on';
  /** The profile queries use right now: the legacy profile while the switch is off. */
  active: EmbeddingProfile;
  profiles: EmbeddingProfile[];
  startup: StartupVerdict;
}

export type ActivateResult = { ok: true; activated: string; previous: string | null } | ProfileRefusal;
export type RollbackResult = { ok: true; restored: string; rolledBack: string } | ProfileRefusal;
export type SetStatusResult = { ok: true; profileId: string; status: string } | ProfileRefusal;

const REFUSAL = /^((?:activation|rollback|profile_status)_refused): ([a-z_]+)/;

function refusalFrom(error: RpcError): ProfileRefusal | null {
  const match = REFUSAL.exec(error.message);
  if (!match) return null;
  return { ok: false, reason: `${match[1]}: ${match[2]}`, detail: error.message };
}

function firstRow(data: unknown[] | null): Record<string, unknown> | null {
  const row = data?.[0];
  return typeof row === 'object' && row !== null ? (row as Record<string, unknown>) : null;
}

function text(row: Record<string, unknown>, key: string): string | null {
  const value = row[key];
  return typeof value === 'string' ? value : null;
}

async function callGate(fn: string, args: Record<string, unknown>): Promise<{ refusal: ProfileRefusal } | { row: Record<string, unknown> }> {
  const client = requireRegistryClient();
  let response;
  try {
    response = await client.rpc(fn, args);
  } catch {
    throw new ProfileUnavailableError('rpc_failed');
  }
  if (response.error) {
    const refusal = refusalFrom(response.error);
    if (refusal) return { refusal };
    throw new ProfileUnavailableError('rpc_failed', response.error.code ?? null);
  }
  const row = firstRow(response.data);
  if (!row) throw new ProfileUnavailableError('rpc_failed', 'empty_response');
  return { row };
}

/** The registry, the switch, the profile queries use right now and the startup verdict. Read fresh, never from the cache. */
export async function getEmbeddingProfileStatus(): Promise<EmbeddingProfileStatus> {
  const enabled = isEmbeddingProfilesEnabled();
  const profiles = await listEmbeddingProfiles();
  const active = enabled ? profiles.find((profile) => profile.status === 'active') : LEGACY_PROFILE;
  if (!active) throw new ProfileUnavailableError('no_active_profile');
  return { switch: enabled ? 'on' : 'off', active, profiles, startup: getStartupVerdict() };
}

/** Flips the pointer through the gate. A refusal comes back with the gate's own reason; success refreshes the cached pointer. */
export async function activateEmbeddingProfile(target: string, actor: string): Promise<ActivateResult> {
  const outcome = await callGate('rag_activate_embedding_profile', { p_target: target, p_actor: actor });
  if ('refusal' in outcome) return outcome.refusal;
  const activated = text(outcome.row, 'activated_profile');
  if (!activated) throw new ProfileUnavailableError('rpc_failed', 'malformed_response');
  await refreshAfterOperation();
  return { ok: true, activated, previous: text(outcome.row, 'previous_profile') };
}

/** Restores the previous profile when it is still complete. */
export async function rollbackEmbeddingProfile(actor: string): Promise<RollbackResult> {
  const outcome = await callGate('rag_rollback_embedding_profile', { p_actor: actor });
  if ('refusal' in outcome) return outcome.refusal;
  const restored = text(outcome.row, 'restored_profile');
  const rolledBack = text(outcome.row, 'rolled_back_profile');
  if (!restored || !rolledBack) throw new ProfileUnavailableError('rpc_failed', 'malformed_response');
  await refreshAfterOperation();
  return { ok: true, restored, rolledBack };
}

/** Moves a profile between available, backfilling and retired. Activation only goes through the gate. */
export async function setEmbeddingProfileStatus(profileId: string, status: string, actor: string): Promise<SetStatusResult> {
  const outcome = await callGate('rag_set_embedding_profile_status', { p_profile_id: profileId, p_status: status, p_actor: actor });
  if ('refusal' in outcome) return outcome.refusal;
  const id = text(outcome.row, 'profile_id');
  const next = text(outcome.row, 'profile_status');
  if (!id || !next) throw new ProfileUnavailableError('rpc_failed', 'malformed_response');
  await refreshAfterOperation();
  return { ok: true, profileId: id, status: next };
}
