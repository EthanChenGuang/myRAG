import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { PGlite } from '@electric-sql/pglite';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { fixtureProcessEnv, startFakeEdge, type FakeEdge } from '../../eval/harness/fake-edge.mts';
import { embedText } from '../../eval/harness/fixture-embedder.mts';
import { createFixtureDatabase, runFixtureRelex, type DeploymentMode } from '../../eval/harness/pglite-supabase.mts';

// Phase 4.3 plan 08 (SEC-12; D-08, D-10, D-11, D-12, D-15, D-25, A-06): every leg inside src/lib/rag sends the request's access filter.
// One document labelled only g:<group-a> and one {all} document share a tenant; for each leg, in both pipelines and both deployment
// modes, the outsider's result holds no restricted marker while member-a's does, and an unresolved scope with the switch off sends
// today's payloads. Fixtures are neutral synthetic sentences.

const MARKER_WORD = 'lanternmoss';
const RESTRICTED_FILE = 'quillmarrow-restricted.md';
const OPEN_FILE = 'quillmarrow-open.md';
const MARKER_TEXT = `General information overview: the zephyrquill ${MARKER_WORD} restricted marker sentence describes a neutral synthetic record.`;
/** The question shares every word but the marker with the restricted sentence, so the marker can only come from restricted content. */
const QUERY = 'General information overview: the zephyrquill restricted marker sentence describes a neutral synthetic record.';
const OPEN_TEXT = 'General information overview: the zephyrquill open control sentence describes a neutral synthetic record for everyone.';
const OPTIONS = { maxResults: 25, fallbackToLowerThreshold: true, ragMode: 'balanced' as const };

const IDS = {
  memberA: '00000000-0000-4000-8000-00000000b8a1',
  outsider: '00000000-0000-4000-8000-00000000b8b1',
  org: '00000000-0000-4000-8000-00000000b8c1',
  groupA: '00000000-0000-4000-8000-00000000b8f1',
  restrictedDoc: '00000000-0000-4000-8000-00000000b8d1',
  restrictedChunk: '00000000-0000-4000-8000-00000000b8e1',
  openDoc: '00000000-0000-4000-8000-00000000b8d2',
  openChunk: '00000000-0000-4000-8000-00000000b8e2',
  restrictedIdDoc: '00000000-0000-4000-8000-00000000b8d3',
  restrictedIdChunk: '00000000-0000-4000-8000-00000000b8e3',
  restrictedInvoice: '00000000-0000-4000-8000-00000000b8d4',
  openInvoice: '00000000-0000-4000-8000-00000000b8d5',
  restrictedVoiceChunk: '00000000-0000-4000-8000-00000000b8e4',
  restrictedParent: '00000000-0000-4000-8000-00000000b801',
  openParent: '00000000-0000-4000-8000-00000000b802',
} as const;
/** An identifier that only the restricted document carries (model-number shape: letters and digits). */
const RESTRICTED_CODE = 'QX7731ZK';
const ID_TEXT = `Catalogue entry ${RESTRICTED_CODE} names the ${MARKER_WORD} part of a neutral synthetic record.`;
const ID_QUERY = `Catalogue entry ${RESTRICTED_CODE} names the part of a neutral synthetic record.`;
const SUPPLIER = 'Zephyrquill Supplies';
/** A restricted chunk the voice keyword fallback finds by its metadata name (a word of the question), not by its vector. */
const VOICE_TEXT = `Badge note: ${MARKER_WORD} badge for the zephyrquill restricted marker record.`;
const VOICE_METADATA = JSON.stringify({ name: 'zephyrquill restricted marker badge', image_context: `${MARKER_WORD} badge` });
const GROUP_KEY = `g:${IDS.groupA}`;

