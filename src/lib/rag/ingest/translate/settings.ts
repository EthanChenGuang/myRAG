export type TranslationSettingsFailure = 'unavailable';

export async function getTranslationSettings(_input: { tenantKey: string; signal: AbortSignal }): Promise<{ ok: false; reason: TranslationSettingsFailure }> {
  return { ok: false, reason: 'unavailable' };
}

export async function setTranslationSettings(_input: {
  actorUserId: string;
  tenantKey: string;
  enabled: boolean;
  targets: string[];
  signal: AbortSignal;
}): Promise<{ ok: false; reason: TranslationSettingsFailure }> {
  return { ok: false, reason: 'unavailable' };
}

export async function translationCoverage(_input: { tenantKey: string; signal: AbortSignal }): Promise<{ ok: false; reason: TranslationSettingsFailure }> {
  return { ok: false, reason: 'unavailable' };
}
