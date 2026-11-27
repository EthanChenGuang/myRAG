import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

/**
 * Plan 03.3-23 (D-11, D-36, TPL-09): a run config that turns a Phase 3.3 switch on gets a fixture database that holds what a deployment
 * holds after its documented steps: the fixture tenant's rule data, attribute schema, header template and attribute values are written
 * through the product services and the import function before the first document, and the documents are ingested with the switches on.
 * A config that restates the defaults layers nothing. Each case runs in its own child process (one deployment mode, one fixture edge
 * and one environment per process).
 */
const SELF = fileURLToPath(import.meta.url);
const REPO_ROOT = path.resolve(path.dirname(SELF), '../..');
const CORPUS_DIR = path.join(REPO_ROOT, 'eval/fixtures/corpus');
const SEED_MODULE = path.join(REPO_ROOT, 'eval/harness/templated-seed.mts');
const CASE_ENV = 'FIXTURE_PHASE33_FEATURE_CASE';
const RESULT_PREFIX = 'FIXTURE_PHASE33_RESULT ';
const RESTRICTED = ['tpl-family-zh-01', 'tpl-family-en-01', 'tpl-family-it-01', 'tpl-variants-zh', 'tpl-variants-en', 'tpl-variants-it'];
/** A product_technical typed fixture ingested before the templated documents: it is the earlier document of the bound doc type. */
const EARLIER_TYPED = 'images-en';
const PHASE33_TABLES = [
  'rag_attribute_definitions',
  'rag_attribute_header_templates',
  'rag_boilerplate_rules',
  'rag_section_rule_sets',
  'rag_staged_attributes',
] as const;
const DATA_FILES = ['attribute-schema.json', 'attributes.json', 'boilerplate-rules.json', 'header-template.json', 'section-rules.json'];

type Mode = 'single-tenant' | 'multi-tenant';
type CaseName = 'ingest-off' | 'ingest-recommended' | 'ingest-identifiers' | 'prechunked-off' | 'prechunked-quantity';

function runConfigEnv(name: string): Record<string, string> {
  return (JSON.parse(fs.readFileSync(path.join(REPO_ROOT, `eval/config/runs/${name}.json`), 'utf8')) as { env: Record<string, string> }).env;
}

interface TemplatedDoc {
  id: string;
  kind: string;
  attributes: Record<string, unknown> | null;
  expectedAttributes: Record<string, unknown>;
  header: string | null;
  stamp: string | null;
  chunks: number;
  chunksWithAttributes: number;
  chunksWithStamp: number;
  lexicalVersions: number[];
  /** Chunks holding a declared top or bottom line. */
  edgeLineChunks: number;
  fragment: string;
  fragmentChunks: number;
  /** Designations of a variant file, and for each chunk naming one, whether its first section_path element names it too. */
  designations: string[];
  variantChunks: Array<{ designation: string; first: string | null }>;
  identifierChunks: number;
  codeIndexedChunks: number;
}

interface CaseResult {
  corpusSha256: string;
  dumpSha256: string;
  tables: Record<string, number>;
  adminUsers: number;
  plain?: { corpusSha256: string; dumpSha256: string };
  repeatCorpusSha256?: string;
  seedParts?: string[];
  docs?: TemplatedDoc[];
  earlier?: { needsReview: boolean; reasons: unknown; chunks: number };
  fragmentCap?: number;
  sqlSha256?: Record<string, string>;
  /** Distinct lexical versions of current chunks. */
  lexicalVersions?: number[];
  /** Distinct lexical versions of superseded chunks (rag:relex rewrites current rows only). */
  supersededLexicalVersions?: number[];
}

async function dumpOf(db: import('@electric-sql/pglite').PGlite): Promise<string> {
  const documents = await db.query(
    'SELECT id, filename, content, metadata, status, is_current, version, attributes, attribute_header, attribute_header_stamp, needs_review FROM documents ORDER BY id',
  );
  const chunks = await db.query(
    'SELECT id, document_id, content, lexical_text, lexical_version, metadata, is_current, status, version, attributes, attribute_header_stamp, identifiers_norm FROM document_chunks ORDER BY id',
  );
  return crypto.createHash('sha256').update(JSON.stringify([documents.rows, chunks.rows])).digest('hex');
}

