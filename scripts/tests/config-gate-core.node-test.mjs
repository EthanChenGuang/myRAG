import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const core = require('../../src/lib/rag/config-gate/gate-core.cjs');
const { ragSettingsHash } = require('../../src/lib/rag/config-gate/settings-hash.cjs');
const fixture = JSON.parse(fs.readFileSync(path.join(REPO, 'tests/fixtures/config-gate-decisions.json'), 'utf8'));

const PASS_ID = '11111111-1111-4111-8111-111111111111';
const FAIL_ID = '22222222-2222-4222-8222-222222222222';
const ADMIN = '00000000-0000-4000-8000-0000000c0de1';

function tempRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'config-gate-'));
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

test('constants follow D-14 and D-15', () => {
  assert.equal(core.OVERRIDE_REASON_MIN, 10);
  assert.equal(core.OVERRIDE_REASON_MAX, 500);
  assert.equal(core.CHECK_CACHE_MS, 30 * 60 * 1000);
  assert.equal(core.CHECK_DIR, 'eval/out/config-gate');
});

test('the fixture table holds at least twelve cases', () => {
  assert.ok(fixture.cases.length >= 12);
});

for (const item of fixture.cases) {
  test(`decideSave: ${item.name}`, async () => {
    const reads = [];
    const readCheck = (id) => {
      reads.push(id);
      return fixture.checks[id] ? clone(fixture.checks[id]) : null;
    };
    const decision = await core.decideSave({
      mode: item.mode,
      before: fixture.settings[item.before],
      after: fixture.settings[item.after],
      ragGate: item.ragGate,
      readCheck,
      names: fixture.names,
    });
    assert.deepEqual(decision, item.expect);
    if (!item.readsCheck) assert.deepEqual(reads, []);
  });
}

test('the fixture hashes match ragSettingsHash over the fixture names', () => {
  assert.equal(ragSettingsHash(fixture.settings.after, fixture.names), fixture.hashes.after);
  assert.equal(ragSettingsHash(fixture.settings.before, fixture.names), fixture.hashes.before);
});

test('decideSave reads no check in off mode even when the reader would throw', async () => {
  const decision = await core.decideSave({
    mode: 'off',
    before: fixture.settings.before,
    after: fixture.settings.after,
    ragGate: { check_id: PASS_ID },
    readCheck: () => {
      throw new Error('must not be called');
    },
    names: fixture.names,
  });
  assert.equal(decision.kind, 'write');
  assert.equal(decision.gateResult, 'not_required');
});

test('a reader that throws counts as no check and fails closed in enforce mode', async () => {
  const decision = await core.decideSave({
    mode: 'enforce',
    before: fixture.settings.before,
    after: fixture.settings.after,
    ragGate: { check_id: PASS_ID },
    readCheck: () => {
      throw new Error('disk gone');
    },
    names: fixture.names,
  });
  assert.deepEqual(decision, { kind: 'refuse', status: 409, error: 'rag_gate_required' });
});

test('writeCheck and readCheck round-trip through a temporary file and rename', () => {
  const root = tempRoot();
  const check = clone(fixture.checks[PASS_ID]);
  assert.deepEqual(core.writeCheck(root, check), { ok: true });
  const dir = path.join(root, core.CHECK_DIR);
  assert.deepEqual(fs.readdirSync(dir), [`${PASS_ID}.json`]);
  assert.deepEqual(core.readCheck(root, PASS_ID), check);
});

test('writeCheck refuses a check id that is not a uuid and writes nothing', () => {
  const root = tempRoot();
  const check = { ...clone(fixture.checks[PASS_ID]), check_id: '../escape-attempt' };
  assert.equal(core.writeCheck(root, check).ok, false);
  assert.equal(fs.existsSync(path.join(root, core.CHECK_DIR)), false);
});

test('readCheck returns null for a missing file, non-JSON, a non-uuid id and a wrong shape', () => {
  const root = tempRoot();
  const dir = path.join(root, core.CHECK_DIR);
  fs.mkdirSync(dir, { recursive: true });
  assert.equal(core.readCheck(root, PASS_ID), null);
  fs.writeFileSync(path.join(dir, `${PASS_ID}.json`), '{ not json');
  assert.equal(core.readCheck(root, PASS_ID), null);
  assert.equal(core.readCheck(root, 'not-a-uuid'), null);
  assert.equal(core.readCheck(root, '../../package'), null);
  const wrongHash = { ...clone(fixture.checks[PASS_ID]), rag_settings_hash: 'abc' };
  fs.writeFileSync(path.join(dir, `${PASS_ID}.json`), JSON.stringify(wrongHash));
  assert.equal(core.readCheck(root, PASS_ID), null);
  const otherId = clone(fixture.checks[FAIL_ID]);
  fs.writeFileSync(path.join(dir, `${PASS_ID}.json`), JSON.stringify(otherId));
  assert.equal(core.readCheck(root, PASS_ID), null, 'a file whose check_id differs from its name is not accepted');
  const doneWithoutResult = { ...clone(fixture.checks[PASS_ID]), result: null };
  fs.writeFileSync(path.join(dir, `${PASS_ID}.json`), JSON.stringify(doneWithoutResult));
  assert.equal(core.readCheck(root, PASS_ID), null);
});

