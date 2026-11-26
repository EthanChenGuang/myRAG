import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RecordedRpc } from '../../helpers/ingest-fakes';

/**
 * TPL-04 (D-12, D-24): `rag:attributes --tenant <key> --import <file>`. Argument parsing, the JSON Lines reader, all-or-nothing validation,
 * the dry-run report and the batched apply pass, against a fake RPC client. MARKER is a value that must never reach output or a log.
 */

const MARKER = 'marker-value-q7z';
const ORG = '00000000-0000-4000-8000-0000000013c1';
const TENANT = `o:${ORG}`;
const DEFINITIONS = [
  { key: 'alpha_code', type: 'code', filterable: false, in_header: false, in_identifier_index: false, soft: false },
  { key: 'beta_list', type: 'text_list', filterable: false, in_header: false, in_identifier_index: false, soft: false },
];
const ON = { RAG_INGEST_PIPELINE: 'unified', RAG_DOC_ATTRIBUTES: 'true' };

let logs: string[] = [];
let dir = '';

beforeEach(async () => {
  logs = [];
  const capture = (...args: unknown[]) => void logs.push(args.map((arg) => (typeof arg === 'string' ? arg : JSON.stringify(arg))).join(' '));
  for (const level of ['log', 'info', 'warn', 'error', 'debug'] as const) vi.spyOn(console, level).mockImplementation(capture);
  dir = await mkdtemp(path.join(os.tmpdir(), 'attributes-cli-'));
});

afterEach(async () => {
  vi.restoreAllMocks();
  vi.resetModules();
  await rm(dir, { recursive: true, force: true });
});

async function file(name: string, lines: Array<string | Record<string, unknown>>): Promise<string> {
  const target = path.join(dir, name);
  await writeFile(target, lines.map((line) => (typeof line === 'string' ? line : JSON.stringify(line))).join('\n'));
  return target;
}

const row = (index: number, extra: Record<string, unknown> = {}) => ({
  source_key: `set-a/item-${String(index).padStart(3, '0')}`,
  attributes: { alpha_code: `A-${index}` },
  ...extra,
});

interface RunOptions {
  env?: Record<string, string>;
  failures?: Record<string, { code: string; message: string }>;
  importAnswer?: (args: Record<string, unknown>, index: number) => Record<string, unknown>[];
  failImportAt?: number;
  scope?: 'ok' | 'refused' | 'unavailable';
  abortAfterImportCalls?: number;
}

async function run(argv: string[], options: RunOptions = {}) {
  vi.resetModules();
  const fakes = await import('../../helpers/ingest-fakes');
  let importCalls = 0;
  const controller = new AbortController();
  const { db, calls } = fakes.fakeIngestDb({
    failures: options.failures,
    answers: {
      rag_attribute_definitions_for: (args) => (args.p_tenant_key === TENANT ? DEFINITIONS : []),
      rag_import_document_attributes: (args) => {
        const index = importCalls;
        importCalls += 1;
        if (options.abortAfterImportCalls !== undefined && importCalls >= options.abortAfterImportCalls) controller.abort(new Error('interrupted'));
        if (options.importAnswer) return options.importAnswer(args, index);
        const rows = args.p_rows as unknown[];
        return [
          {
            documents_changed: rows.length - 1,
            documents_unchanged: 0,
            chunks_updated: (rows.length - 1) * 2,
            staged: 1,
            staged_unchanged: 0,
            changed_document_ids: args.p_dry_run ? [] : [`00000000-0000-4000-8000-${String(index).padStart(12, '0')}`],
            outbox_rows: 0,
          },
        ];
      },
    },
  });
  const failingDb = options.failImportAt === undefined
    ? db
    : {
        rpc(fn: string, args?: Record<string, unknown>) {
          if (fn === 'rag_import_document_attributes' && args?.p_dry_run === false) {
            const applyIndex = calls.filter((call) => call.fn === fn && call.args.p_dry_run === false).length;
            if (applyIndex === options.failImportAt) {
              calls.push({ fn, args: args ?? {} });
              const response = { data: null, error: { code: '22023', message: 'unknown_attribute' } };
              const request = { abortSignal: () => request, then: (ok: (v: unknown) => unknown, ko?: (e: unknown) => unknown) => Promise.resolve(response).then(ok, ko) };
              return request as never;
            }
          }
          return db.rpc(fn, args ?? {});
        },
      };
  fakes.installIngestDeps({ db: failingDb as typeof db, env: options.env ?? ON });
  const out: string[] = [];
  const err: string[] = [];
  const scopeCalls: string[] = [];
  try {
    const { mintScope } = await import('@/lib/rag/tenant/scope');
    const cli = await import('@/lib/rag/ingest/attributes/cli');
    const code = await cli.main(argv, { out: (line) => out.push(line), err: (line) => err.push(line) }, controller.signal, {
      rpc: failingDb as typeof db,
      resolveScope: async (key: string) => {
        scopeCalls.push(key);
        if (options.scope === 'refused') return { ok: false, reason: 'invalid_tenant' };
        if (options.scope === 'unavailable') return { ok: false, reason: 'unavailable' };
        return { ok: true, scope: mintScope('org', null, ORG) };
      },
    });
    return { code, out, err, calls: calls as RecordedRpc[], scopeCalls, all: [...out, ...err, ...logs].join('\n') };
  } finally {
    fakes.uninstallIngestDeps();
  }
}

