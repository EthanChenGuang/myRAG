import { after, afterEach, before, beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fixtureProcessEnv, startFakeEdge, type FakeEdge } from '../../eval/harness/fake-edge.mts';
import { TWO_TENANT_IDS, createTwoTenantDatabase, type TwoTenantDatabase } from '../../eval/harness/two-tenant.mts';
import type { RpcClient } from '@/lib/rag/backend/supabase-rpc';

/**
 * Plan 03.3-12 (TPL-01; D-09, D-17 to D-21): tenant section rules inside the real pipeline against the fixture database, in the chunk
 * stage, the ingest dual-write of a live structure-mode chunking profile and rag:rechunk. Rule sets and documents are invented and
 * described by structure: numbered heading lines with one-word names, shape-only patterns. Multi-tenant here; the single-tenant run is in
 * section-rules-single-tenant.test.mts (one fixture database per process).
 */

type Row = Record<string, unknown>;

const A = { key: `u:${TWO_TENANT_IDS.userA}`, userId: TWO_TENANT_IDS.userA };
const B = { key: `u:${TWO_TENANT_IDS.userB}`, userId: TWO_TENANT_IDS.userB };

interface Heading {
  pattern: string;
  flags: 'u';
  name: string;
  level: number;
  required: boolean;
  restart: boolean;
}

const HEADINGS: Heading[] = [
  { pattern: '^Part [0-9]+', flags: 'u', name: 'Part', level: 1, required: true, restart: true },
  { pattern: '^[0-9]+\\. Alpha', flags: 'u', name: 'Alpha', level: 2, required: true, restart: false },
  { pattern: '^[0-9]+\\. Bravo', flags: 'u', name: 'Bravo', level: 2, required: false, restart: false },
];
const RENAMED: Heading[] = HEADINGS.map((heading) => ({ ...heading, name: `${heading.name}x` }));
const TOC = ['Part 1 ..... 1', '1. Alpha ..... 2', '2. Bravo ..... 3'];

const passage = (seed: string, entry: string) => `The ${seed} passage under ${entry} holds ordinary neutral sentences that describe a plain process in several steps.`;

function partLines(n: number, seed: string, entries = ['1. Alpha', '2. Bravo']): string[] {
  return [`## Part ${n}`, '', `Opening text of part ${n} for ${seed}.`, '', ...entries.flatMap((entry) => [entry, '', passage(seed, entry), '', '### Note', '', `A note line under ${entry} of part ${n}.`, ''])];
}

const singleDoc = (seed: string) => [`# Collection ${seed}`, '', ...partLines(1, seed)].join('\n');
const multiDoc = (seed: string, second = ['1. Alpha', '2. Bravo']) =>
  [`# Collection ${seed}`, '', ...TOC.flatMap((line) => [line, '']), `This collection holds two parts for ${seed}.`, '', ...partLines(1, seed), ...partLines(2, seed, second)].join('\n');

