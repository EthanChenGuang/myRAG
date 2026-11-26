import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, test } from 'vitest';
import type { PGlite } from '@electric-sql/pglite';
import { scanText } from '@/lib/rag/security/injection-rules';
import { loadCorpus, type CorpusDocument, type CorpusLanguage } from '../../eval/harness/corpus.mts';
import { prechunkedWriter } from '../../eval/harness/pglite-supabase.mts';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const CORPUS_DIR = path.join(REPO_ROOT, 'eval/fixtures/corpus');
const LANGUAGE_PACKS_PATH = path.join(REPO_ROOT, 'config/rag/language-packs.json');
const LANGUAGES: CorpusLanguage[] = ['zh', 'en', 'it'];
const NEW_FILE_RE = /^(?:p52-answers|p52-rules-v1|p52-rules-v2|sec-links)\.(?:zh|en|it)\.md$/;

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

// Structure of p52-answers.<lang>.md: partial sections state one part of a subject and leave out another part a question asks;
// adjacent sections are on a neighbouring subject that the off_topic_context questions below land on.
const ANSWER_SECTIONS: Record<CorpusLanguage, { partial: string[]; adjacent: string[] }> = {
  en: {
    partial: ['Quillon RK-3 pottery kiln', 'Brisbel WL-9 table loom', 'Orrinvale Chess Circle rapid evenings', 'Tessaly GS-2 greenhouse sprinkler'],
    adjacent: ['Quillon GM-1 glaze mixer', 'Brisbel YW-2 yarn winder', 'Orrinvale Chess Circle puzzle corner', 'Tessaly ST-4 seed tray heater'],
  },
  zh: {
    partial: ['岚溪 LX-3 陶艺电窑', '织云 ZY-8 台式织布机', '弈桥棋社周三快棋夜', '青畦 QQ-2 温室喷灌头'],
    adjacent: ['岚溪 GM-2 釉料搅拌机', '织云 RX-2 绕线器', '弈桥棋社每周残局角', '青畦 YM-4 育苗盘加热垫'],
  },
  it: {
    partial: ['Forno Calvessa CV-4 per vetrofusione', 'Pressa per legatoria Ombrina LP-3', 'Prove del Coro Valdentro', 'Bilancia per arnie Arnelia AB-6'],
    adjacent: ['Sabbiatrice per vetro Calvessa SB-2', 'Taglierina per cartoncino Ombrina TC-1', 'Archivio spartiti del Coro Valdentro', 'Affumicatore Arnelia AF-1'],
  },
};

const CREDENTIAL_WORDS: Record<CorpusLanguage, RegExp> = {
  en: /\b(?:password|code)\b/i,
  zh: /密码|验证码/,
  it: /\b(?:password|codice)\b/i,
};

const RESERVED_HOST_RE = /\.(?:test|invalid|example)$/;
const ALLOWLISTED_HOST = 'help.fixture-site.example';

function newDocuments(): CorpusDocument[] {
  return loadCorpus(CORPUS_DIR).documents.filter((doc) => NEW_FILE_RE.test(path.posix.basename(doc.relpath)));
}

function documentFor(name: string): CorpusDocument {
  const doc = loadCorpus(CORPUS_DIR).documents.find((candidate) => path.posix.basename(candidate.relpath) === name);
  if (!doc) throw new Error(`missing corpus document ${name}`);
  return doc;
}

function rawFile(doc: CorpusDocument): string {
  return fs.readFileSync(path.join(CORPUS_DIR, doc.relpath), 'utf8');
}

function versionMarkers(language: CorpusLanguage): RegExp[] {
  const packs = JSON.parse(fs.readFileSync(LANGUAGE_PACKS_PATH, 'utf8')) as { packs?: Array<{ code: string; version_markers?: string[] }> };
  const entries = packs.packs ?? (Object.values(packs).find(Array.isArray) as Array<{ code: string; version_markers?: string[] }>);
  const pack = entries.find((entry) => entry.code === language);
  if (!pack?.version_markers?.length) throw new Error(`no version_markers for ${language}`);
  return pack.version_markers.map((source) => new RegExp(source, 'gu'));
}

function withoutMarkers(title: string, language: CorpusLanguage): string {
  let text = title;
  for (const marker of versionMarkers(language)) text = text.replace(marker, '');
  return text.replace(/\s+/g, ' ').trim();
}

function numbersOf(text: string): string[] {
  return text.match(/\d+(?:[.:-]\d+)*/g) ?? [];
}

function tokens(text: string): Set<string> {
  return new Set((text.toLowerCase().replace(/\d+(?:[.:-]\d+)*/g, ' ').match(/\p{Script=Han}|[\p{L}]+/gu) ?? []).filter(Boolean));
}

function jaccard(a: Set<string>, b: Set<string>): number {
  const union = new Set([...a, ...b]);
  let shared = 0;
  for (const token of a) if (b.has(token)) shared += 1;
  return union.size === 0 ? 1 : shared / union.size;
}