const fns = (calls: RecordedRpc[]) => calls.map((call) => call.fn);
const imports = (calls: RecordedRpc[]) => calls.filter((call) => call.fn === 'rag_import_document_attributes');

describe('parseAttributesArgs', () => {
  it('needs --tenant and --import; --dry-run and --apply exclude each other; repeated, valueless and unknown flags are errors', async () => {
    const { parseAttributesArgs } = await import('@/lib/rag/ingest/attributes/cli');
    expect(parseAttributesArgs(['--tenant', TENANT, '--import', 'f.jsonl'])).toEqual({ ok: true, tenantKey: TENANT, file: 'f.jsonl', apply: false });
    expect(parseAttributesArgs(['--tenant', TENANT, '--import', 'f.jsonl', '--apply'])).toEqual({ ok: true, tenantKey: TENANT, file: 'f.jsonl', apply: true });
    expect(parseAttributesArgs(['--tenant', TENANT, '--import', 'f.jsonl', '--dry-run'])).toEqual({ ok: true, tenantKey: TENANT, file: 'f.jsonl', apply: false });
    for (const argv of [
      ['--import', 'f.jsonl'],
      ['--tenant', TENANT],
      ['--tenant', TENANT, '--import', 'f.jsonl', '--apply', '--dry-run'],
      ['--tenant', TENANT, '--tenant', TENANT, '--import', 'f.jsonl'],
      ['--tenant', TENANT, '--import', 'f.jsonl', '--apply', '--apply'],
      ['--tenant', '--import', 'f.jsonl'],
      ['--tenant', TENANT, '--import'],
      ['--tenant', TENANT, '--import', 'f.jsonl', '--source', 'x'],
    ]) {
      expect(parseAttributesArgs(argv).ok, argv.join(' ')).toBe(false);
    }
  });

  it('a usage error exits 64 and prints USAGE, which names every exit code', async () => {
    const { code, err } = await run(['--tenant', TENANT]);
    expect(code).toBe(64);
    const { USAGE } = await import('@/lib/rag/ingest/attributes/cli');
    expect(err).toContain(USAGE);
    for (const word of ['0 done', '1 failed', '2 report only', '3 file refused', '64 usage']) expect(USAGE).toContain(word);
  });
});

describe('switch, tenant and database refusals', () => {
  it('with RAG_DOC_ATTRIBUTES effectively off: exit 64, one fixed line, no tenant check, no RPC', async () => {
    const target = await file('a.jsonl', [row(1)]);
    const envs: Array<Record<string, string>> = [{}, { RAG_DOC_ATTRIBUTES: 'true' }, { RAG_INGEST_PIPELINE: 'legacy', RAG_DOC_ATTRIBUTES: 'true' }];
    for (const env of envs) {
      const result = await run(['--tenant', TENANT, '--import', target, '--apply'], { env });
      expect(result.code).toBe(64);
      expect(result.calls).toEqual([]);
      expect(result.scopeCalls).toEqual([]);
      expect(result.err.join('\n')).toMatch(/RAG_DOC_ATTRIBUTES.*unified/);
    }
  });

  it('a refused tenant exits 64; an unverifiable tenant exits 1; neither reads the schema', async () => {
    const target = await file('a.jsonl', [row(1)]);
    const refused = await run(['--tenant', TENANT, '--import', target], { scope: 'refused' });
    expect(refused.code).toBe(64);
    expect(refused.calls).toEqual([]);
    const unavailable = await run(['--tenant', TENANT, '--import', target], { scope: 'unavailable' });
    expect(unavailable.code).toBe(1);
    expect(unavailable.calls).toEqual([]);
  });

  it('a file that cannot be read is a usage error (64) with no RPC', async () => {
    const result = await run(['--tenant', TENANT, '--import', path.join(dir, 'missing.jsonl')]);
    expect(result.code).toBe(64);
    expect(result.calls).toEqual([]);
  });

  it('an unreachable database (schema read fails) exits 1 and imports nothing', async () => {
    const target = await file('a.jsonl', [row(1)]);
    const result = await run(['--tenant', TENANT, '--import', target], { failures: { rag_attribute_definitions_for: { code: 'XX000', message: 'boom' } } });
    expect(result.code).toBe(1);
    expect(imports(result.calls)).toEqual([]);
  });
});

