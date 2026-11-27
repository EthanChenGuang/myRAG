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

describe('Phase 5.2 eval trace fields (05.2-31, D-62 a)', () => {
  test('nothing while every Phase 5.2 switch is off, whatever the inputs say', async () => {
    const trace = await import('@/lib/rag-eval/trace');
    expect(typeof trace.answerRulesTraceFields).toBe('function');
    expect(
      trace.answerRulesTraceFields({
        anyNonDefault: false,
        answerLanguage: 'en',
        refusedByServer: true,
        refusedByModel: true,
        finishReason: 'length',
        parts: ['relevance'],
      }),
    ).toEqual({});
  });

  test('the fields validate against RagTrace and the refusal origin names who refused', async () => {
    const trace = await import('@/lib/rag-eval/trace');
    expect(typeof trace.answerRulesTraceFields).toBe('function');
    const counts = {
      mode: 'enforce' as const,
      rules_version: 'abcdef012345',
      links_checked: 2,
      links_removed: 1,
      credential_blocked: 1,
      credential_warned: 0,
      rule_ids: ['cred.en.request-secret', 'Not A Rule Id'],
    };
    const fields = trace.answerRulesTraceFields({
      anyNonDefault: true,
      answerLanguage: 'en',
      refusedByServer: false,
      refusedByModel: true,
      finishReason: 'Weird Reason',
      parts: ['relevance', 'output_policy'],
      notices: [{ kind: 'credential_request_blocked', text: 'Blocked.', language: 'en' }],
      outputGuard: trace.outputGuardTraceSummary(counts, ['chunk-1']),
      residual: trace.residualOutputFindings(counts),
      mixedVersions: false,
    });
    expect(fields.refusal_origin).toBe('model_relevance');
    expect(fields.finish_reason).toBe('other');
    expect(fields.residual_output_findings).toEqual({ links: 1, credential_matches: 1, rule_ids: ['cred.en.request-secret'] });
    expect(fields.output_guard?.source_chunk_ids).toEqual(['chunk-1']);
    const base = {
      query: 'q',
      query_context: { is_financial_query: false, is_temporal_query: false, required_precision: 'medium', search_strategy: 'semantic_only', suggested_threshold: 0.3 },
      retrieval_strategy: 'fake',
      candidates: [],
      kept: [],
      used_documents: [],
      context: '',
      refused: true,
      answer: null,
      citations: [],
      stage_latency_ms: {},
      stage_status: {},
      effective_config: buildEffectiveConfig(),
      config_hash: 'x'.repeat(64),
    };
    const parsed = RagTraceSchema.safeParse({ ...base, ...fields });
    expect(parsed.success).toBe(true);
    expect(trace.answerRulesTraceFields({ anyNonDefault: true, answerLanguage: null, refusedByServer: true, refusedByModel: false }).refusal_origin).toBe('server');
  });
});
