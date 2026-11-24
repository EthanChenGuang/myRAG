import type { EmbeddingStorage } from './types';

export type EmbeddingProfileStatus = 'available' | 'backfilling' | 'active' | 'retired';

export interface EmbeddingProfile {
  id: string;
  provider: string;
  model: string;
  dims: number;
  storage: EmbeddingStorage;
  status: EmbeddingProfileStatus;
  queryInstruction: string | null;
  scoreCalibration: Record<string, number>;
  activatedAt: string | null;
  activatedBy: string | null;
  previousActiveId: string | null;
  hasEvidence: boolean;
}

export type ProfileUnavailableReason =
  | 'no_admin_client'
  | 'read_failed'
  | 'read_timeout'
  | 'no_active_profile'
  | 'multiple_active_profiles'
  | 'malformed_active_profile'
  | 'rpc_failed';

export class ProfileUnavailableError extends Error {
  readonly reason: ProfileUnavailableReason;
  readonly code: string | null;

  constructor(reason: ProfileUnavailableReason, code: string | null = null) {
    super(`[Embedding Profile] registry unavailable (${reason}${code ? `, ${code}` : ''})`);
    this.name = 'ProfileUnavailable';
    this.reason = reason;
    this.code = code;
  }
}

export const LEGACY_PROFILE: EmbeddingProfile = {
  id: 'openai-3-small-1536',
  provider: 'openai',
  model: 'text-embedding-3-small',
  dims: 1536,
  storage: 'legacy_column',
  status: 'active',
  queryInstruction: null,
  scoreCalibration: { retrieval_threshold: 0.7, context_threshold: 0.65, fallback_threshold: 0.28, context_image_threshold: 0.25 },
  activatedAt: null,
  activatedBy: null,
  previousActiveId: null,
  hasEvidence: false,
};

export type StartupMismatchReason = 'provider_unconfigured' | 'model_mismatch' | 'dims_unsupported';

export type StartupVerdict =
  | { status: 'unknown'; reason: 'not_checked' | 'timeout' | 'profile_unavailable'; checkedAt: number | null }
  | { status: 'skipped'; checkedAt: number }
  | { status: 'ok'; profile: string; model: string; dims: number; checkedAt: number }
  | { status: 'mismatch'; reason: StartupMismatchReason; profile: string; model: string; dims: number; checkedAt: number };

export function isEmbeddingProfilesEnabled(): boolean {
  return false;
}

export async function getActiveProfile(): Promise<EmbeddingProfile> {
  return LEGACY_PROFILE;
}

export async function refreshActiveProfile(): Promise<EmbeddingProfile> {
  return LEGACY_PROFILE;
}

export async function getBackfillingProfiles(): Promise<EmbeddingProfile[]> {
  return [];
}

export function getStartupVerdict(): StartupVerdict {
  return { status: 'unknown', reason: 'not_checked', checkedAt: null };
}

export async function verifyActiveEmbeddingProfileAtStartup(_options: { timeoutMs?: number } = {}): Promise<StartupVerdict> {
  return getStartupVerdict();
}

export function resetActiveProfileForTests(): void {}