describe('readImportFile and all-or-nothing validation', () => {
  it('collects line errors and value errors with line numbers, exits 3 and makes no call but the schema read; the value is never printed', async () => {
    const target = await file('bad.jsonl', [
      row(1),
      '',
      '{not json',
      { attributes: { alpha_code: 'A-2' } },
      row(1),
      row(5, { attributes: { gamma_text: MARKER } }),
      row(6, { attributes: { alpha_code: 'x'.repeat(201) + MARKER } }),
      row(7, { attributes: { beta_list: [MARKER, MARKER] } }),
      row(8, { attributes: { 'Bad Key': MARKER } }),
    ]);
    const result = await run(['--tenant', TENANT, '--import', target, '--apply']);
    expect(result.code).toBe(3);
    expect(fns(result.calls)).toEqual(['rag_attribute_definitions_for']);
    expect(result.calls[0]?.args).toEqual({ p_tenant_key: TENANT });
    const text = result.out.join('\n');
    expect(text).toMatch(/line 3: invalid_json/);
    expect(text).toMatch(/line 4: invalid_row/);
    expect(text).toMatch(/line 5: duplicate_key/);
    expect(text).toMatch(/line 6: unknown_attribute gamma_text/);
    expect(text).toMatch(/line 7: invalid_row alpha_code/);
    expect(text).toMatch(/line 8: invalid_attribute_type beta_list/);
    expect(text).toMatch(/line 9: unknown_attribute/);
    expect(text).toMatch(/invalid_json: 1/);
    expect(text).toMatch(/unknown_attribute: 2/);
    expect(result.all).not.toContain(MARKER);
    expect(result.all).not.toContain('Bad Key');
  });

  it('prints at most the first 50 errors and the totals per code', async () => {
    const lines = Array.from({ length: 70 }, (_, index) => row(index + 1, { attributes: { gamma_text: MARKER } }));
    const target = await file('many.jsonl', lines);
    const result = await run(['--tenant', TENANT, '--import', target]);
    expect(result.code).toBe(3);
    expect(result.out.filter((line) => /^\[RAG Attributes\]\s+line \d+:/.test(line))).toHaveLength(50);
    expect(result.out.join('\n')).toMatch(/unknown_attribute: 70/);
    expect(result.all).not.toContain(MARKER);
  });

  it('a file of more than 50,000 rows is refused at row 50,001 with too_many_rows', async () => {
    const lines = Array.from({ length: 50_001 }, (_, index) => JSON.stringify({ source_key: `set-a/item-${index}`, attributes: { alpha_code: 'A' } }));
    const target = await file('big.jsonl', lines);
    const { readImportFile, IMPORT_MAX_ROWS } = await import('@/lib/rag/ingest/attributes/import');
    expect(IMPORT_MAX_ROWS).toBe(50_000);
    const read = await readImportFile(target, { signal: new AbortController().signal });
    expect(read.rows).toHaveLength(50_000);
    expect(read.errors).toEqual([{ line: 50_001, code: 'too_many_rows' }]);
    const result = await run(['--tenant', TENANT, '--import', target, '--apply']);
    expect(result.code).toBe(3);
    expect(imports(result.calls)).toEqual([]);
  });

  it('an absent source becomes the backfill source; an explicit source is kept; the same key under another source is not a duplicate', async () => {
    const target = await file('src.jsonl', [row(1), row(1, { source: 'other_feed' }), row(2, { source: 'config_upload' })]);
    const { readImportFile } = await import('@/lib/rag/ingest/attributes/import');
    const read = await readImportFile(target, { signal: new AbortController().signal });
    expect(read.errors).toEqual([]);
    expect(read.rows.map((item) => [item.line, item.source, item.sourceKey])).toEqual([
      [1, 'config_upload', 'set-a/item-001'],
      [2, 'other_feed', 'set-a/item-001'],
      [3, 'config_upload', 'set-a/item-002'],
    ]);
  });
});

