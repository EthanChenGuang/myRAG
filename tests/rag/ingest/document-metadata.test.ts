import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ingest } from '@/lib/rag/ingest';
import { mintScope } from '@/lib/rag/tenant/scope';
import { callsOf, fakeIngestDb, installIngestDeps, uninstallIngestDeps, type RecordedRpc } from '../../helpers/ingest-fakes';

const USER_A = '00000000-0000-4000-8000-0000000000a1';
const TEXT = 'First placeholder paragraph.\n\nSecond placeholder paragraph.';

function run(options: Record<string, unknown> | undefined) {
  const { db, calls } = fakeIngestDb();
  installIngestDeps({ db, env: { RAG_INGEST_PIPELINE: 'unified' } });
  const result = ingest({
    scope: mintScope('personal', USER_A, null),
    source: 'ai_to_rag',
    sourceKey: 'chat:chat-1/message:message-1',
    text: TEXT,
    filename: 'Placeholder Title.md',
    mimeType: 'text/markdown',
    ...(options ? { options } : {}),
    signal: new AbortController().signal,
  });
  return { result, calls };
}

const metadataWrites = (calls: RecordedRpc[]) =>
  callsOf(calls, 'rag_set_document_fields')
    .map((call) => (call.args.p_fields as { metadata?: Record<string, unknown> }).metadata)
    .filter((metadata): metadata is Record<string, unknown> => metadata !== undefined);

describe('ingest options.documentMetadata', () => {
  beforeEach(() => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    uninstallIngestDeps();
    vi.restoreAllMocks();
  });

  it('is written to the document right after the version is begun, before any stage that writes system metadata', async () => {
    const { result, calls } = run({ documentMetadata: { source: 'ai_response', messageId: 'message-1', generatedAt: '2026-01-01T00:00:00.000Z' } });
    expect((await result).status).toBe('ready');
    const order = calls.map((call) => call.fn);
    const writes = callsOf(calls, 'rag_set_document_fields');
    const first = writes.find((call) => 'messageId' in ((call.args.p_fields as { metadata?: object }).metadata ?? {}));
    expect(first).toBeDefined();
    expect(first?.args.p_fields).toEqual({ metadata: { source: 'ai_response', messageId: 'message-1', generatedAt: '2026-01-01T00:00:00.000Z' } });
    expect(order.indexOf('rag_set_document_fields')).toBeGreaterThan(order.indexOf('rag_begin_document_version'));
    expect(calls.indexOf(first as RecordedRpc)).toBeLessThan(calls.findIndex((call) => call.fn === 'rag_write_chunks'));
  });

  it('writes nothing extra when the option is absent', async () => {
    const { result, calls } = run(undefined);
    await result;
    expect(metadataWrites(calls).some((metadata) => 'messageId' in metadata)).toBe(false);
    expect(callsOf(calls, 'rag_set_document_fields').every((call) => Object.keys(call.args.p_fields as object).length > 0)).toBe(true);
  });

  it('drops the keys the pipeline owns, values that are not plain, and keys with unsafe names', async () => {
    const { result, calls } = run({
      documentMetadata: {
        messageId: 'message-1',
        quarantine: { rule_ids: [] },
        duplicate_of: 'other',
        content_hash_version: 99,
        doc_type_detection: { doc_type: 'invoice_receipt' },
        external_url: 'https://example.invalid/',
        nested: { a: 1 },
        list: ['a'],
        nothing: null,
        'bad key': 'x',
        __proto__: 'x',
        ok_number: 3,
        ok_flag: false,
        long: 'x'.repeat(2000),
      },
    });
    await result;
    const written = metadataWrites(calls).find((metadata) => 'messageId' in metadata);
    expect(written).toBeDefined();
    expect(Object.keys(written ?? {}).sort()).toEqual(['long', 'messageId', 'ok_flag', 'ok_number']);
    expect((written?.long as string).length).toBeLessThanOrEqual(500);
  });

  it('ignores a documentMetadata option that is not an object', async () => {
    const baseline = run(undefined);
    await baseline.result;
    const expected = callsOf(baseline.calls, 'rag_set_document_fields').map((call) => call.args.p_fields);
    uninstallIngestDeps();
    for (const bad of ['text', 5, null, ['a']]) {
      const { result, calls } = run({ documentMetadata: bad });
      await result;
      expect(callsOf(calls, 'rag_set_document_fields').map((call) => call.args.p_fields)).toEqual(expected);
      uninstallIngestDeps();
    }
  });
});
