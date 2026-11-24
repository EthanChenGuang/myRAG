import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import type { DocTypeDetection } from '@/lib/rag-eval/contracts.generated';
import type { RpcClient, RpcRequest, RpcResponse } from '@/lib/rag/backend/supabase-rpc';
import { loadIngestConfig, resetIngestConfigForTests } from '@/lib/rag/ingest/config';
import type { DocType } from '@/lib/rag/ingest/profiles/load';
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