describe('dry-run report', () => {
  it('a valid file runs every batch of 200 rows with the dry-run flag, prints the report and exits 2 without --apply', async () => {
    const target = await file('ok.jsonl', Array.from({ length: 450 }, (_, index) => row(index + 1, { attributes: { alpha_code: ` A-${index} `, beta_list: ['x'] } })));
    for (const argv of [['--tenant', TENANT, '--import', target], ['--tenant', TENANT, '--import', target, '--dry-run']]) {
      const result = await run(argv);
      expect(result.code).toBe(2);
      const calls = imports(result.calls);
      expect(calls.map((call) => (call.args.p_rows as unknown[]).length)).toEqual([200, 200, 50]);
      expect(calls.every((call) => call.args.p_dry_run === true && call.args.p_tenant_key === TENANT)).toBe(true);
      expect((calls[0]?.args.p_rows as Array<Record<string, unknown>>)[0]).toEqual({
        source: 'config_upload',
        source_key: 'set-a/item-001',
        attributes: { alpha_code: 'A-0', beta_list: ['x'] },
      });
      const text = result.out.join('\n');
      expect(text).toMatch(/rows read: 450/);
      expect(text).toMatch(/documents to change: 447/);
      expect(text).toMatch(/documents unchanged: 0/);
      expect(text).toMatch(/rows to stage: 3/);
      expect(text).toMatch(/staged rows unchanged: 0/);
      expect(text).toMatch(/chunk rows to update: 894/);
      expect(text).toMatch(/--apply/);
      expect(result.all).not.toContain('A-0');
    }
  });

  it('an interrupt exits 1', async () => {
    const target = await file('ok.jsonl', Array.from({ length: 450 }, (_, index) => row(index + 1)));
    const result = await run(['--tenant', TENANT, '--import', target, '--apply'], { abortAfterImportCalls: 1 });
    expect(result.code).toBe(1);
    expect(imports(result.calls).filter((call) => call.args.p_dry_run === false)).toEqual([]);
  });
});

describe('apply pass', () => {
  it('with --apply: the dry-run pass first, then every batch without the flag, one progress line per batch, the totals and the outbox line', async () => {
    const target = await file('ok.jsonl', Array.from({ length: 401 }, (_, index) => row(index + 1)));
    const result = await run(['--tenant', TENANT, '--import', target, '--apply']);
    expect(result.code).toBe(0);
    const calls = imports(result.calls);
    expect(calls.map((call) => call.args.p_dry_run)).toEqual([true, true, true, false, false, false]);
    expect(calls.map((call) => (call.args.p_rows as unknown[]).length)).toEqual([200, 200, 1, 200, 200, 1]);
    const text = result.out.join('\n');
    expect(result.out.filter((line) => /batch \d of 3:/.test(line))).toHaveLength(3);
    expect(text).toMatch(/documents changed: 398/);
    expect(text).toMatch(/rows staged: 3/);
    expect(text).toMatch(/chunk rows updated: 796 in 3 batches/);
    expect(text).toMatch(/vector sync outbox rows added: 0/);
  });

  it('a refusal at the second batch exits 1 and says how many batches were applied', async () => {
    const target = await file('ok.jsonl', Array.from({ length: 401 }, (_, index) => row(index + 1)));
    const result = await run(['--tenant', TENANT, '--import', target, '--apply'], { failImportAt: 1 });
    expect(result.code).toBe(1);
    expect(imports(result.calls).filter((call) => call.args.p_dry_run === false)).toHaveLength(2);
    expect(result.err.join('\n')).toMatch(/failed at batch 2 of 3: unknown_attribute; 1 of 3 batches applied/);
  });

  it('runAttributesImport returns the changed document ids of the apply pass only', async () => {
    vi.resetModules();
    const fakes = await import('../../helpers/ingest-fakes');
    const { db } = fakes.fakeIngestDb({
      answers: {
        rag_attribute_definitions_for: () => DEFINITIONS,
        rag_import_document_attributes: (args) => [
          { documents_changed: 1, documents_unchanged: 0, chunks_updated: 1, staged: 0, staged_unchanged: 0, changed_document_ids: args.p_dry_run ? [] : ['00000000-0000-4000-8000-00000000d001'], outbox_rows: 0 },
        ],
      },
    });
    fakes.installIngestDeps({ db, env: ON });
    try {
      const { mintScope } = await import('@/lib/rag/tenant/scope');
      const { runAttributesImport } = await import('@/lib/rag/ingest/attributes/import');
      const target = await file('one.jsonl', [row(1)]);
      const outcome = await runAttributesImport(
        { scope: mintScope('org', null, ORG), file: target, apply: true },
        { rpc: db, signal: new AbortController().signal, io: { out: () => undefined, err: () => undefined } },
      );
      expect(outcome).toMatchObject({ exitCode: 0, status: 'done', batches: 1, batchesApplied: 1, changedDocumentIds: ['00000000-0000-4000-8000-00000000d001'] });
    } finally {
      fakes.uninstallIngestDeps();
    }
  });
});
