import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { UploadApprovalSchema } from '@/lib/rag-eval/contracts.generated';
import { decideUploadApproval, normalizeUploaderId, type UploadApprovalInput } from '@/lib/rag/ingest/approval/decide';
import { loadIngestConfig } from '@/lib/rag/ingest/config';
import { getIngestDeps } from '@/lib/rag/ingest/deps';
import { resolveUploadApproval } from '@/lib/rag/ingest/approval/resolve';
import { afterPublish, registerPostPublishHook, resetPostPublishHooksForTests } from '@/lib/rag/ingest/post-publish';
import { identifyStage } from '@/lib/rag/ingest/stages/identify';
import { publishStage } from '@/lib/rag/ingest/stages/publish';
import { emptyIngestState, type IngestResult, type StageContext } from '@/lib/rag/ingest/types';
import { IngestWriterError, type IngestWriter, type PublishOutcome } from '@/lib/rag/ingest/writer';
import { mintScope, type TenantScope } from '@/lib/rag/tenant/scope';

const MEMBER = '00000000-0000-4000-8000-0000000000a1';
const ADMIN = '00000000-0000-4000-8000-0000000000a2';
const OWNER = '00000000-0000-4000-8000-0000000000a3';
const AT = '2026-01-02T03:04:05.000Z';

function input(overrides: Partial<UploadApprovalInput> = {}): UploadApprovalInput {
  return {
    mode: 'members',
    scopeKind: 'org',
    workspaceUserId: null,
    uploaderId: MEMBER,
    isTenantAdmin: false,
    exemptions: [],
    connectorRefs: [],
    decidedAt: AT,
    ...overrides,
  };
}

function decide(overrides: Partial<UploadApprovalInput> = {}) {
  const result = decideUploadApproval(input(overrides));
  expect(UploadApprovalSchema.parse(result)).toEqual(result);
  return { required: result.required, reason: result.reason };
}

