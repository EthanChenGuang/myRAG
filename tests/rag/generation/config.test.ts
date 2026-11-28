import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_ANTHROPIC_BASE_URL,
  readGenerationConfig,
} from '@/lib/rag/generation/config';

const BOOLEAN_SWITCHES = [
  ['RAG_CITATIONS', 'citations'],
  ['RAG_CLAUDE_CITATIONS', 'claudeCitations'],
  ['RAG_GROUNDEDNESS', 'groundedness'],
  ['RAG_GROUNDEDNESS_VECTARA_OPT_IN', 'vectaraOptIn'],
  ['RAG_GROUNDEDNESS_VECTARA_MULTI_TENANT_ACK', 'vectaraMultiTenantAck'],
  ['RAG_ANSWER_FEEDBACK', 'feedback'],
] as const;

describe('readGenerationConfig', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  it('returns every switch off with an empty environment', () => {
    expect(DEFAULT_ANTHROPIC_BASE_URL).toBe('https://api.anthropic.com/v1');
    const config = readGenerationConfig({});
    expect(config).toEqual({
      citations: false,
      claudeCitations: false,
      groundedness: false,
      vectaraOptIn: false,
      vectaraMultiTenantAck: false,
      feedback: false,
      anthropicApiKey: null,
      anthropicBaseUrl: 'https://api.anthropic.com/v1',
      groundednessTimeoutMs: 20000,
      maxPremiseTokens: 3000,
    });
    expect(Object.isFrozen(config)).toBe(true);
  });

  it('turns a switch on only for the literal true, trimmed', () => {
    for (const [name, field] of BOOLEAN_SWITCHES) {
      for (const value of ['TRUE', 'True', '1', 'yes', 'on', '', 'false']) {
        expect(readGenerationConfig({ [name]: value })[field], `${name}=${value}`).toBe(false);
      }
      expect(readGenerationConfig({ [name]: 'true' })[field], name).toBe(true);
      expect(readGenerationConfig({ [name]: '  true \n' })[field], name).toBe(true);
    }
  });

  it('treats an empty or whitespace base URL as unset and drops a trailing slash', () => {
    expect(readGenerationConfig({ ANTHROPIC_BASE_URL: '' }).anthropicBaseUrl).toBe('https://api.anthropic.com/v1');
    expect(readGenerationConfig({ ANTHROPIC_BASE_URL: '   ' }).anthropicBaseUrl).toBe('https://api.anthropic.com/v1');
    expect(readGenerationConfig({ ANTHROPIC_BASE_URL: 'http://127.0.0.1:4010/v1/' }).anthropicBaseUrl).toBe(
      'http://127.0.0.1:4010/v1',
    );
    expect(readGenerationConfig({ ANTHROPIC_BASE_URL: ' http://127.0.0.1:4010/v1// ' }).anthropicBaseUrl).toBe(
      'http://127.0.0.1:4010/v1',
    );
  });

  it('gives null for an empty key, keeps any other value, and never logs or throws it', () => {
    const spies = (['log', 'info', 'warn', 'error', 'debug'] as const).map((method) =>
      vi.spyOn(console, method).mockImplementation(() => undefined),
    );
    expect(readGenerationConfig({ ANTHROPIC_API_KEY: '' }).anthropicApiKey).toBeNull();
    expect(readGenerationConfig({ ANTHROPIC_API_KEY: '  \t ' }).anthropicApiKey).toBeNull();
    const placeholder = 'sk-ant-test-placeholder-not-real';
    let thrown: unknown = null;
    let key: string | null = null;
    try {
      key = readGenerationConfig({
        ANTHROPIC_API_KEY: placeholder,
        RAG_GROUNDEDNESS_TIMEOUT_MS: 'nonsense',
        RAG_GROUNDEDNESS_MAX_PREMISE_TOKENS: 'nonsense',
        ANTHROPIC_BASE_URL: 'not a url',
      }).anthropicApiKey;
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeNull();
    expect(key).toBe(placeholder);
    for (const spy of spies) expect(spy).not.toHaveBeenCalled();
  });

  it('falls back or clamps the groundedness timeout', () => {
    const timeout = (value: string) => readGenerationConfig({ RAG_GROUNDEDNESS_TIMEOUT_MS: value }).groundednessTimeoutMs;
    expect(timeout('abc')).toBe(20000);
    expect(timeout('')).toBe(20000);
    expect(timeout('0')).toBe(20000);
    expect(timeout('-5')).toBe(20000);
    expect(timeout('999999')).toBe(55000);
    expect(timeout('55000')).toBe(55000);
    expect(timeout(' 1500 ')).toBe(1500);
  });

  it('falls back or clamps the premise cap', () => {
    const cap = (value: string) => readGenerationConfig({ RAG_GROUNDEDNESS_MAX_PREMISE_TOKENS: value }).maxPremiseTokens;
    expect(cap('abc')).toBe(3000);
    expect(cap('')).toBe(3000);
    expect(cap('100')).toBe(256);
    expect(cap('0')).toBe(256);
    expect(cap('99999')).toBe(8000);
    expect(cap('4096')).toBe(4096);
  });

  it('reads its source on every call', () => {
    vi.stubEnv('RAG_CITATIONS', 'false');
    vi.stubEnv('RAG_GROUNDEDNESS_TIMEOUT_MS', '1000');
    const first = readGenerationConfig();
    vi.stubEnv('RAG_CITATIONS', 'true');
    vi.stubEnv('RAG_GROUNDEDNESS_TIMEOUT_MS', '2000');
    const second = readGenerationConfig();
    expect(first.citations).toBe(false);
    expect(second.citations).toBe(true);
    expect(first.groundednessTimeoutMs).toBe(1000);
    expect(second.groundednessTimeoutMs).toBe(2000);
  });
});
