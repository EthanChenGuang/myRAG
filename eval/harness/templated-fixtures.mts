/**
 * The templated collection of the ingest fixture mode (plan 03.3-20; D-36, TPL-09). The documents are the `templated_fixtures` of
 * eval/fixtures/ingest/manifest.json; the fixture tenant's rule data is the five files under eval/fixtures/ingest/templated/.
 * `loadTemplatedFixtures` returns the same dump as the Python twin (eval/src/rag_eval/templated_fixtures.py), and
 * `npx tsx eval/harness/templated-fixtures.mts --dump` prints it as sorted JSON. Patterns are data here: nothing in this module
 * compiles or runs one (plan 03.3-23 runs them through the worker).
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  AttributeHeaderTemplateSchema,
  AttributeImportRowSchema,
  AttributeSchemaSchema,
  TenantRulesFileSchema,
} from '../../src/lib/rag-eval/contracts.generated.ts';
import { buildSourceKey } from '../../src/lib/rag/ingest/identity.ts';

const INGEST_DIR = 'eval/fixtures/ingest';
const DATA_DIR = `${INGEST_DIR}/templated`;
export const TEMPLATED_CATEGORY = 'templated_collection';
const DATA_FILES = {
  attribute_schema: 'attribute-schema.json',
  attributes: 'attributes.json',
  section_rules: 'section-rules.json',
  boilerplate_rules: 'boilerplate-rules.json',
  header_template: 'header-template.json',
} as const;

export type TemplatedDataKey = keyof typeof DATA_FILES;

export interface TemplatedFixture {
  id: string;
  language: string;
  doc_type: string;
  file_name: string;
  /** Repo-relative path of the PDF. */
  path: string;
  file_sha256: string;
  source: 'config_upload';
  source_key: string;
  /** expected.templated of the manifest entry: kind, declared lines, heading lines, attributes and the family or variant data. */
  templated: Record<string, unknown> & { kind: 'family' | 'variants'; page_count: number };
  attributes: Record<string, string | string[]>;
}

export interface TemplatedFixtureSet {
  fixtures: TemplatedFixture[];
  data: Record<TemplatedDataKey, unknown>;
}

interface ManifestEntry {
  id: string;
  language: string;
  doc_type: string;
  path: string;
  file_sha256: string;
  expected: { templated: TemplatedFixture['templated'] };
}

function readJson(root: string, relative: string): unknown {
  return JSON.parse(fs.readFileSync(path.join(root, relative), 'utf8'));
}

/** The five data files, each validated against its generated contract and returned as written. */
export function loadTemplatedData(root = process.cwd()): TemplatedFixtureSet['data'] {
  const data = Object.fromEntries(
    Object.entries(DATA_FILES).map(([key, name]) => [key, readJson(root, `${DATA_DIR}/${name}`)]),
  ) as Record<TemplatedDataKey, unknown>;
  AttributeSchemaSchema.parse(data.attribute_schema);
  for (const row of (data.attributes as { rows: unknown[] }).rows) AttributeImportRowSchema.parse(row);
  TenantRulesFileSchema.parse(data.section_rules);
  TenantRulesFileSchema.parse(data.boilerplate_rules);
  AttributeHeaderTemplateSchema.parse(data.header_template);
  return data;
}

/** Every templated fixture with its source key, declared lines and attribute values, plus the five data files. */
export function loadTemplatedFixtures(root = process.cwd()): TemplatedFixtureSet {
  const manifest = readJson(root, `${INGEST_DIR}/manifest.json`) as { templated_fixtures?: ManifestEntry[] };
  const data = loadTemplatedData(root);
  const rows = new Map(
    (data.attributes as { rows: Array<{ source_key: string; attributes: TemplatedFixture['attributes'] }> }).rows.map((row) => [row.source_key, row]),
  );
  const fixtures = (manifest.templated_fixtures ?? []).map((entry): TemplatedFixture => {
    const fileName = path.posix.basename(entry.path);
    const sourceKey = buildSourceKey('config_upload', { filename: fileName });
    const row = rows.get(sourceKey);
    if (!row) throw new Error(`[Templated Fixtures] ${entry.id}: no attribute row for ${sourceKey}`);
    return {
      id: entry.id,
      language: entry.language,
      doc_type: entry.doc_type,
      file_name: fileName,
      path: path.posix.join(INGEST_DIR, entry.path),
      file_sha256: entry.file_sha256,
      source: 'config_upload',
      source_key: sourceKey,
      templated: entry.expected.templated,
      attributes: row.attributes,
    };
  });
  return { fixtures, data };
}

/** A golden item of the templated collection: it runs only where the collection is loaded (inline ingest mode). */
export function isTemplatedItem(item: { category: string }): boolean {
  return item.category === TEMPLATED_CATEGORY;
}

/** The golden file without templated items, for runs that do not load the collection; the file itself when it holds none. */
export function dropTemplatedItems(goldenPath: string, outPath: string): string {
  const lines = fs.readFileSync(goldenPath, 'utf8').split('\n').filter((line) => line.trim() !== '');
  const kept = lines.filter((line) => !isTemplatedItem(JSON.parse(line) as { category: string }));
  if (kept.length === lines.length) return goldenPath;
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, `${kept.join('\n')}\n`);
  return outPath;
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value as Record<string, unknown>)
        .sort()
        .map((key) => [key, sortKeys((value as Record<string, unknown>)[key])]),
    );
  }
  return value;
}

/** The dump as the Python `dump` command prints it: keys sorted at every level. */
export function dumpTemplatedFixtures(root = process.cwd()): string {
  return JSON.stringify(sortKeys(loadTemplatedFixtures(root)));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url) && process.argv.includes('--dump')) {
  process.stdout.write(`${dumpTemplatedFixtures()}\n`);
}
