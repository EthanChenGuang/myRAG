import { describe, expect, it } from 'vitest';
import { maskPII } from '@/lib/rag/trace/mask';
import { queryFingerprint } from '@/lib/rag/feedback-loop/retrieval-log';
import {
  IMPORT_LIMITS,
  importQuestions,
  parseQuestionFile,
  prepareQuestions,
} from '@/lib/rag/monitor/questions-import';

const RESIDUAL = 'reach +10 0000 0000ABCDEF00A00A000A today';

type Call = { kind: 'select' | 'rpc'; args: Record<string, unknown> };

function fakeAdmin(existing: Record<string, Set<string>> = {}) {
  const calls: Call[] = [];
  const admin = {
    calls,
    from(table: string) {
      const filters: Record<string, unknown> = {};
      const builder = {
        select: () => builder,
        eq(column: string, value: unknown) {
          filters[column] = value;
          return builder;
        },
        in(column: string, values: unknown[]) {
          filters[column] = values;
          calls.push({ kind: 'select', args: { table, ...filters } });
          const known = existing[String(filters.tenant_key)] ?? new Set<string>();
          const data = (values as string[]).filter((value) => known.has(value)).map((value) => ({ query_fingerprint: value }));
          return Promise.resolve({ data, error: null });
        },
      };
      return builder;
    },
    async rpc(fn: string, args: Record<string, unknown>) {
      calls.push({ kind: 'rpc', args: { fn, ...args } });
      const tenant = String(args.p_tenant_key);
      const known = (existing[tenant] ??= new Set<string>());
      let inserted = 0;
      for (const row of args.p_rows as Array<{ query_fingerprint: string }>) {
        if (!known.has(row.query_fingerprint)) {
          known.add(row.query_fingerprint);
          inserted += 1;
        }
      }
      return { data: inserted, error: null };
    },
  };
  return admin;
}

describe('IMPORT_LIMITS', () => {
  it('caps files at 10 MB and 20,000 rows, questions at 2000 characters and batches at 60 KB and 2000 rows', () => {
    expect(IMPORT_LIMITS).toEqual({
      maxFileBytes: 10 * 1024 * 1024,
      maxRows: 20_000,
      maxQuestionChars: 2000,
      maxBatchBytes: 60 * 1024,
      maxBatchRows: 2000,
    });
  });
});

describe('parseQuestionFile', () => {
  it('reads the named CSV column with quoted commas, doubled quotes and CRLF line ends', () => {
    const text = 'id,question,extra\r\n1,"question-0001, with a comma",x\r\n2,"say ""question-0002""",y\r\n3,question-0003,z\r\n';
    expect(parseQuestionFile(text, { format: 'csv', column: 'question' })).toEqual({
      ok: true,
      values: ['question-0001, with a comma', 'say "question-0002"', 'question-0003'],
    });
  });

  it('keeps a quoted line break inside a CSV field and strips a byte order mark', () => {
    const text = '﻿question\n"question-0001\nsecond line"\n';
    expect(parseQuestionFile(text, { format: 'csv', column: 'question' })).toEqual({ ok: true, values: ['question-0001\nsecond line'] });
  });

  it('reports a CSV header without the column', () => {
    expect(parseQuestionFile('id,text\n1,question-0001\n', { format: 'csv', column: 'question' })).toEqual({ ok: false, reason: 'column_not_found' });
  });

  it('reads the chosen JSON-lines key and turns a malformed line or a non-string value into an empty row', () => {
    const text = ['{"question":"question-0001"}', '{not json', '{"question":7}', '', '{"q":"question-0004","question":"question-0005"}'].join('\n');
    expect(parseQuestionFile(text, { format: 'jsonl', column: 'question' })).toEqual({
      ok: true,
      values: ['question-0001', null, null, 'question-0005'],
    });
  });

  it('refuses more than 20,000 rows', () => {
    const text = `question\n${Array.from({ length: IMPORT_LIMITS.maxRows + 1 }, (_, i) => `question-${i}`).join('\n')}\n`;
    expect(parseQuestionFile(text, { format: 'csv', column: 'question' })).toEqual({ ok: false, reason: 'too_many_rows' });
  });
});