describe('decideUploadApproval', () => {
  test('off decides nothing, whoever uploads', () => {
    for (const isTenantAdmin of [true, false, null]) {
      for (const uploaderId of [MEMBER, null]) {
        const result = decideUploadApproval(input({ mode: 'off', isTenantAdmin, uploaderId }));
        expect(result).toEqual({ mode: 'off', required: false, reason: null, uploader_id: uploaderId, decided_at: AT });
      }
    }
  });

  test('members: a non-admin upload to an organization is held, an admin upload is not', () => {
    expect(decide()).toEqual({ required: true, reason: 'member_upload' });
    expect(decide({ isTenantAdmin: null })).toEqual({ required: true, reason: 'member_upload' });
    expect(decide({ uploaderId: ADMIN, isTenantAdmin: true })).toEqual({ required: false, reason: 'admin_upload' });
  });

  test('members in single-tenant mode: a user not in admin_users is held, an admin is not', () => {
    expect(decide({ scopeKind: 'single' })).toEqual({ required: true, reason: 'member_upload' });
    expect(decide({ scopeKind: 'single', uploaderId: ADMIN, isTenantAdmin: true })).toEqual({ required: false, reason: 'admin_upload' });
  });

  test("members: a personal workspace's own upload is not held; another user's upload into it is", () => {
    expect(decide({ scopeKind: 'personal', workspaceUserId: OWNER, uploaderId: OWNER })).toEqual({ required: false, reason: 'personal_workspace' });
    expect(decide({ scopeKind: 'personal', workspaceUserId: OWNER, uploaderId: MEMBER })).toEqual({ required: true, reason: 'member_upload' });
  });

  test('members: an uploader who is both the uploader and an admin of the tenant is not held', () => {
    expect(decide({ uploaderId: ADMIN, isTenantAdmin: true, connectorRefs: ['conn-1'] })).toEqual({ required: false, reason: 'admin_upload' });
  });

  test('all: every upload is held, admins and personal workspaces included', () => {
    expect(decide({ mode: 'all' })).toEqual({ required: true, reason: 'all_uploads' });
    expect(decide({ mode: 'all', uploaderId: ADMIN, isTenantAdmin: true })).toEqual({ required: true, reason: 'all_uploads' });
    expect(decide({ mode: 'all', scopeKind: 'personal', workspaceUserId: OWNER, uploaderId: OWNER })).toEqual({ required: true, reason: 'all_uploads' });
  });

  for (const mode of ['members', 'all'] as const) {
    test(`${mode}: an uploader exemption lifts the hold`, () => {
      expect(decide({ mode, exemptions: [{ kind: 'uploader', ref: MEMBER.toUpperCase() }] })).toEqual({ required: false, reason: 'exempt_uploader' });
    });

    test(`${mode}: a connector exemption lifts the hold, an exemption for another connector does not`, () => {
      expect(decide({ mode, connectorRefs: ['conn-1'], exemptions: [{ kind: 'connector', ref: 'conn-1' }] })).toEqual({ required: false, reason: 'exempt_connector' });
      expect(decide({ mode, connectorRefs: ['conn-2'], exemptions: [{ kind: 'connector', ref: 'conn-1' }] }).required).toBe(true);
    });

    test(`${mode}: an exemption of one kind never matches a ref of the other kind`, () => {
      expect(decide({ mode, connectorRefs: [MEMBER], exemptions: [{ kind: 'uploader', ref: 'conn-1' }] }).required).toBe(true);
      expect(decide({ mode, connectorRefs: ['conn-1'], exemptions: [{ kind: 'uploader', ref: 'conn-1' }] }).required).toBe(true);
    });

    test(`${mode}: an unknown uploader is held as unknown_uploader; with no exemption rows the mode alone decides`, () => {
      expect(decide({ mode, uploaderId: null, isTenantAdmin: null })).toEqual({ required: true, reason: 'unknown_uploader' });
      expect(decide({ mode, uploaderId: null, isTenantAdmin: true })).toEqual({ required: true, reason: 'unknown_uploader' });
    });

    test(`${mode}: a connector exemption lifts the hold of an unknown uploader`, () => {
      expect(decide({ mode, uploaderId: null, connectorRefs: ['conn-1'], exemptions: [{ kind: 'connector', ref: 'conn-1' }] })).toEqual({ required: false, reason: 'exempt_connector' });
    });
  }

  test('the uploader id is carried on the decision', () => {
    expect(decideUploadApproval(input()).uploader_id).toBe(MEMBER);
    expect(decideUploadApproval(input({ uploaderId: null })).uploader_id).toBeNull();
  });

  test('normalizeUploaderId accepts a UUID only and lower-cases it', () => {
    expect(normalizeUploaderId(MEMBER.toUpperCase())).toBe(MEMBER);
    expect(normalizeUploaderId('not-a-uuid')).toBeNull();
    expect(normalizeUploaderId(42)).toBeNull();
    expect(normalizeUploaderId(undefined)).toBeNull();
  });
});

// ---- identify-side resolution, the publish stage and the post-publish seam (fake writer, no database) ----


const ORG = '00000000-0000-4000-8000-0000000000c1';
const DOC = '00000000-0000-4000-8000-0000000000d9';

interface FakeWriterOptions {
  admin?: boolean | Error;
  exemptions?: Array<{ kind: string; ref: string }> | Error;
  publishOutcome?: PublishOutcome;
  holdError?: Error;
  rowStatus?: string;
}

