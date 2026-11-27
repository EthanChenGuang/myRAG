import path from 'node:path';
import type { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createFixtureDatabase } from '../../../eval/harness/pglite-supabase.mts';
import { createPgliteAdmin } from '../../helpers/pglite-admin';
import type { RpcClient, RpcResponse } from '@/lib/rag/backend/supabase-rpc';
import { mintScope } from '@/lib/rag/tenant/scope';
import { resetAccessStartupForTests } from '@/lib/rag/tenant/access-startup';
import {
  AccessGroupsError,
  accessReasonOf,
  accessStatus,
  addMember,
  applyConnectorAccess,
  connectorFailClosedCounts,
  createGroup,
  deleteConnectorMap,
  documentAccessCounts,
  documentAudiences,
  listAccessDocuments,
  listConnectorMap,
  listGroups,
  listSharingRules,
  matchConnectorMembers,
  myGroups,
  renameGroup,
  runAccessDrift,
  setConnectorMap,
  setDocumentsAccess,
  setSharingRule,
  setUploadAccess,
  syncAccessStatus,
} from '@/lib/rag';

// Phase 4.3 plan 21 (SEC-12, DATA-22): the typed access services over the 0922, 0924 and 0925 functions, on a single-tenant PGlite fixture.
// Fixtures are neutral synthetic sentences and placeholder addresses.

const CORPUS_DIR = path.resolve(import.meta.dirname, '../../../eval/fixtures/corpus');
const id = (kind: string, n: number): string => `00000000-0000-4000-8000-${kind}${String(n).padStart(8, '0')}`;

const ADMIN = id('9211', 1);
const MEMBER_A = id('9211', 2);
const MEMBER_B = id('9211', 3);
const DOC = { plain: id('9213', 1), second: id('9213', 2), synced: id('9213', 3), missing: id('9213', 9) } as const;

type Admin = ReturnType<typeof createPgliteAdmin>;

/** The PGlite admin answers rpc() with a promise; the services also call abortSignal() on the request. */
function rpcClient(admin: Admin): RpcClient {
  return {
    rpc(fn, args) {
      const request = Promise.resolve(admin.rpc(fn, args)) as Promise<RpcResponse> & { abortSignal: (_signal: AbortSignal) => typeof request };
      request.abortSignal = () => request;
      return request;
    },
  };
}

function fakeClient(response: RpcResponse, calls: Array<{ fn: string; args: Record<string, unknown> }> = []): RpcClient {
  return {
    rpc(fn, args) {
      calls.push({ fn, args });
      const request = Promise.resolve(response) as Promise<RpcResponse> & { abortSignal: (_signal: AbortSignal) => typeof request };
      request.abortSignal = () => request;
      return request;
    },
  };
}

async function reason(run: () => Promise<unknown>): Promise<AccessGroupsError> {
  try {
    await run();
  } catch (error) {
    expect(error).toBeInstanceOf(AccessGroupsError);
    return error as AccessGroupsError;
  }
  throw new Error('expected an AccessGroupsError');
}

