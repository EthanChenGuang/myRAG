import { describe, expect, test } from 'vitest';
import { UploadApprovalSchema } from '@/lib/rag-eval/contracts.generated';
import { decideUploadApproval, normalizeUploaderId, type UploadApprovalInput } from '@/lib/rag/ingest/approval/decide';

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