const BASE_ENV: Record<string, string> = {
  RAG_PIPELINE: 'legacy',
  RAG_LEXICAL_SEARCH: 'true',
  RAG_RERANKER: 'none',
  RAG_REFUSAL_THRESHOLD: 'false',
  RAG_QUERY_LAYER: 'false',
  RAG_SEMANTIC_CACHE: 'off',
  RAG_DOC_ACCESS_GROUPS: 'off',
  RAG_SUPPORTED_LANGUAGES: 'zh,en,it',
  RAG_PRIMARY_LANGUAGE: 'en',
};

type Pipeline = 'legacy' | 'v2';
type Call = { fn: string; args: Record<string, unknown> };
type TenantScope = import('@/lib/rag/tenant/scope').TenantScope;

function vec(text: string): string {
  return `[${embedText(text).join(',')}]`;
}

function leakText(result: unknown): string {
  return JSON.stringify(result).toLowerCase();
}

function assertNoLeak(result: unknown, label: string): void {
  const text = leakText(result);
  assert.ok(!text.includes(MARKER_WORD), `${label}: marker text leaked`);
  assert.ok(!text.includes(RESTRICTED_FILE), `${label}: restricted filename leaked`);
  assert.ok(!text.includes(IDS.restrictedChunk), `${label}: restricted chunk id leaked`);
  assert.ok(!text.includes(IDS.restrictedDoc), `${label}: restricted document id leaked`);
}

function assertHasMarker(result: unknown, label: string): void {
  assert.ok(leakText(result).includes(MARKER_WORD), `${label}: member lost the restricted marker`);
}

const ACCESS_ARG_NAMES = ['p_access_keys', 'p_access_all'];
const LEGACY_SEARCH_RPCS = ['match_document_chunks', 'match_documents_by_workspace', 'match_chunks_by_profile'];

let sharedEdge: FakeEdge | null = null;
const savedEnv: Record<string, string | undefined> = {};