async function tableCounts(db: import('@electric-sql/pglite').PGlite): Promise<{ tables: Record<string, number>; adminUsers: number }> {
  const tables: Record<string, number> = {};
  for (const table of PHASE33_TABLES) tables[table] = (await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM public.${table}`)).rows[0].n;
  const adminUsers = (await db.query<{ n: number }>('SELECT count(*)::int AS n FROM admin_users')).rows[0].n;
  return { tables, adminUsers };
}

async function templatedDocs(db: import('@electric-sql/pglite').PGlite): Promise<TemplatedDoc[]> {
  const { loadTemplatedFixtures } = await import('../../eval/harness/templated-fixtures.mts');
  const { normalizeIdentifier } = await import('@/lib/rag/ids/normalize');
  const out: TemplatedDoc[] = [];
  for (const fixture of loadTemplatedFixtures().fixtures.filter((entry) => RESTRICTED.includes(entry.id))) {
    const doc = (
      await db.query<Record<string, unknown>>('SELECT id, attributes, attribute_header, attribute_header_stamp FROM documents WHERE filename = $1', [
        fixture.file_name,
      ])
    ).rows[0];
    const chunks = (
      await db.query<Record<string, unknown>>(
        "SELECT content, attributes, attribute_header_stamp, lexical_version, metadata -> 'section_path' AS section_path, identifiers_norm FROM document_chunks WHERE document_id = $1 ORDER BY chunk_index",
        [doc.id],
      )
    ).rows;
    const templated = fixture.templated as unknown as { kind: string; lines: { top: string[]; bottom: string[]; fragment: string }; designations?: string[] };
    const edge = [...templated.lines.top, ...templated.lines.bottom];
    const designations = templated.designations ?? [];
    const code = normalizeIdentifier(String(fixture.attributes.alpha_code));
    const variantChunks: TemplatedDoc['variantChunks'] = [];
    for (const chunk of chunks) {
      const content = String(chunk.content);
      const designation = designations.find((entry) => content.includes(entry));
      const sectionPath = Array.isArray(chunk.section_path) ? (chunk.section_path as string[]) : [];
      if (designation && !content.startsWith('Drikpland') && sectionPath.length > 0) variantChunks.push({ designation, first: sectionPath[0] ?? null });
    }
    out.push({
      id: fixture.id,
      kind: templated.kind,
      attributes: (doc.attributes as Record<string, unknown> | null) ?? null,
      expectedAttributes: fixture.attributes,
      header: (doc.attribute_header as string | null) ?? null,
      stamp: (doc.attribute_header_stamp as string | null) ?? null,
      chunks: chunks.length,
      chunksWithAttributes: chunks.filter((chunk) => chunk.attributes !== null).length,
      chunksWithStamp: chunks.filter((chunk) => chunk.attribute_header_stamp !== null).length,
      lexicalVersions: [...new Set(chunks.map((chunk) => Number(chunk.lexical_version)))].sort(),
      edgeLineChunks: chunks.filter((chunk) => edge.some((line) => String(chunk.content).includes(line))).length,
      fragment: templated.lines.fragment,
      fragmentChunks: chunks.filter((chunk) => String(chunk.content).includes(templated.lines.fragment)).length,
      designations,
      variantChunks,
      identifierChunks: chunks.filter((chunk) => Array.isArray(chunk.identifiers_norm) && (chunk.identifiers_norm as unknown[]).length > 0).length,
      codeIndexedChunks: chunks.filter((chunk) => Array.isArray(chunk.identifiers_norm) && (chunk.identifiers_norm as string[]).includes(code)).length,
    });
  }
  return out;
}

async function runCase(caseName: CaseName, mode: Mode): Promise<CaseResult> {
  if (caseName === 'prechunked-off' || caseName === 'prechunked-quantity') {
    const { prepareInProcessEval } = await import('../../eval/harness/run-eval.mts');
    const { createFixtureDatabase } = await import('../../eval/harness/pglite-supabase.mts');
    let plain: CaseResult['plain'];
    if (caseName === 'prechunked-off') {
      const built = await createFixtureDatabase({ deploymentMode: mode, corpusDir: CORPUS_DIR });
      plain = { corpusSha256: built.corpusSha256, dumpSha256: await dumpOf(built.db) };
      await built.db.close();
    }
    const inProcess = await prepareInProcessEval({
      corpusDir: CORPUS_DIR,
      deploymentMode: mode,
      fixtureMode: 'prechunked',
      envOverrides: runConfigEnv(caseName === 'prechunked-off' ? 'tpl-all-off' : 'tpl-only-quantity'),
    });
    try {
      const db = inProcess.fixtureDb;
      const versionsOf = async (current: boolean): Promise<number[]> =>
        (await db.query<{ v: number }>('SELECT DISTINCT lexical_version AS v FROM document_chunks WHERE is_current = $1 ORDER BY 1', [current])).rows.map(
          (row) => row.v,
        );
      const versions = await versionsOf(true);
      const supersededVersions = await versionsOf(false);
      return {
        corpusSha256: inProcess.corpusSha256,
        dumpSha256: await dumpOf(db),
        ...(await tableCounts(db)),
        ...(plain ? { plain } : {}),
        sqlSha256: { ...inProcess.sqlSha256 },
        lexicalVersions: versions,
        supersededLexicalVersions: supersededVersions,
      };
    } finally {
      await inProcess.close();
    }
  }

  const ingestMode = await import('../../eval/harness/ingest-mode.mts');
  const seed = (await import(SEED_MODULE)) as typeof import('../../eval/harness/templated-seed.mts');
  const typedFixtureIds = caseName === 'ingest-recommended' ? [EARLIER_TYPED] : [];
  const small = {
    deploymentMode: mode,
    corpusDir: CORPUS_DIR,
    corpusRange: { start: 0, end: 1 },
    typedFixtureIds,
    parseFixtureIds: [] as string[],
    templated: true,
    templatedFixtureIds: RESTRICTED,
  } as const;
  const configName = caseName === 'ingest-off' ? 'tpl-all-off' : caseName === 'ingest-recommended' ? 'tpl-recommended' : 'tpl-only-identifier-feed';
  const buildEnv = seed.phase33BuildEnv(runConfigEnv(configName));
  const layered = Object.keys(buildEnv).length > 0 ? { ingestEnv: buildEnv } : {};

  let plain: CaseResult['plain'];
  if (caseName === 'ingest-off') {
    const built = await ingestMode.buildIngestFixtureDatabase(small);
    plain = { corpusSha256: built.corpusSha256, dumpSha256: await dumpOf(built.db) };
    await built.edge?.close().catch(() => undefined);
    await built.db.close();
  }
  const built = await ingestMode.buildIngestFixtureDatabase({ ...small, ...layered });
  try {
    const db = built.db;
    const result: CaseResult = {
      corpusSha256: built.corpusSha256,
      dumpSha256: await dumpOf(db),
      ...(await tableCounts(db)),
      ...(plain ? { plain } : {}),
      seedParts: seed.phase33SeedParts(buildEnv),
      docs: await templatedDocs(db),
    };
    if (caseName === 'ingest-recommended') {
      const earlier = (
        await db.query<Record<string, unknown>>(
          "SELECT d.needs_review, d.metadata -> 'review_reasons' AS reasons, (SELECT count(*)::int FROM document_chunks c WHERE c.document_id = d.id) AS chunks FROM documents d WHERE d.filename = 'images-en.pdf'",
        )
      ).rows[0];
      result.earlier = { needsReview: earlier.needs_review === true, reasons: earlier.reasons, chunks: Number(earlier.chunks) };
      const { boilerplateConfig } = await import('@/lib/rag/ingest/prepare/boilerplate-config');
      const { loadTemplatedData } = await import('../../eval/harness/templated-fixtures.mts');
      const rules = (loadTemplatedData().boilerplate_rules as { boilerplate_rules: Array<{ kind: string; max_length?: number }> }).boilerplate_rules;
      const ruleMax = Math.max(...rules.filter((rule) => rule.kind === 'fragment').map((rule) => rule.max_length ?? 0));
      result.fragmentCap = Math.min(ruleMax, boilerplateConfig().fragment_max_length);
      if (mode === 'single-tenant') {
        await built.edge?.close().catch(() => undefined);
        await db.close();
        const again = await ingestMode.buildIngestFixtureDatabase({ ...small, ...layered });
        result.repeatCorpusSha256 = again.corpusSha256;
        await again.edge?.close().catch(() => undefined);
        await again.db.close();
        return result;
      }
    }
    return result;
  } finally {
    await built.edge?.close().catch(() => undefined);
    await built.db.close().catch(() => undefined);
  }
}

function runChild(caseName: CaseName, mode: Mode): CaseResult {
  const result = spawnSync(process.execPath, ['--import', 'tsx', SELF], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    env: { ...process.env, [CASE_ENV]: `${caseName}:${mode}` },
    timeout: 900_000,
    maxBuffer: 256 * 1024 * 1024,
  });
  const line = result.stdout.split('\n').find((entry) => entry.startsWith(RESULT_PREFIX));
  assert.equal(result.status, 0, `${caseName} ${mode} failed:\n${result.stderr.slice(-3000)}`);
  assert.ok(line, `${caseName} ${mode} printed no result:\n${result.stdout.slice(-2000)}\n${result.stderr.slice(-2000)}`);
  return JSON.parse(line.slice(RESULT_PREFIX.length)) as CaseResult;
}

const CASE = process.env[CASE_ENV];

if (CASE !== undefined) {
  const [caseName, mode] = CASE.split(':') as [CaseName, Mode];
  const result = await runCase(caseName, mode);
  process.stdout.write(`${RESULT_PREFIX}${JSON.stringify(result)}\n`);
  process.exit(0);
} else {
  const zeroTables = Object.fromEntries(PHASE33_TABLES.map((table) => [table, 0]));
  const results = new Map<string, CaseResult>();
  const get = (caseName: CaseName, mode: Mode): CaseResult => {
    const key = `${caseName}:${mode}`;
    if (!results.has(key)) results.set(key, runChild(caseName, mode));
    return results.get(key) as CaseResult;
  };

  describe('Phase 3.3 switch layering of the fixture build (03.3-23)', () => {
    test('phase33BuildEnv layers only the switches whose value differs from the default', async () => {
      const { phase33BuildEnv } = (await import(SEED_MODULE)) as typeof import('../../eval/harness/templated-seed.mts');
      assert.deepEqual(phase33BuildEnv(runConfigEnv('tpl-all-off')), {});
      assert.deepEqual(phase33BuildEnv(runConfigEnv('tpl-v2-off')), {});
      assert.deepEqual(phase33BuildEnv(runConfigEnv('tpl-recommended')), {
        RAG_SECTION_RULES: 'on',
        RAG_PAGE_BOILERPLATE: 'both',
        RAG_DOC_ATTRIBUTES: 'true',
        RAG_ATTRIBUTE_HEADER: 'true',
        RAG_LEXICAL_QUANTITY: 'true',
      });
      assert.deepEqual(phase33BuildEnv(runConfigEnv('tpl-only-identifier-feed')), { RAG_DOC_ATTRIBUTES: 'true', RAG_IDENTIFIER_INDEX: 'true' });
      assert.deepEqual(phase33BuildEnv({ RAG_IDENTIFIER_INDEX: 'true' }), {}, 'RAG_IDENTIFIER_INDEX alone is not the identifier-feed branch');
      assert.deepEqual(phase33BuildEnv(runConfigEnv('tpl-only-filter-hard')), { RAG_DOC_ATTRIBUTES: 'true' });
    });

    test('the seeding module compiles and runs no pattern', () => {
      const source = fs.readFileSync(SEED_MODULE, 'utf8');
      assert.doesNotMatch(source, /\bRegExp\b/);
      assert.doesNotMatch(source, /\.(?:test|exec|match|matchAll|search|split|replace|replaceAll)\(/);
    });

    for (const mode of ['single-tenant', 'multi-tenant'] as const) {
      test(`ingest mode, explicit defaults (tpl-all-off), ${mode}: no seeding, same hash and database as a build without the option`, () => {
        const off = get('ingest-off', mode);
        assert.ok(off.plain);
        assert.equal(off.corpusSha256, off.plain.corpusSha256);
        assert.equal(off.dumpSha256, off.plain.dumpSha256);
        assert.deepEqual(off.tables, zeroTables);
        assert.equal(off.adminUsers, 0);
        assert.deepEqual(off.seedParts, []);
      });

      test(`ingest mode, tpl-recommended, ${mode}: the tenant is seeded through the services before the documents`, () => {
        const on = get('ingest-recommended', mode);
        const off = get('ingest-off', mode);
        assert.notEqual(on.corpusSha256, off.corpusSha256);
        assert.equal(on.tables.rag_attribute_definitions, 4);
        assert.equal(on.tables.rag_attribute_header_templates, 1);
        assert.equal(on.tables.rag_boilerplate_rules, 4);
        assert.equal(on.tables.rag_section_rule_sets, 1);
        assert.ok(on.tables.rag_staged_attributes > 0, 'the import staged the values of documents that did not exist yet');
        assert.equal(on.adminUsers, 1);
        assert.deepEqual(
          on.seedParts?.map((part) => part.split(':').slice(0, 2).join(':')),
          DATA_FILES.map((file) => `phase33_seed:${file}`),
        );
        for (const part of on.seedParts ?? []) {
          const [, file, sha] = part.split(':');
          const actual = crypto.createHash('sha256').update(fs.readFileSync(path.join(REPO_ROOT, 'eval/fixtures/ingest/templated', file))).digest('hex');
          assert.equal(sha, actual, `${file} hash part`);
        }
      });

      test(`ingest mode, tpl-recommended, ${mode}: documents and chunks carry attributes, header, stamp and quantity version`, () => {
        const on = get('ingest-recommended', mode);
        assert.equal(on.docs?.length, RESTRICTED.length);
        for (const doc of on.docs ?? []) {
          assert.deepEqual(doc.attributes, doc.expectedAttributes, `${doc.id} attributes`);
          assert.ok(doc.header && doc.header.length > 0, `${doc.id} rendered header`);
          assert.ok(doc.stamp && doc.stamp !== 'none', `${doc.id} header stamp`);
          assert.ok(doc.chunks > 0);
          assert.equal(doc.chunksWithAttributes, doc.chunks, `${doc.id} chunk attributes`);
          assert.equal(doc.chunksWithStamp, doc.chunks, `${doc.id} chunk header stamp`);
          assert.deepEqual(doc.lexicalVersions, [6], `${doc.id} chunks carry the quantity lexical version`);
          assert.equal(doc.identifierChunks, 0, `${doc.id}: RAG_IDENTIFIER_INDEX is off, so no identifier column is written`);
        }
      });

      test(`ingest mode, tpl-recommended, ${mode}: rules shape the chunks; earlier documents of the doc type are flagged`, () => {
        const on = get('ingest-recommended', mode);
        for (const doc of on.docs ?? []) {
          assert.equal(doc.edgeLineChunks, 0, `${doc.id}: no chunk holds a declared top or bottom line`);
          // The effective fragment cap is min(rule max_length, config fragment_max_length); a longer fragment stays (handoff 03.3-23-fragment-cap).
          if ([...doc.fragment].length <= (on.fragmentCap ?? 0)) assert.equal(doc.fragmentChunks, 0, `${doc.id}: no chunk holds the declared fragment`);
          if (doc.kind === 'variants') {
            assert.ok(doc.variantChunks.length >= doc.designations.length, `${doc.id} has chunks for each variant`);
            for (const chunk of doc.variantChunks) {
              assert.ok(chunk.first?.includes(chunk.designation), `${doc.id}: section_path[0] of a ${chunk.designation} chunk is its variant label`);
            }
          }
        }
        assert.ok(on.earlier);
        assert.equal(on.earlier.needsReview, true);
        assert.deepEqual(on.earlier.reasons, ['section_rules_not_satisfied']);
        assert.ok(on.earlier.chunks > 0, 'the flagged document keeps its chunks');
      });
    }

    test('ingest mode: two builds with the same env give the same corpus hash', () => {
      const on = get('ingest-recommended', 'single-tenant');
      assert.equal(on.repeatCorpusSha256, on.corpusSha256);
    });

    test('ingest mode, identifier feed: the code attribute values reach the chunk identifier arrays', () => {
      const feed = get('ingest-identifiers', 'single-tenant');
      assert.deepEqual(feed.seedParts?.map((part) => part.split(':')[1]), ['attribute-schema.json', 'attributes.json']);
      for (const doc of feed.docs ?? []) assert.equal(doc.codeIndexedChunks, doc.chunks, `${doc.id}: every chunk indexes the code value`);
    });

    for (const mode of ['single-tenant', 'multi-tenant'] as const) {
      test(`prechunked mode, explicit defaults (tpl-all-off), ${mode}: the database equals the plain build`, () => {
        const off = get('prechunked-off', mode);
        assert.ok(off.plain);
        assert.equal(off.corpusSha256, off.plain.corpusSha256);
        assert.equal(off.dumpSha256, off.plain.dumpSha256);
        assert.deepEqual(off.tables, zeroTables);
        assert.ok(!Object.keys(off.sqlSha256 ?? {}).some((key) => key.startsWith('lexical_effective_version:')));
      });
    }

    test('prechunked mode, RAG_LEXICAL_QUANTITY=true: the relex moves every chunk to the quantity version and records it', () => {
      const quantity = get('prechunked-quantity', 'single-tenant');
      const off = get('prechunked-off', 'single-tenant');
      assert.deepEqual(quantity.lexicalVersions, [6]);
      assert.deepEqual(quantity.supersededLexicalVersions, off.supersededLexicalVersions, 'superseded chunks keep their version, as rag:relex leaves them');
      assert.ok(quantity.sqlSha256?.['lexical_effective_version:6']);
      assert.notEqual(quantity.dumpSha256, off.dumpSha256);
      assert.deepEqual(quantity.tables, zeroTables, 'no Phase 3.3 rule data is seeded in prechunked mode');
    });
  });
}
