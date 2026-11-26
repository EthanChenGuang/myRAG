import { afterEach, describe, expect, test, vi } from 'vitest';

const SLOT_NAMES = [
  'RAG_FT_EMBED_API_KEY',
  'RAG_FT_SLOT_A_BASE_URL',
  'RAG_FT_SLOT_A_MODEL',
  'RAG_FT_SLOT_A_QUERY_PROMPT',
  'RAG_FT_SLOT_A_DOCUMENT_PROMPT',
  'RAG_FT_SLOT_B_BASE_URL',
  'RAG_FT_SLOT_B_MODEL',
  'RAG_FT_SLOT_B_QUERY_PROMPT',
  'RAG_FT_SLOT_B_DOCUMENT_PROMPT',
] as const;

async function loadEnv(overrides: Record<string, string | undefined>) {
  for (const [name, value] of Object.entries(overrides)) {
    if (value === undefined) vi.stubEnv(name, undefined as unknown as string);
    else vi.stubEnv(name, value);
  }
  vi.resetModules();
  const mod = await import('@/lib/env');
  return mod.env as Record<string, unknown>;
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe('RAG_FINETUNE parsing (06.1 D-02)', () => {
  test("exact 'on' turns the switch on", async () => {
    expect((await loadEnv({ RAG_FINETUNE: 'on' })).RAG_FINETUNE).toBe('on');
  });

  test.each([[undefined], [''], ['true'], ['ON '], ['On'], ['yes'], ['1'], [' on']])(
    'any other value (%j) fails closed to off',
    async (value) => {
      expect((await loadEnv({ RAG_FINETUNE: value })).RAG_FINETUNE).toBe('off');
    },
  );

  test('the slot settings and key are strings that default to empty', async () => {
    const unset = Object.fromEntries(SLOT_NAMES.map((name) => [name, undefined]));
    const env = await loadEnv(unset);
    for (const name of SLOT_NAMES) expect(env[name], name).toBe('');
  });

  test('the slot settings pass through unchanged', async () => {
    const env = await loadEnv({ RAG_FT_SLOT_A_MODEL: 'example-model-v1', RAG_FT_SLOT_B_QUERY_PROMPT: 'query: ' });
    expect(env.RAG_FT_SLOT_A_MODEL).toBe('example-model-v1');
    expect(env.RAG_FT_SLOT_B_QUERY_PROMPT).toBe('query: ');
  });
});
