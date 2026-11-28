/**
 * The Auto model entry (06.2-02) stays in the five model lists, but no server path resolves it before 06.2-29/35.
 * The chat selector shows it only while model routing is effective and both routing ids are listed; a stored
 * Auto selection falls back to the default model.
 */
export const AUTO_MODEL_ID = 'auto';

export interface AutoModelRouting {
  mode: 'off' | 'auto';
  fastModel: string;
  qualityModel: string;
}

function entryId(entry: unknown): string | null {
  const id = (entry as { id?: unknown } | null)?.id;
  return typeof id === 'string' && id !== '' ? id : null;
}

export function isAutoModelSelectable(routing: AutoModelRouting | null | undefined, models: readonly unknown[]): boolean {
  if (!routing || routing.mode !== 'auto') return false;
  const listed = new Set(models.map(entryId).filter((id): id is string => id !== null));
  return [routing.fastModel, routing.qualityModel].every((raw) => {
    const id = typeof raw === 'string' ? raw.trim() : '';
    return id !== '' && id !== AUTO_MODEL_ID && listed.has(id);
  });
}

export function withoutUnselectableAuto<T>(models: T[], selectable: boolean): T[] {
  return selectable ? models : models.filter((entry) => entryId(entry) !== AUTO_MODEL_ID);
}

export function defaultModelId(models: readonly unknown[], fallback: string): string {
  const concrete = models.filter((entry) => {
    const id = entryId(entry);
    return id !== null && id !== AUTO_MODEL_ID;
  });
  const marked = concrete.find((entry) => (entry as { isDefault?: unknown }).isDefault === true);
  return entryId(marked ?? concrete[0]) ?? fallback;
}

export function parseModelList(raw: string | undefined): unknown[] {
  try {
    const parsed: unknown = JSON.parse(raw || '[]');
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

const loggedSurfaces = new Set<string>();

export function resolveStoredAutoModel(requested: string | null | undefined, fallback: string, surface: string): string | undefined {
  if (requested !== AUTO_MODEL_ID) return requested ?? undefined;
  if (!loggedSurfaces.has(surface)) {
    loggedSurfaces.add(surface);
    console.warn('[Model Selection] Auto is not resolvable yet, using the default model', { surface, model: fallback });
  }
  return fallback;
}

export function resetAutoModelLogForTests(): void {
  loggedSurfaces.clear();
}
