import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const ADMIN_ID = '00000000-0000-4000-8000-0000000000a1';
const DOC_ID = '00000000-0000-4000-8000-0000000000d1';
const AUDIT_ID = '00000000-0000-4000-8000-0000000000e1';
const LINEAGE_ID = '00000000-0000-4000-8000-0000000000d2';
const ADMIN_CODES = ['owner_request', 'added_in_error', 'retention_ended', 'legal_or_policy', 'restricted_content', 'other'] as const;
const REPO_ROOT = path.resolve(__dirname, '../..');

type AdminResult = { ok: true; userId: string } | { ok: false; status: 401 | 403 | 503; reason: string };

const state = {
  admin: { ok: true, userId: ADMIN_ID } as AdminResult,
};

const purgeDocumentAsAdmin = vi.fn();
const listPurgeRecords = vi.fn();
const reverifyPurgeAsAdmin = vi.fn();

const CHECK = {
  left: { documents: 0, chunks: 0, original_files: 0 },
  pendingFiles: 0,
  queuedExternal: 0,
  result: 'verified' as const,
  checkedAt: '2026-11-27T10:00:00.000Z',
};

async function load() {
  vi.resetModules();
  vi.doMock('@/lib/admin-route-auth', () => ({
    checkAdmin: async () => state.admin,
    adminDenied: (status: number) =>
      new Response(JSON.stringify({ success: false, error: `denied ${status}` }), {
        status,
        headers: { 'content-type': 'application/json', 'Cache-Control': 'no-store' },
      }),
  }));
  vi.doMock('@/lib/rag', () => ({ PURGE_ADMIN_REASON_CODES: ADMIN_CODES, purgeDocumentAsAdmin, listPurgeRecords, reverifyPurgeAsAdmin }));
  const purge = await import('@/app/api/rag/admin/documents/[id]/purge/route');
  return { purge };
}

