import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { IngestInput, IngestResult, TenantScope } from '@/lib/rag';

const OWNER_A = '00000000-0000-4000-8000-0000000000a1';
const FILE_ID = 'drive-file-1';
const CONNECTION = 'conn-a';
const FOLDER = 'folder-1';

const state = {
  pipeline: 'legacy' as 'legacy' | 'unified',
  mode: 'multi-tenant' as 'single-tenant' | 'multi-tenant',
  configThrows: false,
  ingestResults: [] as IngestResult[],
  scopeKey: (_scope: TenantScope): string => '',
};

const processDocument = vi.fn();
const ingest = vi.fn();

function result(partial: Partial<IngestResult> & Pick<IngestResult, 'status'>): IngestResult {
  return { documentId: null, version: null, parserUsed: 'text', chunkCount: 0, warnings: [], ...partial };
}

async function loadAdapter() {
  vi.resetModules();
  const identity = await vi.importActual<typeof import('@/lib/rag/ingest/identity')>('@/lib/rag/ingest/identity');
  const ingestScope = await vi.importActual<typeof import('@/lib/rag/tenant/ingest-scope')>('@/lib/rag/tenant/ingest-scope');
  vi.doMock('@/lib/document-processor', () => ({ processDocument }));
  vi.doMock('@/lib/rag', () => ({
    ingest,
    buildSourceKey: identity.buildSourceKey,
    nangoOwnerScope: (input: { ownerUserId: string | null | undefined }) =>
      ingestScope.nangoOwnerScope({ ownerUserId: input.ownerUserId, deploymentMode: state.mode }),
    currentIngestConfig: () => {
      if (state.configThrows) throw new Error('config unavailable');
      return { pipeline: state.pipeline };
    },
  }));
  const scope = await vi.importActual<typeof import('@/lib/rag/tenant/scope')>('@/lib/rag/tenant/scope');
  state.scopeKey = scope.scopeKey;
  return import('@/lib/nango/document-adapter');
}

beforeEach(() => {
  state.pipeline = 'legacy';
  state.mode = 'multi-tenant';
  state.configThrows = false;
  state.ingestResults = [];
  processDocument.mockReset();
  ingest.mockReset();
  ingest.mockImplementation(async () => state.ingestResults.shift() ?? result({ status: 'ready', documentId: 'doc-default', version: 1 }));
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.resetModules();
  vi.doUnmock('@/lib/document-processor');
  vi.doUnmock('@/lib/rag');
});

function ingestInput(call = 0): IngestInput {
  return ingest.mock.calls[call][0] as IngestInput;
}

const baseOptions = {
  userId: OWNER_A,
  source: 'nango' as const,
  sourceProvider: 'google-drive',
  sourceFileId: FILE_ID,
  sourceConnectionId: CONNECTION,
  nangoConnectionId: CONNECTION,
  nangoFolderId: FOLDER,
  mimeType: 'application/pdf',
};

describe('nango document adapter, legacy pipeline', () => {
  it('sends today\'s metadata to processDocument and never calls ingest', async () => {
    processDocument.mockResolvedValue('doc-legacy');
    const { processDocumentWithMetadata } = await loadAdapter();
    const buffer = Buffer.from('legacy bytes');

    const id = await processDocumentWithMetadata('Report.pdf', buffer, baseOptions);

    expect(id).toBe('doc-legacy');
    expect(processDocument).toHaveBeenCalledTimes(1);
    const [filename, passed, metadata] = processDocument.mock.calls[0];
    expect(filename).toBe('Report.pdf');
    expect(passed).toBe(buffer);
    expect(metadata).toEqual({
      user_id: OWNER_A,
      source: 'nango',
      source_provider: 'google-drive',
      source_file_id: FILE_ID,
      source_connection_id: CONNECTION,
    });
    expect(ingest).not.toHaveBeenCalled();
  });

  it('stays legacy when the ingest configuration cannot be read', async () => {
    state.pipeline = 'unified';
    state.configThrows = true;
    processDocument.mockResolvedValue('doc-legacy');
    const { processDocumentWithMetadata, nangoPipeline } = await loadAdapter();

    expect(nangoPipeline()).toBe('legacy');
    await processDocumentWithMetadata('Report.pdf', Buffer.from('x'), baseOptions);
    expect(processDocument).toHaveBeenCalledTimes(1);
    expect(ingest).not.toHaveBeenCalled();
  });
});