describe('access services (single-tenant PGlite)', () => {
  let db: PGlite;
  let deps: { db: () => RpcClient; signal: AbortSignal };
  const scope = mintScope('single', null, null);
  let groupA = '';

  beforeAll(async () => {
    ({ db } = await createFixtureDatabase({ deploymentMode: 'single-tenant', corpusDir: CORPUS_DIR, supabaseGrants: true }));
    await db.exec('ALTER TABLE auth.users ADD COLUMN IF NOT EXISTS email_confirmed_at timestamptz');
    for (const [user, email] of [
      [ADMIN, 'admin-person@example.invalid'],
      [MEMBER_A, 'member-alpha@example.invalid'],
      [MEMBER_B, 'member-beta@example.invalid'],
    ]) {
      await db.query('INSERT INTO auth.users (id, email, email_confirmed_at) VALUES ($1, $2, now()) ON CONFLICT DO NOTHING', [user, email]);
    }
    await db.query('INSERT INTO admin_users (id) VALUES ($1)', [ADMIN]);
    const docs: Array<[string, string, string]> = [
      [DOC.plain, 'plain-note.md', MEMBER_A],
      [DOC.second, 'second-note.md', MEMBER_B],
      [DOC.synced, 'synced-note.md', MEMBER_A],
    ];
    for (const [docId, filename, uploader] of docs) {
      await db.query(
        `INSERT INTO documents (id, filename, content, metadata, user_id, language, access_groups, lineage_id, version)
         VALUES ($1, $2, 'A neutral synthetic sentence about a shared record.', '{}'::jsonb, $3, 'en', ARRAY['all']::text[], $1, 1)`,
        [docId, filename, uploader],
      );
    }
    await db.query(
      `INSERT INTO nango_sync_records (user_id, connection_id, provider, file_id, file_name, document_id, status)
       VALUES ($1, 'connection-1', 'google-drive', 'file-1', 'file-1', $2, 'completed')`,
      [MEMBER_A, DOC.synced],
    );
    const client = rpcClient(createPgliteAdmin(db));
    deps = { db: () => client, signal: new AbortController().signal };
  }, 180_000);

  afterAll(async () => {
    await db?.close();
  });

  describe('groups and members (Task 1)', () => {
    it('creates a group, adds a member and reads it back as that member\'s own and assignable group', async () => {
      const created = await createGroup(scope, { key: 'group-a', name: '  Group alpha ', actorId: ADMIN }, deps);
      expect(created).toMatchObject({ key: 'group-a', name: 'Group alpha', source: 'manual' });
      groupA = created.id;

      const member = await addMember(scope, { groupId: groupA, userId: MEMBER_A, actorId: ADMIN }, deps);
      expect(member).toMatchObject({ groupId: groupA, userId: MEMBER_A });

      const mine = await myGroups(scope, { userId: MEMBER_A }, deps);
      expect(mine.isAdmin).toBe(false);
      expect(mine.ownGroups).toEqual([{ id: groupA, name: 'Group alpha' }]);
      expect(mine.assignableGroups).toEqual([{ id: groupA, name: 'Group alpha' }]);

      const admin = await myGroups(scope, { userId: ADMIN }, deps);
      expect(admin.isAdmin).toBe(true);
      expect(admin.assignableGroups.map((group) => group.id)).toContain(groupA);
    });

    it('maps a taken key to group_exists and a second member add to member_exists', async () => {
      expect((await reason(() => createGroup(scope, { key: 'group-a', name: 'Again', actorId: ADMIN }, deps))).reason).toBe('group_exists');
      expect((await reason(() => addMember(scope, { groupId: groupA, userId: MEMBER_A, actorId: ADMIN }, deps))).reason).toBe('member_exists');
    });

    it('lists groups with counts and renames one', async () => {
      const page = await listGroups(scope, {}, deps);
      expect(page.groups).toEqual([expect.objectContaining({ id: groupA, key: 'group-a', memberCount: 1, documentCount: 0 })]);
      expect(page.nextCursor).toBeNull();
      const renamed = await renameGroup(scope, { groupId: groupA, name: 'Group alpha one', actorId: ADMIN }, deps);
      expect(renamed.name).toBe('Group alpha one');
    });

    it('refuses an invalid or reserved key before any database call', async () => {
      const calls: Array<{ fn: string; args: Record<string, unknown> }> = [];
      const fake = { db: () => fakeClient({ data: [], error: null }, calls), signal: new AbortController().signal };
      expect((await reason(() => createGroup(scope, { key: 'Bad Key', name: 'x', actorId: ADMIN }, fake))).reason).toBe('invalid_key');
      expect((await reason(() => createGroup(scope, { key: '-lead', name: 'x', actorId: ADMIN }, fake))).reason).toBe('invalid_key');
      expect((await reason(() => createGroup(scope, { key: 'all', name: 'x', actorId: ADMIN }, fake))).reason).toBe('reserved_key');
      expect((await reason(() => createGroup(scope, { key: 'group-z', name: 'x', actorId: 'not-a-uuid' }, fake))).reason).toBe('actor_required');
      expect(calls).toEqual([]);
    });

    it('never carries the database message: an unknown message gives reason null', async () => {
      const secret = 'duplicate key value violates "rag_access_groups_key" detail: key=(group-secret-input)';
      const fake = { db: () => fakeClient({ data: null, error: { code: 'XX000', message: secret } }), signal: new AbortController().signal };
      const error = await reason(() => createGroup(scope, { key: 'group-q', name: 'Group q', actorId: ADMIN }, fake));
      expect(error.reason).toBeNull();
      expect(error.code).toBe('XX000');
      expect(error.message).not.toContain('group-secret-input');
      expect(error.message).not.toContain('duplicate');
    });

    it('takes only the leading word of a known reason, and folds not-found words', () => {
      expect(accessReasonOf('group_exists')).toBe('group_exists');
      expect(accessReasonOf('count_required: 3')).toBe('count_required');
      expect(accessReasonOf('mapping_not_found')).toBe('not_found');
      expect(accessReasonOf('some other failure')).toBeNull();
      expect(accessReasonOf(undefined)).toBeNull();
    });

    it('takes the tenant from the scope only', async () => {
      const calls: Array<{ fn: string; args: Record<string, unknown> }> = [];
      const fake = { db: () => fakeClient({ data: [], error: null }, calls), signal: new AbortController().signal };
      const org = mintScope('org', MEMBER_A, id('9212', 1));
      await listGroups(org, { cursor: null }, fake);
      expect(calls[0]?.args.p_tenant_key).toBe(`o:${id('9212', 1)}`);
    });
  });
  describe('documents (Task 2)', () => {
    const labelOf = async (docId: string): Promise<string[]> =>
      (await db.query<{ g: string[] }>('SELECT access_groups AS g FROM documents WHERE id = $1', [docId])).rows[0]!.g;

    it('relabels to groups the caller names by id, skipping a connector-managed document', async () => {
      const result = await setDocumentsAccess(scope, { documentIds: [DOC.plain, DOC.synced], groupIds: [groupA.toUpperCase()] }, ADMIN, deps);
      expect(result.changed).toBe(1);
      expect(result.skipped).toBe(1);
      expect(result.notFound).toBe(0);
      expect(result.audiences).toEqual([expect.objectContaining({ documentId: DOC.plain, kind: 'groups', groupIds: [groupA], connectorManaged: false })]);
      expect(await labelOf(DOC.plain)).toEqual([`g:${groupA}`]);
      expect(await labelOf(DOC.synced)).toEqual(['all']);
      const audit = await db.query<{ actor_kind: string; actor: string }>(
        "SELECT actor_kind, actor::text AS actor FROM rag_access_audit WHERE action = 'document_set' AND document_id = $1",
        [DOC.plain],
      );
      expect(audit.rows).toEqual([{ actor_kind: 'admin', actor: ADMIN }]);
    });

    it('raises access_managed_by_connector for a single connector-managed document and not_found for an unknown one', async () => {
      expect((await reason(() => setDocumentsAccess(scope, { documentIds: [DOC.synced], everyone: true }, ADMIN, deps))).reason).toBe(
        'access_managed_by_connector',
      );
      expect((await reason(() => setDocumentsAccess(scope, { documentIds: [DOC.missing], everyone: true }, ADMIN, deps))).reason).toBe('not_found');
      expect((await reason(() => setDocumentsAccess(scope, { documentIds: [DOC.plain], groupIds: [id('9219', 1)] }, ADMIN, deps))).reason).toBe(
        'unknown_group',
      );
    });

    it('builds the keys itself: everyone is {all}, and client-built keys never reach the setter', async () => {
      const calls: Array<{ fn: string; args: Record<string, unknown> }> = [];
      const fake = { db: () => fakeClient({ data: [{ document_id: DOC.plain, outcome: 'unchanged', before_groups: ['all'], after_groups: ['all'] }], error: null }, calls), signal: new AbortController().signal };
      await setDocumentsAccess(scope, { documentIds: [DOC.plain], everyone: true }, ADMIN, fake);
      expect(calls[0]).toMatchObject({ fn: 'rag_set_document_access_groups', args: { p_keys: ['all'], p_actor: ADMIN, p_actor_kind: 'admin', p_tenant_key: 's:default' } });
      calls.length = 0;
      for (const groupIds of [[`g:${groupA}`], ['all'], [`u:${MEMBER_A}`], []]) {
        expect((await reason(() => setDocumentsAccess(scope, { documentIds: [DOC.plain], groupIds }, ADMIN, fake))).reason).toBe('empty_access');
      }
      expect((await reason(() => setDocumentsAccess(scope, { documentIds: [], everyone: true }, ADMIN, fake))).reason).toBe('invalid_argument');
      expect((await reason(() => setDocumentsAccess(scope, { documentIds: [DOC.plain], everyone: true }, 'someone', fake))).reason).toBe('actor_required');
      expect(calls).toEqual([]);
    });

    it('applies an upload choice with actor kind system and reason upload', async () => {
      const outcome = await setUploadAccess(scope, DOC.second, [`g:${groupA}`], MEMBER_B, deps);
      expect(outcome).toEqual({ documentId: DOC.second, outcome: 'changed', keys: [`g:${groupA}`] });
      const audit = await db.query<{ actor_kind: string; reason: string; actor: string }>(
        "SELECT actor_kind, reason, actor::text AS actor FROM rag_access_audit WHERE action = 'document_set' AND document_id = $1",
        [DOC.second],
      );
      expect(audit.rows).toEqual([{ actor_kind: 'system', reason: 'upload', actor: MEMBER_B }]);
      expect((await reason(() => setUploadAccess(scope, DOC.second, ['g:not-a-group'], MEMBER_B, deps))).reason).toBe('empty_access');
      expect((await reason(() => setUploadAccess(scope, DOC.second, [], MEMBER_B, deps))).reason).toBe('empty_access');
    });

    it('lists documents with their audience, reads audiences by id and counts per filter', async () => {
      const restricted = await listAccessDocuments(scope, { filter: 'restricted' }, deps);
      expect(restricted.documents.map((doc) => doc.documentId).sort()).toEqual([DOC.plain, DOC.second].sort());
      expect(restricted.documents[0]).toMatchObject({ kind: 'groups', groupNames: ['Group alpha one'] });
      expect(restricted.nextCursor).toBeNull();
      const all = await listAccessDocuments(scope, { filter: 'all', query: 'synced' }, deps);
      expect(all.documents).toEqual([expect.objectContaining({ documentId: DOC.synced, kind: 'everyone', connectorManaged: true, source: 'google-drive' })]);
      const audiences = await documentAudiences(scope, [DOC.plain, DOC.missing], deps);
      expect(audiences.map((row) => row.documentId)).toEqual([DOC.plain]);
      const counts = await documentAccessCounts(scope, {}, deps);
      expect(counts).toMatchObject({ restricted: 2, uploaderOnly: 0 });
      expect(counts.all).toBe(counts.everyone + 2);
      expect(await documentAccessCounts(scope, { query: 'synced-note' }, deps)).toEqual({ restricted: 0, uploaderOnly: 0, everyone: 1, all: 1 });
      expect((await reason(() => listAccessDocuments(scope, { filter: 'secret' }, deps))).reason).toBe('invalid_filter');
    });
  });

  describe('status and drift (Task 2)', () => {
    const startup = (on: boolean) => ({
      ragEnv: () => ({ RAG_DOC_ACCESS_GROUPS: on ? 'on' : 'off', RAG_EMBED_ACCESS_GROUP: on ? 'group-a' : '' }),
      adminClient: () => deps.db(),
      backendCapabilities: () => ({ accessFilter: true }) as never,
      now: () => 1_700_000_000_000,
    });

    afterAll(async () => {
      resetAccessStartupForTests();
      await syncAccessStatus({ ...deps, ragEnv: startup(false).ragEnv, startup: startup(false), embedScope: async () => scope });
      resetAccessStartupForTests();
    });

    it('with the switch off reports off and the database flag false', async () => {
      resetAccessStartupForTests();
      const status = await syncAccessStatus({ ...deps, ragEnv: startup(false).ragEnv, startup: startup(false), embedScope: async () => scope });
      expect(status).toMatchObject({ runningSwitch: 'off', databaseFlag: false, status: 'off', ready: false, embedGroup: null, checkedAt: 1_700_000_000_000 });
    });

    it('with the switch on reports the flag, the readiness reasons and the embed group by key and name only', async () => {
      resetAccessStartupForTests();
      const status = await syncAccessStatus({ ...deps, ragEnv: startup(true).ragEnv, startup: startup(true), embedScope: async () => scope });
      expect(status.runningSwitch).toBe('on');
      expect(status.databaseFlag).toBe(true);
      expect(status.ready).toBe(status.status === 'ready');
      expect(Array.isArray(status.reasons)).toBe(true);
      expect(status.embedGroup).toEqual({ key: 'group-a', valid: true, exists: true, name: 'Group alpha one' });
      const serialised = JSON.stringify(status);
      expect(serialised).not.toContain(groupA);
      expect(serialised).not.toContain('g:');

      const missing = await accessStatus({ ...deps, ragEnv: () => ({ RAG_DOC_ACCESS_GROUPS: 'on', RAG_EMBED_ACCESS_GROUP: 'group-none' }), embedScope: async () => scope });
      expect(missing.embedGroup).toEqual({ key: 'group-none', valid: true, exists: false, name: null });
      const malformed = await accessStatus({ ...deps, ragEnv: () => ({ RAG_DOC_ACCESS_GROUPS: 'on', RAG_EMBED_ACCESS_GROUP: 'Bad Key' }), embedScope: async () => scope });
      expect(malformed.embedGroup).toEqual({ key: 'Bad Key', valid: false, exists: false, name: null });
      const noTenant = await accessStatus({ ...deps, ragEnv: startup(true).ragEnv, embedScope: async () => null });
      expect(noTenant.embedGroup).toEqual({ key: 'group-a', valid: true, exists: false, name: null });
    });

    it('returns the per-store drift counts', async () => {
      const drift = await runAccessDrift(deps);
      expect(drift.length).toBeGreaterThan(0);
      expect(drift.find((row) => row.store === 'document_chunks')).toEqual({ store: 'document_chunks', rows: 0 });
      for (const row of drift) expect(Number.isInteger(row.rows)).toBe(true);
    });
  });

  describe('connector (Task 2)', () => {
    let mappingId = '';

    it('creates, lists and refuses duplicate or unknown mappings', async () => {
      const created = await setConnectorMap(
        scope,
        { provider: 'google-drive', kind: 'group', externalPrincipalId: 'Source-Group-1@example.org', groupId: groupA },
        ADMIN,
        deps,
      );
      expect(created).toMatchObject({ groupId: groupA, outcome: 'created' });
      mappingId = created.id;
      expect(
        (await reason(() => setConnectorMap(scope, { provider: 'google-drive', kind: 'group', externalPrincipalId: 'source-group-1@example.org', groupId: groupA }, ADMIN, deps)))
          .reason,
      ).toBe('mapping_exists');
      expect(
        (await reason(() => setConnectorMap(scope, { provider: 'google-drive', kind: 'group', externalPrincipalId: 'source-group-2@example.org', groupId: id('9219', 2) }, ADMIN, deps)))
          .reason,
      ).toBe('unknown_group');
      expect((await reason(() => setConnectorMap(scope, { id: id('9219', 3), groupId: groupA }, ADMIN, deps))).reason).toBe('not_found');
      expect((await reason(() => setConnectorMap(scope, { provider: 'other', kind: 'group', externalPrincipalId: 'x', groupId: groupA }, ADMIN, deps))).reason).toBe(
        'invalid_argument',
      );
      const page = await listConnectorMap(scope, {}, deps);
      expect(page.total).toBe(1);
      expect(page.rows).toEqual([expect.objectContaining({ id: mappingId, provider: 'google-drive', kind: 'group', externalPrincipalId: 'source-group-1@example.org', groupId: groupA })]);
    });

    it('matches source addresses to members by position, never returning an address', async () => {
      expect(await matchConnectorMembers(scope, ['MEMBER-ALPHA@example.invalid', 'nobody@example.invalid', ' member-beta@example.invalid '], deps)).toEqual([
        MEMBER_A,
        null,
        MEMBER_B,
      ]);
      expect(await matchConnectorMembers(scope, [], deps)).toEqual([]);
    });

    it('applies a mapped principal, falls back closed on an unmapped one and counts the fallback per connection', async () => {
      const mapped = await applyConnectorAccess(
        scope,
        { documentId: DOC.synced, provider: 'google-drive', principals: [{ kind: 'group', id: 'source-group-1@example.org' }, { kind: 'user', memberId: MEMBER_A }], ownerId: MEMBER_A, status: 'ok' },
        deps,
      );
      expect(mapped).toEqual({ keys: [`g:${groupA}`, `u:${MEMBER_A}`].sort(), failClosed: false, reason: 'source_mapped' });
      expect(await connectorFailClosedCounts(scope, deps)).toEqual([]);

      const unmapped = await applyConnectorAccess(
        scope,
        { documentId: DOC.synced, provider: 'google-drive', principals: [{ kind: 'group', id: 'unknown-group@example.org' }], ownerId: MEMBER_A, status: 'ok' },
        deps,
      );
      expect(unmapped).toEqual({ keys: [`u:${MEMBER_A}`], failClosed: true, reason: 'unmapped_source' });
      expect(await connectorFailClosedCounts(scope, deps)).toEqual([{ connectionId: 'connection-1', documents: 1 }]);
      const audit = await db.query<{ actor_kind: string }>("SELECT actor_kind FROM rag_access_audit WHERE action = 'document_set' AND document_id = $1", [DOC.synced]);
      expect(audit.rows.every((row) => row.actor_kind === 'connector')).toBe(true);

      expect((await reason(() => applyConnectorAccess(scope, { documentId: DOC.synced, provider: 'other' as never, principals: [], ownerId: MEMBER_A, status: 'ok' }, deps))).reason).toBe(
        'invalid_argument',
      );
      expect((await reason(() => applyConnectorAccess(scope, { documentId: DOC.missing, provider: 'notion', principals: [], ownerId: MEMBER_A, status: 'ok' }, deps))).reason).toBe(
        'not_found',
      );
    });

    it('creates sharing rules off, refuses a bad domain and turns a rule on', async () => {
      expect((await reason(() => setSharingRule(scope, { provider: 'google-drive', kind: 'domain', domain: 'not a domain' }, ADMIN, deps))).reason).toBe('bad_domain');
      expect((await reason(() => setSharingRule(scope, { provider: 'dropbox', kind: 'anyone', domain: 'example.org' }, ADMIN, deps))).reason).toBe('bad_domain');
      const rule = await setSharingRule(scope, { provider: 'google-drive', kind: 'domain', domain: 'Example.org' }, ADMIN, deps);
      expect(rule).toMatchObject({ enabled: false, outcome: 'created' });
      expect(await setSharingRule(scope, { id: rule.id, enabled: true }, ADMIN, deps)).toEqual({ id: rule.id, enabled: true, outcome: 'enabled' });
      expect(await listSharingRules(scope, deps)).toEqual([expect.objectContaining({ id: rule.id, provider: 'google-drive', kind: 'domain', domain: 'example.org', enabled: true })]);
    });

    it('lists an unmapped source group without an id, then deletes a mapping', async () => {
      const page = await listConnectorMap(scope, {}, deps);
      expect(page.total).toBe(2);
      expect(page.rows[0]).toEqual({ id: null, provider: 'google-drive', kind: 'group', externalPrincipalId: 'unknown-group@example.org', groupId: null, documents: 1 });
      expect(await deleteConnectorMap(scope, { id: mappingId }, ADMIN, deps)).toBe(true);
      expect((await listConnectorMap(scope, {}, deps)).rows.find((row) => row.id === mappingId)).toBeUndefined();
      expect((await reason(() => deleteConnectorMap(scope, { id: mappingId }, ADMIN, deps))).reason).toBe('not_found');
    });
  });
});
