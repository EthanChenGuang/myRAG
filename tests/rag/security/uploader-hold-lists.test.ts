import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { listPendingUploads } from '@/lib/rag/ingest/approval/admin';
import { resetIngestDepsForTests, setIngestDepsForTests } from '@/lib/rag/ingest/deps';
import { listQuarantine } from '@/lib/rag/ingest/quarantine-admin';
import { resetRagDepsForTests, setRagDepsForTests } from '@/lib/rag/deps';

// Plan 05.2-17 Task 3 (UI-SPEC 6.14, 8.1): the quarantine list and the pending uploads carry the uploader's hold state, with one batched
// rag_active_uploader_holds call per tenant on a page; with RAG_UPLOADER_HOLD off both lists are unchanged.

type Row = Record<string, unknown>;

const ACTOR = '00000000-0000-4000-8000-0000000017d1';
const HELD = '00000000-0000-4000-8000-0000000017d2';
const FREE = '00000000-0000-4000-8000-0000000017d3';
const ORG_O = 'o:00000000-0000-4000-8000-0000000017e1';
const ORG_P = 'o:00000000-0000-4000-8000-0000000017e2';
const doc = (n: number) => `00000000-0000-4000-8000-0000000017f${n}`;

const state = {
  calls: [] as Array<{ fn: string; args: Record<string, unknown> }>,
  quarantine: [] as Row[],
  pending: [] as Row[],
  holds: {} as Record<string, string[]>,
  holdFails: false,
};

function respond(fn: string, args: Record<string, unknown>) {
  if (fn === 'rag_list_quarantine_reasons') return { data: state.quarantine, error: null };
  if (fn === 'rag_list_pending_uploads') return { data: state.pending, error: null };
  if (fn === 'rag_active_uploader_holds') {
    if (state.holdFails) return { data: null, error: { code: 'XX000', message: 'down' } };
    const held = state.holds[String(args.p_tenant_key)] ?? [];
    return { data: (args.p_user_ids as string[]).filter((id) => held.includes(id)), error: null };
  }
  return { data: null, error: { message: `unexpected ${fn}` } };
}

const fakeDb = {
  rpc(fn: string, args: Record<string, unknown>) {
    state.calls.push({ fn, args });
    const request = {
      abortSignal: () => request,
      then: (onFulfilled: (value: unknown) => unknown, onRejected?: (reason: unknown) => unknown) =>
        Promise.resolve(respond(fn, args)).then(onFulfilled, onRejected),
    };
    return request;
  },
};

const fakeAdmin = { auth: { admin: { getUserById: async (id: string) => ({ data: { user: { id, email: `${id.slice(-4)}@example.invalid` } }, error: null }) } } };

function quarantineRow(n: number, tenantKey: string, uploader: string | null): Row {
  return {
    document_id: doc(n),
    lineage_id: doc(n),
    tenant_key: tenantKey,
    filename: `document-${n}.pdf`,
    source: 'config_upload',
    version: 1,
    rule_ids: ['inj-en-01'],
    snippets: [],
    quarantined_at: '2026-11-20T10:00:00.000Z',
    detected_by: 'injection_scan',
    reasons: [],
    unlocated: 0,
    hidden_text_check: null,
    pending_approval: false,
    uploader_id: uploader,
    total_count: 4,
  };
}

function pendingRow(n: number, uploader: string | null): Row {
  return {
    document_id: doc(n),
    lineage_id: doc(n),
    tenant_key: ORG_O,
    filename: `document-${n}.pdf`,
    source: 'config_upload',
    doc_type: null,
    version: 1,
    uploader_id: uploader,
    uploaded_at: '2026-11-20T10:00:00.000Z',
    new_version: false,
    total_count: 3,
  };
}

const signal = new AbortController().signal;
const holdCalls = () => state.calls.filter((call) => call.fn === 'rag_active_uploader_holds');

beforeEach(() => {
  state.calls = [];
  state.holdFails = false;
  state.holds = { [ORG_O]: [HELD] };
  state.quarantine = [quarantineRow(1, ORG_O, HELD), quarantineRow(2, ORG_O, FREE), quarantineRow(3, ORG_P, HELD), quarantineRow(4, ORG_O, null)];
  state.pending = [pendingRow(5, HELD), pendingRow(6, FREE), pendingRow(7, null)];
  setIngestDepsForTests({ db: () => fakeDb as never });
  setRagDepsForTests({ adminClient: () => fakeAdmin as never });
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

afterEach(() => {
  resetIngestDepsForTests();
  resetRagDepsForTests();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe('quarantine list', () => {
  test('hold on: uploaderHeld per item, one batched call per tenant on the page, another tenant\'s hold never shows', async () => {
    vi.stubEnv('RAG_UPLOADER_HOLD', 'manual');
    const result = await listQuarantine({ actorUserId: ACTOR, signal });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.items.map((item) => [item.documentId, item.uploaderHeld])).toEqual([
      [doc(1), true],
      [doc(2), false],
      [doc(3), false],
      [doc(4), false],
    ]);
    const calls = holdCalls();
    expect(calls).toHaveLength(2);
    expect(calls.map((call) => call.args.p_tenant_key).sort()).toEqual([ORG_O, ORG_P]);
    const forO = calls.find((call) => call.args.p_tenant_key === ORG_O);
    expect([...(forO?.args.p_user_ids as string[])].sort()).toEqual([HELD, FREE].sort());
  });

  test('hold off: the list is deep-equal to before, with no uploaderHeld key and no hold call', async () => {
    const before = await listQuarantine({ actorUserId: ACTOR, signal });
    vi.stubEnv('RAG_UPLOADER_HOLD', 'off');
    const after = await listQuarantine({ actorUserId: ACTOR, signal });
    expect(after).toEqual(before);
    expect(after.ok && after.items.some((item) => 'uploaderHeld' in item)).toBe(false);
    expect(holdCalls()).toHaveLength(0);
  });

  test('a failed hold lookup shows nobody held and keeps the list', async () => {
    vi.stubEnv('RAG_UPLOADER_HOLD', 'auto');
    state.holdFails = true;
    const result = await listQuarantine({ actorUserId: ACTOR, signal });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.items.every((item) => item.uploaderHeld === false)).toBe(true);
  });
});

describe('pending uploads', () => {
  test('hold on: heldByUploaderHold for the held uploader, one call for the page', async () => {
    vi.stubEnv('RAG_UPLOADER_HOLD', 'manual');
    const result = await listPendingUploads({ actorUserId: ACTOR, tenantKey: ORG_O, signal });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.items.map((item) => [item.documentId, item.heldByUploaderHold])).toEqual([
      [doc(5), true],
      [doc(6), false],
      [doc(7), false],
    ]);
    expect(holdCalls()).toHaveLength(1);
    expect(holdCalls()[0]?.args.p_tenant_key).toBe(ORG_O);
  });

  test('hold off: the list is deep-equal to before, with no heldByUploaderHold key', async () => {
    const before = await listPendingUploads({ actorUserId: ACTOR, tenantKey: ORG_O, signal });
    vi.stubEnv('RAG_UPLOADER_HOLD', 'off');
    const after = await listPendingUploads({ actorUserId: ACTOR, tenantKey: ORG_O, signal });
    expect(after).toEqual(before);
    expect(after.ok && after.items.some((item) => 'heldByUploaderHold' in item)).toBe(false);
    expect(holdCalls()).toHaveLength(0);
  });
});
