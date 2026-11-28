import { afterEach, describe, expect, it, vi } from 'vitest';

// The values of the route's nested getMaxTokensForModel before it moved to module scope (05.2.1-21)
const CASES: Array<[string, number]> = [
  ['anthropic/claude-sonnet-4', 16384],
  ['anthropic/claude-4-sonnet', 16384],
  ['anthropic/claude-opus-4', 16384],
  ['anthropic/claude-4-opus', 16384],
  ['anthropic/claude-3.7-sonnet', 8192],
  ['anthropic/claude-3.8-sonnet', 8192],
  ['anthropic/claude-3-haiku', 4096],
  ['anthropic/claude-sonnet-4.5', 16384],
  ['openai/gpt-5-mini', 8192],
  ['openai/gpt-5', 4096],
  ['openai/gpt-4.1-mini', 8192],
  ['openai/gpt-4.1', 4096],
  ['meta-llama/llama-3.3-70b-instruct', 4096],
  ['openai/gpt-4o-mini', 4096],
];

async function load() {
  vi.resetModules();
  return import('@/lib/chat/model-output-limit');
}

describe('getMaxTokensForModel at module scope', () => {
  afterEach(() => {
    delete process.env.MAX_COMPLETION_TOKENS;
    vi.restoreAllMocks();
  });

  it('returns the same limits as the route did', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const { getMaxTokensForModel } = await load();
    for (const [model, limit] of CASES) expect([model, getMaxTokensForModel(model)]).toEqual([model, limit]);
  });

  it('a MAX_COMPLETION_TOKENS process variable changes nothing, as before (the env reader has no such field)', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    process.env.MAX_COMPLETION_TOKENS = '1234';
    expect((await load()).getMaxTokensForModel('openai/gpt-5')).toBe(4096);
  });
});