describe('prepareQuestions', () => {
  it('masks an e-mail address and fingerprints with the retrieval-log function', () => {
    const prepared = prepareQuestions(['Where is the sample report for person@example.invalid?']);
    expect(prepared.rows).toHaveLength(1);
    expect(prepared.rows[0]!.queryMasked).toBe('Where is the sample report for [EMAIL]?');
    expect(prepared.rows[0]!.fingerprint).toBe(queryFingerprint('Where is the sample report for [EMAIL]?'));
  });

  it('rejects a row that still changes under maskPII after masking', () => {
    expect(maskPII(maskPII(RESIDUAL))).not.toBe(maskPII(RESIDUAL));
    const prepared = prepareQuestions([RESIDUAL, 'question-0002']);
    expect(prepared.rejectedPii).toBe(1);
    expect(prepared.rows.map((row) => row.queryMasked)).toEqual(['question-0002']);
  });

  it('caps a 2500-character question at 2000 characters and counts it as truncated', () => {
    const prepared = prepareQuestions(['a'.repeat(2500)]);
    expect(prepared.truncated).toBe(1);
    expect(prepared.rows[0]!.queryMasked).toHaveLength(2000);
  });

  it('skips empty and whitespace rows and counts them', () => {
    const prepared = prepareQuestions(['', '   ', null, 42, 'question-0001']);
    expect(prepared).toMatchObject({ read: 5, empty: 4, rows: [{ queryMasked: 'question-0001' }] });
  });

  it('keeps one of two equal questions and counts the other as a duplicate', () => {
    const prepared = prepareQuestions(['What is the sample topic?', '  what is the  SAMPLE topic? ']);
    expect(prepared.rows).toHaveLength(1);
    expect(prepared.duplicatesInFile).toBe(1);
  });

  it('records a language code for every row, und when undetermined', () => {
    const prepared = prepareQuestions(['What is the status of the sample item and the other one?', '12345']);
    expect(prepared.rows[0]!.language).toBe('en');
    expect(prepared.rows[1]!.language).toBe('und');
  });
});

describe('importQuestions', () => {
  const NOW = new Date('2026-11-26T10:00:00Z');

  it('enqueues historical representative rows in the import week and returns counts only', async () => {
    const admin = fakeAdmin();
    const prepared = prepareQuestions(['question-0001', 'question-0001', 'question-0002', '', RESIDUAL, 'b'.repeat(2100)]);
    const counts = await importQuestions(admin, { tenantKey: 's:default', prepared, dryRun: false, now: NOW });
    expect(counts).toEqual({ read: 6, added: 3, duplicates: 1, rejected_pii: 1, truncated: 1, empty: 1, by_language: { und: 3 } });
    const rpc = admin.calls.find((call) => call.kind === 'rpc')!;
    expect(rpc.args.fn).toBe('rag_review_items_enqueue');
    expect(rpc.args.p_tenant_key).toBe('s:default');
    expect(rpc.args.p_source).toBe('historical');
    const rows = rpc.args.p_rows as Array<Record<string, unknown>>;
    expect(rows[0]).toEqual({
      query_masked: 'question-0001',
      query_fingerprint: queryFingerprint('question-0001'),
      language: 'und',
      reasons: ['representative'],
      mining_window: '2026-11-23T00:00:00.000Z',
      stratum: 'historical|und|import',
      sampling_weight: 1,
    });
    expect(JSON.stringify(counts)).not.toContain('question-0001');
  });

  it('adds nothing when the same file is imported again', async () => {
    const admin = fakeAdmin();
    const prepared = prepareQuestions(['question-0001', 'question-0002']);
    await importQuestions(admin, { tenantKey: 's:default', prepared, dryRun: false, now: NOW });
    const again = await importQuestions(admin, { tenantKey: 's:default', prepared, dryRun: false, now: new Date('2026-12-10T10:00:00Z') });
    expect(again).toMatchObject({ added: 0, duplicates: 2 });
  });

  it('a dry run computes the counts against the queue and calls no writer', async () => {
    const admin = fakeAdmin({ 's:default': new Set([queryFingerprint('question-0001')]) });
    const prepared = prepareQuestions(['question-0001', 'question-0002', 'question-0002']);
    const counts = await importQuestions(admin, { tenantKey: 's:default', prepared, dryRun: true, now: NOW });
    expect(counts).toMatchObject({ read: 3, added: 1, duplicates: 2 });
    expect(admin.calls.some((call) => call.kind === 'rpc')).toBe(false);
  });

  it('refuses a tenant key that is not one of the deployment forms', async () => {
    await expect(importQuestions(fakeAdmin(), { tenantKey: 'tenant-a', prepared: prepareQuestions(['question-0001']), dryRun: true })).rejects.toThrow(
      'invalid_tenant_key',
    );
  });
});
