import { afterEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_LAKERA_BASE_URL, readSecurityConfig } from '@/lib/rag/security/config';

const BOOLEAN_SWITCHES = [
  ['RAG_CONTEXT_TAGGING', 'contextTagging'],
  ['RAG_INJECTION_PROMPT_GUARD', 'promptGuard'],
  ['RAG_INJECTION_LAKERA', 'lakera'],
  ['RAG_INJECTION_LAKERA_MULTI_TENANT_ACK', 'lakeraMultiTenantAck'],
] as const;

const PLACEHOLDER_KEY = 'placeholder-lakera-key-0000000000000000';

function allText(value: unknown): string {
  return JSON.stringify(value);
}

describe('readSecurityConfig', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('returns every switch off with an empty environment', () => {
    expect(DEFAULT_LAKERA_BASE_URL).toBe('https://api.lakera.ai');
    const config = readSecurityConfig({});
    expect(config).toEqual({
      contextTagging: false,
      injectionCheck: 'off',
      promptGuard: false,
      lakera: false,
      lakeraApiKey: null,
      lakeraBaseUrl: 'https://api.lakera.ai',
      lakeraMultiTenantAck: false,
      toolResultGuard: 'off',
      anyNonDefault: false,
      warnings: [],
    });
    expect(Object.isFrozen(config)).toBe(true);
    expect(Object.isFrozen(config.warnings)).toBe(true);
  });

  it('reports the init-env defaults as no change', () => {
    const config = readSecurityConfig({
      RAG_CONTEXT_TAGGING: 'false',
      RAG_INJECTION_CHECK: 'off',
      RAG_INJECTION_PROMPT_GUARD: 'false',
      RAG_INJECTION_LAKERA: 'false',
      LAKERA_GUARD_API_KEY: '',
      LAKERA_GUARD_BASE_URL: '',
      RAG_INJECTION_LAKERA_MULTI_TENANT_ACK: 'false',
      RAG_TOOL_RESULT_GUARD: 'off',
    });
    expect(config.anyNonDefault).toBe(false);
    expect(config.warnings).toEqual([]);
  });

  it.each(BOOLEAN_SWITCHES)('turns %s on only for the literal true, trimmed', (name, field) => {
    for (const raw of ['TRUE', 'True', '1', 'yes', 'on', '']) {
      expect(readSecurityConfig({ [name]: raw })[field]).toBe(false);
    }
    expect(readSecurityConfig({ [name]: 'true' })[field]).toBe(true);
    expect(readSecurityConfig({ [name]: '  true \n' })[field]).toBe(true);
  });

  it('accepts the four injection check modes and falls back to off for anything else', () => {
    for (const mode of ['off', 'flag', 'drop', 'downweight'] as const) {
      const config = readSecurityConfig({ RAG_INJECTION_CHECK: ` ${mode} ` });
      expect(config.injectionCheck).toBe(mode);
      expect(config.warnings).toEqual([]);
    }
    for (const raw of ['DROP', 'block', 'quarantine']) {
      const config = readSecurityConfig({ RAG_INJECTION_CHECK: raw });
      expect(config.injectionCheck).toBe('off');
      expect(config.warnings.map((w) => w.code)).toEqual(['invalid_injection_check']);
      expect(allText(config.warnings)).not.toContain(raw);
    }
  });

  it('accepts the three tool result guard modes and falls back to off for anything else', () => {
    for (const mode of ['off', 'tag', 'tag_and_flag'] as const) {
      expect(readSecurityConfig({ RAG_TOOL_RESULT_GUARD: mode }).toolResultGuard).toBe(mode);
    }
    const config = readSecurityConfig({ RAG_TOOL_RESULT_GUARD: 'flag' });
    expect(config.toolResultGuard).toBe('off');
    expect(config.warnings.map((w) => w.code)).toEqual(['invalid_tool_result_guard']);
    expect(allText(config.warnings)).not.toContain('"flag"');
    expect(allText(config.warnings.map((w) => w.message))).not.toMatch(/\bflag\b/);
  });

  it('normalises the Lakera base URL and allows https or loopback http only', () => {
    expect(readSecurityConfig({ LAKERA_GUARD_BASE_URL: 'https://eu.api.lakera.ai/' }).lakeraBaseUrl).toBe(
      'https://eu.api.lakera.ai',
    );
    expect(readSecurityConfig({ LAKERA_GUARD_BASE_URL: '   ' }).lakeraBaseUrl).toBe(DEFAULT_LAKERA_BASE_URL);
    expect(readSecurityConfig({ LAKERA_GUARD_BASE_URL: 'http://127.0.0.1:4011' }).lakeraBaseUrl).toBe(
      'http://127.0.0.1:4011',
    );
    expect(readSecurityConfig({ LAKERA_GUARD_BASE_URL: 'http://localhost:4011/' }).lakeraBaseUrl).toBe(
      'http://localhost:4011',
    );

    for (const raw of ['http://attacker.example', 'http://127.0.0.1.attacker.example', 'ftp://api.lakera.ai']) {
      const config = readSecurityConfig({ LAKERA_GUARD_BASE_URL: raw });
      expect(config.lakeraBaseUrl).toBe(DEFAULT_LAKERA_BASE_URL);
      expect(config.warnings.map((w) => w.code)).toEqual(['insecure_lakera_base_url']);
      expect(allText(config.warnings)).not.toContain('attacker');
    }

    for (const raw of ['not a url', 'https://user:secret@api.lakera.ai']) {
      const config = readSecurityConfig({ LAKERA_GUARD_BASE_URL: raw });
      expect(config.lakeraBaseUrl).toBe(DEFAULT_LAKERA_BASE_URL);
      expect(config.warnings.map((w) => w.code)).toEqual(['invalid_lakera_base_url']);
      expect(allText(config.warnings)).not.toContain('secret');
    }
  });

  it('keeps a set key, treats whitespace as unset, and never echoes the key', () => {
    expect(readSecurityConfig({ LAKERA_GUARD_API_KEY: ' \t ' }).lakeraApiKey).toBeNull();
    const config = readSecurityConfig({
      LAKERA_GUARD_API_KEY: ` ${PLACEHOLDER_KEY} `,
      RAG_INJECTION_CHECK: 'nope',
      RAG_TOOL_RESULT_GUARD: 'nope',
      LAKERA_GUARD_BASE_URL: 'http://attacker.example',
    });
    expect(config.lakeraApiKey).toBe(PLACEHOLDER_KEY);
    expect(config.warnings).toHaveLength(3);
    expect(allText(config.warnings)).not.toContain(PLACEHOLDER_KEY);
  });

  it('reads process.env on every call', () => {
    vi.stubEnv('RAG_INJECTION_CHECK', 'flag');
    expect(readSecurityConfig().injectionCheck).toBe('flag');
    vi.stubEnv('RAG_INJECTION_CHECK', 'drop');
    expect(readSecurityConfig().injectionCheck).toBe('drop');
    vi.stubEnv('RAG_CONTEXT_TAGGING', 'true');
    expect(readSecurityConfig().contextTagging).toBe(true);
  });

  it('reports anyNonDefault when any single switch differs from its default', () => {
    const changed: Record<string, string>[] = [
      { RAG_CONTEXT_TAGGING: 'true' },
      { RAG_INJECTION_CHECK: 'flag' },
      { RAG_INJECTION_PROMPT_GUARD: 'true' },
      { RAG_INJECTION_LAKERA: 'true' },
      { RAG_INJECTION_LAKERA_MULTI_TENANT_ACK: 'true' },
      { RAG_TOOL_RESULT_GUARD: 'tag' },
    ];
    for (const source of changed) {
      expect(readSecurityConfig(source).anyNonDefault).toBe(true);
    }
    expect(readSecurityConfig({ RAG_INJECTION_CHECK: 'block' }).anyNonDefault).toBe(false);
  });
});
