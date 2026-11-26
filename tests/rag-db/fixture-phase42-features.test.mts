import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

/**
 * Plan 04.2-29 (D-09, D-15, D-19, D-28, D-49): a run config that turns a Phase 4.2 ingestion-side switch on gets a prechunked fixture
 * database built the way a deployment holds it after the switch's rebuild command; with every switch off the database and its inputs
 * hash are those of the plain build. Each case runs in its own child process, because the eval route binds one deployment mode, one
 * fixture edge and one environment per process.
 */
const SELF = fileURLToPath(import.meta.url);
const REPO_ROOT = path.resolve(path.dirname(SELF), '../..');
const CORPUS_DIR = path.join(REPO_ROOT, 'eval/fixtures/corpus');
const CASE_ENV = 'FIXTURE_PHASE42_FEATURE_CASE';
const RESULT_PREFIX = 'FIXTURE_FEATURE_RESULT ';
const LANGUAGES = ['en', 'it', 'zh'] as const;
const COPIES = 30;
const NO_DIGIT_IDENTIFIERS = ['QJ-XUV-QOR', 'KZ-OWA-FUD', 'WX-YEM-GIT'];

type Mode = 'single-tenant' | 'multi-tenant';
type CaseName = 'off' | 'stem' | 'dictionary' | 'identifiers' | 'tables' | 'clusters';

const CASE_ENVS: Record<CaseName, Record<string, string>> = {
  off: { RAG_PIPELINE: 'v2' },
  stem: { RAG_PIPELINE: 'v2', RAG_LEXICAL_SEARCH: 'true', RAG_LEXICAL_STEM_IT: 'true' },
  dictionary: { RAG_PIPELINE: 'v2', RAG_LEXICAL_SEARCH: 'true', RAG_LEXICAL_DICTIONARY: 'true' },
  identifiers: { RAG_PIPELINE: 'v2', RAG_IDENTIFIER_INDEX: 'true' },
  tables: { RAG_PIPELINE: 'v2', RAG_TABLE_LOOKUP: 'true' },
  clusters: { RAG_PIPELINE: 'v2', RAG_DUP_CLUSTERS: 'true' },
};

interface CaseResult {
  sqlSha256: Record<string, string>;
  /** Digest of documents and chunks (the columns every build has) of the in-process database. */
  dumpSha256: string;
  /** The same digest over createFixtureDatabase without the eval route (off case only). */
  plainDumpSha256?: string;
  plainSqlSha256?: Record<string, string>;
  counts: Record<string, number>;
  italianStemmed: number;
  italianCurrent: number;
  nonItalianStemmed: number;
  lexicalVersions: number[];
  dictionaryChunks: Array<{ lexicalText: string; dictVersion: string | null }>;
  patternTenants: string[];
  chunksWithoutIdentifiers: number;
  noDigitIndexed: string[];
  tableDocumentsWithRows: string[];
  clusters: Array<{ language: string; section: string; clusterIds: number; memberCount: number | null; members: number }>;
}