test('readCheck applies an extra validator and treats a rejection as absent', () => {
  const root = tempRoot();
  core.writeCheck(root, clone(fixture.checks[PASS_ID]));
  assert.equal(core.readCheck(root, PASS_ID, { validate: () => false }), null);
  assert.ok(core.readCheck(root, PASS_ID, { validate: () => true }));
});

test('cachedCheck returns a done check of the same hash finished less than 30 minutes ago', () => {
  const root = tempRoot();
  const finished = Date.parse(fixture.checks[PASS_ID].finished_at);
  for (const id of Object.keys(fixture.checks)) core.writeCheck(root, clone(fixture.checks[id]));
  const hit = core.cachedCheck(root, fixture.hashes.after, finished + 29 * 60 * 1000);
  assert.ok(hit);
  assert.equal(hit.rag_settings_hash, fixture.hashes.after);
  assert.equal(hit.status, 'done');
  assert.notEqual(hit.result, 'error');
  assert.equal(core.cachedCheck(root, fixture.hashes.after, finished + 31 * 60 * 1000), null);
  assert.equal(core.cachedCheck(root, 'f'.repeat(64), finished + 60 * 1000), null);
  assert.equal(core.cachedCheck(root, fixture.hashes.after, finished - 60 * 1000), null, 'a check finished in the future is not cached');
});

test('cachedCheck does not cache an error result', () => {
  const root = tempRoot();
  const errorId = '55555555-5555-4555-8555-555555555555';
  core.writeCheck(root, clone(fixture.checks[errorId]));
  const finished = Date.parse(fixture.checks[errorId].finished_at);
  assert.equal(core.cachedCheck(root, fixture.hashes.after, finished + 1000), null);
});

test('latestCheck returns the newest valid check and null for an empty store', () => {
  const root = tempRoot();
  assert.equal(core.latestCheck(root), null);
  const older = { ...clone(fixture.checks[PASS_ID]), started_at: '2026-11-25T10:00:00Z', finished_at: '2026-11-25T10:05:00Z' };
  const newer = { ...clone(fixture.checks[FAIL_ID]), started_at: '2026-11-26T11:00:00Z', finished_at: '2026-11-26T11:05:00Z' };
  core.writeCheck(root, newer);
  core.writeCheck(root, older);
  fs.writeFileSync(path.join(root, core.CHECK_DIR, '77777777-7777-4777-8777-777777777777.json'), 'garbage');
  assert.equal(core.latestCheck(root).check_id, FAIL_ID);
});

const BASE_RECORD = {
  actor: ADMIN,
  source: 'config_ui',
  before: fixture.settings.before,
  after: fixture.settings.after,
  names: fixture.names,
  gateResult: 'fail',
  check: fixture.checks[FAIL_ID],
  overrideReason: '  Operator reviewed the failed slice.  ',
  uncalibratedCells: ['cohere|rerank-v3.5|en', 'bad cell with spaces'],
};

test('buildChangeRecord holds names, hashes, result, counts and the trimmed reason, never a value', () => {
  const row = core.buildChangeRecord({ ...BASE_RECORD, value: 'leaked-value', values: { RAG_RERANKER: 'leaked-value' } });
  assert.deepEqual(Object.keys(row).sort(), [
    'actor',
    'after_hash',
    'before_hash',
    'changed_keys',
    'gate_result',
    'gate_summary',
    'override_reason',
    'retrieval_config_hash',
    'source',
    'uncalibrated_cells',
  ]);
  assert.deepEqual(row.changed_keys, ['RAG_RERANKER']);
  assert.equal(row.before_hash, fixture.hashes.before);
  assert.equal(row.after_hash, fixture.hashes.after);
  assert.equal(row.gate_result, 'fail');
  assert.equal(row.override_reason, 'Operator reviewed the failed slice.');
  assert.deepEqual(row.uncalibrated_cells, ['cohere|rerank-v3.5|en']);
  assert.deepEqual(row.gate_summary, {
    checks: 2,
    failed: 1,
    skipped: 0,
    offenders: ['context_recall'],
    layers: { deterministic: 'fail', live: 'skipped', real_set: 'skipped' },
  });
  const text = JSON.stringify(row);
  for (const value of ['leaked-value', 'local_bm25', 'Answer from the context']) assert.equal(text.includes(value), false, value);
});