function fakeWriter(options: FakeWriterOptions = {}) {
  const calls: string[] = [];
  const writer = {
    async isTenantAdmin(userId: string) {
      calls.push(`isTenantAdmin:${userId}`);
      if (options.admin instanceof Error) throw options.admin;
      return options.admin ?? false;
    },
    async uploadExemptions() {
      calls.push('uploadExemptions');
      if (options.exemptions instanceof Error) throw options.exemptions;
      return options.exemptions ?? [];
    },
    async holdForReview(documentId: string) {
      calls.push(`holdForReview:${documentId}`);
      if (options.holdError) throw options.holdError;
      return { documentId, version: 3 };
    },
    async getDocument() {
      calls.push('getDocument');
      return { status: options.rowStatus ?? 'processing', version: 3 } as Awaited<ReturnType<IngestWriter['getDocument']>>;
    },
    async setFields(documentId: string, fields: Record<string, unknown>) {
      calls.push(`setFields:${documentId}:${JSON.stringify(fields)}`);
    },
    async publish(documentId: string) {
      calls.push(`publish:${documentId}`);
      return { outcome: options.publishOutcome ?? 'published', documentId, version: 3, supersededDocumentId: null };
    },
  };
  return { writer: writer as unknown as IngestWriter, calls };
}

function ctxFor(scope: TenantScope, writer: IngestWriter, overrides: { mode?: 'off' | 'members' | 'all'; uploaderId?: string | null; options?: Record<string, unknown> } = {}): StageContext {
  const deps = getIngestDeps();
  return {
    input: {
      scope,
      source: 'config_upload',
      sourceKey: 'root/notes.md',
      text: '# Notes\n\nA neutral sentence about a blue widget.\n',
      filename: 'notes.md',
      mimeType: 'text/markdown',
      signal: new AbortController().signal,
      ...(overrides.uploaderId !== undefined ? { uploaderId: overrides.uploaderId } : {}),
      ...(overrides.options ? { options: overrides.options } : {}),
    },
    deps,
    writer,
    config: loadIngestConfig({ RAG_UPLOAD_APPROVAL: overrides.mode ?? 'members' }),
    signal: new AbortController().signal,
    deadline: Number.POSITIVE_INFINITY,
    state: emptyIngestState(),
    warnings: [],
    identity: null,
    document: { id: DOC, version: 3, lineageId: 'lineage', resumed: false },
    parserUsed: 'text',
    work: { parseText: null, parserVersion: null, chunks: [], chunksWritten: 2 },
  };
}

