import { afterEach, describe, expect, test } from 'vitest';
import { buildEffectiveConfig } from '@/lib/rag-eval/trace';

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
