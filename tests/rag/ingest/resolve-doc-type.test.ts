import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import type { DocTypeDetection } from '@/lib/rag-eval/contracts.generated';
import type { RpcClient, RpcRequest, RpcResponse } from '@/lib/rag/backend/supabase-rpc';
import { loadIngestConfig, resetIngestConfigForTests } from '@/lib/rag/ingest/config';
import { ingest } from '@/lib/rag/ingest';
import { getProcessingProfile, type DocType } from '@/lib/rag/ingest/profiles/load';
import { CHUNKERS } from '@/lib/rag/ingest/chunkers';
import { enrichStage } from '@/lib/rag/ingest/stages/enrich';
import { emptyIngestState, type StageContext } from '@/lib/rag/ingest/types';
import type { IngestWriter } from '@/lib/rag/ingest/writer';
import {
  DocTypeDefaultsError,
  deleteDocTypeDefault,
  getDocTypeDefaults,
  resolveDocType,
  setDocTypeDefault,
  type DocTypeChoice,
  type ResolveDocTypeDeps,
  type ResolveDocTypeInput,
} from '@/lib/rag/ingest/profiles/resolve-doc-type';
import { mintScope } from '@/lib/rag/tenant/scope';
import { callsOf, fakeIngestDb, installIngestDeps, uninstallIngestDeps, type RecordedRpc } from '../../helpers/ingest-fakes';

// Detection itself is tested in detect-doc-type.test.ts; here a canned answer shows what the resolver does with it.
const detector = vi.hoisted(() => ({ canned: null as DocTypeDetection | null }));
vi.mock('@/lib/rag/ingest/profiles/detect-doc-type', async (importActual) => {
  const actual = await importActual<typeof import('@/lib/rag/ingest/profiles/detect-doc-type')>();
  return { ...actual, detectDocType: (input: Parameters<typeof actual.detectDocType>[0]) => detector.canned ?? actual.detectDocType(input) };
});

const USER_A = '00000000-0000-4000-8000-0000000000a1';
const USER_B = '00000000-0000-4000-8000-0000000000b2';
const scopeA = mintScope('personal', USER_A, null);
const scopeB = mintScope('personal', USER_B, null);
const KEY_A = `u:${USER_A}`;
const KEY_B = `u:${USER_B}`;

interface DefaultsRow {
  tenant_key: string;
  source_kind: string;
  source_ref: string | null;
  doc_type: string;
  updated_by?: string | null;
  updated_at?: string | null;
}

interface RecordedCall {
  fn: string;
  args: Record<string, unknown>;
}

function fakeDb(answer: (call: RecordedCall) => RpcResponse): { db: RpcClient; calls: RecordedCall[] } {
  const calls: RecordedCall[] = [];
  const db: RpcClient = {
    rpc(fn, args) {
      const call = { fn, args: (args ?? {}) as Record<string, unknown> };
      calls.push(call);
      const response = answer(call);
      const request: RpcRequest = {
        abortSignal: () => request,
        then: (onFulfilled, onRejected) => Promise.resolve(response).then(onFulfilled, onRejected),
      };
      return request;
    },
  };
  return { db, calls };
}

function rowsDb(rows: DefaultsRow[]) {
  return fakeDb(() => ({ data: rows, error: null }));
}

function depsOf(db: RpcClient | null, env: Record<string, string> = {}): ResolveDocTypeDeps {
  return { db: () => db, config: loadIngestConfig(env), signal: new AbortController().signal };
}

