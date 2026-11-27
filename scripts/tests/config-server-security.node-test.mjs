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

test('Nango integration ids are shown, while other Nango keys and secrets stay masked (06.3-02, D-42)', () => {
  assert.equal(isSecretConfigEntry('NANGO_SHAREPOINT_INTEGRATION_KEY', 'sharepoint-online'), false);
  assert.equal(isSecretConfigEntry('NANGO_ONEDRIVE_INTEGRATION_KEY', 'one-drive'), false);
  assert.equal(isSecretConfigEntry('NANGO_SECRET_KEY', 'placeholder'), true);
  assert.equal(isSecretConfigEntry('NANGO_WEBHOOK_SECRET', 'placeholder'), true);
  assert.equal(isSecretConfigEntry('OPENAI_INTEGRATION_KEY', 'placeholder'), true);
  assert.equal(isSecretConfigEntry('NANGO_SHAREPOINT_INTEGRATION_KEY', 'https://user:placeholder@example.test'), true);
  const { config, secretsSet } = maskConfig({ NANGO_SHAREPOINT_INTEGRATION_KEY: 'sharepoint-online', NANGO_SECRET_KEY: 'placeholder' });
  assert.equal(config.NANGO_SHAREPOINT_INTEGRATION_KEY, 'sharepoint-online');
  assert.deepEqual(secretsSet, ['NANGO_SECRET_KEY']);
});