describe('resolveUploadApproval', () => {
  beforeEach(() => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  test('single-tenant: the caller-set uploader is asked about, and an admin publishes', async () => {
    const { writer, calls } = fakeWriter({ admin: true });
    const decision = await resolveUploadApproval(ctxFor(mintScope('single', null, null), writer, { uploaderId: ADMIN.toUpperCase() }));
    expect(decision).toMatchObject({ required: false, reason: 'admin_upload', uploader_id: ADMIN });
    expect(calls).toEqual(['uploadExemptions', `isTenantAdmin:${ADMIN}`]);
  });

  test('single-tenant without an uploader: held as unknown_uploader, and no admin check is made', async () => {
    const { writer, calls } = fakeWriter({ admin: true });
    const decision = await resolveUploadApproval(ctxFor(mintScope('single', null, null), writer));
    expect(decision).toMatchObject({ required: true, reason: 'unknown_uploader', uploader_id: null });
    expect(calls).toEqual(['uploadExemptions']);
  });

  test("an organization scope's verified user wins over a caller-set uploader id", async () => {
    const { writer, calls } = fakeWriter({ admin: false });
    const decision = await resolveUploadApproval(ctxFor(mintScope('org', MEMBER, ORG), writer, { uploaderId: ADMIN }));
    expect(decision).toMatchObject({ required: true, reason: 'member_upload', uploader_id: MEMBER });
    expect(calls).toContain(`isTenantAdmin:${MEMBER}`);
  });

  test('a failed lookup can only hold: admin check and exemptions unavailable count as member and none', async () => {
    const { writer } = fakeWriter({ admin: new Error('down'), exemptions: new Error('down') });
    const decision = await resolveUploadApproval(ctxFor(mintScope('org', ADMIN, ORG), writer, { options: { nangoConnectionId: 'conn-1' } }));
    expect(decision).toMatchObject({ required: true, reason: 'member_upload' });
  });

  test("a connector exemption matches the upload's connection id", async () => {
    const { writer } = fakeWriter({ exemptions: [{ kind: 'connector', ref: 'conn-1' }] });
    const decision = await resolveUploadApproval(ctxFor(mintScope('single', null, null), writer, { options: { nangoConnectionId: 'conn-1' } }));
    expect(decision).toMatchObject({ required: false, reason: 'exempt_connector' });
  });

  test('a personal workspace owner is not asked about and publishes under members', async () => {
    const { writer, calls } = fakeWriter();
    const decision = await resolveUploadApproval(ctxFor(mintScope('personal', OWNER, null), writer));
    expect(decision).toMatchObject({ required: false, reason: 'personal_workspace' });
    expect(calls).toEqual(['uploadExemptions']);
  });

  test('identify with the switch off makes no call and stores no decision', async () => {
    const { writer, calls } = fakeWriter();
    const ctx = ctxFor(mintScope('single', null, null), writer, { mode: 'off', uploaderId: MEMBER });
    ctx.document = null;
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const outcome = await identifyStage.run(ctx);
    expect(outcome.kind).toBe('next');
    expect(calls).toEqual([]);
    expect('approval' in ctx.state).toBe(false);
  });
});

describe('publish stage with an approval decision', () => {
  beforeEach(() => {
    resetPostPublishHooksForTests();
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  });
  afterEach(() => {
    resetPostPublishHooksForTests();
    vi.restoreAllMocks();
  });

  const required = { mode: 'members' as const, required: true, reason: 'member_upload' as const, uploader_id: MEMBER, decided_at: AT };

  async function publishWith(options: FakeWriterOptions, state: Partial<StageContext['state']> = {}) {
    const { writer, calls } = fakeWriter(options);
    const ctx = ctxFor(mintScope('single', null, null), writer);
    Object.assign(ctx.state, state);
    const outcome = await publishStage.run(ctx);
    expect(outcome.kind).toBe('done');
    return { result: (outcome as { result: IngestResult }).result, calls };
  }

  test('approval required: the version is held for review and the publish function is not called', async () => {
    const { result, calls } = await publishWith({}, { approval: required });
    expect(result).toMatchObject({ status: 'pending_review', documentId: DOC, version: 3, chunkCount: 2 });
    expect(calls).toEqual([`holdForReview:${DOC}`]);
  });

  test('no decision: publish is called as today and maps published to ready', async () => {
    const { result, calls } = await publishWith({});
    expect(result).toEqual({ status: 'ready', documentId: DOC, version: 3, parserUsed: 'text', chunkCount: 2, warnings: [] });
    expect(calls).toEqual([`publish:${DOC}`]);
  });

  test('a decision that requires nothing publishes', async () => {
    const { result, calls } = await publishWith({}, { approval: { ...required, required: false, reason: 'admin_upload' } });
    expect(result.status).toBe('ready');
    expect(calls).toEqual([`publish:${DOC}`]);
  });

  test('quarantine wins: a scan-quarantined version goes to the publish function, which keeps it quarantined', async () => {
    const { result, calls } = await publishWith({ publishOutcome: 'quarantined' }, { approval: required, quarantine: { ruleIds: ['r'], released: false } });
    expect(result.status).toBe('quarantined');
    expect(calls).toEqual([`publish:${DOC}`]);
  });

  test('a resumed publish of an already held version answers pending_review without holding twice', async () => {
    const { result } = await publishWith({ holdError: new IngestWriterError('rag_hold_document_for_review', 'P0001', 'not_holdable'), rowStatus: 'pending_review' }, { approval: required });
    expect(result.status).toBe('pending_review');
  });

  test('not_holdable on a version that is neither pending nor quarantined fails the stage', async () => {
    await expect(publishWith({ holdError: new IngestWriterError('rag_hold_document_for_review', 'P0001', 'not_holdable'), rowStatus: 'ready' }, { approval: required })).rejects.toThrow();
  });

  test('the guard outcomes of the publish function map to pending_review and to a batch hold', async () => {
    expect((await publishWith({ publishOutcome: 'pending_review' })).result.status).toBe('pending_review');
    const held = await publishWith({ publishOutcome: 'held' }, { publishHold: { batchId: 'batch-1' } });
    expect(held.result).toMatchObject({ status: 'ready', reason: 'publish_held' });
    expect(held.calls).toEqual([`setFields:${DOC}:${JSON.stringify({ metadata: { publish_hold: { batch_id: 'batch-1' } } })}`, `publish:${DOC}`]);
  });
});

describe('afterPublish', () => {
  beforeEach(() => {
    resetPostPublishHooksForTests();
  });
  afterEach(() => {
    resetPostPublishHooksForTests();
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  const flush = async () => {
    for (let i = 0; i < 10; i += 1) await new Promise((resolve) => setTimeout(resolve, 0));
  };

  async function runPublish(outcome: PublishOutcome, state: Partial<StageContext['state']> = {}) {
    const { writer } = fakeWriter({ publishOutcome: outcome });
    const ctx = ctxFor(mintScope('single', null, null), writer);
    Object.assign(ctx.state, state);
    const result = await publishStage.run(ctx);
    await flush();
    return result;
  }

  test('a registered hook runs once after published, with the document and the tenant only', async () => {
    const seen: unknown[] = [];
    registerPostPublishHook('probe', (event) => {
      seen.push(event);
    });
    await runPublish('published');
    expect(seen).toEqual([{ documentId: DOC, tenantKey: 's:default' }]);
  });

  test('no hook runs after pending_review, held or quarantined', async () => {
    const seen: unknown[] = [];
    registerPostPublishHook('probe', (event) => {
      seen.push(event);
    });
    await runPublish('pending_review');
    await runPublish('held', { publishHold: { batchId: 'b' } });
    await runPublish('quarantined');
    const { writer } = fakeWriter();
    const ctx = ctxFor(mintScope('single', null, null), writer);
    ctx.state.approval = { mode: 'all', required: true, reason: 'all_uploads', uploader_id: null, decided_at: AT };
    await publishStage.run(ctx);
    await flush();
    expect(seen).toEqual([]);
  });

  test('hooks run in registration order; a throwing hook logs one [Ingest] line with ids only and the others still run', async () => {
    const order: string[] = [];
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    registerPostPublishHook('first', () => {
      order.push('first');
    });
    registerPostPublishHook('broken', () => {
      order.push('broken');
      throw new Error('secret document text');
    });
    registerPostPublishHook('third', async () => {
      order.push('third');
    });
    await afterPublish({ documentId: DOC, tenantKey: 's:default' });
    expect(order).toEqual(['first', 'broken', 'third']);
    expect(warn).toHaveBeenCalledTimes(1);
    const line = JSON.stringify(warn.mock.calls[0]);
    expect(line).toContain('[Ingest]');
    expect(line).toContain(DOC);
    expect(line).toContain('broken');
    expect(line).not.toContain('secret document text');
  });

  test('a throwing or slow hook does not change the ingest result or delay it', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    let release: () => void = () => undefined;
    registerPostPublishHook('slow', () => new Promise<void>((resolve) => (release = resolve)), { timeoutMs: 60_000 });
    registerPostPublishHook('broken', () => {
      throw new Error('boom');
    });
    const outcome = await runPublish('published');
    expect(outcome).toMatchObject({ kind: 'done', result: { status: 'ready', documentId: DOC } });
    release();
  });

  test('a hook that exceeds its time budget is abandoned and logged as a timeout', async () => {
    vi.useFakeTimers();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    let aborted = false;
    registerPostPublishHook(
      'stuck',
      (_event, signal) =>
        new Promise<void>(() => {
          signal.addEventListener('abort', () => {
            aborted = true;
          });
        }),
      { timeoutMs: 50 },
    );
    const done = afterPublish({ documentId: DOC, tenantKey: 's:default' });
    await vi.advanceTimersByTimeAsync(60);
    await done;
    expect(aborted).toBe(true);
    expect(JSON.stringify(warn.mock.calls[0])).toContain('timeout');
  });
});