beforeEach(() => {
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

afterEach(() => {
  detector.canned = null;
  uninstallIngestDeps();
  resetIngestConfigForTests();
  vi.restoreAllMocks();
});

const NANGO: ResolveDocTypeInput = {
  source: 'nango',
  nangoConnectionId: 'conn-1',
  nangoFolderId: 'folder-1',
  filename: 'notes.md',
  mimeType: 'text/markdown',
};

// One distinct type per precedence level, so the winner names the level that decided.
const LEVEL_TYPE = {
  picked: 'contract_legal',
  folder: 'financial_report',
  connection: 'invoice_receipt',
  source: 'product_technical',
  tenant: 'scanned_image',
} as const satisfies Record<string, DocType>;

describe('resolveDocType precedence (D-15)', () => {
  const ORDER = ['picked', 'folder', 'connection', 'source', 'tenant'] as const;
  type Level = (typeof ORDER)[number];

  const ORIGIN: Record<Level, string> = {
    picked: 'picked',
    folder: 'source_default',
    connection: 'source_default',
    source: 'source_default',
    tenant: 'tenant_default',
  };

  function rowsFor(present: Set<Level>): DefaultsRow[] {
    const rows: DefaultsRow[] = [];
    if (present.has('folder')) rows.push({ tenant_key: KEY_A, source_kind: 'nango', source_ref: 'folder-1', doc_type: LEVEL_TYPE.folder });
    if (present.has('connection')) rows.push({ tenant_key: KEY_A, source_kind: 'nango', source_ref: 'conn-1', doc_type: LEVEL_TYPE.connection });
    if (present.has('source')) rows.push({ tenant_key: KEY_A, source_kind: 'nango', source_ref: null, doc_type: LEVEL_TYPE.source });
    if (present.has('tenant')) rows.push({ tenant_key: KEY_A, source_kind: 'tenant', source_ref: null, doc_type: LEVEL_TYPE.tenant });
    return rows;
  }

  const combinations: Array<Set<Level>> = [];
  for (let mask = 0; mask < 1 << ORDER.length; mask += 1) {
    combinations.push(new Set(ORDER.filter((_, index) => (mask & (1 << index)) !== 0)));
  }

  test.each(combinations.map((present) => [[...present].join('+') || 'nothing', present] as const))(
    'with %s present the first level in the order wins',
    async (_label, present) => {
      const winner = ORDER.find((level) => present.has(level));
      const { db } = rowsDb(rowsFor(present));
      const resolved = await resolveDocType(
        scopeA,
        { ...NANGO, ...(present.has('picked') ? { picked: LEVEL_TYPE.picked } : {}) },
        depsOf(db),
      );
      if (winner === undefined) {
        expect(resolved.docType).toBe('general');
        expect(resolved.origin).toBe('fallback');
      } else {
        expect(resolved.docType).toBe(LEVEL_TYPE[winner]);
        expect(resolved.origin).toBe(ORIGIN[winner]);
      }
      expect(resolved.profile.doc_type).toBe(resolved.docType);
      expect(resolved.detection).toBeNull();
    },
  );

  test('a picked type never reads the defaults table', async () => {
    const { db, calls } = rowsDb([]);
    const resolved = await resolveDocType(scopeA, { ...NANGO, picked: 'contract_legal' }, depsOf(db));
    expect(resolved).toMatchObject({ docType: 'contract_legal', origin: 'picked' });
    expect(calls).toHaveLength(0);
  });

  test('reads the defaults of the caller tenant with the source and the Nango ids', async () => {
    const { db, calls } = rowsDb([]);
    await resolveDocType(scopeA, NANGO, depsOf(db));
    expect(calls).toEqual([
      {
        fn: 'rag_get_doc_type_defaults',
        args: { p_tenant_key: KEY_A, p_source: 'nango', p_connection_id: 'conn-1', p_folder_id: 'folder-1' },
      },
    ]);
  });

  test('rows of another tenant are dropped even if the database returned them', async () => {
    const { db } = rowsDb([{ tenant_key: KEY_B, source_kind: 'tenant', source_ref: null, doc_type: 'invoice_receipt' }]);
    const resolved = await resolveDocType(scopeA, { ...NANGO, source: 'chat_upload' }, depsOf(db));
    expect(resolved).toMatchObject({ docType: 'general', origin: 'fallback' });
  });

  test('Nango refs apply only to a Nango source; other sources use their own default and the tenant default', async () => {
    const { db } = rowsDb([
      { tenant_key: KEY_A, source_kind: 'nango', source_ref: 'folder-1', doc_type: 'financial_report' },
      { tenant_key: KEY_A, source_kind: 'nango', source_ref: null, doc_type: 'contract_legal' },
      { tenant_key: KEY_A, source_kind: 'chat_upload', source_ref: null, doc_type: 'invoice_receipt' },
      { tenant_key: KEY_A, source_kind: 'tenant', source_ref: null, doc_type: 'scanned_image' },
    ]);
    const chat = await resolveDocType(scopeA, { ...NANGO, source: 'chat_upload' }, depsOf(db));
    expect(chat).toMatchObject({ docType: 'invoice_receipt', origin: 'source_default' });
    const scraper = await resolveDocType(scopeA, { ...NANGO, source: 'scraper' }, depsOf(db));
    expect(scraper).toMatchObject({ docType: 'scanned_image', origin: 'tenant_default' });
  });

  test('an unreadable defaults table resolves to general with a warning and never throws', async () => {
    const failing = fakeDb(() => ({ data: null, error: { code: '42883', message: 'function does not exist' } }));
    const resolved = await resolveDocType(scopeA, NANGO, depsOf(failing.db));
    expect(resolved).toMatchObject({ docType: 'general', origin: 'fallback' });
    expect(resolved.warnings).toContain('doc_type_defaults_unavailable');
    const missing = await resolveDocType(scopeA, NANGO, depsOf(null));
    expect(missing.warnings).toContain('doc_type_defaults_unavailable');
  });

  test('a stored type this build does not know is ignored with a warning', async () => {
    const { db } = rowsDb([
      { tenant_key: KEY_A, source_kind: 'nango', source_ref: null, doc_type: 'memo' },
      { tenant_key: KEY_A, source_kind: 'tenant', source_ref: null, doc_type: 'contract_legal' },
    ]);
    const resolved = await resolveDocType(scopeA, NANGO, depsOf(db));
    expect(resolved).toMatchObject({ docType: 'contract_legal', origin: 'tenant_default' });
    expect(resolved.warnings).toContain('doc_type_default_invalid');
  });

  test('an invalid picked value falls back to general and says so', async () => {
    const { db, calls } = rowsDb([{ tenant_key: KEY_A, source_kind: 'tenant', source_ref: null, doc_type: 'invoice_receipt' }]);
    const resolved = await resolveDocType(scopeA, { ...NANGO, picked: 'memo' as DocTypeChoice }, depsOf(db));
    expect(resolved).toMatchObject({ docType: 'general', origin: 'fallback' });
    expect(resolved.warnings).toContain('doc_type_invalid');
    expect(calls).toHaveLength(0);
  });

  test('a scope that was not minted by the tenant module is refused before any call', async () => {
    const { db, calls } = rowsDb([]);
    const forged = { kind: 'single', userId: null, organizationId: null } as unknown as ReturnType<typeof mintScope>;
    await expect(resolveDocType(forged, NANGO, depsOf(db))).rejects.toThrow(/unminted/);
    expect(calls).toHaveLength(0);
  });
});

describe('resolveDocType with auto (D-16)', () => {
  const INVOICE_FILE: ResolveDocTypeInput = { source: 'config_upload', filename: 'fattura_2025_0042.pdf', mimeType: 'application/pdf' };
  const INVOICE: DocTypeDetection = { doc_type: 'invoice_receipt', confidence: 0.8, signals: ['filename:keyword:fattura'], method: 'rules' };
  const NOTHING: DocTypeDetection = { doc_type: 'general', confidence: 0.2, signals: [], method: 'rules' };

  beforeEach(() => {
    detector.canned = INVOICE;
  });

  test('a picked auto runs the detector and records the origin auto', async () => {
    const { db } = rowsDb([]);
    const resolved = await resolveDocType(scopeA, { ...INVOICE_FILE, picked: 'auto' }, depsOf(db));
    expect(resolved).toMatchObject({ docType: 'invoice_receipt', origin: 'auto' });
    expect(resolved.detection).toEqual(INVOICE);
  });

  test('a default of auto from the source level runs the detector', async () => {
    const { db } = rowsDb([{ tenant_key: KEY_A, source_kind: 'config_upload', source_ref: null, doc_type: 'auto' }]);
    const resolved = await resolveDocType(scopeA, INVOICE_FILE, depsOf(db));
    expect(resolved).toMatchObject({ docType: 'invoice_receipt', origin: 'auto' });
  });

  test('a tenant default of auto with nothing recognisable resolves to general with the origin auto', async () => {
    detector.canned = NOTHING;
    const { db } = rowsDb([{ tenant_key: KEY_A, source_kind: 'tenant', source_ref: null, doc_type: 'auto' }]);
    const resolved = await resolveDocType(scopeA, { source: 'chat_upload', filename: 'notes.txt', mimeType: 'text/plain' }, depsOf(db));
    expect(resolved).toMatchObject({ docType: 'general', origin: 'auto' });
    expect(resolved.detection?.confidence).toBeLessThan(0.6);
  });

  test('a more specific default beats an auto tenant default', async () => {
    const { db } = rowsDb([
      { tenant_key: KEY_A, source_kind: 'config_upload', source_ref: null, doc_type: 'financial_report' },
      { tenant_key: KEY_A, source_kind: 'tenant', source_ref: null, doc_type: 'auto' },
    ]);
    const resolved = await resolveDocType(scopeA, INVOICE_FILE, depsOf(db));
    expect(resolved).toMatchObject({ docType: 'financial_report', origin: 'source_default', detection: null });
  });
});

describe('defaults table access (admin only by grant; callers gate with the admin guard)', () => {
  test('getDocTypeDefaults lists the rows of the caller tenant only and maps the columns', async () => {
    const { db, calls } = rowsDb([
      { tenant_key: KEY_A, source_kind: 'tenant', source_ref: null, doc_type: 'auto', updated_by: 'admin-1', updated_at: '2026-11-24T10:00:00Z' },
      { tenant_key: KEY_B, source_kind: 'tenant', source_ref: null, doc_type: 'invoice_receipt' },
    ]);
    const rows = await getDocTypeDefaults(scopeA, undefined, depsOf(db));
    expect(calls[0]).toEqual({
      fn: 'rag_get_doc_type_defaults',
      args: { p_tenant_key: KEY_A, p_source: null, p_connection_id: null, p_folder_id: null },
    });
    expect(rows).toEqual([{ sourceKind: 'tenant', sourceRef: null, docType: 'auto', updatedBy: 'admin-1', updatedAt: '2026-11-24T10:00:00Z' }]);
  });

  test('setDocTypeDefault sends the tenant key of the scope and the actor, never a tenant of the caller input', async () => {
    const { db, calls } = fakeDb((call) => ({
      data: [{ tenant_key: call.args.p_tenant_key, source_kind: 'nango', source_ref: 'folder-9', doc_type: 'contract_legal', updated_by: 'admin-1', updated_at: 'now' }],
      error: null,
    }));
    const row = await setDocTypeDefault(
      scopeB,
      { sourceKind: 'nango', sourceRef: 'folder-9', docType: 'contract_legal', updatedBy: 'admin-1' },
      depsOf(db),
    );
    expect(calls).toEqual([
      {
        fn: 'rag_set_doc_type_default',
        args: { p_tenant_key: KEY_B, p_source_kind: 'nango', p_source_ref: 'folder-9', p_doc_type: 'contract_legal', p_updated_by: 'admin-1' },
      },
    ]);
    expect(row).toMatchObject({ sourceKind: 'nango', sourceRef: 'folder-9', docType: 'contract_legal', updatedBy: 'admin-1' });
  });

  test.each([
    ['an unknown type', { sourceKind: 'tenant', docType: 'memo', updatedBy: 'admin-1' }],
    ['an unknown source kind', { sourceKind: 'email', docType: 'general', updatedBy: 'admin-1' }],
    ['a blank actor', { sourceKind: 'tenant', docType: 'general', updatedBy: '  ' }],
    ['a ref on a kind that takes none', { sourceKind: 'chat_upload', sourceRef: 'x', docType: 'general', updatedBy: 'admin-1' }],
  ])('setDocTypeDefault rejects %s before any call', async (_label, input) => {
    const { db, calls } = rowsDb([]);
    await expect(setDocTypeDefault(scopeA, input as Parameters<typeof setDocTypeDefault>[1], depsOf(db))).rejects.toBeInstanceOf(DocTypeDefaultsError);
    expect(calls).toHaveLength(0);
  });

  test('a database refusal surfaces as DocTypeDefaultsError with the reason word only', async () => {
    const { db } = fakeDb(() => ({ data: null, error: { code: 'P0001', message: 'invalid_doc_type: secret-looking-value' } }));
    const failure = await setDocTypeDefault(scopeA, { sourceKind: 'tenant', docType: 'general', updatedBy: 'admin-1' }, depsOf(db)).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(DocTypeDefaultsError);
    expect((failure as DocTypeDefaultsError).reason).toBe('invalid_doc_type');
    expect((failure as Error).message).not.toContain('secret-looking-value');
  });

  test('deleteDocTypeDefault passes the tenant key and reports whether a row was removed', async () => {
    const { db, calls } = fakeDb(() => ({ data: [{ deleted: true }], error: null }));
    await expect(deleteDocTypeDefault(scopeA, { sourceKind: 'nango', sourceRef: 'conn-1' }, depsOf(db))).resolves.toBe(true);
    expect(calls[0]).toEqual({
      fn: 'rag_delete_doc_type_default',
      args: { p_tenant_key: KEY_A, p_source_kind: 'nango', p_source_ref: 'conn-1' },
    });
  });
});

describe('identify resolves the type and the profile', () => {
  const single = mintScope('single', null, null);
  const INVOICE_TEXT = 'Fattura n. FT-2025/0042\nPartita IVA IT99999999990\nTotale documento 122,00\n';
  const NOTES_TEXT = '# Notes\n\nWe met on Tuesday and talked about the garden and the plans for the summer.\n';

  interface IngestFixtureOptions {
    defaults?: DefaultsRow[];
    defaultsFailure?: { code: string; message: string };
    env?: Record<string, string>;
  }

  function ingestFixture(options: IngestFixtureOptions = {}) {
    const base = fakeIngestDb();
    const db: RpcClient = {
      rpc(fn, args) {
        if (fn !== 'rag_get_doc_type_defaults') return base.db.rpc(fn, args);
        base.calls.push({ fn, args: (args ?? {}) as Record<string, unknown> });
        const response: RpcResponse = options.defaultsFailure
          ? { data: null, error: options.defaultsFailure }
          : { data: options.defaults ?? [], error: null };
        const request: RpcRequest = {
          abortSignal: () => request,
          then: (onFulfilled, onRejected) => Promise.resolve(response).then(onFulfilled, onRejected),
        };
        return request;
      },
    };
    installIngestDeps({ db, env: options.env ?? {} });
    return base.calls;
  }

  const upload = (overrides: Partial<Parameters<typeof ingest>[0]> = {}) =>
    ingest({
      scope: single,
      source: 'config_upload',
      sourceKey: 'root/notes.md',
      text: NOTES_TEXT,
      filename: 'notes.md',
      mimeType: 'text/markdown',
      signal: new AbortController().signal,
      ...overrides,
    } as Parameters<typeof ingest>[0]);

  const beginArgs = (calls: RecordedRpc[]) => callsOf(calls, 'rag_begin_document_version')[0]?.args;

  test('a picked type uses its profile, stores origin picked and reads no defaults', async () => {
    const calls = ingestFixture({ defaults: [{ tenant_key: 's:default', source_kind: 'tenant', source_ref: null, doc_type: 'financial_report' }] });
    const result = await upload({ docType: 'contract_legal' });
    expect(result.status).toBe('ready');
    expect(beginArgs(calls)).toMatchObject({
      p_doc_type: 'contract_legal',
      p_doc_type_origin: 'picked',
      p_profile_id: getProcessingProfile('contract_legal').id,
      p_profile_version: getProcessingProfile('contract_legal').version,
    });
    expect(callsOf(calls, 'rag_get_doc_type_defaults')).toHaveLength(0);
  });

  test('auto with an invoice filename stores the detected type, origin auto and metadata.doc_type_detection', async () => {
    const calls = ingestFixture();
    // 03-19 leaves the invoice chunker unregistered until 03-29; stand in so the run reaches enrich.
    CHUNKERS.invoice = CHUNKERS.markdown_sections;
    let result: Awaited<ReturnType<typeof upload>>;
    try {
      result = await upload({ docType: 'auto', filename: 'fattura_2025_0042.pdf', sourceKey: 'root/fattura_2025_0042.pdf', mimeType: 'application/pdf', text: INVOICE_TEXT });
    } finally {
      delete CHUNKERS.invoice;
    }
    expect(result.status).toBe('ready');
    expect(beginArgs(calls)).toMatchObject({
      p_doc_type: 'invoice_receipt',
      p_doc_type_origin: 'auto',
      p_profile_id: getProcessingProfile('invoice_receipt').id,
    });
    const stored = callsOf(calls, 'rag_set_document_fields')
      .map((call) => call.args.p_fields as Record<string, unknown>)
      .find((fields) => (fields.metadata as Record<string, unknown> | undefined)?.doc_type_detection !== undefined);
    expect(stored).toMatchObject({ doc_type: 'invoice_receipt', doc_type_origin: 'auto' });
    const detection = (stored?.metadata as { doc_type_detection: DocTypeDetection }).doc_type_detection;
    expect(detection).toMatchObject({ doc_type: 'invoice_receipt', method: 'rules' });
    expect(detection.confidence).toBeGreaterThanOrEqual(0.6);
    expect(detection.signals).toContain('filename:keyword:fattura');
    expect(JSON.stringify(detection)).not.toContain('FT-2025');
  });

  test('no picked type and a tenant default of financial_report stores origin tenant_default', async () => {
    const calls = ingestFixture({ defaults: [{ tenant_key: 's:default', source_kind: 'tenant', source_ref: null, doc_type: 'financial_report' }] });
    const result = await upload();
    expect(result.status).toBe('ready');
    expect(beginArgs(calls)).toMatchObject({ p_doc_type: 'financial_report', p_doc_type_origin: 'tenant_default' });
    expect(callsOf(calls, 'rag_get_doc_type_defaults')[0]?.args).toEqual({
      p_tenant_key: 's:default',
      p_source: 'config_upload',
      p_connection_id: null,
      p_folder_id: null,
    });
    const detectionWrites = callsOf(calls, 'rag_set_document_fields').filter((call) => JSON.stringify(call.args).includes('doc_type_detection'));
    expect(detectionWrites).toHaveLength(0);
  });

  test('a Nango upload passes its connection and folder ids and takes the folder default', async () => {
    const calls = ingestFixture({
      defaults: [
        { tenant_key: 's:default', source_kind: 'nango', source_ref: 'folder-7', doc_type: 'contract_legal' },
        { tenant_key: 's:default', source_kind: 'tenant', source_ref: null, doc_type: 'financial_report' },
      ],
    });
    const result = await upload({ source: 'nango', sourceKey: 'file-1', options: { nangoConnectionId: 'conn-3', nangoFolderId: 'folder-7' } });
    expect(result.status).toBe('ready');
    expect(callsOf(calls, 'rag_get_doc_type_defaults')[0]?.args).toEqual({
      p_tenant_key: 's:default',
      p_source: 'nango',
      p_connection_id: 'conn-3',
      p_folder_id: 'folder-7',
    });
    expect(beginArgs(calls)).toMatchObject({ p_doc_type: 'contract_legal', p_doc_type_origin: 'source_default' });
  });

  test('a default of auto runs detection with the switches from the ingest env', async () => {
    const calls = ingestFixture({ defaults: [{ tenant_key: 's:default', source_kind: 'tenant', source_ref: null, doc_type: 'auto' }], env: { RAG_DOC_TYPE_LLM_DETECT: 'false' } });
    const result = await upload();
    expect(result.status).toBe('ready');
    expect(beginArgs(calls)).toMatchObject({ p_doc_type: 'general', p_doc_type_origin: 'auto' });
  });

  test('a defaults table that cannot be read leaves the type general and says so in the warnings', async () => {
    const calls = ingestFixture({ defaultsFailure: { code: '42883', message: 'function rag_get_doc_type_defaults does not exist' } });
    const result = await upload();
    expect(result.status).toBe('ready');
    expect(result.warnings).toContain('doc_type_defaults_unavailable');
    expect(beginArgs(calls)).toMatchObject({ p_doc_type: 'general', p_doc_type_origin: 'fallback' });
  });

  test('the identify span records the doc type and its origin', async () => {
    ingestFixture({ defaults: [{ tenant_key: 's:default', source_kind: 'tenant', source_ref: null, doc_type: 'financial_report' }] });
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    await upload();
    const line = log.mock.calls.map((call) => call.map(String).join(' ')).find((entry) => entry.includes('[Ingest Trace]'));
    expect(line).toBeDefined();
    const payload = JSON.parse((line as string).slice((line as string).indexOf('{'))) as { stages: Array<Record<string, unknown>> };
    expect(payload.stages.find((stage) => stage.name === 'identify')).toMatchObject({ doc_type: 'financial_report', doc_type_origin: 'tenant_default' });
  });

  test('enrich writes the final type, origin, profile and detection of an auto-detected document once', async () => {
    const setFields = vi.fn(async () => undefined);
    const detection: DocTypeDetection = { doc_type: 'invoice_receipt', confidence: 0.75, signals: ['text:invoice_number'], method: 'rules' };
    const state = emptyIngestState();
    state.docTypeDetection = { signals: detection.signals, refined: 'invoice_receipt', reparsed: true, detection };
    const profile = getProcessingProfile('invoice_receipt');
    const ctx = {
      document: { id: 'doc-1', version: 1, resumed: false },
      identity: { tenantKey: 's:default', filename: 'a.pdf', fileSha256: 'x', docType: 'invoice_receipt', docTypeOrigin: 'auto', profile, bytes: null },
      state,
      work: { parseText: 'Invoice 1', parserVersion: null, chunks: [], chunksWritten: 0 },
      writer: { setFields } as unknown as IngestWriter,
    } as unknown as StageContext;
    await enrichStage.run(ctx);
    expect(setFields).toHaveBeenCalledWith('doc-1', {
      doc_type: 'invoice_receipt',
      doc_type_origin: 'auto',
      processing_profile_id: profile.id,
      processing_profile_version: profile.version,
      metadata: { doc_type_detection: detection },
    });
  });
});
