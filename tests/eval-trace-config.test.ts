import { afterEach, describe, expect, test } from 'vitest';
import { buildEffectiveConfig, configHash } from '@/lib/rag-eval/trace';
import { injectionTraceVersions } from '@/lib/rag';
import { RagTraceSchema } from '@/lib/rag-eval/contracts.generated';
import { detectorsConfigVersion } from '@/lib/rag/security/detectors';
import { injectionRulesVersion } from '@/lib/rag/security/injection-rules';

const env = process.env as Record<string, string | undefined>;
const NAMES = [
  'RAG_DB_PASSWD',
  'RAG_STORE_CREDENTIALS',
  'RAG_UPSTREAM_AUTH',
  'RAG_VECTOR_DSN',
  'RAG_PRIVATE_NOTE',
  'RAG_UPSTREAM_URL',
  'RAG_MULTI_PASS',
  'RAG_EVAL_ALLOWED_SCOPES',
];

afterEach(() => {
  for (const name of NAMES) delete env[name];
});

describe('buildEffectiveConfig rag_env', () => {
  test('drops credential-like names, URLs with credentials and eval access settings', () => {
    env.RAG_DB_PASSWD = 'placeholder';
    env.RAG_STORE_CREDENTIALS = 'placeholder';
    env.RAG_UPSTREAM_AUTH = 'placeholder';
    env.RAG_VECTOR_DSN = 'placeholder';
    env.RAG_PRIVATE_NOTE = 'placeholder';
    env.RAG_UPSTREAM_URL = 'https://user:placeholder@vectors.example.com/db';
    env.RAG_EVAL_ALLOWED_SCOPES = 'org:11111111-1111-4111-8111-111111111111';
    env.RAG_MULTI_PASS = 'true';

    const { rag_env: ragEnv } = buildEffectiveConfig();
    for (const name of NAMES.filter((name) => name !== 'RAG_MULTI_PASS')) {
      expect(ragEnv).not.toHaveProperty(name);
    }
    expect(ragEnv.RAG_MULTI_PASS).toBe('true');
  });
});

describe('buildEffectiveConfig security block (D-18)', () => {
  const saved = env.RAG_INJECTION_CHECK;
  afterEach(() => {
    if (saved === undefined) delete env.RAG_INJECTION_CHECK;
    else env.RAG_INJECTION_CHECK = saved;
  });

  test('carries the rules and detector config versions when the injection check is on', () => {
    env.RAG_INJECTION_CHECK = 'drop';
    const config = buildEffectiveConfig({ security: injectionTraceVersions() });
    expect(config.security).toEqual({ rules_version: injectionRulesVersion(), detectors_version: detectorsConfigVersion() });
    expect(RagTraceSchema.shape.effective_config.parse(config)).toMatchObject({ security: config.security });
  });

  test('omits the block when the check is unset or off', () => {
    delete env.RAG_INJECTION_CHECK;
    expect(injectionTraceVersions()).toBeNull();
    const unset = buildEffectiveConfig({ security: injectionTraceVersions() });
    expect(unset).not.toHaveProperty('security');
    expect(RagTraceSchema.shape.effective_config.parse(unset).security).toBeNull();
    env.RAG_INJECTION_CHECK = 'off';
    expect(buildEffectiveConfig({ security: injectionTraceVersions() })).not.toHaveProperty('security');
    expect(buildEffectiveConfig()).not.toHaveProperty('security');
  });

  test('with the check on the config hash covers the security block', () => {
    env.RAG_INJECTION_CHECK = 'flag';
    const on = buildEffectiveConfig({ security: injectionTraceVersions() });
    expect(on.security).toBeDefined();
    const changed = { ...on, security: { ...on.security!, rules_version: 'other' } };
    expect(configHash(changed)).not.toBe(configHash(on));
  });
});
