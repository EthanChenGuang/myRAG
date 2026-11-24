import type { RpcClient, RpcRequest, RpcResponse } from '@/lib/rag/backend/supabase-rpc';
import type { IngestEnvInput } from '@/lib/rag/ingest/config';
import { resetIngestConfigForTests } from '@/lib/rag/ingest/config';
import { resetIngestDepsForTests, setIngestDepsForTests } from '@/lib/rag/ingest/deps';

type Row = Record<string, unknown>;

export const FAKE_DOCUMENT_ID = '11111111-1111-4111-8111-111111111111';
export const FAKE_LINEAGE_ID = '22222222-2222-4222-8222-222222222222';

export interface RecordedRpc {
  fn: string;
  args: Record<string, unknown>;
}

export interface FakeIngestDocumentRow {
  status: string;
  version: number;
  processing_status: string | null;
  processing_state: Record<string, unknown>;
  filename: string;
  doc_type: string;
  parser_used: string | null;
  created_at: string;
}

export interface FakeIngestDbOptions {
  /** Row answered by rag_get_ingest_document; null answers no row, as another tenant's id does. */
  document?: FakeIngestDocumentRow | null;
  documentId?: string;
  failures?: Record<string, { code: string; message: string }>;
  /** Runs after a call is recorded and before it is answered. */
  onCall?: (call: RecordedRpc) => void;
}

function answer(fn: string, args: Record<string, unknown>, options: FakeIngestDbOptions, quarantined: boolean): Row[] {
  const documentId = options.documentId ?? FAKE_DOCUMENT_ID;
  switch (fn) {
    case 'rag_begin_document_version':
      return [{ outcome: 'created', document_id: documentId, version: 1, lineage_id: FAKE_LINEAGE_ID, duplicate_of: null }];
    case 'rag_find_content_duplicate':
      return [];
    case 'rag_set_document_fields':
      return [{ document_id: args.p_document_id, status: 'processing' }];
    case 'rag_save_ingest_state':
      return [{ document_id: args.p_document_id, processing_status: args.p_processing_status }];
    case 'rag_get_ingest_document':
      return options.document ? [options.document as unknown as Row] : [];
    case 'rag_write_chunks':
      return [{ chunks_written: (args.p_chunks as unknown[]).length, chunks_deleted: 0 }];
    case 'rag_publish_document_version':
      return [{ outcome: quarantined ? 'quarantined' : 'published', document_id: args.p_document_id, version: 1, superseded_document_id: null }];
    case 'rag_mark_document_failed':
      return [{ document_id: args.p_document_id, status: 'failed' }];
    default:
      return [];
  }
}

/** A recording RpcClient that answers the ingest writer functions without a database. */
export function fakeIngestDb(options: FakeIngestDbOptions = {}): { db: RpcClient; calls: RecordedRpc[] } {
  const calls: RecordedRpc[] = [];
  let quarantined = false;
  const db: RpcClient = {
    rpc(fn, args) {
      const call: RecordedRpc = { fn, args: (args ?? {}) as Record<string, unknown> };
      calls.push(call);
      if (fn === 'rag_set_document_fields' && (call.args.p_fields as Record<string, unknown> | undefined)?.status === 'quarantined') quarantined = true;
      options.onCall?.(call);
      const failure = options.failures?.[fn];
      const response: RpcResponse = failure ? { data: null, error: failure } : { data: answer(fn, call.args, options, quarantined), error: null };
      const request: RpcRequest = {
        abortSignal: () => request,
        then: (onFulfilled, onRejected) => Promise.resolve(response).then(onFulfilled, onRejected),
      };
      return request;
    },
  };
  return { db, calls };
}

export interface InstallIngestDepsInput {
  db: RpcClient;
  env?: IngestEnvInput;
  now?: () => number;
  embedDocuments?: (texts: string[], opts: { signal: AbortSignal }) => Promise<number[][]>;
}

export const unitVector = (): number[] => Array.from({ length: 1536 }, (_, index) => (index === 0 ? 1 : 0));

export function installIngestDeps(input: InstallIngestDepsInput): void {
  resetIngestConfigForTests();
  setIngestDepsForTests({
    db: () => input.db,
    embedDocuments: input.embedDocuments ?? (async (texts) => texts.map(() => unitVector())),
    ingestEnv: () => input.env ?? {},
    ...(input.now ? { now: input.now } : {}),
  });
}

export function uninstallIngestDeps(): void {
  resetIngestDepsForTests();
  resetIngestConfigForTests();
}

export function callsOf(calls: RecordedRpc[], fn: string): RecordedRpc[] {
  return calls.filter((call) => call.fn === fn);
}

/** The lastCompleted values written by rag_save_ingest_state, in call order. */
export function savedStages(calls: RecordedRpc[]): Array<string | null> {
  return callsOf(calls, 'rag_save_ingest_state').map((call) => {
    const state = call.args.p_state as Record<string, unknown> | undefined;
    return (state?.lastCompleted as string | null | undefined) ?? null;
  });
}
