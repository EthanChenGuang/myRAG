import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  AUTO_MODEL_ID,
  defaultModelId,
  isAutoModelSelectable,
  resetAutoModelLogForTests,
  resolveStoredAutoModel,
  withoutUnselectableAuto,
  type AutoModelRouting,
} from '@/lib/chat/auto-model';
import { makeEnvDir, request } from '../helpers/admin-guard-fixture';

const FAST = 'vendor/model-fast';
const QUALITY = 'vendor/model-quality';
const DEFAULT = 'vendor/model-default';

const LIST = [
  { id: DEFAULT, displayName: 'Default model', isDefault: true },
  { id: AUTO_MODEL_ID, displayName: 'Auto' },
  { id: FAST, displayName: 'Fast model' },
  { id: QUALITY, displayName: 'Quality model' },
];

const ON: AutoModelRouting = { mode: 'auto', fastModel: FAST, qualityModel: QUALITY };
const OFF: AutoModelRouting = { mode: 'off', fastModel: FAST, qualityModel: QUALITY };

const routing: { value: AutoModelRouting | null } = { value: null };

const ids = (models: Array<{ id: string }>) => models.map((m) => m.id);

describe('Auto model visibility (pure)', () => {
  it('routing off: the list has no Auto entry', () => {
    expect(isAutoModelSelectable(OFF, LIST)).toBe(false);
    expect(ids(withoutUnselectableAuto(LIST, isAutoModelSelectable(OFF, LIST)))).not.toContain(AUTO_MODEL_ID);
  });

  it('routing on with both ids listed: the list keeps Auto in place', () => {
    expect(isAutoModelSelectable(ON, LIST)).toBe(true);
    expect(ids(withoutUnselectableAuto(LIST, true))).toEqual([DEFAULT, AUTO_MODEL_ID, FAST, QUALITY]);
  });

  it('routing on but a routing id empty, auto or not listed: no Auto entry', () => {
    expect(isAutoModelSelectable({ ...ON, fastModel: '' }, LIST)).toBe(false);
    expect(isAutoModelSelectable({ ...ON, qualityModel: '  ' }, LIST)).toBe(false);
    expect(isAutoModelSelectable({ ...ON, fastModel: AUTO_MODEL_ID }, LIST)).toBe(false);
    expect(isAutoModelSelectable({ ...ON, qualityModel: 'vendor/not-listed' }, LIST)).toBe(false);
    expect(isAutoModelSelectable(null, LIST)).toBe(false);
  });

  it('hiding removes only the Auto entry and keeps the rest in order', () => {
    expect(ids(withoutUnselectableAuto(LIST, false))).toEqual([DEFAULT, FAST, QUALITY]);
  });
});

describe('a stored Auto selection falls back to the default model', () => {
  beforeEach(() => resetAutoModelLogForTests());
  afterEach(() => vi.restoreAllMocks());

  it('the default model is the isDefault entry, never auto', () => {
    expect(defaultModelId(LIST, 'vendor/fallback')).toBe(DEFAULT);
    expect(defaultModelId([{ id: AUTO_MODEL_ID, isDefault: true }, { id: FAST }], 'vendor/fallback')).toBe(FAST);
    expect(defaultModelId([], 'vendor/fallback')).toBe('vendor/fallback');
  });

  it('auto resolves to the default model, logs once and does not throw', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(resolveStoredAutoModel(AUTO_MODEL_ID, DEFAULT, 'chat')).toBe(DEFAULT);
    expect(resolveStoredAutoModel(AUTO_MODEL_ID, DEFAULT, 'chat')).toBe(DEFAULT);
    const lines = warn.mock.calls.filter((call) => String(call[0]).startsWith('[Model Selection]'));
    expect(lines).toHaveLength(1);
  });

  it('an explicit model and an empty selection pass through unchanged', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(resolveStoredAutoModel(FAST, DEFAULT, 'chat')).toBe(FAST);
    expect(resolveStoredAutoModel(undefined, DEFAULT, 'chat')).toBeUndefined();
    expect(warn).not.toHaveBeenCalled();
  });
});

describe('GET /api/config/models?for=chat', () => {

  beforeEach(() => {
    vi.resetModules();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.doMock('@/lib/rag', async (importOriginal) => {
      const actual = await importOriginal<Record<string, unknown>>();
      return { ...actual, currentModelRouting: () => routing.value };
    });
    makeEnvDir([`NEXT_PUBLIC_AI_PROVIDER=openrouter`, `NEXT_PUBLIC_OPENROUTER_MODELS=${JSON.stringify(LIST)}`, ''].join('\n'));
  });

  afterEach(() => {
    vi.doUnmock('@/lib/rag');
    vi.restoreAllMocks();
  });

  async function get(query: string) {
    const route = await import('@/app/api/config/models/route');
    const res = await route.GET(request(`/api/config/models${query}`));
    expect(res.status).toBe(200);
    return (await res.json()) as { openrouterModels: Array<{ id: string }> };
  }

  it('routing off: the chat list has no Auto entry', async () => {
    routing.value = OFF;
    expect(ids((await get('?for=chat')).openrouterModels)).toEqual([DEFAULT, FAST, QUALITY]);
  });

  it('routing on with both ids configured: the chat list has Auto', async () => {
    routing.value = ON;
    expect(ids((await get('?for=chat')).openrouterModels)).toContain(AUTO_MODEL_ID);
  });

  it('the Config UI read (no for=chat) keeps the stored Auto entry, so a save never deletes it', async () => {
    routing.value = OFF;
    expect(ids((await get('')).openrouterModels)).toContain(AUTO_MODEL_ID);
  });
});