async function runCase(caseName: CaseName, mode: Mode): Promise<CaseResult> {
  const { prepareInProcessEval } = await import('../../eval/harness/run-eval.mts');
  const { createFixtureDatabase } = await import('../../eval/harness/pglite-supabase.mts');

  async function digest(db: import('@electric-sql/pglite').PGlite): Promise<string> {
    const documents = await db.query('SELECT id, filename, content, metadata, status, is_current, version FROM documents ORDER BY id');
    const chunks = await db.query(
      'SELECT id, document_id, content, lexical_text, lexical_version, metadata, is_current, status, version FROM document_chunks ORDER BY id',
    );
    return crypto.createHash('sha256').update(JSON.stringify([documents.rows, chunks.rows])).digest('hex');
  }

  let plain: { dump: string; sqlSha256: Record<string, string> } | undefined;
  if (caseName === 'off') {
    const built = await createFixtureDatabase({ deploymentMode: mode, corpusDir: CORPUS_DIR });
    plain = { dump: await digest(built.db), sqlSha256: { ...built.sqlSha256 } };
    await built.db.close();
  }

  const inProcess = await prepareInProcessEval({
    corpusDir: CORPUS_DIR,
    deploymentMode: mode,
    fixtureMode: 'prechunked',
    envOverrides: CASE_ENVS[caseName],
  });
  try {
    const db = inProcess.fixtureDb;
    const one = async (sql: string, params: unknown[] = []): Promise<number> =>
      Number(((await db.query<{ n: number | string }>(sql, params)).rows[0]?.n ?? 0));
    const counts = {
      tableRows: await one('SELECT count(*) AS n FROM rag_table_rows'),
      patterns: await one('SELECT count(*) AS n FROM rag_identifier_patterns'),
      dupClusters: await one('SELECT count(*) AS n FROM rag_dup_clusters'),
      chunksWithIdentifiers: await one('SELECT count(*) AS n FROM document_chunks WHERE identifiers_norm IS NOT NULL'),
      chunksWithCluster: await one('SELECT count(*) AS n FROM document_chunks WHERE dup_cluster_id IS NOT NULL'),
      chunksWithSimhash: await one('SELECT count(*) AS n FROM document_chunks WHERE simhash IS NOT NULL'),
      chunksWithDictStamp: await one('SELECT count(*) AS n FROM document_chunks WHERE lexical_dict_version IS NOT NULL'),
      chunksWithPatternStamp: await one("SELECT count(*) AS n FROM document_chunks WHERE metadata ? 'lexical_patterns'"),
    };
    const italian = (
      await db.query<{ stemmed: boolean; language: string | null }>(
        `SELECT c.lexical_text LIKE '%\\_s\\_%' AS stemmed, coalesce(c.language, d.metadata ->> 'language') AS language
           FROM document_chunks c JOIN documents d ON d.id = c.document_id WHERE c.is_current`,
      )
    ).rows;
    const lexicalVersions = (
      await db.query<{ v: number }>('SELECT DISTINCT lexical_version AS v FROM document_chunks WHERE is_current ORDER BY 1')
    ).rows.map((row) => Number(row.v));
    const dictionaryChunks = (
      await db.query<{ lexical_text: string; lexical_dict_version: string | null }>(
        "SELECT lexical_text, lexical_dict_version FROM document_chunks WHERE is_current AND lower(content) LIKE '%term alpha beta%' ORDER BY id",
      )
    ).rows.map((row) => ({ lexicalText: row.lexical_text, dictVersion: row.lexical_dict_version }));
    const patternTenants = (await db.query<{ tenant_key: string }>('SELECT tenant_key FROM rag_identifier_patterns ORDER BY 1')).rows.map(
      (row) => row.tenant_key,
    );
    const { normalizeIdentifier } = await import('../../src/lib/rag/ids/normalize.ts');
    const noDigitIndexed: string[] = [];
    for (const raw of NO_DIGIT_IDENTIFIERS) {
      const hits = await one('SELECT count(*) AS n FROM document_chunks WHERE is_current AND $1 = ANY(identifiers_norm)', [normalizeIdentifier(raw)]);
      if (hits > 0) noDigitIndexed.push(raw);
    }
    const tableDocumentsWithRows = (
      await db.query<{ filename: string }>(
        "SELECT DISTINCT d.filename FROM rag_table_rows r JOIN documents d ON d.id = r.document_id WHERE d.filename LIKE 'grid-reference.%' ORDER BY 1",
      )
    ).rows.map((row) => row.filename);
    const clusters: CaseResult['clusters'] = [];
    for (const language of LANGUAGES) {
      const sections = (
        await db.query<{ section: string; cluster_ids: number; member_count: number | null; members: number }>(
          `SELECT split_part(c.content, E'\\n', 1) AS section,
                  count(DISTINCT c.dup_cluster_id)::int AS cluster_ids,
                  max(k.member_count)::int AS member_count,
                  count(*)::int AS members
             FROM document_chunks c
             JOIN documents d ON d.id = c.document_id
             LEFT JOIN rag_dup_clusters k ON k.id = c.dup_cluster_id
            WHERE c.is_current AND d.filename LIKE $1
            GROUP BY 1 ORDER BY 1`,
          [`dup-passage-%.${language}.md`],
        )
      ).rows;
      for (const row of sections) {
        clusters.push({ language, section: row.section, clusterIds: row.cluster_ids, memberCount: row.member_count, members: row.members });
      }
    }
    return {
      sqlSha256: { ...inProcess.sqlSha256 },
      dumpSha256: await digest(db),
      ...(plain ? { plainDumpSha256: plain.dump, plainSqlSha256: plain.sqlSha256 } : {}),
      counts,
      italianStemmed: italian.filter((row) => row.language === 'it' && row.stemmed).length,
      italianCurrent: italian.filter((row) => row.language === 'it').length,
      nonItalianStemmed: italian.filter((row) => row.language !== 'it' && row.stemmed).length,
      lexicalVersions,
      dictionaryChunks,
      patternTenants,
      chunksWithoutIdentifiers: await one('SELECT count(*) AS n FROM document_chunks WHERE is_current AND identifiers_norm IS NULL'),
      noDigitIndexed,
      tableDocumentsWithRows,
      clusters,
    };
  } finally {
    await inProcess.close();
  }
}

