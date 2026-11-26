import { afterEach, describe, expect, test, vi } from 'vitest';
import {
  UploadApprovalRequiresUnifiedError,
  approvalRequiresUnified,
  assertLegacyWriteAllowed,
  legacyWriteRefused,
} from '@/lib/rag/ingest/approval/legacy-refusal';

// Plan 05.2-17 (T-05.2-171, D-46 with Phase 3.2 D-56): the legacy writers cannot hold a document, so with RAG_UPLOADER_HOLD on they
// refuse the way Phase 3.2 refuses with upload approval on; with the hold off nothing changes.

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe('legacy knowledge-base writes and the uploader hold', () => {
  test.each(['manual', 'auto'])('hold %s with approval off: the legacy writers refuse', (mode) => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    vi.stubEnv('RAG_UPLOAD_APPROVAL', 'off');
    vi.stubEnv('RAG_UPLOADER_HOLD', mode);
    expect(legacyWriteRefused()).toBe(true);
    expect(() => assertLegacyWriteAllowed()).toThrow(UploadApprovalRequiresUnifiedError);
    expect(approvalRequiresUnified({ pipeline: 'legacy', uploadApproval: 'off' })).toBe(true);
    expect(approvalRequiresUnified({ pipeline: 'unified', uploadApproval: 'off' })).toBe(false);
  });

  test('hold off and approval off: the legacy writers run as before', () => {
    vi.stubEnv('RAG_UPLOAD_APPROVAL', 'off');
    vi.stubEnv('RAG_UPLOADER_HOLD', 'off');
    expect(legacyWriteRefused()).toBe(false);
    expect(() => assertLegacyWriteAllowed()).not.toThrow();
    expect(approvalRequiresUnified({ pipeline: 'legacy', uploadApproval: 'off' })).toBe(false);
  });

  test('an invalid hold value is off and refuses nothing', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    vi.stubEnv('RAG_UPLOAD_APPROVAL', 'off');
    vi.stubEnv('RAG_UPLOADER_HOLD', 'sometimes');
    expect(legacyWriteRefused()).toBe(false);
  });
});
