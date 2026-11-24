import type { EmbeddingProfile, StartupVerdict } from './active-profile';
import { LEGACY_PROFILE, getStartupVerdict } from './active-profile';

export interface ProfileRefusal {
  ok: false;
  reason: string;
  detail: string;
}

export interface EmbeddingProfileStatus {
  switch: 'off' | 'on';
  active: EmbeddingProfile;
  profiles: EmbeddingProfile[];
  startup: StartupVerdict;
}

export type ActivateResult = { ok: true; activated: string; previous: string | null } | ProfileRefusal;
export type RollbackResult = { ok: true; restored: string; rolledBack: string } | ProfileRefusal;
export type SetStatusResult = { ok: true; profileId: string; status: string } | ProfileRefusal;

const NOT_IMPLEMENTED: ProfileRefusal = { ok: false, reason: 'not_implemented', detail: '' };

export async function getEmbeddingProfileStatus(): Promise<EmbeddingProfileStatus> {
  return { switch: 'off', active: LEGACY_PROFILE, profiles: [], startup: getStartupVerdict() };
}

export async function activateEmbeddingProfile(_target: string, _actor: string): Promise<ActivateResult> {
  return NOT_IMPLEMENTED;
}

export async function rollbackEmbeddingProfile(_actor: string): Promise<RollbackResult> {
  return NOT_IMPLEMENTED;
}

export async function setEmbeddingProfileStatus(_profileId: string, _status: string, _actor: string): Promise<SetStatusResult> {
  return NOT_IMPLEMENTED;
}
