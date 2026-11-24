import type { SupabaseClient } from '@supabase/supabase-js';
import { getRagDeps } from '@/lib/rag/deps';
import { getProcessingProfile, type DocType, type ProcessingProfile } from '../profiles/load';

export type ParseTier = NonNullable<ProcessingProfile['min_tier']>;

export interface EffectiveTierBounds {
  min_tier: ParseTier;
  max_tier: ParseTier;
}

export interface TierBoundsDeps {
  admin: () => Pick<SupabaseClient, 'from'> | null;
}

const defaults: TierBoundsDeps = {
  admin: () => getRagDeps().adminClient(),
};

let overrides: Partial<TierBoundsDeps> = {};

export function getTierBoundsDeps(): TierBoundsDeps {
  return { ...defaults, ...overrides };
}

export function setTierBoundsDepsForTests(partial: Partial<TierBoundsDeps>): void {
  overrides = { ...overrides, ...partial };
}

export function resetTierBoundsDepsForTests(): void {
  overrides = {};
}

type OverrideRow = { min_tier: string; max_tier: string };

/**
 * Admin override from rag_parse_tier_overrides when present, otherwise the processing profile bounds (D-13).
 */
export async function effectiveTierBounds(docType: DocType, deps: TierBoundsDeps = getTierBoundsDeps()): Promise<EffectiveTierBounds> {
  const profile = getProcessingProfile(docType);
  const min = profile.min_tier;
  const max = profile.max_tier;
  if (!min || !max) {
    throw new Error('[Ingest] profile missing tier bounds');
  }
  const admin = deps.admin();
  if (!admin) return { min_tier: min, max_tier: max };

  const { data, error } = await admin.from('rag_parse_tier_overrides').select('min_tier, max_tier').eq('doc_type', docType).maybeSingle();
  if (error || !data) return { min_tier: min, max_tier: max };
  const row = data as OverrideRow;
  return { min_tier: row.min_tier as ParseTier, max_tier: row.max_tier as ParseTier };
}