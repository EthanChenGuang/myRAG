import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';
import { derivePinnedEvalEnv } from '../eval/harness/eval-env.mts';
import { parseRunConfig, RUN_CONFIG_ENV_ALLOWLIST, RunConfigError } from '../eval/harness/run-config.mts';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

describe('pinned eval env', () => {
  test('rag-eval-env.json equals the RAG_* defaults derived from scripts/init-env.js', () => {
    const derived = derivePinnedEvalEnv(fs.readFileSync(path.join(REPO_ROOT, 'scripts/init-env.js'), 'utf8'));
    const pinned = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'eval/config/rag-eval-env.json'), 'utf8'));
    expect(pinned).toEqual(derived);
  });

  test('pins the MCP system flag next to the deployment mode so eval classifies queries like production', () => {
    const derived = derivePinnedEvalEnv('');
    expect(derived.NEXT_PUBLIC_MCP_SYSTEM_ENABLED).toBe('true');
    expect(derived.NEXT_PUBLIC_MYRAG_DEPLOYMENT_MODE).toBe('single-tenant');
    const pinned = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'eval/config/rag-eval-env.json'), 'utf8'));
    expect(pinned.NEXT_PUBLIC_MCP_SYSTEM_ENABLED).toBe('true');
  });

  test('pins the Phase 6 query-layer and cache defaults with both switches off', () => {
    const pinned = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'eval/config/rag-eval-env.json'), 'utf8'));
    expect(pinned).toMatchObject({
      RAG_QUERY_LAYER: 'false',
      RAG_QUERY_FRAMEWORK: 'llamaindex',
      RAG_QUERY_LLM_MODEL: 'openai/gpt-4.1-nano',
      RAG_QUERY_HYDE: 'false',
      RAG_QUERY_VOICE_TRANSFORMS: 'condense_history,normalize_dates',
      RAG_SEMANTIC_CACHE: 'off',
      RAG_SEMANTIC_CACHE_MAX_DISTANCE: '0.05',
      RAG_SEMANTIC_CACHE_EMBED_STORE: 'false',
    });
    expect(pinned).not.toHaveProperty('REDIS_URL');
  });

  test('pins the eighteen Phase 3.2 variables: languages zh,en,it with primary en, every switch at its D-47 default, RAG_TABLE_HEADER_REPEAT at the 03.2-67 decision (D-02, D-19)', () => {
    const expected = {
      RAG_SUPPORTED_LANGUAGES: 'zh,en,it',
      RAG_PRIMARY_LANGUAGE: 'en',
      RAG_LANGUAGE_AWARE_INGEST: 'off',
      RAG_TABLE_HEADER_REPEAT: 'always',
      RAG_TABLE_ROW_SERIALIZATION: 'false',
      RAG_CAPTION_LANGUAGE: 'en',
      RAG_BGE_M3_SERVING: 'hosted',
      RAG_DOC_TRANSLATION: 'off',
      RAG_DOC_TRANSLATION_MODEL: '',
      RAG_HIDDEN_TEXT_CHECK: 'off',
      RAG_INGEST_LINK_CHECK: 'off',
      RAG_OUTPUT_LINK_ALLOWLIST: '',
      RAG_UPLOAD_APPROVAL: 'off',
      RAG_SCOPE_TAGS: 'false',
      RAG_SCOPE_TAG_SUGGEST: 'false',
      RAG_SUPERSESSION_DETECT: 'off',
      RAG_EFFECTIVE_DATES: 'false',
      RAG_EFFECTIVE_DATE_LLM_EXTRACT: 'false',
    };
    expect(Object.keys(expected)).toHaveLength(18);
    const pinned = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'eval/config/rag-eval-env.json'), 'utf8'));
    for (const [name, value] of Object.entries(expected)) {
      expect(pinned, `${name} is pinned`).toHaveProperty(name);
      expect(pinned[name], name).toBe(value);
    }
    const derived = derivePinnedEvalEnv(fs.readFileSync(path.join(REPO_ROOT, 'scripts/init-env.js'), 'utf8'));
    expect(derived).toMatchObject(expected);
  });

  test('pins the seven Phase 5.1.1 feedback-loop variables off, with the embed secret empty (D-26)', () => {
    const expected = {
      RAG_RETRIEVAL_LOG: 'off',
      RAG_RETRIEVAL_LOG_RETENTION_DAYS: '30',
      RAG_REFUSAL_FEEDBACK: 'false',
      RAG_EMBED_FEEDBACK: 'false',
      RAG_EMBED_FEEDBACK_SECRET: '',
      RAG_SOURCE_OPEN_SIGNAL: 'false',
      RAG_DOMAIN_EXPERT_REVIEW: 'false',
    };
    const pinned = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'eval/config/rag-eval-env.json'), 'utf8'));
    for (const [name, value] of Object.entries(expected)) {
      expect(pinned, `${name} is pinned`).toHaveProperty(name);
      expect(pinned[name], name).toBe(value);
    }
  });

  test('pins the Phase 7 backend defaults on pgvector with the sync secret empty and no vendor URL or key (D-24)', () => {
    const expected = {
      RAG_RETRIEVAL_BACKEND: 'pgvector',
      RAG_RETRIEVAL_BACKEND_VOICE: 'pgvector',
      RAG_VECTOR_SYNC_MAX_LAG_SECONDS: '300',
      RAG_VECTOR_SYNC_SECRET: '',
    };
    const pinned = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'eval/config/rag-eval-env.json'), 'utf8'));
    for (const [name, value] of Object.entries(expected)) {
      expect(pinned, `${name} is pinned`).toHaveProperty(name);
      expect(pinned[name], name).toBe(value);
    }
    for (const name of Object.keys(pinned)) expect(name).not.toMatch(/^(WEAVIATE|QDRANT)_/);
  });

  test('pins the eight Phase 4.2 retrieval tuning switches off (D-04, D-53)', () => {
    const expected = {
      RAG_LEXICAL_DICTIONARY: 'false',
      RAG_LEXICAL_STEM_IT: 'false',
      RAG_VERSION_SCOPE: 'false',
      RAG_EMBED_VERSION_SCOPE: 'false',
      RAG_TABLE_LOOKUP: 'false',
      RAG_DUP_CLUSTERS: 'false',
      RAG_RESULT_DIVERSITY: 'off',
      RAG_IDENTIFIER_INDEX: 'false',
      RAG_IDENTIFIER_FILTER: 'false',
    };
    const pinned = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'eval/config/rag-eval-env.json'), 'utf8'));
    for (const [name, value] of Object.entries(expected)) {
      expect(pinned, `${name} is pinned`).toHaveProperty(name);
      expect(pinned[name], name).toBe(value);
    }
  });

  test('pins the fourteen Phase 5.2 answer-rule switches at their D-58 defaults', () => {
    const expected = {
      RAG_REGISTRY_TEXTS: 'false',
      RAG_PARTIAL_ANSWER_RULE: 'false',
      RAG_CONTEXT_RELEVANCE_RULE: 'false',
      RAG_CITATION_PER_SENTENCE: 'false',
      RAG_CLAIM_CHECK: 'false',
      RAG_GROUNDEDNESS_LLM_JUDGE: 'false',
      RAG_GROUNDEDNESS_JUDGE_MODEL: '',
      RAG_MAX_OUTPUT_TOKENS: 'off',
      RAG_OUTPUT_GUARD: 'off',
      RAG_VERSION_LABELS: 'false',
      RAG_SECURITY_EVENTS: 'false',
      RAG_UPLOADER_ALERT_THRESHOLD: '0',
      RAG_UPLOADER_ALERT_WINDOW_HOURS: '24',
      RAG_UPLOADER_HOLD: 'off',
    };
    expect(Object.keys(expected)).toHaveLength(14);
    const pinned = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'eval/config/rag-eval-env.json'), 'utf8'));
    for (const [name, value] of Object.entries(expected)) {
      expect(pinned, `${name} is pinned`).toHaveProperty(name);
      expect(pinned[name], name).toBe(value);
      expect(RUN_CONFIG_ENV_ALLOWLIST, `${name} is settable by a run config`).toContain(name);
    }
    expect(pinned).not.toHaveProperty('WHATSAPP_LINK_PREVIEW_HOSTS');
  });

  test('a run config may set the Phase 5.2 switches and still rejects an unknown name or value', () => {
    const config = parseRunConfig(
      {
        name: 'answer-rules',
        env: { RAG_OUTPUT_GUARD: 'enforce', RAG_PARTIAL_ANSWER_RULE: 'true', RAG_MAX_OUTPUT_TOKENS: '600' },
      },
      'inline',
    );
    expect(config.env).toEqual({ RAG_MAX_OUTPUT_TOKENS: '600', RAG_OUTPUT_GUARD: 'enforce', RAG_PARTIAL_ANSWER_RULE: 'true' });
    expect(parseRunConfig({ name: 'cap-auto', env: { RAG_MAX_OUTPUT_TOKENS: 'auto' } }, 'inline').env.RAG_MAX_OUTPUT_TOKENS).toBe('auto');
    expect(() => parseRunConfig({ name: 'unknown', env: { RAG_NOT_A_SWITCH: 'true' } }, 'inline')).toThrow(RunConfigError);
    expect(() => parseRunConfig({ name: 'bad-guard', env: { RAG_OUTPUT_GUARD: 'block' } }, 'inline')).toThrow(RunConfigError);
    expect(() => parseRunConfig({ name: 'bad-hold', env: { RAG_UPLOADER_HOLD: 'always' } }, 'inline')).toThrow(RunConfigError);
    expect(() => parseRunConfig({ name: 'bad-cap', env: { RAG_MAX_OUTPUT_TOKENS: 'lots' } }, 'inline')).toThrow(RunConfigError);
  });

  test('a run config cannot set the embed version-scope switch (D-58)', () => {
    expect(RUN_CONFIG_ENV_ALLOWLIST).toContain('RAG_VERSION_SCOPE');
    expect(RUN_CONFIG_ENV_ALLOWLIST).not.toContain('RAG_EMBED_VERSION_SCOPE');
  });

  test('pins the six Phase 3.3 templated-collection switches off (D-03)', () => {
    const expected = {
      RAG_SECTION_RULES: 'off',
      RAG_PAGE_BOILERPLATE: 'off',
      RAG_DOC_ATTRIBUTES: 'false',
      RAG_ATTRIBUTE_HEADER: 'false',
      RAG_ATTRIBUTE_FILTER: 'off',
      RAG_LEXICAL_QUANTITY: 'false',
    };
    const pinned = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'eval/config/rag-eval-env.json'), 'utf8'));
    for (const [name, value] of Object.entries(expected)) {
      expect(pinned, `${name} is pinned`).toHaveProperty(name);
      expect(pinned[name], name).toBe(value);
    }
  });

  test('eval-env --check exits 0', () => {
    const result = spawnSync('npx', ['tsx', 'eval/harness/eval-env.mts', '--check'], { cwd: REPO_ROOT, encoding: 'utf8' });
    expect(result.status).toBe(0);
  }, 60_000);
  test('pins the Phase 6.1 fine-tune switch off with empty slot settings and an empty key', () => {
    const pinned = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'eval/config/rag-eval-env.json'), 'utf8'));
    expect(pinned).toMatchObject({
      RAG_FINETUNE: 'off',
      RAG_FT_EMBED_API_KEY: '',
      RAG_FT_SLOT_A_BASE_URL: '',
      RAG_FT_SLOT_A_MODEL: '',
      RAG_FT_SLOT_A_QUERY_PROMPT: '',
      RAG_FT_SLOT_A_DOCUMENT_PROMPT: '',
      RAG_FT_SLOT_B_BASE_URL: '',
      RAG_FT_SLOT_B_MODEL: '',
      RAG_FT_SLOT_B_QUERY_PROMPT: '',
      RAG_FT_SLOT_B_DOCUMENT_PROMPT: '',
    });
  });
});
