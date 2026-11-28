import { afterEach, describe, expect, it, vi } from 'vitest';
import { anthropicIdFor } from '@/lib/rag/generation/citations/models';

const LIST = JSON.stringify([
  { id: 'anthropic/claude-sonnet-4.5', displayName: 'Claude Sonnet 4.5', isDefault: true },
  { id: 'anthropic/claude-sonnet-5.5', displayName: 'Claude Sonnet 5.5', anthropicId: 'claude-sonnet-5-5', contextLength: 1000000 },
  { id: 'openai/gpt-4.1', displayName: 'GPT-4.1' },
]);

describe('anthropicIdFor (D-08)', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('returns the mapped Anthropic id', () => {
    expect(anthropicIdFor('anthropic/claude-sonnet-5.5', { NEXT_PUBLIC_OPENROUTER_MODELS: LIST })).toBe('claude-sonnet-5-5');
  });

  it('returns null for a listed model without anthropicId', () => {
    expect(anthropicIdFor('anthropic/claude-sonnet-4.5', { NEXT_PUBLIC_OPENROUTER_MODELS: LIST })).toBeNull();
    expect(anthropicIdFor('openai/gpt-4.1', { NEXT_PUBLIC_OPENROUTER_MODELS: LIST })).toBeNull();
  });

  it('returns null for an id that is not in the list', () => {
    expect(anthropicIdFor('anthropic/claude-opus-9', { NEXT_PUBLIC_OPENROUTER_MODELS: LIST })).toBeNull();
  });

  it('returns null for every id when the list is malformed, without throwing', () => {
    for (const raw of ['not json', '{"id":"anthropic/claude-sonnet-5.5"}', '[{"id":42}]', '[null]']) {
      expect(() => anthropicIdFor('anthropic/claude-sonnet-5.5', { NEXT_PUBLIC_OPENROUTER_MODELS: raw })).not.toThrow();
      expect(anthropicIdFor('anthropic/claude-sonnet-5.5', { NEXT_PUBLIC_OPENROUTER_MODELS: raw })).toBeNull();
    }
  });

  it('ignores an anthropicId that is not a well-formed Anthropic id or sits on a non-anthropic model', () => {
    const list = JSON.stringify([
      { id: 'anthropic/claude-x', anthropicId: 'gpt-4' },
      { id: 'openai/gpt-x', anthropicId: 'claude-sonnet-5-5' },
      { id: 'anthropic/claude-y', anthropicId: '' },
    ]);
    expect(anthropicIdFor('anthropic/claude-x', { NEXT_PUBLIC_OPENROUTER_MODELS: list })).toBeNull();
    expect(anthropicIdFor('openai/gpt-x', { NEXT_PUBLIC_OPENROUTER_MODELS: list })).toBeNull();
    expect(anthropicIdFor('anthropic/claude-y', { NEXT_PUBLIC_OPENROUTER_MODELS: list })).toBeNull();
  });

  it('reads process.env on every call', () => {
    vi.stubEnv('NEXT_PUBLIC_OPENROUTER_MODELS', LIST);
    expect(anthropicIdFor('anthropic/claude-sonnet-5.5')).toBe('claude-sonnet-5-5');
    vi.stubEnv('NEXT_PUBLIC_OPENROUTER_MODELS', JSON.stringify([{ id: 'anthropic/claude-sonnet-5.5', displayName: 'Claude Sonnet 5.5' }]));
    expect(anthropicIdFor('anthropic/claude-sonnet-5.5')).toBeNull();
  });

  it('maps the Claude 5.5 family and leaves 4.5 and 4.1 unmapped in the default list', () => {
    expect(anthropicIdFor('anthropic/claude-opus-5.5', {})).toBe('claude-opus-5-5');
    expect(anthropicIdFor('anthropic/claude-sonnet-5.5', {})).toBe('claude-sonnet-5-5');
    expect(anthropicIdFor('anthropic/claude-haiku-5.5', {})).toBe('claude-haiku-5-5');
    expect(anthropicIdFor('anthropic/claude-sonnet-4.5', {})).toBeNull();
    expect(anthropicIdFor('anthropic/claude-opus-4.1', {})).toBeNull();
  });
});