describe('section rules through the pipeline (multi-tenant)', () => {
  let fixture: TwoTenantDatabase;
  let edge: FakeEdge;
  let ingestModule: typeof import('@/lib/rag/ingest');
  let depsModule: typeof import('@/lib/rag/ingest/deps');
  let configModule: typeof import('@/lib/rag/ingest/config');
  let objectStoreModule: typeof import('@/lib/rag/ingest/object-store');
  let fakeStoreModule: typeof import('../helpers/fake-object-store');
  let rulesModule: typeof import('@/lib/rag/ingest/rules/load');
  let scopeModule: typeof import('@/lib/rag/tenant/scope');
  let rechunk: typeof import('@/lib/rag/ingest/rechunk/run');
  let supabaseModule: typeof import('@/lib/supabase');
  let store: import('../helpers/fake-object-store').FakeObjectStore;
  let counter = 0;

  before(async () => {
    const emptyCorpus = fs.mkdtempSync(path.join(os.tmpdir(), 'section-rules-ingest-'));
    try {
      fixture = await createTwoTenantDatabase({ corpusDir: emptyCorpus });
    } finally {
      fs.rmdirSync(emptyCorpus);
    }
    edge = await startFakeEdge({ db: fixture.db });
    Object.assign(process.env, fixtureProcessEnv(edge.url));
    process.env.NEXT_PUBLIC_MYRAG_DEPLOYMENT_MODE = 'multi-tenant';
    process.env.MYRAG_DEPLOYMENT_MODE = 'multi-tenant';
    ingestModule = await import('@/lib/rag/ingest');
    depsModule = await import('@/lib/rag/ingest/deps');
    configModule = await import('@/lib/rag/ingest/config');
    objectStoreModule = await import('@/lib/rag/ingest/object-store');
    fakeStoreModule = await import('../helpers/fake-object-store');
    rulesModule = await import('@/lib/rag/ingest/rules/load');
    scopeModule = await import('@/lib/rag/tenant/scope');
    rechunk = await import('@/lib/rag/ingest/rechunk/run');
    supabaseModule = await import('@/lib/supabase');
  });

  after(async () => {
    objectStoreModule?.resetObjectStoreForTests();
    depsModule?.resetIngestDepsForTests();
    await edge?.close();
    await fixture?.db.close();
  });

  beforeEach(() => {
    store = fakeStoreModule.createFakeObjectStore();
    objectStoreModule.setObjectStoreForTests(store);
    rulesModule.resetTenantRuleCacheForTests();
  });

  afterEach(async () => {
    objectStoreModule.resetObjectStoreForTests();
    depsModule.resetIngestDepsForTests();
    delete process.env.RAG_PIPELINE;
    await fixture.db.exec(`
      DELETE FROM public.rag_section_rule_sets;
      DELETE FROM chunking_build_gaps;
      DELETE FROM chunking_build_runs;
      DELETE FROM chunk_embeddings WHERE chunk_id IN (SELECT id FROM document_chunks WHERE chunking_profile_id <> 'legacy');
      DELETE FROM document_chunks WHERE chunking_profile_id <> 'legacy';
      DELETE FROM document_parents;
      DELETE FROM documents;
      UPDATE chunking_profiles SET status = 'retired' WHERE id <> 'legacy';`);
  });

  const rows = async (sql: string, params: unknown[] = []): Promise<Row[]> => (await fixture.db.query<Row>(sql, params)).rows;
  const scopeOf = (userId: string) => scopeModule.mintScope('personal', userId, null);
  const scopeFor = async (tenantKey: string) => (tenantKey === A.key ? scopeOf(A.userId) : tenantKey === B.key ? scopeOf(B.userId) : null);

  /** Counts rpc calls by name on the real admin client; optional clock jump after the images stage saved its state (a yield before embed). */
  const useDeps = (env: Record<string, string>, options: { interrupt?: boolean } = {}) => {
    configModule.resetIngestConfigForTests();
    const real = supabaseModule.getSupabaseAdmin() as unknown as RpcClient;
    const counts = new Map<string, number>();
    let clock = 1_000_000;
    let armed = options.interrupt === true;
    const db: RpcClient = {
      rpc(fn, args) {
        counts.set(fn, (counts.get(fn) ?? 0) + 1);
        const state = args.p_state as { lastCompleted?: string } | undefined;
        if (armed && fn === 'rag_save_ingest_state' && state?.lastCompleted === 'images') {
          clock += 49_500;
          armed = false;
        }
        return real.rpc(fn, args);
      },
    };
    depsModule.setIngestDepsForTests({
      db: () => db,
      now: () => clock,
      ingestEnv: () => ({ RAG_INGEST_PIPELINE: 'unified', RAG_EMBEDDING_PROFILES: 'off', ...env }),
      embedDocuments: async (texts) => texts.map((text, index) => Array.from({ length: 1536 }, (_, i) => (i === (text.length + index) % 1536 ? 1 : 0))),
    });
    return { counts, db };
  };

  const addRuleSet = async (tenantKey: string, headings: Heading[] = HEADINGS, extra: Record<string, unknown> = {}): Promise<string> => {
    const result = await fixture.db.query<Row>(
      `INSERT INTO public.rag_section_rule_sets (tenant_key, name, doc_type, rules) VALUES ($1, $2, 'general', $3::jsonb) RETURNING id`,
      [tenantKey, `set-${(counter += 1)}`, JSON.stringify({ headings, require_increasing_numbers: true, skip_toc: true, toc_min_run: 3, ...extra })],
    );
    return String(result.rows[0]?.id);
  };

  const editRuleSet = async (id: string, headings: Heading[]) => {
    await fixture.db.query(
      `UPDATE public.rag_section_rule_sets SET rules = jsonb_set(rules, '{headings}', $2::jsonb), version = version + 1 WHERE id = $1`,
      [id, JSON.stringify(headings)],
    );
    rulesModule.resetTenantRuleCacheForTests();
  };

  const upload = async (tenant: { userId: string }, text: string, label: string) => {
    const filename = `${label}-${(counter += 1)}.md`;
    return ingestModule.ingest({
      scope: scopeOf(tenant.userId),
      source: 'config_upload',
      sourceKey: `root/${filename}`,
      text,
      filename,
      mimeType: 'text/markdown',
      docType: 'general',
      signal: new AbortController().signal,
    });
  };

  const chunksOf = async (documentId: string, profile = 'legacy') =>
    rows(
      `SELECT content, section_path, metadata, page_start, page_end FROM document_chunks WHERE document_id = $1 AND chunking_profile_id = $2 ORDER BY chunk_index`,
      [documentId, profile],
    );
  const shape = (chunks: Row[]) => chunks.map((chunk) => ({ content: chunk.content, section_path: chunk.section_path }));
  const metadataKeys = (chunks: Row[]) => chunks.map((chunk) => Object.keys(chunk.metadata as Row).sort());
  const documentRow = async (id: string) =>
    (await rows(
      `SELECT status, is_current, needs_review, metadata -> 'review_reasons' AS reasons, metadata -> 'section_rules' AS section_rules FROM documents WHERE id = $1`,
      [id],
    ))[0]!;

  test('a conforming document is cut by its rule set: canonical names in the path, other headings stay body text, no page numbers, report stored', async () => {
    const id = await addRuleSet(A.key);
    useDeps({ RAG_SECTION_RULES: 'on' });
    const result = await upload(A, singleDoc('conform'), 'conform');
    assert.equal(result.status, 'ready');
    const chunks = await chunksOf(result.documentId!);
    const alpha = chunks.find((chunk) => String(chunk.content).includes(passage('conform', '1. Alpha')));
    assert.deepEqual(alpha?.section_path, ['Part', 'Alpha']);
    assert.ok(String(alpha?.content).includes('A note line under 1. Alpha'), 'a heading that is not allowed stays in the body');
    for (const chunk of chunks) {
      assert.ok(!(chunk.section_path as string[]).includes('Note'));
      assert.equal(chunk.page_start, null);
      assert.equal(chunk.page_end, null);
    }
    const doc = await documentRow(result.documentId!);
    assert.deepEqual(doc.section_rules, { rule_set_id: id, version: 1, satisfied: true, counts: { headings: 3, variants: 0, skipped: 0 } });
    assert.equal(doc.needs_review, false);
  });

  test('a file with two variants: the label leads the path and is stored on the chunks; the table-of-contents lines are in no chunk', async () => {
    await addRuleSet(A.key);
    useDeps({ RAG_SECTION_RULES: 'on' });
    const result = await upload(A, multiDoc('variants'), 'variants');
    assert.equal(result.status, 'ready');
    const chunks = await chunksOf(result.documentId!);
    const second = chunks.filter((chunk) => (chunk.metadata as Row).variant_index === 2);
    assert.ok(second.length > 0);
    for (const chunk of second) {
      assert.equal((chunk.section_path as string[])[0], 'Part 2');
      assert.equal((chunk.metadata as Row).variant_label, 'Part 2');
    }
    const alphaTwo = chunks.find((chunk) => String(chunk.content).includes('A note line under 1. Alpha of part 2'));
    assert.deepEqual(alphaTwo?.section_path, ['Part 2', 'Part', 'Alpha']);
    for (const chunk of chunks) for (const line of TOC) assert.ok(!String(chunk.content).includes(line), 'no chunk holds a table-of-contents line');
    assert.deepEqual(((await documentRow(result.documentId!)).section_rules as Row).counts, { headings: 7, variants: 2, skipped: 2 });
  });

  test('a document that does not satisfy its rule set is cut as with the switch off, flagged, and still published; another tenant is untouched', async () => {
    await addRuleSet(A.key);
    useDeps({ RAG_SECTION_RULES: 'off' });
    const text = multiDoc('fallback', ['2. Bravo']);
    const plain = await upload(B, text, 'fallback-off');
    useDeps({ RAG_SECTION_RULES: 'on' });
    const flagged = await upload(A, text, 'fallback-on');
    assert.equal(flagged.status, 'ready');
    assert.deepEqual(shape(await chunksOf(flagged.documentId!)), shape(await chunksOf(plain.documentId!)));
    const doc = await documentRow(flagged.documentId!);
    assert.equal(doc.status, 'ready');
    assert.equal(doc.is_current, true);
    assert.equal(doc.needs_review, true);
    assert.deepEqual(doc.reasons, ['section_rules_not_satisfied']);
    assert.equal((doc.section_rules as Row).satisfied, false);

    const foreign = await upload(B, multiDoc('foreign'), 'foreign-on');
    const foreignChunks = await chunksOf(foreign.documentId!);
    assert.ok(foreignChunks.every((chunk) => !('variant_index' in (chunk.metadata as Row))), 'tenant A’s rule set never cuts tenant B’s document');
    assert.equal((await documentRow(foreign.documentId!)).section_rules, null);
  });

  test('a pattern that runs past the worker deadline flags tenant_pattern_timeout, uses the profile chunker and ingests', async () => {
    await addRuleSet(A.key, [{ pattern: '^(?:x|xx)+y', flags: 'u', name: 'Slow', level: 1, required: true, restart: false }]);
    const text = [singleDoc('slow'), '', 'x'.repeat(120)].join('\n');
    useDeps({ RAG_SECTION_RULES: 'off' });
    const plain = await upload(B, text, 'slow-off');
    useDeps({ RAG_SECTION_RULES: 'on' });
    const result = await upload(A, text, 'slow-on');
    assert.equal(result.status, 'ready');
    const doc = await documentRow(result.documentId!);
    assert.deepEqual(doc.reasons, ['tenant_pattern_timeout']);
    assert.deepEqual(shape(await chunksOf(result.documentId!)), shape(await chunksOf(plain.documentId!)));
  });

  test('resume after the tenant edited the rule set: the same chunks as an uninterrupted run with the first rule set, no rule load', async () => {
    await addRuleSet(B.key);
    useDeps({ RAG_SECTION_RULES: 'on' });
    const text = multiDoc('resume');
    const reference = await upload(B, text, 'resume-reference');
    assert.equal(reference.status, 'ready');

    const id = await addRuleSet(A.key);
    useDeps({ RAG_SECTION_RULES: 'on' }, { interrupt: true });
    const interrupted = await upload(A, text, 'resume-run');
    assert.equal(interrupted.status, 'processing');
    const [saved] = await rows('SELECT processing_state FROM documents WHERE id = $1', [interrupted.documentId]);
    assert.ok(((saved?.processing_state as Row).chunkPrep as Row).sectionRules, 'the section-rules snapshot is saved with the state');

    await editRuleSet(id, [...RENAMED, { pattern: '^Appendix', flags: 'u', name: 'Appendix', level: 1, required: true, restart: false }]);
    const { counts } = useDeps({ RAG_SECTION_RULES: 'on' });
    const resumed = await ingestModule.resumeIngest(scopeOf(A.userId), interrupted.documentId!);
    assert.equal(resumed.status, 'ready');
    assert.ok(!resumed.warnings.includes('write_incomplete'));
    assert.equal(counts.get('rag_tenant_rules_for') ?? 0, 0, 'the resumed run loads no rule set');
    assert.equal(resumed.chunkCount, reference.chunkCount);
    assert.deepEqual(shape(await chunksOf(interrupted.documentId!)), shape(await chunksOf(reference.documentId!)));
  });

  test('switch off: no rule set is requested, and chunks, paths and metadata keys equal those of a tenant without rule sets', async () => {
    await addRuleSet(A.key);
    const { counts } = useDeps({ RAG_SECTION_RULES: 'off', RAG_PAGE_BOILERPLATE: 'off' });
    const text = multiDoc('off');
    const ruled = await upload(A, text, 'off-ruled');
    const plain = await upload(B, text, 'off-plain');
    assert.equal(counts.get('rag_tenant_rules_for') ?? 0, 0);
    const ruledChunks = await chunksOf(ruled.documentId!);
    const plainChunks = await chunksOf(plain.documentId!);
    assert.deepEqual(shape(ruledChunks), shape(plainChunks));
    assert.deepEqual(metadataKeys(ruledChunks), metadataKeys(plainChunks));
    assert.equal((await documentRow(ruled.documentId!)).section_rules, null);
  });

  test('parent-child structure mode: one parent per rule section on the ingest dual-write; rag:rechunk of a second profile writes the same parents and children with no parser call', async () => {
    await addRuleSet(A.key);
    await fixture.db.exec(`INSERT INTO chunking_profiles (id, doc_type, child_tokens, parent_mode, parent_tokens, status, preset)
      VALUES ('p256sra', 'general', 256, 'structure', 1024, 'building', '256/1024'), ('p256srb', 'general', 256, 'structure', 1024, 'retired', '256/1024')
      ON CONFLICT DO NOTHING;
      UPDATE chunking_profiles SET status = 'building' WHERE id = 'p256sra';
      UPDATE chunking_profiles SET status = 'retired' WHERE id = 'p256srb';`);
    process.env.RAG_PIPELINE = 'v2';
    const { db } = useDeps({ RAG_SECTION_RULES: 'on' });
    const result = await upload(A, multiDoc('parents'), 'parents');
    assert.equal(result.status, 'ready');
    const documentId = result.documentId!;

    const parentsOf = async (profile: string) =>
      rows('SELECT parent_index, section_path, content FROM document_parents WHERE document_id = $1 AND chunking_profile_id = $2 ORDER BY parent_index', [documentId, profile]);
    const childrenOf = async (profile: string) =>
      rows(
        `SELECT c.content, c.section_path, c.metadata, p.section_path AS parent_path, p.parent_index FROM document_chunks c JOIN document_parents p ON p.id = c.parent_id
         WHERE c.document_id = $1 AND c.chunking_profile_id = $2 ORDER BY c.chunk_index`,
        [documentId, profile],
      );
    const parents = await parentsOf('p256sra');
    const children = await childrenOf('p256sra');
    assert.ok(parents.some((parent) => JSON.stringify(parent.section_path) === JSON.stringify(['Part 2', 'Part', 'Alpha'])), 'a rule section is a parent');
    assert.equal(new Set(parents.map((parent) => JSON.stringify(parent.section_path))).size, parents.length, 'one parent per rule section');
    for (const child of children) {
      assert.deepEqual(child.section_path, child.parent_path);
      assert.ok(!('variant_index' in (child.metadata as Row)) && !('variant_label' in (child.metadata as Row)), 'children carry no variant keys');
    }
    assert.ok(children.some((child) => (child.section_path as string[])[0] === 'Part 2'));

    await fixture.db.exec("UPDATE chunking_profiles SET status = 'retired' WHERE id = 'p256sra'; UPDATE chunking_profiles SET status = 'building' WHERE id = 'p256srb'");
    const puts = store.calls.filter((call) => call.op === 'put').length;
    const report = await rechunk.runRechunk({ db, profileId: 'p256srb', scopeFor });
    assert.equal(report.documentsWritten, 1);
    assert.equal(store.calls.filter((call) => call.op === 'put').length, puts, 'nothing is stored: no parser ran');
    const strip = (list: Row[]) => list.map((row) => ({ content: row.content, section_path: row.section_path, parent_index: row.parent_index }));
    assert.deepEqual(strip(await parentsOf('p256srb')), strip(parents));
    assert.deepEqual(strip(await childrenOf('p256srb')), strip(children));
  });

  test('rag:rechunk after a rule edit cuts by the new rule set, falls back and flags when it is not satisfied, and the dry run writes nothing', async () => {
    const id = await addRuleSet(A.key);
    useDeps({ RAG_SECTION_RULES: 'on' });
    const result = await upload(A, multiDoc('relabel'), 'relabel');
    const documentId = result.documentId!;
    await fixture.db.exec(`INSERT INTO chunking_profiles (id, doc_type, child_tokens, parent_mode, parent_tokens, status, preset)
      VALUES ('p256src', 'general', 256, 'none', NULL, 'building', 'custom') ON CONFLICT DO NOTHING;
      UPDATE chunking_profiles SET status = 'building' WHERE id = 'p256src';`);
    const childPaths = async () =>
      (await rows("SELECT section_path FROM document_chunks WHERE document_id = $1 AND chunking_profile_id = 'p256src' ORDER BY chunk_index", [documentId])).map((row) => row.section_path as string[]);

    await editRuleSet(id, RENAMED);
    const { db } = useDeps({ RAG_SECTION_RULES: 'on' });
    const puts = store.calls.filter((call) => call.op === 'put').length;
    assert.equal((await rechunk.runRechunk({ db, profileId: 'p256src', scopeFor })).documentsWritten, 1);
    assert.equal(store.calls.filter((call) => call.op === 'put').length, puts, 'no parser call');
    assert.ok((await childPaths()).some((p) => JSON.stringify(p) === JSON.stringify(['Part 2', 'Partx', 'Alphax'])), 'the new canonical names');

    await fixture.db.exec(`DELETE FROM chunk_embeddings WHERE chunk_id IN (SELECT id FROM document_chunks WHERE chunking_profile_id = 'p256src');
      DELETE FROM document_chunks WHERE chunking_profile_id = 'p256src'; DELETE FROM chunking_build_gaps; DELETE FROM chunking_build_runs;`);
    await editRuleSet(id, [...HEADINGS, { pattern: '^Appendix', flags: 'u', name: 'Appendix', level: 1, required: true, restart: false }]);
    const dry = await rechunk.dryRunRechunk({ db, profileId: 'p256src', scopeFor });
    assert.deepEqual(dry.gaps.filter((gap) => gap.documentId === documentId), []);
    const afterDry = await documentRow(documentId);
    assert.equal(afterDry.needs_review, false, 'the dry run writes no flag');
    assert.equal((afterDry.section_rules as Row).version, 2, 'the dry run writes no metadata');

    assert.equal((await rechunk.runRechunk({ db, profileId: 'p256src', scopeFor })).documentsWritten, 1);
    assert.ok((await childPaths()).every((p) => !p.includes('Appendix') && p[0] !== 'Part 2'), 'the profile chunker cuts the document');
    const flagged = await documentRow(documentId);
    assert.equal(flagged.needs_review, true);
    assert.deepEqual(flagged.reasons, ['section_rules_not_satisfied']);
    assert.equal((flagged.section_rules as Row).version, 3);
  });
});