after(async () => {
  for (const [name, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  await sharedEdge?.close();
});

for (const mode of ['multi-tenant', 'single-tenant'] as DeploymentMode[]) {
  describe(`every leg inside the RAG module filters by access group (${mode})`, () => {
    let db: PGlite;
    let corpusDir: string;
    let rag: typeof import('@/lib/rag');
    let scopeModule: typeof import('@/lib/rag/tenant/scope');
    let accessModule: typeof import('@/lib/rag/tenant/access');
    let configModule: typeof import('@/lib/rag/config');
    let registryModule: typeof import('@/lib/rag/backend/registry');
    let recording: SupabaseClient;
    const recorded: Call[] = [];
    const multi = mode === 'multi-tenant';

    async function setEnv(values: Record<string, string>): Promise<void> {
      Object.assign(process.env, values);
      configModule.resetRagConfigForTests();
      registryModule.resetRetrievalBackendForTests();
    }

    async function withPipeline<T>(pipeline: Pipeline, run: () => Promise<T>, extra: Record<string, string> = {}): Promise<T> {
      const saved = Object.fromEntries(['RAG_PIPELINE', ...Object.keys(extra)].map((name) => [name, process.env[name]]));
      await setEnv({ RAG_PIPELINE: pipeline, ...extra });
      try {
        return await run();
      } finally {
        for (const [name, value] of Object.entries(saved)) {
          if (value === undefined) delete process.env[name];
          else process.env[name] = value;
        }
        configModule.resetRagConfigForTests();
        registryModule.resetRetrievalBackendForTests();
      }
    }

    before(async () => {
      corpusDir = fs.mkdtempSync(path.join(os.tmpdir(), 'access-legs-corpus-'));
      const fixture = await createFixtureDatabase({ deploymentMode: mode, corpusDir, relex: false });
      db = fixture.db;
      await db.query('INSERT INTO auth.users (id, email) VALUES ($1, $2), ($3, $4)', [
        IDS.memberA,
        'member-a@example.invalid',
        IDS.outsider,
        'outsider@example.invalid',
      ]);
      if (multi) {
        await db.query('INSERT INTO organizations (id, name, slug, owner_id, is_personal) VALUES ($1, $2, $3, $4, false)', [
          IDS.org,
          'Neutral workspace',
          'neutral-workspace-legs',
          IDS.memberA,
        ]);
        await db.query(
          "INSERT INTO organization_members (organization_id, user_id, role) VALUES ($1, $2, 'member'), ($1, $3, 'member')",
          [IDS.org, IDS.memberA, IDS.outsider],
        );
        await db.query('INSERT INTO rag_access_groups (id, key, name, organization_id) VALUES ($1, $2, $3, $4)', [
          IDS.groupA,
          'group-a',
          'Group A',
          IDS.org,
        ]);
      } else {
        await db.query('INSERT INTO rag_access_groups (id, key, name) VALUES ($1, $2, $3)', [IDS.groupA, 'group-a', 'Group A']);
      }
      await db.query('INSERT INTO rag_access_group_members (group_id, user_id) VALUES ($1, $2)', [IDS.groupA, IDS.memberA]);

      for (const doc of [
        { docId: IDS.restrictedDoc, chunkId: IDS.restrictedChunk, text: MARKER_TEXT, groups: [GROUP_KEY], name: RESTRICTED_FILE },
        { docId: IDS.openDoc, chunkId: IDS.openChunk, text: OPEN_TEXT, groups: ['all'], name: OPEN_FILE },
      ]) {
        await db.query(
          `INSERT INTO documents (id, filename, content, metadata, user_id${multi ? ', organization_id' : ''}, language, access_groups)
           VALUES ($1, $2, $3, '{}'::jsonb, $4${multi ? ', $6' : ''}, 'en', $5::text[])`,
          multi ? [doc.docId, doc.name, doc.text, IDS.memberA, doc.groups, IDS.org] : [doc.docId, doc.name, doc.text, IDS.memberA, doc.groups],
        );
        await db.query(
          `INSERT INTO document_chunks (id, document_id, content, embedding, chunk_index, metadata${multi ? ', organization_id' : ''}, access_groups)
           VALUES ($1, $2, $3, $4::vector, 0, '{}'::jsonb${multi ? ', $5' : ''}, '{all}')`,
          multi ? [doc.chunkId, doc.docId, doc.text, vec(doc.text), IDS.org] : [doc.chunkId, doc.docId, doc.text, vec(doc.text)],
        );
      }
      const orgColumn = multi ? ', organization_id' : '';
      const orgValue = (index: number) => (multi ? `, $${index}` : '');
      const withOrg = (values: unknown[]) => (multi ? [...values, IDS.org] : values);
      await db.query(
        `INSERT INTO documents (id, filename, content, metadata, user_id${orgColumn}, language, access_groups)
         VALUES ($1, 'quillmarrow-catalogue.md', $2, '{}'::jsonb, $3${orgValue(5)}, 'en', $4::text[])`,
        withOrg([IDS.restrictedIdDoc, ID_TEXT, IDS.memberA, [GROUP_KEY]]),
      );
      await db.query(
        `INSERT INTO document_chunks (id, document_id, content, embedding, chunk_index, metadata${orgColumn})
         VALUES ($1, $2, $3, $4::vector, 0, '{}'::jsonb${orgValue(5)})`,
        withOrg([IDS.restrictedIdChunk, IDS.restrictedIdDoc, ID_TEXT, vec(ID_TEXT)]),
      );
      await db.query(
        `INSERT INTO document_chunks (id, document_id, content, embedding, chunk_index, metadata${orgColumn})
         VALUES ($1, $2, $3, $4::vector, 1, $5::jsonb${orgValue(6)})`,
        withOrg([IDS.restrictedVoiceChunk, IDS.restrictedDoc, VOICE_TEXT, vec('unrelated filler words only'), VOICE_METADATA]),
      );
      for (const invoice of [
        { id: IDS.restrictedInvoice, number: 'ZQ-RESTRICTED-1', groups: [GROUP_KEY], name: `${MARKER_WORD}-invoice.pdf` },
        { id: IDS.openInvoice, number: 'ZQ-OPEN-1', groups: ['all'], name: 'open-invoice.pdf' },
      ]) {
        await db.query(
          `INSERT INTO documents (id, filename, content, metadata, user_id${orgColumn}, language, access_groups, doc_type, doc_type_origin,
             invoice_number, supplier_name, issue_date, gross_total, currency)
           VALUES ($1, $2, 'Neutral synthetic invoice.', '{}'::jsonb, $3${orgValue(7)}, 'en', $4::text[], 'invoice_receipt', 'picked',
             $5, $6, '2025-01-15', 100, 'EUR')`,
          withOrg([invoice.id, invoice.name, IDS.memberA, invoice.groups, invoice.number, SUPPLIER]),
        );
      }
      const tenantKey = multi ? `o:${IDS.org}` : 's:default';
      for (const parent of [
        { id: IDS.restrictedParent, docId: IDS.restrictedDoc, text: `Parent section: the ${MARKER_WORD} restricted parent text.` },
        { id: IDS.openParent, docId: IDS.openDoc, text: 'Parent section: the open parent text for everyone.' },
      ]) {
        await db.query(
          `INSERT INTO document_parents (id, document_id, tenant_key, chunking_profile_id, content, token_count, parent_index)
           VALUES ($1, $2, $3, 'legacy', $4, 8, 0)`,
          [parent.id, parent.docId, tenantKey, parent.text],
        );
      }
      await runFixtureRelex(db);

      if (sharedEdge === null) {
        sharedEdge = await startFakeEdge({ db, documentFilenameFilter: true });
        const names = ['NEXT_PUBLIC_MYRAG_DEPLOYMENT_MODE', 'MYRAG_DEPLOYMENT_MODE', ...Object.keys(BASE_ENV), ...Object.keys(fixtureProcessEnv(sharedEdge.url))];
        for (const name of names) if (!(name in savedEnv)) savedEnv[name] = process.env[name];
      } else {
        sharedEdge.useDatabase(db);
      }
      const edge = sharedEdge;
      const processEnv = fixtureProcessEnv(edge.url);
      Object.assign(process.env, processEnv, BASE_ENV);
      process.env.NEXT_PUBLIC_MYRAG_DEPLOYMENT_MODE = mode;
      process.env.MYRAG_DEPLOYMENT_MODE = mode;
      rag = await import('@/lib/rag');
      scopeModule = await import('@/lib/rag/tenant/scope');
      accessModule = await import('@/lib/rag/tenant/access');
      configModule = await import('@/lib/rag/config');
      registryModule = await import('@/lib/rag/backend/registry');
      (await import('@/lib/rag/lang/settings')).resetLanguageSettingsForTests();
      const depsModule = await import('@/lib/rag/deps');
      const real = createClient(edge.url, processEnv.SUPABASE_SERVICE_ROLE_KEY as string, {
        auth: { persistSession: false, autoRefreshToken: false },
      });
      recording = new Proxy(real, {
        get(target, prop, receiver) {
          if (prop === 'rpc') {
            return (fn: string, args?: Record<string, unknown>, opts?: Parameters<SupabaseClient['rpc']>[2]) => {
              recorded.push({ fn, args: { ...(args ?? {}) } });
              return target.rpc(fn, args, opts);
            };
          }
          const value = Reflect.get(target, prop, receiver);
          return typeof value === 'function' ? value.bind(target) : value;
        },
      });
      (await import('@/lib/rag/embeddings/registry')).resetEmbeddingProvidersForTests();
      (await import('@/lib/rag/embeddings/active-profile')).resetActiveProfileForTests();
      depsModule.resetRagDepsForTests();
      depsModule.setRagDepsForTests({ adminClient: () => recording });
      configModule.resetRagConfigForTests();
      registryModule.resetRetrievalBackendForTests();
    });

    after(async () => {
      configModule?.resetRagConfigForTests();
      registryModule?.resetRetrievalBackendForTests();
      (await import('@/lib/rag/deps')).resetRagDepsForTests();
      await db?.close();
      fs.rmSync(corpusDir, { recursive: true, force: true });
    });

    const baseScope = (userId: string): TenantScope =>
      multi ? scopeModule.mintScope('org', userId, IDS.org) : scopeModule.mintScope('single', null, null);
    const outsiderScope = () => scopeModule.withAccess(baseScope(IDS.outsider), accessModule.mintAccessScope('keys', ['all', `u:${IDS.outsider}`]));
    const memberScope = () =>
      scopeModule.withAccess(baseScope(IDS.memberA), accessModule.mintAccessScope('keys', ['all', `u:${IDS.memberA}`, GROUP_KEY]));
    const adminScope = () => scopeModule.withAccess(baseScope(IDS.memberA), accessModule.mintAccessScope('admin_all', []));
    const offScope = () => baseScope(IDS.outsider);

    type RetrieveInput = Partial<import('@/lib/rag').RunRetrievalInput>;
    const retrieve = async (scope: TenantScope, extra: RetrieveInput = {}) => {
      const start = recorded.length;
      const result = await rag.runRetrieval({
        scope,
        query: QUERY,
        profile: 'chat',
        options: OPTIONS,
        signal: new AbortController().signal,
        ...extra,
      } as import('@/lib/rag').RunRetrievalInput);
      return { result, calls: recorded.slice(start) };
    };

    describe('legacy chat (Task 1)', () => {
      test('the outsider gets no marker; the legacy search RPC carries the outsider keys', async () => {
        await withPipeline('legacy', async () => {
          const { result, calls } = await retrieve(outsiderScope());
          assert.ok(!result.stages.some((stage) => stage.name === 'fuse'), 'the legacy pipeline ran');
          assertNoLeak(result, 'outsider legacy chat');
          assert.ok(result.candidates.some((candidate) => candidate.chunk_id === IDS.openChunk), 'the {all} control is still returned');
          const searches = calls.filter((call) => LEGACY_SEARCH_RPCS.includes(call.fn));
          assert.ok(searches.length > 0, 'a legacy search RPC ran');
          for (const call of searches) {
            assert.deepEqual(call.args.p_access_keys, ['all', `u:${IDS.outsider}`].sort());
            assert.equal(call.args.p_access_all, false);
          }
        });
      });

      test('member-a and admin_all get the marker', async () => {
        await withPipeline('legacy', async () => {
          for (const [label, scope] of [
            ['member-a', memberScope()],
            ['admin_all', adminScope()],
          ] as const) {
            const { result } = await retrieve(scope);
            assert.ok(result.candidates.some((candidate) => candidate.chunk_id === IDS.restrictedChunk), `${label} lost the restricted chunk`);
            assertHasMarker(result, label);
          }
        });
      });

      test('the access_scope stage is recorded when the mode is not off, directly on the trace', async () => {
        await withPipeline('legacy', async () => {
          for (const scope of [outsiderScope(), memberScope(), adminScope()]) {
            const { result } = await retrieve(scope);
            const stages = result.stages.filter((stage) => stage.name === 'access_scope');
            assert.equal(stages.length, 1);
            assert.equal(stages[0]?.status, 'ok');
            assert.ok((stages[0]?.latency_ms ?? -1) >= 0);
          }
        });
      });

      test('an unresolved scope with the switch off: no access argument on any RPC, no access_scope stage, the marker is returned', async () => {
        await withPipeline('legacy', async () => {
          const { result, calls } = await retrieve(offScope());
          assert.ok(result.candidates.some((candidate) => candidate.chunk_id === IDS.restrictedChunk));
          assert.ok(!result.stages.some((stage) => stage.name === 'access_scope'));
          assert.ok(calls.length > 0);
          for (const call of calls) for (const name of ACCESS_ARG_NAMES) assert.ok(!(name in call.args), `${call.fn} sent ${name} while off`);
        });
      });
    });

    describe('exact id, invoices, parents, media and overview (Task 2)', () => {
      for (const pipeline of ['legacy', 'v2'] as const) {
        test(`${pipeline}: an identifier only the restricted document carries returns nothing restricted to the outsider`, async () => {
          await withPipeline(
            pipeline,
            async () => {
              const outsider = await retrieve(outsiderScope(), { query: ID_QUERY });
              const exactCalls = outsider.calls.filter((entry) => entry.fn === 'rag_exact_id_documents');
              assert.ok(exactCalls.length > 0, 'the exact id leg ran');
              for (const call of exactCalls) {
                assert.deepEqual(call.args.p_access_keys, ['all', `u:${IDS.outsider}`].sort());
                assert.equal(call.args.p_access_all, false);
              }
              assertNoLeak(outsider.result, `outsider ${pipeline} exact id`);
              const exactOut = (result: typeof outsider.result) => result.stages.find((stage) => stage.name === 'exact_id_lookup')?.candidates_out;
              assert.equal(exactOut(outsider.result), 0, `the outsider's exact id leg found a row (${pipeline})`);
              const member = await retrieve(memberScope(), { query: ID_QUERY });
              assert.equal(exactOut(member.result), 1, `member-a's exact id leg lost the row (${pipeline})`);
              assert.ok(
                member.result.candidates.some((candidate) => candidate.chunk_id === IDS.restrictedIdChunk),
                `member-a lost the exact-id chunk (${pipeline})`,
              );
            },
            { RAG_EXACT_ID_LOOKUP: 'true' },
          );
        });
      }

      test('invoice lookups exclude the restricted invoice for the outsider and keep it for member-a and admin_all', async () => {
        const find = async (scope: TenantScope) => {
          const start = recorded.length;
          const hits = await rag.findInvoices(scope, { supplier: 'zephyrquill' }, { db: () => recording as never, access: accessModule.scopeAccessFilter(scope) });
          return { ids: hits.map((hit) => hit.documentId).sort(), calls: recorded.slice(start) };
        };
        const outsider = await find(outsiderScope());
        assert.deepEqual(outsider.ids, [IDS.openInvoice]);
        assert.deepEqual(outsider.calls[0]?.args.p_access_keys, ['all', `u:${IDS.outsider}`].sort());
        assert.deepEqual((await find(memberScope())).ids, [IDS.restrictedInvoice, IDS.openInvoice].sort());
        assert.deepEqual((await find(adminScope())).ids, [IDS.restrictedInvoice, IDS.openInvoice].sort());
        const off = await find(offScope());
        assert.deepEqual(off.ids, [IDS.restrictedInvoice, IDS.openInvoice].sort());
        for (const name of ACCESS_ARG_NAMES) assert.ok(!(name in (off.calls[0]?.args ?? {})), `off sent ${name}`);
      });

      test('parent expansion never fetches the restricted parent for the outsider, even for an injected child', async () => {
        const { expandParents } = await import('@/lib/rag/parents/expand');
        const survivors = [
          { chunk_id: IDS.restrictedChunk, document_id: IDS.restrictedDoc, parent_id: IDS.restrictedParent },
          { chunk_id: IDS.openChunk, document_id: IDS.openDoc, parent_id: IDS.openParent },
        ];
        const expand = async (scope: TenantScope) => {
          const start = recorded.length;
          const access = accessModule.scopeAccessFilter(scope);
          const result = await expandParents({ survivors, scope, admin: recording as never, signal: new AbortController().signal, access } as never);
          const parents = (result as { candidates: Array<{ parent?: { id: string } }> }).candidates
            .map((candidate) => candidate.parent?.id)
            .filter((value): value is string => typeof value === 'string')
            .sort();
          return { parents, calls: recorded.slice(start), result };
        };
        const outsider = await expand(outsiderScope());
        assert.deepEqual(outsider.parents, [IDS.openParent]);
        assert.deepEqual(outsider.calls[0]?.args.p_access_keys, ['all', `u:${IDS.outsider}`].sort());
        assertNoLeak(
          (outsider.result as { candidates: Array<{ parent?: unknown }> }).candidates.map((candidate) => candidate.parent ?? null),
          'outsider parents',
        );
        assert.deepEqual((await expand(memberScope())).parents, [IDS.restrictedParent, IDS.openParent].sort());
        assert.deepEqual((await expand(adminScope())).parents, [IDS.restrictedParent, IDS.openParent].sort());
        const off = await expand(offScope());
        assert.deepEqual(off.parents, [IDS.restrictedParent, IDS.openParent].sort());
        for (const name of ACCESS_ARG_NAMES) assert.ok(!(name in (off.calls[0]?.args ?? {})), `off sent ${name}`);
      });

      for (const pipeline of ['legacy', 'v2'] as const) {
        for (const [label, extra] of [
          ['media', { profile: 'media' }],
          ['overview', { options: { ...OPTIONS, generalOverview: true } }],
        ] as const) {
          test(`${pipeline}: the ${label} profile returns no marker to the outsider and the marker to member-a`, async () => {
            await withPipeline(pipeline, async () => {
              const outsider = await retrieve(outsiderScope(), extra as RetrieveInput);
              assert.notEqual(outsider.result.status, 'error', `${label} errored: ${outsider.result.reason}`);
              assertNoLeak(outsider.result, `outsider ${pipeline} ${label}`);
              const searches = outsider.calls.filter((call) => LEGACY_SEARCH_RPCS.includes(call.fn));
              assert.ok(searches.length > 0, 'media and overview always take the legacy search');
              for (const call of searches) assert.equal(call.args.p_access_all, false);
              const member = await retrieve(memberScope(), extra as RetrieveInput);
              assertHasMarker(member.result, `member-a ${pipeline} ${label}`);
            });
          });
        }
      }
    });

    describe('voice, references, assembly and overview reads, labels and the fake edge (Task 3)', () => {
      for (const pipeline of ['legacy', 'v2'] as const) {
        test(`${pipeline}: the voice profile (keyword fallback included) returns no marker to the outsider and the marker to member-a`, async () => {
          await withPipeline(pipeline, async () => {
            const outsider = await retrieve(outsiderScope(), { profile: 'voice' });
            assert.notEqual(outsider.result.status, 'error', `voice errored: ${outsider.result.reason}`);
            assertNoLeak(outsider.result, `outsider ${pipeline} voice`);
            if (pipeline === 'legacy') {
              const member = await retrieve(memberScope(), { profile: 'voice' });
              assert.ok(leakText(member.result).includes(IDS.restrictedVoiceChunk), 'the keyword fallback found the restricted badge for member-a');
            }
            const member = await retrieve(memberScope(), { profile: 'voice' });
            assertHasMarker(member.result, `member-a ${pipeline} voice`);
          });
        });

        test(`${pipeline}: a reference to the restricted file name or id resolves for the outsider exactly as an unknown one`, async () => {
          await withPipeline(pipeline, async () => {
            const refsOf = (mentions: string[], ids: string[]) => ({
              documentRefs: { mentions, documentParts: ids.map((id) => ({ id, name: 'referenced part' })) },
            });
            const shape = (result: import('@/lib/rag').RetrievalResult) => ({
              used: result.usedDocuments.map((doc) => doc.id).sort(),
              explicit: result.usedDocuments.filter((doc) => doc.explicitly_referenced).length,
              context: result.context.split('referenced part').length,
            });
            const restricted = await retrieve(outsiderScope(), refsOf(['quillmarrow-restricted'], [IDS.restrictedDoc]));
            assertNoLeak(restricted.result, `outsider ${pipeline} refs`);
            const unknown = await retrieve(outsiderScope(), refsOf(['quillmarrow-unknown'], ['00000000-0000-4000-8000-00000000b8ff']));
            assert.deepEqual(shape(restricted.result), shape(unknown.result), 'a restricted reference differs from an unknown one');
            const member = await retrieve(memberScope(), refsOf(['quillmarrow-restricted'], []));
            assert.ok(
              member.result.usedDocuments.some((doc) => doc.id === IDS.restrictedDoc && doc.explicitly_referenced),
              `member-a lost the referenced restricted document (${pipeline})`,
            );
          });
        });
      }

      test('the assembly re-read and the overview read return nothing restricted for forged ids', async () => {
        const { fetchAssemblyRows } = await import('@/lib/rag/context/fetch-rows');
        const { fetchOverviewDocuments } = await import('@/lib/rag/context/overview');
        const forged = [
          { chunk_id: IDS.restrictedChunk, document_id: IDS.restrictedDoc, content: '', similarity: 1, metadata: null },
          { chunk_id: IDS.openChunk, document_id: IDS.openDoc, content: '', similarity: 1, metadata: null },
        ];
        const read = async (scope: TenantScope) => {
          const access = accessModule.scopeAccessFilter(scope);
          const signal = new AbortController().signal;
          const rows = await fetchAssemblyRows(forged as never, { adminClient: recording, signal, access } as never);
          const overview = await fetchOverviewDocuments(forged, { admin: recording, signal, access } as never);
          return { documents: [...rows.documents.keys()].sort(), chunks: [...rows.chunkMetadata.keys()].sort(), overview: [...overview.keys()].sort() };
        };
        assert.deepEqual(await read(outsiderScope()), { documents: [IDS.openDoc], chunks: [IDS.openChunk], overview: [IDS.openDoc] });
        const everything = {
          documents: [IDS.restrictedDoc, IDS.openDoc].sort(),
          chunks: [IDS.restrictedChunk, IDS.openChunk].sort(),
          overview: [IDS.restrictedDoc, IDS.openDoc].sort(),
        };
        for (const scope of [memberScope(), adminScope(), offScope()]) assert.deepEqual(await read(scope), everything);
      });

      for (const pipeline of ['legacy', 'v2'] as const) {
        test(`${pipeline}: accessLabels maps each used document to its labels, server-side only, and is absent while off`, async () => {
          await withPipeline(pipeline, async () => {
            const { result } = await retrieve(memberScope());
            const labels = result.accessLabels;
            assert.ok(labels instanceof Map, 'accessLabels is set when the mode is not off');
            assert.deepEqual(labels.get(IDS.restrictedDoc), [GROUP_KEY]);
            assert.deepEqual(labels.get(IDS.openDoc), ['all']);
            assert.ok(!Object.keys(result).includes('accessLabels'), 'accessLabels is not enumerable');
            assert.ok(!JSON.stringify(result).includes('accessLabels'), 'accessLabels is not serialised');
            assert.ok(!JSON.stringify({ ...result }).includes(GROUP_KEY), 'a spread copy carries no label');
            const off = await retrieve(offScope());
            assert.equal(off.result.accessLabels, undefined);
          });
        });
      }

      test('the fake edge accepts access_groups with the overlaps operator and still rejects other operators and columns', async () => {
        const outsiderKeys = ['all', `u:${IDS.outsider}`];
        const docs = await recording.from('documents').select('id, access_groups').overlaps('access_groups', outsiderKeys).in('id', [IDS.restrictedDoc, IDS.openDoc]);
        assert.equal(docs.error, null);
        assert.deepEqual((docs.data ?? []).map((row) => row.id), [IDS.openDoc]);
        const chunks = await recording.from('document_chunks').select('id').overlaps('access_groups', [GROUP_KEY]).in('id', [IDS.restrictedChunk, IDS.openChunk]);
        assert.equal(chunks.error, null);
        assert.deepEqual((chunks.data ?? []).map((row) => row.id), [IDS.restrictedChunk]);
        const contains = await recording.from('documents').select('id').contains('access_groups', ['all']);
        assert.ok(contains.error, 'the contains operator is rejected');
        const bogus = await recording.from('documents').select('id').overlaps('access_groups', ['all); DROP TABLE documents; --']);
        assert.ok(bogus.error, 'a malformed key is rejected');
        const unknownColumn = await recording.from('documents').select('id, secret_column');
        assert.ok(unknownColumn.error, 'an unknown column is rejected');
      });
    });
  });
}
