import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import * as gate from '@/lib/rag/config-gate/gate-core';
import { ConfigChangeRecordSchema, ConfigGateCheckSchema } from '@/lib/rag-eval/contracts.generated';

interface DecisionCase {
  name: string;
  mode: string;
  before: string;
  after: string;
  ragGate: unknown;
  expect: unknown;
  readsCheck: boolean;
}

const fixture = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'tests/fixtures/config-gate-decisions.json'), 'utf8')) as {
  names: string[];
  settings: Record<string, Record<string, string>>;
  hashes: { before: string; after: string };
  checks: Record<string, Record<string, unknown>>;
  cases: DecisionCase[];
};

const PASS_ID = '11111111-1111-4111-8111-111111111111';
const FAIL_ID = '22222222-2222-4222-8222-222222222222';
const ADMIN = '00000000-0000-4000-8000-0000000c0de1';
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
const tempRoot = () => fs.mkdtempSync(path.join(os.tmpdir(), 'config-gate-ts-'));

describe('gate-core TypeScript wrapper', () => {
  it('every fixture check is a valid ConfigGateCheck', () => {
    for (const check of Object.values(fixture.checks)) expect(ConfigGateCheckSchema.safeParse(check).success).toBe(true);
  });

  it.each(fixture.cases.map((item) => [item.name, item] as const))('decideSave: %s', async (_name, item) => {
    const reads: string[] = [];
    const decision = await gate.decideSave({
      mode: item.mode,
      before: fixture.settings[item.before],
      after: fixture.settings[item.after],
      ragGate: item.ragGate as gate.RagGateInput,
      readCheck: (id: string) => {
        reads.push(id);
        const check = fixture.checks[id];
        return check ? (clone(check) as gate.ConfigGateCheck) : null;
      },
      names: fixture.names,
    });
    expect(decision).toEqual(item.expect);
    if (!item.readsCheck) expect(reads).toEqual([]);
  });

  it('readCheck validates with ConfigGateCheckSchema, so an extra field reads as absent', () => {
    const root = tempRoot();
    expect(gate.writeCheck(root, clone(fixture.checks[PASS_ID]) as gate.ConfigGateCheck)).toEqual({ ok: true });
    expect(gate.readCheck(root, PASS_ID)?.check_id).toBe(PASS_ID);
    const tampered = { ...clone(fixture.checks[PASS_ID]), injected: 'value' };
    fs.writeFileSync(path.join(root, gate.CHECK_DIR, `${PASS_ID}.json`), JSON.stringify(tampered));
    expect(gate.readCheck(root, PASS_ID)).toBeNull();
    expect(gate.cachedCheck(root, fixture.hashes.after, Date.parse('2026-11-26T10:06:00Z'))).toBeNull();
    expect(gate.latestCheck(root)).toBeNull();
  });

  it('cachedCheck and latestCheck return validated checks', () => {
    const root = tempRoot();
    gate.writeCheck(root, clone(fixture.checks[PASS_ID]) as gate.ConfigGateCheck);
    expect(gate.cachedCheck(root, fixture.hashes.after, Date.parse('2026-11-26T10:06:00Z'))?.check_id).toBe(PASS_ID);
    expect(gate.latestCheck(root)?.check_id).toBe(PASS_ID);
  });

  it('buildChangeRecord output plus the database id and time is a valid ConfigChangeRecord', () => {
    const row = gate.buildChangeRecord({
      actor: ADMIN,
      source: 'release_override',
      before: fixture.settings.before,
      after: fixture.settings.after,
      names: fixture.names,
      gateResult: 'fail',
      check: clone(fixture.checks[FAIL_ID]) as gate.ConfigGateCheck,
      overrideReason: 'Release accepted by the operator.',
      releaseSha: 'a'.repeat(40),
      githubActor: 'octo-operator',
    });
    const parsed = ConfigChangeRecordSchema.safeParse({ ...row, id: '99999999-9999-4999-8999-999999999999', created_at: '2026-11-26T10:00:00+00:00' });
    expect(parsed.success).toBe(true);
  });

  it('listChangeRecords drops rows that fail ConfigChangeRecordSchema', async () => {
    const good = {
      ...gate.buildChangeRecord({ actor: 'cli', source: 'cli', changedKeys: ['RAG_PIPELINE'], beforeHash: 'b'.repeat(64), afterHash: 'c'.repeat(64), gateResult: 'skipped' }),
      id: '99999999-9999-4999-8999-999999999999',
      created_at: '2026-11-26T10:00:00+00:00',
    };
    const bad = { ...good, id: '88888888-8888-4888-8888-888888888888', value: 'leaked' };
    const query = {
      select: () => query,
      gte: () => query,
      order: () => query,
      limit: () => query,
      then: (ok: (value: unknown) => unknown) => Promise.resolve({ data: [good, bad], error: null }).then(ok),
    };
    const result = await gate.listChangeRecords({ from: () => query } as unknown as gate.ChangeRecordClient, { since: '2026-11-01T00:00:00.000Z', limit: 10 });
    expect(result).toEqual({ ok: true, records: [ConfigChangeRecordSchema.parse(good)] });
  });

  it('exposes the D-15 bounds and the D-14 cache window', () => {
    expect([gate.OVERRIDE_REASON_MIN, gate.OVERRIDE_REASON_MAX, gate.CHECK_CACHE_MS]).toEqual([10, 500, 1_800_000]);
  });
});
