import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildIngestFixtureDatabase } from '../../eval/harness/ingest-mode.mts';
import { FIXTURE_USER_ID, type FixtureDatabase } from '../../eval/harness/pglite-supabase.mts';
import { TABLE_SPLIT_USER_ID, type TableSplitTenant } from '../../eval/harness/table-split.mts';

const ROOT = process.cwd();
const CORPUS_DIR = path.join(ROOT, 'eval/fixtures/corpus');
const INGEST_GOLDEN = path.join(ROOT, 'eval/fixtures/ingest/golden-ingest.jsonl');
const EVAL_SECRET = 'table-split-multi-tenant-eval-secret-000';

interface TraceLine {
  item_id: string;
  candidates: Array<{ document_name?: string | null }>;
  kept: Array<{ document_name: string }>;
}

describe('table_split tenants in multi-tenant mode have their own tenant key', () => {
  let tmp: string;
  let fixture: (FixtureDatabase & { tableSplitTenants?: TableSplitTenant[] }) | undefined;
  let traces: Map<string, TraceLine>;
  let tableId: string;
  let oldId: string;

  before(async () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'table-split-mt-'));
    const lines = fs.readFileSync(INGEST_GOLDEN, 'utf8').split('\n').filter((line) => line.trim() !== '');
    const table = lines.find((line) => JSON.parse(line).category === 'table_split' && JSON.parse(line).language === 'en');
    const old = lines.find((line) => JSON.parse(line).category === 'table');
    assert.ok(table && old);
    tableId = JSON.parse(table).id;
    oldId = JSON.parse(old).id;
    const golden = path.join(tmp, 'golden.jsonl');
    fs.writeFileSync(golden, `${table}\n${old}\n`);
    fixture = await buildIngestFixtureDatabase({
      deploymentMode: 'multi-tenant',
      corpusDir: CORPUS_DIR,
      processEnv: { RAG_EVAL_SECRET: EVAL_SECRET, RAG_EVAL_ALLOWED_SCOPES: `user:${FIXTURE_USER_ID},user:${TABLE_SPLIT_USER_ID}` },
      tableSplit: true,
    });
    const { runEval } = await import('../../eval/harness/run-eval.mts');
    const result = await runEval({
      goldenPath: golden,
      corpusDir: CORPUS_DIR,
      outDir: path.join(tmp, 'out'),
      deploymentMode: 'multi-tenant',
      fixtureMode: 'ingest',
      ingestFixture: fixture,
    });
    traces = new Map(
      fs
        .readFileSync(result.tracesPath, 'utf8')
        .split('\n')
        .filter((line) => line.trim() !== '')
        .map((line) => {
          const trace = JSON.parse(line) as TraceLine;
          return [trace.item_id, trace];
        }),
    );
  });

  after(async () => {
    for (const tenant of fixture?.tableSplitTenants ?? []) await tenant.db.close().catch(() => undefined);
    await fixture?.edge?.close();
    await fixture?.db.close().catch(() => undefined);
    if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
  });

  test('the long-table documents belong to the table_split fixture user, not to the fixture user', async () => {
    assert.ok(fixture?.tableSplitTenants);
    for (const tenant of fixture.tableSplitTenants) {
      assert.equal(tenant.tenantKey, `u:${TABLE_SPLIT_USER_ID}`);
      const { rows } = await tenant.db.query<{ tenant_key: string; user_id: string }>('SELECT tenant_key, user_id FROM documents');
      assert.equal(rows.length, 3);
      for (const row of rows) {
        assert.equal(row.tenant_key, `u:${TABLE_SPLIT_USER_ID}`);
        assert.equal(row.user_id, TABLE_SPLIT_USER_ID);
      }
    }
  });

  test('the table_split item is answered from its tenant and the old item from the fixture tenant', () => {
    const table = traces.get(tableId);
    const old = traces.get(oldId);
    assert.ok(table && old);
    assert.ok(table.candidates.length > 0);
    assert.ok(table.candidates.every((chunk) => /^long-table-(zh|en|it)\.pdf$/.test(String(chunk.document_name))));
    assert.ok(old.candidates.every((chunk) => !String(chunk.document_name).startsWith('long-table-')));
  });
});