function hostsIn(text: string): string[] {
  const hosts: string[] = [];
  for (const match of text.matchAll(/https?:\/\/([^/\s)>\]"'，。]+)/gu)) hosts.push(match[1].toLowerCase().replace(/[.,;:]+$/, ''));
  for (const match of text.matchAll(/[\w.+-]+@([\w-]+(?:\.[\w-]+)+)/gu)) hosts.push(match[1].toLowerCase());
  return hosts;
}

describe('documents', () => {
  test('all twelve files exist, three per kind, one per language', () => {
    const names = newDocuments().map((doc) => path.posix.basename(doc.relpath)).sort();
    expect(names).toHaveLength(12);
    for (const language of LANGUAGES) {
      for (const kind of ['p52-answers', 'p52-rules-v1', 'p52-rules-v2', 'sec-links']) expect(names).toContain(`${kind}.${language}.md`);
    }
  });

  test('every new chunk carries exactly one section heading (one topic per chunk)', () => {
    for (const doc of newDocuments()) {
      for (const chunk of doc.chunks) {
        const headings = chunk.text.split('\n').filter((line) => /^#{1,6}\s/.test(line));
        expect(headings.length, `${doc.relpath} chunk ${chunk.index}`).toBe(1);
      }
    }
  });

  test.each(LANGUAGES)('%s: p52-answers holds at least 4 partial and 4 adjacent sections', (language) => {
    const doc = documentFor(`p52-answers.${language}.md`);
    const sections = doc.chunks.map((chunk) => chunk.section);
    const { partial, adjacent } = ANSWER_SECTIONS[language];
    expect(partial.length).toBeGreaterThanOrEqual(4);
    expect(adjacent.length).toBeGreaterThanOrEqual(4);
    for (const heading of [...partial, ...adjacent]) expect(sections, heading).toContain(heading);
    expect(new Set(sections).size).toBe(sections.length);
  });

  test.each(LANGUAGES)('%s: p52-rules v1 and v2 are two current documents of one type whose titles match after marker removal', (language) => {
    const v1 = documentFor(`p52-rules-v1.${language}.md`);
    const v2 = documentFor(`p52-rules-v2.${language}.md`);
    expect(v1.lineage).toBeUndefined();
    expect(v2.lineage).toBeUndefined();
    expect(v1.docType).toBe(v2.docType);
    expect([v1.version, v1.versionLabel, v2.version, v2.versionLabel]).toEqual([1, 'v1', 2, 'v2']);
    expect(v1.effectiveFrom && v2.effectiveFrom && v1.effectiveFrom < v2.effectiveFrom).toBe(true);
    expect(v1.filename).not.toBe(v2.filename);
    expect(withoutMarkers(v1.filename, language)).toBe(withoutMarkers(v2.filename, language));
    expect(v1.chunks[0].section).not.toBe(v2.chunks[0].section);
    expect(withoutMarkers(v1.chunks[0].section, language)).toBe(withoutMarkers(v2.chunks[0].section, language));
  });

  test.each(LANGUAGES)('%s: v1 and v2 state the same rules, at least 4, each with a changed number or date', (language) => {
    const v1 = documentFor(`p52-rules-v1.${language}.md`);
    const v2 = documentFor(`p52-rules-v2.${language}.md`);
    expect(v2.chunks.map((chunk) => chunk.section)).toEqual(v1.chunks.slice(0).map((chunk, index) => (index === 0 ? v2.chunks[0].section : chunk.section)));
    const rules = v1.chunks.slice(1);
    expect(rules.length).toBeGreaterThanOrEqual(4);
    for (const [index, rule] of rules.entries()) {
      const newer = v2.chunks[index + 1];
      expect(numbersOf(rule.text).length, rule.section).toBeGreaterThan(0);
      expect(numbersOf(rule.text), rule.section).not.toEqual(numbersOf(newer.text));
      expect(jaccard(tokens(rule.text), tokens(newer.text)), rule.section).toBeGreaterThanOrEqual(0.8);
    }
  });

  test.each(LANGUAGES)('%s: sec-links plants at least 4 reserved-host links with a credential request and 4 allowlisted links', (language) => {
    const doc = documentFor(`sec-links.${language}.md`);
    const planted = doc.chunks.filter((chunk) => hostsIn(chunk.text).some((host) => host.endsWith('.test')));
    const allowlisted = doc.chunks.filter((chunk) => hostsIn(chunk.text).includes(ALLOWLISTED_HOST));
    expect(planted.length).toBeGreaterThanOrEqual(4);
    expect(allowlisted.length).toBeGreaterThanOrEqual(4);
    for (const chunk of planted) {
      expect(CREDENTIAL_WORDS[language].test(chunk.text), chunk.section).toBe(true);
      expect(hostsIn(chunk.text), chunk.section).not.toContain(ALLOWLISTED_HOST);
    }
    for (const chunk of allowlisted) {
      expect(CREDENTIAL_WORDS[language].test(chunk.text), chunk.section).toBe(false);
      expect(hostsIn(chunk.text).every((host) => host === ALLOWLISTED_HOST), chunk.section).toBe(true);
    }
  });

  test('every host or e-mail domain in the new files is a reserved test name', () => {
    for (const doc of newDocuments()) {
      for (const host of hostsIn(rawFile(doc))) expect(RESERVED_HOST_RE.test(host), `${doc.relpath}: ${host}`).toBe(true);
    }
  });

  test('no new chunk matches an injection rule, so ingest mode keeps the documents ready and the output guard sees the planted links', () => {
    const findings: string[] = [];
    for (const doc of newDocuments()) {
      for (const chunk of doc.chunks) if (scanText(chunk.text).matched) findings.push(`${doc.relpath} chunk ${chunk.index}`);
    }
    expect(findings).toEqual([]);
  });
});
