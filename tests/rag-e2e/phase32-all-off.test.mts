import fs from 'node:fs';
import path from 'node:path';
import { before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import {
  compactSnapshot,
  fromColumnar,
  KEYED_JSON_COLUMNS,
  PHASE_32_VARIABLES,
  probeWritePaths,
  type CompactProbeSnapshot,
  type ColumnInfo,
  type PathName,
  type ProbeInputs,
  type RetrievalProbe,
  type SnapshotRow,
  type SnapshotTable,
} from './phase32-all-off-probe.mts';

// Plan 03.2-66 (D-46, roadmap criterion 7): with every Phase 3.2 variable absent, the fixture corpus is ingested inline and through the
// queue and the same retrieval requests run through legacy and v2, and the result is compared with a recording made by the same probe
// on the tree before the first Phase 3.2 commit (recorded_from). Re-record with tests/rag-e2e/phase32-all-off-record.mts on that tree.
const REFERENCE_PATH = 'tests/fixtures/ingest/phase32-all-off-reference.json';


/**
 * The only writes this phase adds while its switches are off (listed in the 03.2-66 SUMMARY): the ingestion fingerprint (plan 17),
 * the parser version kept in processing_state so a resumed run can build the fingerprint (plan 17), and effective dates found by the
 * rules (plan 47), which no retrieval reads while RAG_EFFECTIVE_DATES is false.
 */
const ADDITIVE_COLUMNS: Record<SnapshotTable, ReadonlySet<string>> = {
  documents: new Set(['ingest_fingerprint', 'effective_from', 'effective_to', 'effective_dates_origin', 'effective_dates_confidence']),
  document_chunks: new Set(['effective_from', 'effective_to']),
};
const ADDITIVE_JSON_KEYS: Record<string, ReadonlySet<string>> = {
  'documents.metadata': new Set(['ingest_fingerprint_parts']),
  'documents.processing_state': new Set(['parserVersion']),
};

/** Seed rows of later migrations, not of a write path: 0440 (Phase 3.1.1) adds three catalog profiles to embedding_profiles. */
const MIGRATION_SEEDED_TABLES = new Set(['embedding_profiles']);

interface Reference {
  recorded_from: string;
  inputs: ProbeInputs;
  snapshot: CompactProbeSnapshot;
}

const reference = JSON.parse(fs.readFileSync(path.join(process.cwd(), REFERENCE_PATH), 'utf8')) as Reference;
const TABLES: SnapshotTable[] = ['documents', 'document_chunks'];
const PATHS: PathName[] = ['inline', 'queued'];

function rowKey(row: SnapshotRow): string {
  return String(row.id);
}

function defaultValue(column: ColumnInfo): unknown {
  if (column.default === null) return null;
  if (/^'\{\}'::[a-z_ ]+\[\]$/.test(column.default)) return [];
  if (column.default === 'false') return false;
  if (column.default === 'true') return true;
  throw new Error(`[Phase 3.2 All-off] no rule for the default ${column.default} of ${column.name}`);
}

/** Candidates: identical above the pool's lowest similarity; at that boundary random uuids break ties, so only the count must match. */
function assertCandidates(actual: RetrievalProbe['candidates'], expected: RetrievalProbe['candidates'], label: string): void {
  assert.equal(actual.length, expected.length, `${label}: candidate count`);
  if (expected.length === 0) return;
  const floor = Math.min(...expected.map((candidate) => candidate.similarity ?? 0));
  const above = (list: RetrievalProbe['candidates']) =>
    list
      .filter((candidate) => (candidate.similarity ?? 0) > floor)
      .map((candidate) => `${candidate.chunk}@${candidate.similarity}`)
      .sort();
  assert.deepEqual(above(actual), above(expected), `${label}: candidates above the boundary similarity ${floor}`);
  const at = (list: RetrievalProbe['candidates']) => list.filter((candidate) => (candidate.similarity ?? 0) === floor).length;
  assert.equal(at(actual), at(expected), `${label}: candidates at the boundary similarity`);
}

describe('Phase 3.2 all off: ingestion and retrieval equal the tree before the phase', () => {
  let current: CompactProbeSnapshot;
  const saved = new Map<string, string | undefined>();

  before(async () => {
    for (const name of PHASE_32_VARIABLES) {
      saved.set(name, process.env[name]);
      delete process.env[name];
    }
    try {
      current = compactSnapshot(await probeWritePaths(reference.inputs));
    } finally {
      for (const [name, value] of saved) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
    }
  });

  test('the reference was recorded before the first Phase 3.2 commit with the same inputs', () => {
    assert.equal(reference.recorded_from, '0e740fc5');
    assert.ok(reference.inputs.corpus_files.length > 0 && reference.inputs.queries.length > 0);
  });

  for (const table of TABLES) {
    for (const pathName of PATHS) {
      test(`${pathName}: every ${table} column that existed before the phase holds the recorded value`, () => {
        const expectedColumns = new Set(reference.snapshot.columns[table].map((column) => column.name));
        const expected = fromColumnar(reference.snapshot.paths[pathName][table]);
        const actual = fromColumnar(current.paths[pathName][table]);
        assert.deepEqual(actual.map(rowKey), expected.map(rowKey), `${pathName} ${table}: the same rows`);
        const differences: string[] = [];
        actual.forEach((row, index) => {
          const recorded = expected[index] as SnapshotRow;
          for (const column of expectedColumns) {
            if (KEYED_JSON_COLUMNS.has(column) && recorded[column] && typeof recorded[column] === 'object') {
              const additive = ADDITIVE_JSON_KEYS[`${table}.${column}`] ?? new Set<string>();
              const now = (row[column] ?? {}) as Record<string, unknown>;
              const then = recorded[column] as Record<string, unknown>;
              for (const key of new Set([...Object.keys(now), ...Object.keys(then)])) {
                if (additive.has(key) && !(key in then)) continue;
                if (JSON.stringify(now[key]) !== JSON.stringify(then[key])) differences.push(`${rowKey(row)} ${column}.${key}`);
              }
            } else if (JSON.stringify(row[column]) !== JSON.stringify(recorded[column])) {
              differences.push(`${rowKey(row)} ${column}`);
            }
          }
        });
        assert.deepEqual(differences, [], `${pathName} ${table}: columns that changed`);
      });

      test(`${pathName}: every ${table} column this phase or a later one added holds its default, apart from the additive fields`, () => {
        const before = new Set(reference.snapshot.columns[table].map((column) => column.name));
        const added = current.columns[table].filter((column) => !before.has(column.name) && !ADDITIVE_COLUMNS[table].has(column.name));
        assert.ok(added.length > 0, 'the phase added columns to compare');
        const rows = fromColumnar(current.paths[pathName][table]);
        const offending: string[] = [];
        for (const column of added) {
          const expected = column.type.startsWith('timestamp') ? false : defaultValue(column);
          for (const row of rows) {
            if (JSON.stringify(row[column.name]) !== JSON.stringify(expected)) offending.push(`${rowKey(row)} ${column.name}`);
          }
        }
        assert.deepEqual(offending, []);
      });
    }
  }

  test('every published version carries the ingestion fingerprint (the additive field)', () => {
    for (const pathName of PATHS) {
      const documents = fromColumnar(current.paths[pathName].documents);
      for (const row of documents) {
        if (row.status === 'ready') assert.match(String(row.ingest_fingerprint), /^(sha:|[0-9a-f]{64}$)/, `${rowKey(row)} has a fingerprint`);
      }
    }
  });

  test('no table created after the phase began holds a row, and no ledger row is written inline', () => {
    const before = new Set(reference.snapshot.tables);
    for (const pathName of PATHS) {
      const counts = current.paths[pathName].table_rows;
      const recorded = reference.snapshot.paths[pathName].table_rows;
      const newTables = Object.entries(counts).filter(([table, count]) => !before.has(table) && count !== 0);
      assert.deepEqual(newTables, [], `${pathName}: rows in tables this phase or a later one created`);
      const changed = Object.entries(recorded).filter(([table, count]) => !MIGRATION_SEEDED_TABLES.has(table) && counts[table] !== count);
      assert.deepEqual(changed, [], `${pathName}: row counts of tables that existed before`);
    }
    assert.equal(current.paths.inline.table_rows.ingestion_jobs, 0);
  });

  test('the builds call the same sidecar routes and model endpoints as before, and no route this phase added', () => {
    for (const pathName of PATHS) {
      assert.deepEqual(current.external_calls[pathName], reference.snapshot.external_calls[pathName], `${pathName}: external calls`);
      const added = Object.keys(current.external_calls[pathName]).filter((call) => /\/v1\/(hidden-text|embed)\b/.test(call));
      assert.deepEqual(added, []);
    }
  });

  for (const pipeline of ['legacy', 'v2'] as const) {
    test(`${pipeline} retrieval: the same status, context, candidates and retrievalConfigHash for every request`, () => {
      const expected = reference.snapshot.retrieval[pipeline];
      const actual = current.retrieval[pipeline];
      assert.deepEqual(actual.map((probe) => probe.query_id), expected.map((probe) => probe.query_id));
      expected.forEach((recorded, index) => {
        const probe = actual[index] as RetrievalProbe;
        const label = `${pipeline} ${recorded.query_id}`;
        assert.equal(probe.status, recorded.status, `${label}: status`);
        assert.equal(probe.reason, recorded.reason, `${label}: reason`);
        assert.equal(probe.retrieval_config_hash, recorded.retrieval_config_hash, `${label}: retrievalConfigHash`);
        assert.equal(probe.context_sha256, recorded.context_sha256, `${label}: context`);
        assert.equal(probe.source_images, recorded.source_images, `${label}: source_images`);
        assertCandidates(probe.candidates, recorded.candidates, label);
      });
      if (pipeline === 'v2') assert.ok(expected.every((probe) => probe.retrieval_config_hash), 'v2 records a retrievalConfigHash');
    });
  }
});
