import { after, afterEach, before, beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fixtureProcessEnv, startFakeEdge, type FakeEdge } from '../../eval/harness/fake-edge.mts';
import { TWO_TENANT_IDS, createTwoTenantDatabase, type TwoTenantDatabase } from '../../eval/harness/two-tenant.mts';
import type { FakeSidecar } from '../helpers/fake-sidecar';
import type { DocumentParser } from '@/lib/rag/ingest/parsers/shared';

type Row = Record<string, unknown>;

interface LinkFixture {
  mime: string;
  language: string;
  expected: 'quarantined' | 'ready';
  targets: Array<{ kind: string; target: string }>;
  visible_text?: string;
  annotation_targets?: string[];
  sha256: string;
}

const LINKS_DIR = path.join(process.cwd(), 'eval', 'fixtures', 'security', 'links');
const MANIFEST = JSON.parse(fs.readFileSync(path.join(LINKS_DIR, 'manifest.json'), 'utf8')) as { allowlist: string; fixtures: Record<string, LinkFixture> };
const APP_URL = 'https://app.myrag.example';
const PHISH = 'https://phish.example.net/login';

const note = (...lines: string[]) => ['# Relay Notes', '', 'The blue module joins the second relay after the amber light turns steady.', '', ...lines, ''].join('\n');

