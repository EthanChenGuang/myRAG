import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { isSecretConfigEntry, maskConfig } = require('../config-server-security.js');

test('REDIS_URL is always a secret, with or without credentials', () => {
  assert.equal(isSecretConfigEntry('REDIS_URL', ''), true);
  assert.equal(isSecretConfigEntry('REDIS_URL', 'redis://localhost:6379'), true);
  assert.equal(isSecretConfigEntry('REDIS_URL', 'redis://user:placeholder-password@localhost:6379/0'), true);
});

test('maskConfig lists a set REDIS_URL in secretsSet and never returns its value', () => {
  const { config, secretsSet } = maskConfig({ REDIS_URL: 'redis://localhost:6379', RAG_SEMANTIC_CACHE: 'redisvl' });
  assert.ok(secretsSet.includes('REDIS_URL'));
  assert.equal(Object.prototype.hasOwnProperty.call(config, 'REDIS_URL'), false);
  assert.equal(config.RAG_SEMANTIC_CACHE, 'redisvl');
  assert.doesNotMatch(JSON.stringify(config), /redis:\/\//);
});

test('existing classifications are unchanged', () => {
  assert.equal(isSecretConfigEntry('RAG_SIDECAR_URL', 'http://localhost:8000'), false);
  assert.equal(isSecretConfigEntry('LANGFUSE_SECRET_KEY', 'placeholder'), true);
  assert.equal(isSecretConfigEntry('RAG_VOICE_TOKEN_TTL_SECONDS', '3600'), false);
  assert.equal(isSecretConfigEntry('RAG_SEMANTIC_CACHE_MAX_DISTANCE', '0.05'), false);
});

test('RAG_FT_EMBED_API_KEY is a secret and its value never leaves the server; the slot settings stay visible', () => {
  assert.equal(isSecretConfigEntry('RAG_FT_EMBED_API_KEY', ''), true);
  assert.equal(isSecretConfigEntry('RAG_FT_EMBED_API_KEY', 'placeholder-ft-key'), true);
  const { config, secretsSet } = maskConfig({
    RAG_FT_EMBED_API_KEY: 'placeholder-ft-key',
    RAG_FINETUNE: 'off',
    RAG_FT_SLOT_A_BASE_URL: 'http://localhost:8080/v1',
    RAG_FT_SLOT_A_MODEL: 'example-model-v1',
    RAG_FT_SLOT_A_QUERY_PROMPT: 'query: ',
  });
  assert.deepEqual(secretsSet, ['RAG_FT_EMBED_API_KEY']);
  assert.equal(Object.prototype.hasOwnProperty.call(config, 'RAG_FT_EMBED_API_KEY'), false);
  assert.doesNotMatch(JSON.stringify(config), /placeholder-ft-key/);
  assert.equal(config.RAG_FT_SLOT_A_BASE_URL, 'http://localhost:8080/v1');
  assert.equal(config.RAG_FT_SLOT_A_QUERY_PROMPT, 'query: ');
  assert.equal(isSecretConfigEntry('RAG_FT_SLOT_B_BASE_URL', 'http://user:placeholder@localhost:8080/v1'), true);
});