test('buildChangeRecord keeps release fields only on release sources', () => {
  const sha = 'a'.repeat(40);
  const release = core.buildChangeRecord({ ...BASE_RECORD, source: 'release_override', releaseSha: sha, githubActor: 'octo-operator' });
  assert.equal(release.gate_summary.release_sha, sha);
  assert.equal(release.gate_summary.github_actor, 'octo-operator');
  const ui = core.buildChangeRecord({ ...BASE_RECORD, releaseSha: sha, githubActor: 'octo-operator' });
  assert.equal('release_sha' in ui.gate_summary, false);
  assert.equal('github_actor' in ui.gate_summary, false);
});

test('buildChangeRecord accepts explicit keys and hashes when no values are known', () => {
  const row = core.buildChangeRecord({
    actor: 'cli',
    source: 'cli',
    changedKeys: ['RAG_PIPELINE', 'RAG_PIPELINE', 'not a key'],
    beforeHash: 'b'.repeat(64),
    afterHash: 'c'.repeat(64),
    gateResult: 'skipped',
  });
  assert.deepEqual(row.changed_keys, ['RAG_PIPELINE']);
  assert.equal(row.before_hash, 'b'.repeat(64));
  assert.equal(row.after_hash, 'c'.repeat(64));
  assert.equal(row.override_reason, null);
  assert.deepEqual(row.gate_summary, { checks: 0, failed: 0, skipped: 0, offenders: [], layers: {} });
});

test('buildChangeRecord refuses an unknown actor, source or result', () => {
  assert.throws(() => core.buildChangeRecord({ ...BASE_RECORD, actor: 'someone' }), TypeError);
  assert.throws(() => core.buildChangeRecord({ ...BASE_RECORD, source: 'browser' }), TypeError);
  assert.throws(() => core.buildChangeRecord({ ...BASE_RECORD, gateResult: 'maybe' }), TypeError);
});

function fakeClient({ fail = false, throws = false, rows = [] } = {}) {
  const calls = [];
  const builder = (table) => {
    const q = { table, ops: [] };
    calls.push(q);
    const result = () => {
      if (throws) throw new Error('network');
      if (fail) return { data: null, error: { code: 'PGRST500', message: 'down' } };
      const insert = q.ops.find((op) => op[0] === 'insert');
      if (insert) return { data: { id: '99999999-9999-4999-8999-999999999999' }, error: null };
      return { data: rows, error: null };
    };
    const b = {};
    for (const name of ['insert', 'select', 'gte', 'order', 'limit']) {
      b[name] = (...args) => {
        q.ops.push([name, ...args]);
        return b;
      };
    }
    b.single = () => Promise.resolve().then(result);
    b.then = (ok, bad) => Promise.resolve().then(result).then(ok, bad);
    return b;
  };
  return { calls, client: { from: builder } };
}

test('insertChangeRecord inserts into rag_config_change_records and returns the id', async () => {
  const { client, calls } = fakeClient();
  const row = core.buildChangeRecord(BASE_RECORD);
  assert.deepEqual(await core.insertChangeRecord(client, row), { ok: true, id: '99999999-9999-4999-8999-999999999999' });
  assert.equal(calls[0].table, 'rag_config_change_records');
  assert.deepEqual(calls[0].ops[0], ['insert', row]);
});

test('insertChangeRecord and listChangeRecords report failures without throwing', async () => {
  for (const options of [{ fail: true }, { throws: true }]) {
    const { client } = fakeClient(options);
    assert.deepEqual(await core.insertChangeRecord(client, core.buildChangeRecord(BASE_RECORD)), { ok: false, reason: 'insert_failed' });
    assert.deepEqual(await core.listChangeRecords(client, { since: '2026-11-01T00:00:00.000Z', limit: 10 }), { ok: false, reason: 'read_failed' });
  }
  assert.deepEqual(await core.insertChangeRecord(null, {}), { ok: false, reason: 'insert_failed' });
});

test('listChangeRecords filters by since, orders newest first and limits', async () => {
  const { client, calls } = fakeClient({ rows: [{ id: 'x' }] });
  assert.deepEqual(await core.listChangeRecords(client, { since: '2026-11-01T00:00:00.000Z', limit: 10 }), { ok: true, records: [{ id: 'x' }] });
  const ops = calls[0].ops;
  assert.deepEqual(ops.find((op) => op[0] === 'gte'), ['gte', 'created_at', '2026-11-01T00:00:00.000Z']);
  assert.deepEqual(ops.find((op) => op[0] === 'order'), ['order', 'created_at', { ascending: false }]);
  assert.deepEqual(ops.find((op) => op[0] === 'limit'), ['limit', 10]);
  const select = ops.find((op) => op[0] === 'select')[1];
  assert.equal(select.includes('*'), false);
});
