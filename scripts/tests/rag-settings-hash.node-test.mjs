import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const { ragSettingsHash, ragSettingsCanonical, ragAffectingDiff } = require('../../src/lib/rag/config-gate/settings-hash.cjs');
const { isSecretName } = require('../../src/lib/rag/config-gate/secret-name.cjs');
const { isSecretConfigEntry } = require('../config-server-security.js');
const vector = JSON.parse(fs.readFileSync(path.join(REPO, 'tests/fixtures/rag-settings-hash-vector.json'), 'utf8'));
const generated = JSON.parse(fs.readFileSync(path.join(REPO, 'src/lib/rag/config-gate/rag-affecting.generated.json'), 'utf8'));

const NAMES = ['RAG_PIPELINE', 'RAG_PRE_CONTEXT', 'COHERE_API_KEY'];

test('the CommonJS entry reproduces the shared vector (D-12)', () => {
  assert.equal(ragSettingsCanonical(vector.values, vector.names), vector.canonical);
  assert.equal(ragSettingsHash(vector.values, vector.names), vector.hash);
});

test('a rotated secret keeps the hash; setting an unset secret changes it', () => {
  const base = { RAG_PIPELINE: 'v2', RAG_PRE_CONTEXT: 'a', COHERE_API_KEY: 'placeholder-one' };
  const rotated = { ...base, COHERE_API_KEY: 'placeholder-two' };
  assert.equal(ragSettingsHash(rotated, NAMES), ragSettingsHash(base, NAMES));
  const unset = { ...base, COHERE_API_KEY: '' };
  assert.notEqual(ragSettingsHash(unset, NAMES), ragSettingsHash(base, NAMES));
});

test('one character of RAG_PRE_CONTEXT changes the hash and no prompt or secret text enters the input', () => {
  const values = { RAG_PIPELINE: 'v2', RAG_PRE_CONTEXT: 'neutral prompt text', COHERE_API_KEY: 'placeholder-secret' };
  const changed = { ...values, RAG_PRE_CONTEXT: 'neutral prompt texT' };
  assert.notEqual(ragSettingsHash(changed, NAMES), ragSettingsHash(values, NAMES));
  const canonical = ragSettingsCanonical(values, NAMES);
  assert.equal(canonical.includes('neutral prompt text'), false);
  assert.equal(canonical.includes('placeholder-secret'), false);
  assert.match(canonical, /"COHERE_API_KEY":"set"/);
});

test('a missing name hashes like the empty string and names are order-independent', () => {
  assert.equal(ragSettingsHash({}, NAMES), ragSettingsHash({ RAG_PIPELINE: '', RAG_PRE_CONTEXT: '', COHERE_API_KEY: '' }, NAMES));
  assert.equal(ragSettingsHash({ RAG_PIPELINE: 'v2' }, [...NAMES].reverse()), ragSettingsHash({ RAG_PIPELINE: 'v2' }, NAMES));
});

test('ragAffectingDiff returns the sorted names whose values differ, missing treated as empty', () => {
  const before = { RAG_PIPELINE: 'legacy', RAG_PRE_CONTEXT: '' };
  const after = { RAG_PIPELINE: 'v2', COHERE_API_KEY: 'placeholder', UNLISTED: 'x' };
  assert.deepEqual(ragAffectingDiff(before, after, ['RAG_PRE_CONTEXT', 'RAG_PIPELINE', 'COHERE_API_KEY']), ['COHERE_API_KEY', 'RAG_PIPELINE']);
  assert.deepEqual(ragAffectingDiff(before, { ...before }, NAMES), []);
});

test('the config server uses the shared secret-name rule', () => {
  for (const name of ['RAG_MONITOR_WEBHOOK_URL', 'COHERE_API_KEY', 'REDIS_URL', 'MCP_EXAMPLE_ENDPOINT']) {
    assert.equal(isSecretName(name), true, name);
    assert.equal(isSecretConfigEntry(name, ''), true, name);
  }
  for (const name of ['RAG_MONITOR', 'RAG_CONTEXT_TOKEN_BUDGET', 'RAG_MAX_KEY_TERMS', 'RAG_VOICE_TOKEN_TTL_SECONDS']) {
    assert.equal(isSecretName(name), false, name);
    assert.equal(isSecretConfigEntry(name, ''), false, name);
  }
});

test('no RAG-affecting name is a secret name', () => {
  assert.ok(generated.names.length > 0);
  assert.deepEqual(generated.names.filter((name) => isSecretName(name)), []);
});
