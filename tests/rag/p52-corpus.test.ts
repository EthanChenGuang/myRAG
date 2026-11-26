import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, test } from 'vitest';
import type { PGlite } from '@electric-sql/pglite';
import { loadCorpus, type CorpusDocument } from '../../eval/harness/corpus.mts';
import { prechunkedWriter } from '../../eval/harness/pglite-supabase.mts';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const CORPUS_DIR = path.join(REPO_ROOT, 'eval/fixtures/corpus');

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function tempCorpus(files: Record<string, string>): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'p52-corpus-'));
  tempDirs.push(dir);
  for (const [relpath, content] of Object.entries(files)) {
    fs.mkdirSync(path.join(dir, path.dirname(relpath)), { recursive: true });
    fs.writeFileSync(path.join(dir, relpath), content);
  }
  return dir;
}

const BODY = '## Section one\n\nThe synthetic gadget has 3 dials.\n\n<!-- chunk -->\n\n## Section two\n\nThe synthetic gadget weighs 40 grams.\n';
const VERSIONED_META = '<!-- fixture-meta {"doc_type": "general", "version": 2, "version_label": "v2", "effective_from": "2026-03-01"} -->\n';

interface RecordedInsert {
  table: string;
  columns: Record<string, unknown>;
}

/** A query recorder standing in for PGlite: every public column exists, and each INSERT is captured by column name. */
function recordingDb(): { db: PGlite; inserts: RecordedInsert[] } {
  const inserts: RecordedInsert[] = [];
  const db = {
    async query(sql: string, params: unknown[] = []) {
      if (sql.includes('information_schema.columns')) return { rows: [{ present: true }] };
      const match = /^INSERT INTO (\S+) \(([^)]*)\)/.exec(sql);
      if (match) {
        const names = match[2].split(',').map((name) => name.trim());
        inserts.push({ table: match[1], columns: Object.fromEntries(names.map((name, index) => [name, params[index]])) });
      }
      return { rows: [] };
    },
  } as unknown as PGlite;
  return { db, inserts };
}

describe('loader', () => {
  test('fixture-meta version, version_label and effective_from reach the document', () => {
    const dir = tempCorpus({ 'en/versioned.en.md': VERSIONED_META + BODY });
    const [doc] = loadCorpus(dir).documents;
    expect(doc.version).toBe(2);
    expect(doc.versionLabel).toBe('v2');
    expect(doc.effectiveFrom).toBe('2026-03-01');
    expect(doc.lineage).toBeUndefined();
  });

  test('a document without the version fields gains no new keys', () => {
    const dir = tempCorpus({ 'en/plain.en.md': '<!-- fixture-meta {"doc_type": "general"} -->\n' + BODY });
    const [doc] = loadCorpus(dir).documents;
    expect(Object.keys(doc).sort()).toEqual(['chunks', 'content', 'createdAt', 'docType', 'filename', 'id', 'imageUrl', 'language', 'relpath']);
  });

  test('version fields on one document leave the other documents and the hash rule unchanged', () => {
    const plain = '<!-- fixture-meta {"doc_type": "general"} -->\n' + BODY;
    const before = loadCorpus(tempCorpus({ 'en/plain.en.md': plain }));
    const after = loadCorpus(tempCorpus({ 'en/plain.en.md': plain, 'en/versioned.en.md': VERSIONED_META + BODY }));
    const plainAfter = after.documents.find((doc) => doc.relpath === 'en/plain.en.md') as CorpusDocument;
    expect(plainAfter).toEqual(before.documents[0]);
    expect(after.corpusSha256).not.toBe(before.corpusSha256);
  });

  test('the committed corpus documents without version fields carry none', () => {
    for (const doc of loadCorpus(CORPUS_DIR).documents) {
      if (/^p52-rules-v\d\./.test(path.posix.basename(doc.relpath))) continue;
      expect(doc.versionLabel, doc.relpath).toBeUndefined();
      expect(doc.effectiveFrom, doc.relpath).toBeUndefined();
      expect(doc.version, doc.relpath).toBeUndefined();
    }
  });

  test.each([
    ['2026-3-01'],
    ['2026-02-30'],
    ['01/03/2026'],
    [20260301],
  ])('an invalid effective_from %j throws with the file path, not its content', (value) => {
    const meta = `<!-- fixture-meta {"version": 2, "version_label": "v2", "effective_from": ${JSON.stringify(value)}} -->\n`;
    const dir = tempCorpus({ 'en/bad-date.en.md': meta + BODY });
    let message = '';
    try {
      loadCorpus(dir);
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toContain('en/bad-date.en.md');
    expect(message).toContain('effective_from');
    expect(message).not.toContain('synthetic gadget');
  });

  test.each([
    ['version 0', '{"version": 0}'],
    ['a fractional version', '{"version": 1.5}'],
    ['an empty version_label', '{"version_label": ""}'],
    ['a numeric version_label', '{"version_label": 2}'],
  ])('%s throws with the file path', (_label, json) => {
    const dir = tempCorpus({ 'en/bad-version.en.md': `<!-- fixture-meta ${json} -->\n` + BODY });
    expect(() => loadCorpus(dir)).toThrow(/en\/bad-version\.en\.md/);
  });

  test('a lineage document keeps its lineage version and gains no document version key', () => {
    const dir = tempCorpus({ 'en/lineage.en.md': '<!-- fixture-meta {"lineage": "gadget", "version": 3} -->\n' + BODY });
    const [doc] = loadCorpus(dir).documents;
    expect(doc.lineage).toEqual({ id: 'gadget', version: 3 });
    expect('version' in doc).toBe(false);
  });

  test('the prechunked writer writes version, version_label and effective_from to the document and its chunk rows', async () => {
    const [doc] = loadCorpus(tempCorpus({ 'en/versioned.en.md': VERSIONED_META + BODY })).documents;
    const { db, inserts } = recordingDb();
    const write = await prechunkedWriter(db, 'single-tenant');
    await write(doc);
    const documentRow = inserts.find((insert) => insert.table === 'documents') as RecordedInsert;
    expect(documentRow.columns.version).toBe(2);
    expect(documentRow.columns.version_label).toBe('v2');
    expect(documentRow.columns.effective_from).toBe('2026-03-01');
    expect(JSON.parse(documentRow.columns.metadata as string)).toMatchObject({ version_label: 'v2', effective_from: '2026-03-01' });
    const chunkRows = inserts.filter((insert) => insert.table === 'document_chunks');
    expect(chunkRows).toHaveLength(2);
    for (const row of chunkRows) expect(row.columns.effective_from).toBe('2026-03-01');
  });

  test('the prechunked writer writes no version columns for a document without them', async () => {
    const [doc] = loadCorpus(tempCorpus({ 'en/plain.en.md': BODY })).documents;
    const { db, inserts } = recordingDb();
    await (await prechunkedWriter(db, 'single-tenant'))(doc);
    for (const insert of inserts) {
      expect(Object.keys(insert.columns)).not.toContain('version');
      expect(Object.keys(insert.columns)).not.toContain('version_label');
      expect(Object.keys(insert.columns)).not.toContain('effective_from');
    }
    const documentRow = inserts.find((insert) => insert.table === 'documents') as RecordedInsert;
    expect(Object.keys(JSON.parse(documentRow.columns.metadata as string)).sort()).toEqual(['language', 'relpath']);
  });
});
