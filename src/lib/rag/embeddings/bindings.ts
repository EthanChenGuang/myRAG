import type { EmbeddingProfile } from './active-profile';

export interface BindingProfile extends EmbeddingProfile {
  docTypes: string[];
}

export interface EffectiveBinding {
  bindingId: string;
  docType: string;
  tenantKey: string | null;
  profile: BindingProfile;
  stale: boolean;
}

export interface BindingTarget {
  bindingId: string;
  docType: string;
  tenantKey: string | null;
  profile: BindingProfile;
  role: 'active' | 'backfilling';
}

export async function getEffectiveBindings(_tenantKey: string): Promise<EffectiveBinding[]> {
  return [];
}

export async function getBindingTargets(_docType: string, _tenantKey: string): Promise<BindingTarget[]> {
  return [];
}

export async function refreshBindings(): Promise<void> {}

export function resetBindingsForTests(): void {}