function spawnCase(caseName: CaseName, mode: Mode): CaseResult {
  const result = spawnSync(process.execPath, ['--import', 'tsx', SELF], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    env: { ...process.env, [CASE_ENV]: `${caseName}:${mode}` },
    timeout: 600_000,
    maxBuffer: 64 * 1024 * 1024,
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
  describe('Phase 4.2 feature seeding of the prechunked fixture database', () => {
    const results = new Map<string, CaseResult>();
    const get = (caseName: CaseName, mode: Mode = 'single-tenant'): CaseResult => {
      const key = `${caseName}:${mode}`;
      let found = results.get(key);
      if (!found) {
        found = spawnCase(caseName, mode);
        results.set(key, found);
      }
      return found;
    };

    for (const mode of ['single-tenant', 'multi-tenant'] as const) {
      test(`${mode}: every Phase 4.2 switch off builds the plain database and inputs hash, with no feature rows`, () => {
        const off = get('off', mode);
        assert.equal(off.dumpSha256, off.plainDumpSha256);
        assert.deepEqual(off.sqlSha256, off.plainSqlSha256);
        assert.deepEqual(off.counts, {
          tableRows: 0,
          patterns: 0,
          dupClusters: 0,
          chunksWithIdentifiers: 0,
          chunksWithCluster: 0,
          chunksWithSimhash: 0,
          chunksWithDictStamp: 0,
          chunksWithPatternStamp: 0,
        });
      });
    }

    test('RAG_LEXICAL_STEM_IT: Italian chunks carry stem tokens at the effective lexical version, and the inputs hash changes', () => {
      const off = get('off');
      const stem = get('stem');
      assert.ok(stem.italianCurrent > 0);
      assert.equal(stem.italianStemmed, stem.italianCurrent, 'every current Italian chunk has _s_ tokens');
      assert.equal(stem.nonItalianStemmed, 0);
      assert.deepEqual(stem.lexicalVersions, [4]);
      assert.deepEqual(off.lexicalVersions, [2]);
      assert.notDeepEqual(stem.sqlSha256, off.sqlSha256);
      assert.equal(stem.counts.tableRows + stem.counts.dupClusters + stem.counts.chunksWithIdentifiers, 0);
    });

    test('RAG_LEXICAL_DICTIONARY: chunks with a qualifying fixture term carry its _t_ token and the dictionary stamp', () => {
      const off = get('off');
      const dictionary = get('dictionary');
      assert.ok(dictionary.dictionaryChunks.length > 0);
      const stamps = new Set(dictionary.dictionaryChunks.map((chunk) => chunk.dictVersion));
      assert.equal(stamps.size, 1);
      const [stamp] = [...stamps];
      assert.ok(stamp, 'the dictionary stamp is set');
      for (const chunk of dictionary.dictionaryChunks) assert.match(chunk.lexicalText, /_t_/);
      assert.equal(off.dictionaryChunks.every((chunk) => !chunk.lexicalText.includes('_t_') && chunk.dictVersion === null), true);
      assert.deepEqual(dictionary.lexicalVersions, [3]);
      assert.equal(dictionary.sqlSha256[`lexical_dict_version:${stamp}`] !== undefined, true, JSON.stringify(dictionary.sqlSha256));
    });

    test('RAG_IDENTIFIER_INDEX: the fixture tenant has the fixture pattern, every chunk is indexed and the no-digit identifiers are found', () => {
      const off = get('off');
      const identifiers = get('identifiers');
      assert.deepEqual(identifiers.patternTenants, ['s:default']);
      assert.equal(identifiers.chunksWithoutIdentifiers, 0);
      assert.deepEqual(identifiers.noDigitIndexed, NO_DIGIT_IDENTIFIERS);
      assert.deepEqual(off.noDigitIndexed, []);
      const patternKeys = Object.keys(identifiers.sqlSha256).filter((key) => key.startsWith('lexical_patterns:'));
      assert.equal(patternKeys.length, 1, JSON.stringify(identifiers.sqlSha256));
      assert.match(patternKeys[0], /^lexical_patterns:p[0-9a-f]{12}$/);
      assert.ok(identifiers.counts.chunksWithPatternStamp > 0, 'relex stamped the patterns fingerprint');
    });

    test('RAG_TABLE_LOOKUP: the table documents have table rows', () => {
      const tables = get('tables');
      assert.deepEqual(tables.tableDocumentsWithRows, LANGUAGES.map((language) => `grid-reference.${language}.md`));
      assert.equal(tables.counts.dupClusters + tables.counts.chunksWithIdentifiers, 0);
    });

    for (const mode of ['single-tenant', 'multi-tenant'] as const) {
      test(`${mode}: RAG_DUP_CLUSTERS clusters each template section of the ${COPIES} generated copies into one cluster`, () => {
        const clusters = get('clusters', mode);
        assert.equal(clusters.clusters.length, LANGUAGES.length * 3, JSON.stringify(clusters.clusters));
        for (const section of clusters.clusters) {
          assert.equal(section.members, COPIES, JSON.stringify(section));
          assert.equal(section.clusterIds, 1, JSON.stringify(section));
          assert.equal(section.memberCount, COPIES, JSON.stringify(section));
        }
        assert.ok(Object.keys(clusters.sqlSha256).some((key) => key.startsWith('dup_clusters:')), JSON.stringify(clusters.sqlSha256));
      });
    }
  });
}