describe('the ingestion link check quarantines documents that link outside the allowlist (SEC-08, D-35)', () => {
  let db: TwoTenantDatabase;
  let edge: FakeEdge;
  let sidecar: FakeSidecar;
  let m: {
    ingest: typeof import('@/lib/rag/ingest');
    admin: typeof import('@/lib/rag/ingest/quarantine-admin');
    deps: typeof import('@/lib/rag/ingest/deps');
    config: typeof import('@/lib/rag/ingest/config');
    objectStore: typeof import('@/lib/rag/ingest/object-store');
    fakeStore: typeof import('../helpers/fake-object-store');
    fakeSidecar: typeof import('../helpers/fake-sidecar');
    hiddenText: typeof import('@/lib/rag/security/hidden-text');
    llama: typeof import('@/lib/rag/ingest/parsers/llamaparse-v2');
    docling: typeof import('@/lib/rag/ingest/parsers/sidecar-docling');
    resolver: typeof import('@/lib/rag/tenant/resolve-chat');
    supabase: typeof import('@/lib/supabase');
    postPublish: typeof import('@/lib/rag/ingest/post-publish');
    contracts: typeof import('@/lib/rag-eval/contracts.generated');
  };
  let env: Record<string, string> = {};
  let pdfText = '';
  let counter = 0;

  const A = TWO_TENANT_IDS.userA;
  const encoder = new TextEncoder();
  const signal = () => new AbortController().signal;
  const rows = async (sql: string, params: unknown[] = []): Promise<Row[]> => (await db.db.query<Row>(sql, params)).rows;
  const one = async (sql: string, params: unknown[] = []): Promise<Row> => {
    const found = await rows(sql, params);
    assert.equal(found.length, 1, sql);
    return found[0] as Row;
  };

  /** Parser stand-in: a text file's own text, or the visible text of a PDF fixture, as a real parser extracts it (an annotation is not text). */
  function pdfParser(name: 'llamaparse' | 'docling'): DocumentParser {
    return {
      name,
      unavailableReason: () => null,
      async parse() {
        return {
          kind: 'done',
          result: {
            markdown: pdfText,
            chunks: [{ text: pdfText, contextualized_text: pdfText, headings: [], is_table: false, pages: [1], table_header: null }],
            pictures: [],
            page_count: 1,
            language: 'en',
            parser: name,
            parser_version: `${name}-test`,
            partial: false,
            text_layer_page_share: null,
            warnings: [],
          },
          artifacts: [],
          warnings: [],
        };
      },
    };
  }

  before(async () => {
    const emptyCorpus = fs.mkdtempSync(path.join(os.tmpdir(), 'link-check-corpus-'));
    try {
      db = await createTwoTenantDatabase({ corpusDir: emptyCorpus });
    } finally {
      fs.rmdirSync(emptyCorpus);
    }
    edge = await startFakeEdge({ db: db.db });
    Object.assign(process.env, fixtureProcessEnv(edge.url));
    process.env.NEXT_PUBLIC_MYRAG_DEPLOYMENT_MODE = 'multi-tenant';
    process.env.MYRAG_DEPLOYMENT_MODE = 'multi-tenant';
    m = {
      ingest: await import('@/lib/rag/ingest'),
      admin: await import('@/lib/rag/ingest/quarantine-admin'),
      deps: await import('@/lib/rag/ingest/deps'),
      config: await import('@/lib/rag/ingest/config'),
      objectStore: await import('@/lib/rag/ingest/object-store'),
      fakeStore: await import('../helpers/fake-object-store'),
      fakeSidecar: await import('../helpers/fake-sidecar'),
      hiddenText: await import('@/lib/rag/security/hidden-text'),
      llama: await import('@/lib/rag/ingest/parsers/llamaparse-v2'),
      docling: await import('@/lib/rag/ingest/parsers/sidecar-docling'),
      resolver: await import('@/lib/rag/tenant/resolve-chat'),
      supabase: await import('@/lib/supabase'),
      postPublish: await import('@/lib/rag/ingest/post-publish'),
      contracts: await import('@/lib/rag-eval/contracts.generated'),
    };
    await db.db.query('INSERT INTO admin_users (id) VALUES ($1) ON CONFLICT DO NOTHING', [A]);
    sidecar = await m.fakeSidecar.startFakeSidecar();
  });

  after(async () => {
    await sidecar?.close();
    await edge?.close();
    await db?.db.close();
  });

  beforeEach(async () => {
    await db.db.exec("UPDATE documents SET status = 'deleted', is_current = false WHERE status <> 'deleted'");
    env = {
      RAG_INGEST_PIPELINE: 'unified',
      RAG_INGEST_LINK_CHECK: 'quarantine',
      RAG_OUTPUT_LINK_ALLOWLIST: MANIFEST.allowlist,
      NEXT_PUBLIC_SITE_URL: APP_URL,
    };
    pdfText = '';
    m.objectStore.setObjectStoreForTests(m.fakeStore.createFakeObjectStore());
    m.config.resetIngestConfigForTests();
    m.deps.setIngestDepsForTests({ ingestEnv: () => env });
    m.llama.setLlamaParseParserForTests(pdfParser('llamaparse'));
    m.docling.setSidecarParserForTests(pdfParser('docling'));
    m.hiddenText.setHiddenTextClientForTests(m.hiddenText.createHiddenTextClient({ baseUrl: sidecar.url, secret: sidecar.secret }));
    sidecar.hiddenTextRequests.length = 0;
  });

  afterEach(() => {
    m.hiddenText.resetHiddenTextClientForTests();
    m.llama.resetLlamaParseParserForTests();
    m.docling.resetSidecarParserForTests();
    m.objectStore.resetObjectStoreForTests();
    m.deps.resetIngestDepsForTests();
    m.config.resetIngestConfigForTests();
    m.postPublish.resetPostPublishHooksForTests();
  });

  const scopeOf = async (userId: string) => {
    const resolved = await m.resolver.resolveTenantScope({
      requestedOrganizationId: null,
      deploymentMode: 'multi-tenant',
      getUser: async () => ({ id: userId }),
      admin: m.supabase.getSupabaseAdmin(),
      signal: signal(),
    });
    assert.ok(resolved.ok && resolved.scope, 'scope must resolve');
    return resolved.scope;
  };

  const uploadBytes = async (bytes: Uint8Array, filename: string, mimeType: string, sourceKey?: string) => {
    counter += 1;
    if (mimeType !== 'application/pdf') pdfText = new TextDecoder().decode(bytes);
    const result = await m.ingest.ingest({
      scope: await scopeOf(A),
      source: 'config_upload',
      sourceKey: sourceKey ?? `root/${counter}-${filename}`,
      file: bytes,
      filename,
      mimeType,
      docType: 'general',
      signal: signal(),
    });
    assert.ok(result.documentId, `${filename} has a document`);
    return { ...result, documentId: String(result.documentId) };
  };
  const uploadNote = (text: string, sourceKey?: string) => uploadBytes(encoder.encode(text), 'notes.md', 'text/markdown', sourceKey);

  const documentOf = (documentId: string) => one('SELECT status, is_current, metadata, lineage_id, version FROM documents WHERE id = $1', [documentId]);
  const metadataOf = async (documentId: string) => (await documentOf(documentId)).metadata as Row;
  const linkReason = async (documentId: string) => {
    const quarantine = (await metadataOf(documentId)).quarantine as Row | undefined;
    assert.ok(quarantine, 'the document has a quarantine object');
    const reasons = (quarantine.reasons as unknown[]).map((reason) => m.contracts.QuarantineReasonSchema.parse(reason));
    assert.deepEqual(reasons.map((reason) => reason.kind), ['untrusted_link']);
    const reason = reasons[0];
    assert.ok(reason?.kind === 'untrusted_link');
    return reason;
  };
  const chunkStatuses = async (documentId: string) => (await rows('SELECT status FROM document_chunks WHERE document_id = $1', [documentId])).map((row) => row.status);

  test('quarantine: an off-allowlist URL quarantines the document with that target as the reason; its chunks stay out of retrieval', async () => {
    const result = await uploadNote(note(`Further steps are described at ${PHISH} before the night cycle.`));
    assert.equal(result.status, 'quarantined');
    const reason = await linkReason(result.documentId);
    assert.deepEqual(reason.targets, [PHISH]);
    assert.match(reason.detail, /^1 link targets outside the allowlist \(url: 1\)$/);
    const document = await documentOf(result.documentId);
    assert.equal(document.status, 'quarantined');
    assert.equal(document.is_current, false);
    assert.ok((await chunkStatuses(result.documentId)).every((status) => status === 'quarantined'));
    const { dropped, ...stored } = (await metadataOf(result.documentId)).link_check as Row;
    assert.equal(dropped, 0);
    const recorded = m.contracts.LinkCheckResultSchema.parse(stored);
    assert.deepEqual(recorded.targets, [{ kind: 'url', target: PHISH, host: 'phish.example.net' }]);
  });

  test('quarantine: a document linking only inside the allowlist is ready', async () => {
    const result = await uploadNote(note('The guide is at https://docs.example.com/a and the app at https://app.myrag.example/help.'));
    assert.equal(result.status, 'ready');
    const metadata = await metadataOf(result.documentId);
    assert.equal(metadata.quarantine, undefined);
    assert.equal(metadata.link_check, undefined, 'quarantine mode records nothing for a clean document');
  });

  test('off runs nothing: the off-allowlist document is ready and nothing is recorded', async () => {
    env = { ...env, RAG_INGEST_LINK_CHECK: 'off' };
    const result = await uploadNote(note(`Further steps are described at ${PHISH}.`));
    assert.equal(result.status, 'ready');
    const metadata = await metadataOf(result.documentId);
    assert.equal(metadata.quarantine, undefined);
    assert.equal(metadata.link_check, undefined);
  });

  test('the link fixtures: every bad fixture is quarantined with its target kind, no clean fixture in zh, en or it is (D-46)', async () => {
    env = { ...env, RAG_HIDDEN_TEXT_CHECK: 'flag' };
    for (const [name, fixture] of Object.entries(MANIFEST.fixtures)) {
      const bytes = new Uint8Array(fs.readFileSync(path.join(LINKS_DIR, name)));
      if (fixture.mime === 'application/pdf') {
        pdfText = fixture.visible_text ?? '';
        sidecar.enqueueHiddenText({
          report: { status: 'clean', spans: [], link_targets: fixture.annotation_targets ?? [], checker_version: m.fakeSidecar.FAKE_HIDDEN_TEXT_CHECKER_VERSION, dropped: 0 },
        });
      }
      const result = await uploadBytes(bytes, name, fixture.mime);
      assert.equal(result.status, fixture.expected, `${name} is ${fixture.expected}`);
      const linkCheck = (await metadataOf(result.documentId)).link_check as Row | undefined;
      if (fixture.expected === 'ready') {
        assert.equal(linkCheck, undefined, `${name} records no link target`);
        continue;
      }
      const reason = await linkReason(result.documentId);
      assert.deepEqual(reason.targets, fixture.targets.map((target) => target.target), `${name} names its target`);
      assert.deepEqual(
        (linkCheck?.targets as Row[]).map((target) => ({ kind: target.kind, target: target.target })),
        fixture.targets,
        `${name} reports the target kind`,
      );
    }
  });

  test('targets are reported de-duplicated and sorted by kind and then target, the same on every run', async () => {
    const text = note('zeta.example.net, ops@outside.example.org, alpha.example.net', `${PHISH} and again ${PHISH}`, 'alpha.example.net');
    const first = await uploadNote(text);
    const expected = [PHISH, 'alpha.example.net', 'zeta.example.net', 'ops@outside.example.org'];
    assert.deepEqual((await linkReason(first.documentId)).targets, expected);
    await db.db.exec("UPDATE documents SET status = 'deleted', is_current = false WHERE status <> 'deleted'");
    const second = await uploadNote(text);
    assert.notEqual(second.documentId, first.documentId);
    assert.deepEqual((await linkReason(second.documentId)).targets, expected);
  });

  test('flag stores metadata.link_check with the targets and leaves the document ready', async () => {
    env = { ...env, RAG_INGEST_LINK_CHECK: 'flag' };
    const result = await uploadNote(note(`Further steps are described at ${PHISH}.`));
    assert.equal(result.status, 'ready');
    const metadata = await metadataOf(result.documentId);
    assert.equal(metadata.quarantine, undefined);
    const linkCheck = metadata.link_check as Row;
    assert.equal(linkCheck.status, 'untrusted_found');
    assert.deepEqual(linkCheck.targets, [{ kind: 'url', target: PHISH, host: 'phish.example.net' }]);
    assert.equal(linkCheck.dropped, 0);
    assert.ok((await chunkStatuses(result.documentId)).every((status) => status === 'ready'));
  });

  test('an empty allowlist allows only the app host; a document with no link is ready in every mode', async () => {
    env = { ...env, RAG_OUTPUT_LINK_ALLOWLIST: '' };
    assert.equal((await uploadNote(note('Help is at https://app.myrag.example/help.'))).status, 'ready');
    assert.equal((await uploadNote(note('The guide is at https://docs.example.com/a.'))).status, 'quarantined');
    for (const mode of ['off', 'flag', 'quarantine']) {
      env = { ...env, RAG_INGEST_LINK_CHECK: mode };
      const result = await uploadNote(note(`The panel stays closed during cycle ${mode}; see report.pdf, v2.0 and section 3.2.1.`));
      assert.equal(result.status, 'ready', `${mode}: a document with no link is ready`);
      const metadata = await metadataOf(result.documentId);
      assert.equal(metadata.quarantine, undefined);
      if (mode === 'flag') assert.deepEqual((metadata.link_check as Row).targets, []);
      else assert.equal(metadata.link_check, undefined);
    }
  });

  test('a release covers the reviewed targets of that document on its next version only, and never widens the allowlist', async () => {
    const key = `root/${counter + 1000}-released.md`;
    const v1 = await uploadNote(note(`Further steps are described at ${PHISH}.`), key);
    assert.equal(v1.status, 'quarantined');
    const released = await m.admin.releaseQuarantined({ documentId: v1.documentId, actorUserId: A, signal: signal() });
    assert.ok(released.ok, JSON.stringify(released));
    assert.deepEqual(released.releasedTargets, [PHISH]);
    assert.equal((await documentOf(v1.documentId)).status, 'ready');

    const v2 = await uploadNote(note(`Further steps are described at ${PHISH}.`, 'The panel stays closed during the night cycle.'), key);
    const v2Row = await documentOf(v2.documentId);
    assert.equal(v2Row.lineage_id, (await documentOf(v1.documentId)).lineage_id, 'the upload is a new version of the same document');
    assert.equal(v2.status, 'ready', 'a reviewed target does not quarantine the next version');

    const v3 = await uploadNote(note(`Further steps are described at ${PHISH}.`, 'New counters are on fresh-example.net.'), key);
    assert.equal(v3.status, 'quarantined', 'a new target quarantines the version again');
    assert.deepEqual((await linkReason(v3.documentId)).targets, ['fresh-example.net'], 'only the new target is named');

    const other = await uploadNote(note(`Other steps are described at ${PHISH}.`));
    assert.notEqual((await documentOf(other.documentId)).lineage_id, v2Row.lineage_id);
    assert.equal(other.status, 'quarantined', 'another document is not allowed the released target');
    assert.deepEqual((await linkReason(other.documentId)).targets, [PHISH]);
    assert.equal(env.RAG_OUTPUT_LINK_ALLOWLIST, MANIFEST.allowlist);
    assert.equal(m.config.loadIngestConfig(env).outputLinkAllowlist, MANIFEST.allowlist, 'the allowlist value is unchanged');
  });

  test('the log line carries the number of targets and no target text', async () => {
    const original = console.warn;
    const lines: unknown[][] = [];
    console.warn = (...args: unknown[]) => void lines.push(args);
    try {
      const result = await uploadNote(note(`Steps at ${PHISH}, also ops@outside.example.org.`));
      assert.equal(result.status, 'quarantined');
    } finally {
      console.warn = original;
    }
    const linkLines = lines.filter((args) => String(args[0]).includes('link targets outside the allowlist'));
    assert.equal(linkLines.length, 1);
    assert.deepEqual(linkLines[0]?.[1], { mode: 'quarantine', targets: 2, released: 0 });
    const all = JSON.stringify(lines);
    assert.ok(!all.includes('phish') && !all.includes('outside.example.org'), 'no target text is logged');
  });
});