function post(url: string, body?: unknown, raw?: string): Request {
  return new Request(`http://localhost${url}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    ...(raw !== undefined ? { body: raw } : body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
}

const params = (id: string) => ({ params: Promise.resolve({ id }) });
const purgeUrl = (id: string) => `/api/rag/admin/documents/${id}/purge`;

describe('POST /api/rag/admin/documents/[id]/purge', () => {
  beforeEach(() => {
    state.admin = { ok: true, userId: ADMIN_ID };
    purgeDocumentAsAdmin.mockReset();
    purgeDocumentAsAdmin.mockResolvedValue({
      ok: true,
      auditId: AUDIT_ID,
      lineageId: LINEAGE_ID,
      removed: { documents: 2, chunks: 4, original_files: 4 },
      check: CHECK,
    });
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.resetModules();
  });

  it('answers the admin-denied status for a caller who is not an admin and purges nothing', async () => {
    const { purge } = await load();
    for (const status of [401, 403, 503] as const) {
      state.admin = { ok: false, status, reason: 'denied' };
      const response = await purge.POST(post(purgeUrl(DOC_ID), { reason_code: 'owner_request' }), params(DOC_ID));
      expect(response.status).toBe(status);
    }
    expect(purgeDocumentAsAdmin).not.toHaveBeenCalled();
  });

  it('refuses an id that is not a uuid with 400', async () => {
    const { purge } = await load();
    const response = await purge.POST(post(purgeUrl('not-a-uuid'), { reason_code: 'owner_request' }), params('not-a-uuid'));
    expect(response.status).toBe(400);
    expect(purgeDocumentAsAdmin).not.toHaveBeenCalled();
  });

  it.each([
    ['no body', undefined, ''],
    ['malformed JSON', undefined, '{"reason_code":'],
    ['an unknown reason code', { reason_code: 'source_deleted' }, undefined],
    ['a note over 500 characters', { reason_code: 'owner_request', reason_note: 'n'.repeat(501) }, undefined],
    ['other with a blank note', { reason_code: 'other', reason_note: '   ' }, undefined],
    ['other without a note', { reason_code: 'other' }, undefined],
    ['an extra key', { reason_code: 'owner_request', tenant_key: 's:default' }, undefined],
    ['an actor in the body', { reason_code: 'owner_request', actor: { kind: 'admin', id: DOC_ID } }, undefined],
  ])('refuses %s with 400', async (_name, body, raw) => {
    const { purge } = await load();
    const response = await purge.POST(post(purgeUrl(DOC_ID), body, raw), params(DOC_ID));
    expect(response.status).toBe(400);
    expect((await response.json()).success).toBe(false);
    expect(purgeDocumentAsAdmin).not.toHaveBeenCalled();
  });

  it('answers the same 404 for an unknown id and for another tenant document', async () => {
    const { purge } = await load();
    purgeDocumentAsAdmin.mockResolvedValue({ ok: false, reason: 'not_found' });
    const unknown = await purge.POST(post(purgeUrl(DOC_ID), { reason_code: 'owner_request' }), params(DOC_ID));
    const foreignId = '00000000-0000-4000-8000-0000000000f9';
    const foreign = await purge.POST(post(purgeUrl(foreignId), { reason_code: 'owner_request' }), params(foreignId));
    expect(unknown.status).toBe(404);
    expect(foreign.status).toBe(404);
    const unknownBody = await unknown.json();
    expect(unknownBody).toEqual({ success: false, error: 'not_found' });
    expect(await foreign.json()).toEqual(unknownBody);
  });

  it('passes the verified admin id as the actor, with the reason, and answers the receipt without caching', async () => {
    const { purge } = await load();
    const response = await purge.POST(
      post(purgeUrl(DOC_ID.toUpperCase()), { reason_code: 'other', reason_note: 'A synthetic note.' }),
      params(DOC_ID.toUpperCase()),
    );
    expect(response.status).toBe(200);
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    expect(purgeDocumentAsAdmin).toHaveBeenCalledTimes(1);
    const input = purgeDocumentAsAdmin.mock.calls[0]?.[0];
    expect(input).toMatchObject({ documentId: DOC_ID.toUpperCase(), actorUserId: ADMIN_ID, reasonCode: 'other', reasonNote: 'A synthetic note.' });
    expect(input.signal).toBeInstanceOf(AbortSignal);
    expect(await response.json()).toEqual({
      success: true,
      record_id: AUDIT_ID,
      removed: { documents: 2, chunks: 4, original_files: 4 },
      check: { left: { documents: 0, chunks: 0, original_files: 0 }, pending_files: 0, queued_external: 0, result: 'verified' },
      checked_at: CHECK.checkedAt,
    });
  });

  it('accepts a note of exactly 500 characters and a null note', async () => {
    const { purge } = await load();
    const full = await purge.POST(post(purgeUrl(DOC_ID), { reason_code: 'legal_or_policy', reason_note: 'n'.repeat(500) }), params(DOC_ID));
    const none = await purge.POST(post(purgeUrl(DOC_ID), { reason_code: 'retention_ended', reason_note: null }), params(DOC_ID));
    expect(full.status).toBe(200);
    expect(none.status).toBe(200);
    expect(purgeDocumentAsAdmin.mock.calls[1]?.[0].reasonNote).toBeNull();
  });

  it('maps an unavailable library to 503 and an invalid argument to 400', async () => {
    const { purge } = await load();
    purgeDocumentAsAdmin.mockResolvedValueOnce({ ok: false, reason: 'unavailable' });
    expect((await purge.POST(post(purgeUrl(DOC_ID), { reason_code: 'owner_request' }), params(DOC_ID))).status).toBe(503);
    purgeDocumentAsAdmin.mockResolvedValueOnce({ ok: false, reason: 'invalid_argument' });
    expect((await purge.POST(post(purgeUrl(DOC_ID), { reason_code: 'owner_request' }), params(DOC_ID))).status).toBe(400);
  });

  it('leaves DELETE /api/documents/[id] on its soft path: it never reaches the purge', () => {
    const source = fs.readFileSync(path.join(REPO_ROOT, 'src/app/api/documents/[id]/route.ts'), 'utf8');
    expect(source).not.toMatch(/purge/i);
  });
});