describe('nango document adapter, unified pipeline', () => {
  beforeEach(() => {
    state.pipeline = 'unified';
  });

  it('multi-tenant: ingests in the owner personal scope with the provider file id as identity and returns the version id', async () => {
    state.ingestResults = [result({ status: 'ready', documentId: 'doc-v1', version: 1 })];
    const { processDocumentWithMetadata } = await loadAdapter();
    const buffer = Buffer.from('%PDF-1.4 body');

    const id = await processDocumentWithMetadata('Report.pdf', buffer, baseOptions);

    expect(id).toBe('doc-v1');
    expect(processDocument).not.toHaveBeenCalled();
    expect(ingest).toHaveBeenCalledTimes(1);
    const input = ingestInput();
    expect(state.scopeKey(input.scope)).toBe(`u:${OWNER_A}`);
    expect(input).toMatchObject({
      source: 'nango',
      sourceKey: FILE_ID,
      filename: 'Report.pdf',
      mimeType: 'application/pdf',
      options: {
        origin: { sourceProvider: 'google-drive', sourceFileId: FILE_ID, sourceConnectionId: CONNECTION },
        nangoConnectionId: CONNECTION,
        nangoFolderId: FOLDER,
      },
    });
    expect(input.file).toBe(buffer);
    expect(input.signal).toBeInstanceOf(AbortSignal);
  });

  it('single-tenant: ingests in the s:default scope', async () => {
    state.mode = 'single-tenant';
    const { processDocumentWithMetadata } = await loadAdapter();

    await processDocumentWithMetadata('Report.pdf', Buffer.from('x'), { ...baseOptions, userId: 'single-tenant-user' });

    expect(state.scopeKey(ingestInput().scope)).toBe('s:default');
  });

  it('refuses an owner that is not a UUID in multi-tenant mode: typed error, ingest never called', async () => {
    const { processDocumentWithMetadata, NangoIngestError } = await loadAdapter();

    for (const owner of ['single-tenant-user', '', 'null', 'a1']) {
      const failure = await processDocumentWithMetadata('Report.pdf', Buffer.from('x'), { ...baseOptions, userId: owner }).catch((error) => error);
      expect(failure).toBeInstanceOf(NangoIngestError);
      expect(failure.reason).toBe('invalid_owner');
      expect(failure.status).toBe(503);
    }
    expect(ingest).not.toHaveBeenCalled();
    expect(processDocument).not.toHaveBeenCalled();
  });

  it('refuses a file without a provider file id', async () => {
    const { processDocumentWithMetadata, NangoIngestError } = await loadAdapter();

    const failure = await processDocumentWithMetadata('Report.pdf', Buffer.from('x'), { ...baseOptions, sourceFileId: undefined }).catch((error) => error);

    expect(failure).toBeInstanceOf(NangoIngestError);
    expect(failure.reason).toBe('missing_file_id');
    expect(ingest).not.toHaveBeenCalled();
  });

  it('returns the existing current document id when the file is an unchanged duplicate', async () => {
    state.ingestResults = [result({ status: 'skipped_duplicate', duplicateOf: 'doc-current' })];
    const { processDocumentWithMetadata } = await loadAdapter();

    expect(await processDocumentWithMetadata('Report.pdf', Buffer.from('x'), baseOptions)).toBe('doc-current');
  });

  it('throws a typed error for a failed ingest and for one that is still processing', async () => {
    state.ingestResults = [
      result({ status: 'failed', documentId: 'doc-x', reason: 'parse_failed' }),
      result({ status: 'processing', documentId: 'doc-y', reason: 'deadline' }),
    ];
    const { processDocumentWithMetadata, NangoIngestError } = await loadAdapter();

    const failed = await processDocumentWithMetadata('A.pdf', Buffer.from('x'), baseOptions).catch((error) => error);
    const pending = await processDocumentWithMetadata('B.pdf', Buffer.from('y'), baseOptions).catch((error) => error);

    expect(failed).toBeInstanceOf(NangoIngestError);
    expect(failed.reason).toBe('parse_failed');
    expect(pending).toBeInstanceOf(NangoIngestError);
    expect(pending.reason).toBe('deadline');
  });

  it('records a quarantined file under its document id without throwing', async () => {
    state.ingestResults = [result({ status: 'quarantined', documentId: 'doc-q', version: 1 })];
    const { processDocumentWithMetadata } = await loadAdapter();

    expect(await processDocumentWithMetadata('Report.pdf', Buffer.from('x'), baseOptions)).toBe('doc-q');
  });

  it('names exported Google documents and extensionless text pages after the bytes that are stored', async () => {
    const { processDocumentWithMetadata } = await loadAdapter();

    await processDocumentWithMetadata('Quarterly plan', Buffer.from('%PDF-1.4'), { ...baseOptions, mimeType: 'application/vnd.google-apps.document' });
    await processDocumentWithMetadata('Plan v1.2', Buffer.from('notes'), { ...baseOptions, sourceProvider: 'notion', mimeType: 'text/plain' });
    await processDocumentWithMetadata('Notes.txt', Buffer.from('notes'), { ...baseOptions, mimeType: undefined });

    expect(ingestInput(0)).toMatchObject({ filename: 'Quarterly plan.pdf', mimeType: 'application/pdf' });
    expect(ingestInput(1)).toMatchObject({ filename: 'Plan v1.2.txt', mimeType: 'text/plain' });
    expect(ingestInput(2)).toMatchObject({ filename: 'Notes.txt', mimeType: 'text/plain' });
  });
});
