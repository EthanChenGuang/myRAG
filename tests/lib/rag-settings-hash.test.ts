import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';
import { isSecretEnvName } from '@/lib/config-env-allowlist';
import { RAG_AFFECTING_NAMES, isSecretName, ragAffectingDiff, ragSettingsCanonical, ragSettingsHash } from '@/lib/rag';

const require = createRequire(import.meta.url);
const { isSecretConfigEntry } = require('../../scripts/config-server-security.js') as {
  isSecretConfigEntry: (name: string, value: string) => boolean;
};
const vector = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'tests/fixtures/rag-settings-hash-vector.json'), 'utf8')) as {
  values: Record<string, string>;
  names: string[];
  canonical: string;
  hash: string;
};

const NAME_TABLE: Array<[string, boolean]> = [
  ['RAG_MONITOR_WEBHOOK_URL', true],
  ['RAG_MONITOR_WEBHOOK_SECRET', true],
  ['RAG_MONITOR', false],
  ['RAG_CONFIG_GATE', false],
  ['COHERE_API_KEY', true],
  ['LANGFUSE_PUBLIC_KEY', true],
  ['SUPABASE_SERVICE_ROLE_KEY', true],
  ['REDIS_URL', true],
  ['MCP_CUSTOM_SERVERS', true],
  ['MCP_EXAMPLE_ENDPOINT', true],
  ['RAG_VOICE_TOKEN_SECRET', true],
  ['RAG_VOICE_TOKEN_TTL_SECONDS', false],
  ['RAG_CONTEXT_TOKEN_BUDGET', false],
  ['RAG_GROUNDEDNESS_MAX_PREMISE_TOKENS', false],
  ['RAG_MAX_KEY_TERMS', false],
  ['MAX_COMPLETION_TOKENS', false],
  ['RAG_PIPELINE', false],
  ['NEXT_PUBLIC_AI_PROVIDER', false],
];

describe('rag_settings_hash (D-12)', () => {
  it('the TypeScript entry reproduces the shared vector', () => {
    expect(ragSettingsCanonical(vector.values, vector.names)).toBe(vector.canonical);
    expect(ragSettingsHash(vector.values, vector.names)).toBe(vector.hash);
  });

  it('keeps prompt and secret text out of the canonical input', () => {
    const canonical = ragSettingsCanonical(vector.values, vector.names);
    expect(canonical).not.toContain(vector.values.RAG_SYSTEM_PROMPT);
    expect(canonical).not.toContain(vector.values.RAG_PRE_CONTEXT);
    expect(canonical).not.toContain(vector.values.COHERE_API_KEY);
  });

  it('diffs only the listed names', () => {
    expect(ragAffectingDiff({ RAG_PIPELINE: 'legacy' }, { RAG_PIPELINE: 'v2', OTHER: 'x' }, ['RAG_PIPELINE'])).toEqual(['RAG_PIPELINE']);
  });

  it('exports the generated RAG-affecting names without gate switches or secrets', () => {
    expect(RAG_AFFECTING_NAMES).toContain('RAG_BEHAVIOR_MODE');
    expect(RAG_AFFECTING_NAMES).toContain('NEXT_PUBLIC_MYRAG_DEPLOYMENT_MODE');
    expect(RAG_AFFECTING_NAMES).not.toContain('RAG_CONFIG_GATE');
    expect(RAG_AFFECTING_NAMES.filter((name) => isSecretName(name))).toEqual([]);
  });
});

describe('one secret-name rule (O-3 item 5)', () => {
  it.each(NAME_TABLE)('%s is classified the same by the config server and the app', (name, secret) => {
    expect(isSecretName(name)).toBe(secret);
    expect(isSecretEnvName(name)).toBe(secret);
    expect(isSecretConfigEntry(name, '')).toBe(secret);
  });
});
