import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createFixtureDatabase, type FixtureDatabase } from '../eval/harness/pglite-supabase.mts';
import { fixtureProcessEnv, startFakeEdge, type FakeEdge } from '../eval/harness/fake-edge.mts';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const REAL_CORPUS = path.join(REPO_ROOT, 'eval/fixtures/corpus');
const GOLDEN = path.join(REPO_ROOT, 'eval/fixtures/golden.jsonl');

const questions: string[] = fs
  .readFileSync(GOLDEN, 'utf8')
  .split('\n')
  .filter((line) => line.trim() !== '')
  .map((line) => (JSON.parse(line) as { question: string }).question);

const MODELS = [
  { isGPTModel: true, model: 'openai/gpt-4o' },
  { isGPTModel: false, model: 'anthropic/claude-sonnet' },
];

interface Candidate {
  chunk_id: string;
  document_id: string;
  content: string;
  similarity: number;
  metadata: Record<string, unknown> | null;
}

interface ReferencedState {
  usedDocuments: Array<Record<string, unknown>>;
  context: string;
}

describe('assembleContext is byte-identical to the frozen chat assembly oracle', () => {
  let fixture: FixtureDatabase;
  let edge: FakeEdge;
  let rag: typeof import('@/lib/rag');
  let scopeModule: typeof import('@/lib/rag/tenant/scope');
  let deps: typeof import('@/lib/rag/deps');
  let assemble: typeof import('@/lib/rag/context/assemble');
  let fetchRows: typeof import('@/lib/rag/context/fetch-rows');
  let oracle: typeof import('./fixtures/legacy-chat-assembly');
  let urlExtractor: typeof import('@/lib/url-extractor');

  before(async () => {
    fixture = await createFixtureDatabase({ deploymentMode: 'single-tenant', corpusDir: REAL_CORPUS });
    edge = await startFakeEdge({ db: fixture.db });
    Object.assign(process.env, fixtureProcessEnv(edge.url));
    process.env.NEXT_PUBLIC_MYRAG_DEPLOYMENT_MODE = 'single-tenant';
    rag = await import('@/lib/rag');
    scopeModule = await import('@/lib/rag/tenant/scope');
    deps = await import('@/lib/rag/deps');
    assemble = await import('@/lib/rag/context/assemble');
    fetchRows = await import('@/lib/rag/context/fetch-rows');
    oracle = await import('./fixtures/legacy-chat-assembly');
    urlExtractor = await import('@/lib/url-extractor');
  });

  after(async () => {
    deps?.resetRagDepsForTests();
    await edge?.close();
    await fixture?.db.close();
  });

  function adminClient() {
    const admin = deps.getRagDeps().adminClient();
    assert.ok(admin, 'the fixture environment must provide an admin client');
    return admin;
  }

  async function referencedStateFor(documentId: string): Promise<ReferencedState> {
    const { data, error } = await adminClient()
      .from('documents')
      .select('id, filename, created_at, content, metadata')
      .eq('id', documentId)
      .single();
    assert.equal(error, null);
    assert.ok(data);
    return {
      usedDocuments: [
        {
          id: data.id,
          name: data.filename,
          filename: data.filename,
          created_at: data.created_at,
          content_preview: data.content ? (data.content as string).substring(0, 200) + '...' : undefined,
          explicitly_referenced: true,
          external_url: (data.metadata as Record<string, any> | null)?.external_url,
        },
      ],
      context: `\n\n=== DOCUMENT: "${data.filename}" ===\n${data.content}\n=== END OF DOCUMENT ===\n`,
    };
  }

  async function compareCase(
    question: string,
    candidates: Candidate[],
    initial: ReferencedState | null,
    { isGPTModel, model }: { isGPTModel: boolean; model: string },
  ) {
    const admin = adminClient();
    const rows = await fetchRows.fetchAssemblyRows(candidates, { adminClient: admin, signal: new AbortController().signal });

    const realLog = console.log;
    console.log = () => undefined;
    let expected;
    try {
      expected = await oracle.legacyChatAssembly({
        supabase: admin as never,
        queryText: question,
        similarChunks: structuredClone(candidates) as never,
        usedDocuments: initial ? (structuredClone(initial.usedDocuments) as never) : [],
        context: initial ? initial.context : '',
        model,
        ragMode: 'strict',
        effectiveDisableRAG: false,
        webSearchEnabled: false,
        ragStartTime: Date.now(),
        normalize: (input: unknown) => (typeof input === 'string' ? input.toLowerCase() : ''),
        formatURLsForContext: urlExtractor.formatURLsForContext,
        getQueryEmbedding: async () => {
          throw new Error('the oracle must not use the general lookup branch');
        },
      });
    } finally {
      console.log = realLog;
    }

    const actual = assemble.assembleContext({
      queryText: question,
      candidates: structuredClone(candidates),
      documents: rows.documents,
      chunkMetadata: rows.chunkMetadata,
      referenced: initial ? (structuredClone(initial) as never) : null,
      isGPTModel,
      ragMode: 'strict',
      webSearchEnabled: false,
      applyRelevanceFilter: true,
    });

    const where = `${question} (gpt=${isGPTModel}, ref=${initial !== null})`;
    assert.equal(actual.context, expected.context, `context differs for: ${where}`);
    assert.deepStrictEqual(actual.usedDocuments, expected.usedDocuments, `usedDocuments differ for: ${where}`);
    assert.deepStrictEqual(actual.sourceImages, expected.sourceImages, `sourceImages differ for: ${where}`);
    assert.equal(actual.refusalCandidate, expected.shouldRefuseCandidate, `refusal candidate differs for: ${where}`);
    return actual;
  }

  test('the golden set has at least the original 72 questions', () => {
    assert.ok(questions.length >= 72, `golden set has ${questions.length} questions`);
  });

  test('every golden question x isGPTModel {true, false} x {no reference, one referenced document} give 0 differences', async () => {
    const scope = scopeModule.mintScope('single', null, null);
    const firstDocument = (await fixture.db.query<{ id: string }>('SELECT id FROM documents ORDER BY filename LIMIT 1')).rows[0];
    assert.ok(firstDocument);

    let compared = 0;
    let withUsedDocuments = 0;
    let withReference = 0;
    let withRefusalCandidate = 0;

    for (const question of questions) {
      const retrieved = await rag.runRetrieval({
        scope,
        query: question,
        profile: 'eval',
        options: { maxResults: 25, fallbackToLowerThreshold: true },
        stageOverrides: { disabledStages: ['post_filter', 'assemble'] },
        signal: new AbortController().signal,
      });
      const candidates = retrieved.candidates as Candidate[];
      const referencedId = candidates.length > 0 ? candidates[candidates.length - 1].document_id : firstDocument.id;

      for (const withRef of [false, true]) {
        for (const models of MODELS) {
          const initial = withRef ? await referencedStateFor(referencedId) : null;
          const actual = await compareCase(question, candidates, initial, models);
          compared += 1;
          if (actual.usedDocuments.length > 0) withUsedDocuments += 1;
          if (withRef) withReference += 1;
          if (actual.refusalCandidate) withRefusalCandidate += 1;
        }
      }
    }

    console.log(
      `[assemble differential] compared ${compared} cases, 0 differences (used documents in ${withUsedDocuments}, referenced ${withReference}, refusal candidates ${withRefusalCandidate})`,
    );
    assert.equal(compared, questions.length * 4);
    assert.ok(withUsedDocuments >= 100, `only ${withUsedDocuments} cases produced used documents`);
    assert.ok(withRefusalCandidate >= 1, 'no case exercised the refusal candidate');
    assert.deepEqual(edge.errors, []);
  });

  test('image documents, chunk urls, same-filename groups and a Chinese query are identical to the oracle', async () => {
    const id = () => crypto.randomUUID();
    const docs = { links: id(), image: id(), sameA: id(), sameB: id(), own: id() };
    const insertDocument = (docId: string, filename: string, content: string, metadata: Record<string, unknown> = {}) =>
      fixture.db.query('INSERT INTO documents (id, filename, content, metadata) VALUES ($1, $2, $3, $4::jsonb)', [
        docId,
        filename,
        content,
        JSON.stringify(metadata),
      ]);
    const insertChunk = async (documentId: string, content: string, metadata: Record<string, unknown>): Promise<string> => {
      const chunkId = id();
      await fixture.db.query('INSERT INTO document_chunks (id, document_id, content, metadata) VALUES ($1, $2, $3, $4::jsonb)', [
        chunkId,
        documentId,
        content,
        JSON.stringify(metadata),
      ]);
      return chunkId;
    };

    await insertDocument(docs.links, 'links-synthetic.md', 'pricing page and help centre', { external_url: 'https://ext.test/links' });
    await insertDocument(docs.image, 'diagram-synthetic.PNG', 'diagram of the plan');
    await insertDocument(docs.sameA, 'same-synthetic.md', 'first of two');
    await insertDocument(docs.sameB, 'same-synthetic.md', 'second of two');
    await insertDocument(docs.own, 'own-synthetic.md', 'candidate carries its own image');

    const linkA = { url: 'https://example.test/pricing', context: 'see pricing', category: 'product', description: 'Pricing' };
    const linkB = { url: 'https://example.test/help', context: 'see help', category: 'documentation' };
    const text1 = 'Document: links-synthetic.md. Chunk 2 of 2. Content: second links chunk';
    const text2 = 'Document: links-synthetic.md. Chunk 1 of 2. Content: first links chunk';
    const text5 = 'Document: same-synthetic.md. Chunk 3 of 9. Content: same file name chunk b';
    const c1 = await insertChunk(docs.links, text1, { urls: [linkA, linkB] });
    const c2 = await insertChunk(docs.links, text2, { urls: [linkA] });
    const c3 = await insertChunk(docs.image, 'caption of the diagram', { image_url: 'https://img.test/diagram.png' });
    const c4 = await insertChunk(docs.sameA, 'same file name chunk a', {});
    const c5 = await insertChunk(docs.sameB, text5, {});
    const c6 = await insertChunk(docs.own, 'own image chunk', { image_url: 'https://img.test/row.png' });
    const c7 = await insertChunk(docs.own, 'second own chunk', {});

    const candidates: Candidate[] = [
      { chunk_id: c1, document_id: docs.links, content: text1, similarity: 0.8, metadata: null },
      { chunk_id: c3, document_id: docs.image, content: 'caption of the diagram', similarity: 0.3, metadata: null },
      { chunk_id: c4, document_id: docs.sameA, content: 'same file name chunk a', similarity: 0.7, metadata: {} },
      { chunk_id: c2, document_id: docs.links, content: text2, similarity: 0.72, metadata: null },
      { chunk_id: c5, document_id: docs.sameB, content: text5, similarity: 0.66, metadata: null },
      { chunk_id: c6, document_id: docs.own, content: 'own image chunk', similarity: 0.4, metadata: { image_url: 'https://img.test/own.png', note: 'own' } },
      { chunk_id: c7, document_id: docs.own, content: 'second own chunk', similarity: 0.2, metadata: null },
    ];

    const queries = ['what does the pricing page say about the plan', '年度订阅可以在多少天内退款？', 'zzzzzzzz', 'Perché il piano annuale costa di più'];
    let compared = 0;
    let withLinks = 0;
    let withImages = 0;
    for (const query of queries) {
      for (const withRef of [false, true]) {
        for (const models of MODELS) {
          const initial = withRef ? await referencedStateFor(docs.sameB) : null;
          const actual = await compareCase(query, candidates, initial, models);
          compared += 1;
          if (actual.links.length > 0) withLinks += 1;
          if (actual.sourceImages.length > 0) withImages += 1;
        }
      }
    }
    console.log(
      `[assemble differential] synthetic image/url cases: compared ${compared}, 0 differences (with links ${withLinks}, with source images ${withImages})`,
    );
    assert.equal(compared, 16);
    assert.ok(withLinks > 0, 'no case produced a links section');
    assert.ok(withImages > 0, 'no case produced source images');
  });
});
