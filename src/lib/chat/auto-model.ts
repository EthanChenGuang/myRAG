export const AUTO_MODEL_ID = 'auto';

export interface AutoModelRouting {
  mode: 'off' | 'auto';
  fastModel: string;
  qualityModel: string;
}

export function isAutoModelSelectable(_routing: AutoModelRouting | null | undefined, _models: readonly unknown[]): boolean {
  return true;
}

export function withoutUnselectableAuto<T>(models: T[], _selectable: boolean): T[] {
  return models;
}

export function defaultModelId(_models: readonly unknown[], fallback: string): string {
  return fallback;
}

export function resolveStoredAutoModel(requested: string | null | undefined, _fallback: string, _surface: string): string | undefined {
  return requested ?? undefined;
}

export function resetAutoModelLogForTests(): void {}
