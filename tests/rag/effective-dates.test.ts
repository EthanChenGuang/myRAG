import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { ingest } from '@/lib/rag/ingest';
import {
  MAX_LLM_TEXT_CHARS,
  RULE_CONFIDENCE,
  extractEffectiveDates,
  setEffectiveDateLlmForTests,
  type EffectiveDateLlmInput,
} from '@/lib/rag/ingest/extractors/effective-dates';
import { mintScope } from '@/lib/rag/tenant/scope';
import { callsOf, fakeIngestDb, installIngestDeps, uninstallIngestDeps, type RecordedRpc } from '../helpers/ingest-fakes';

const scope = mintScope('single', null, null);
const NOW = Date.parse('2026-06-15T10:00:00Z');
const signal = new AbortController().signal;

function rules(text: string, language: string | null) {
  return extractEffectiveDates(text, { language, primary: null });
}

describe('extractEffectiveDates (rules)', () => {
  test.each([
    ['zh', '本文件自2024年3月1日起施行。', '2024-03-01'],
    ['en', 'This document is effective from 1 March 2024 for every reader.', '2024-03-01'],
    ['it', 'Il presente documento è in vigore dal 1° marzo 2024 per tutti.', '2024-03-01'],
  ])('%s: a stated start date gives effective_from with the rule confidence', async (language, text, iso) => {
    const { result } = await rules(text, language);
    expect(result).toMatchObject({ from: iso, to: null, confidence: RULE_CONFIDENCE, source: 'rule' });
    expect(text).toContain(result!.evidenceQuote);
  });

  test.each([
    ['zh', '本文件有效期至2030年12月31日。', '2030-12-31'],
    ['en', 'This document is valid until December 31, 2030 for every reader.', '2030-12-31'],
    ['it', 'Il presente documento è valido fino al 31 dicembre 2030 per tutti.', '2030-12-31'],
  ])('%s: a stated end date gives effective_to', async (language, text, iso) => {
    const { result } = await rules(text, language);
    expect(result).toMatchObject({ from: null, to: iso, confidence: RULE_CONFIDENCE, source: 'rule' });
  });

  test('start and end in one text give both bounds', async () => {
    const { result } = await rules('This note is effective from 2024-01-01. It is valid until 2030-06-30.', 'en');
    expect(result).toMatchObject({ from: '2024-01-01', to: '2030-06-30' });
  });

  test('full-width digits are read', async () => {
    const { result } = await rules('本文件自２０２４年３月１日起施行。', 'zh');
    expect(result?.from).toBe('2024-03-01');
  });

  test('the first pattern in pack order wins over an earlier match of a later pattern', async () => {
    const text = 'The text is in force from 5 May 2024. Later it says it is effective from 1 March 2024.';
    const { result } = await rules(text, 'en');
    expect(result?.from).toBe('2024-03-01');
  });

  test('within one pattern the earliest position wins', async () => {
    const text = 'Part one is effective from 2 February 2024. Part two is effective from 1 March 2024.';
    const { result } = await rules(text, 'en');
    expect(result?.from).toBe('2024-02-02');
  });

  test('a text without a date expression yields nothing', async () => {
    expect((await rules('This document describes a neutral process in plain words.', 'en')).result).toBeNull();
    expect((await rules('This text is effective from the next cycle onward.', 'en')).result).toBeNull();
  });

  test('the patterns of the document language are used, falling back to the primary language', async () => {
    const text = 'Il presente documento è in vigore dal 1° marzo 2024.';
    expect((await extractEffectiveDates(text, { language: 'en', primary: null })).result).toBeNull();
    expect((await extractEffectiveDates(text, { language: null, primary: 'it' })).result?.from).toBe('2024-03-01');
  });
});

describe('extractEffectiveDates (model step)', () => {
  afterEach(() => setEffectiveDateLlmForTests(null));

  const LLM = { filename: 'note.md', signal };
  const TEXT = 'This note\n takes   effect on the first day of March 2024 for every reader.';

  test('an answer whose quote occurs verbatim after whitespace collapse is accepted with its confidence', async () => {
    const seen: EffectiveDateLlmInput[] = [];
    setEffectiveDateLlmForTests(async (input) => {
      seen.push(input);
      return { effective_from: '2024-03-01', effective_to: null, confidence: 0.85, evidence_quote: 'takes effect on the first   day of March 2024' };
    });
    const { result, warnings } = await extractEffectiveDates(TEXT, { language: 'en', primary: null, llm: LLM });
    expect(result).toMatchObject({ from: '2024-03-01', to: null, confidence: 0.85, source: 'model' });
    expect(warnings).toEqual([]);
    expect(seen).toHaveLength(1);
  });

  test('an answer whose quote is not in the text is discarded and recorded as a gap', async () => {
    setEffectiveDateLlmForTests(async () => ({ effective_from: '2024-03-01', confidence: 0.95, evidence_quote: 'effective from 1 March 2024' }));
    const { result, warnings } = await extractEffectiveDates(TEXT, { language: 'en', primary: null, llm: LLM });
    expect(result).toBeNull();
    expect(warnings).toContain('effective_date_llm_unquoted');
  });

  test('an answer outside the schema is discarded', async () => {
    setEffectiveDateLlmForTests(async () => ({ effective_from: 'March 2024', confidence: 2, evidence_quote: 'takes effect' }));
    const { result, warnings } = await extractEffectiveDates(TEXT, { language: 'en', primary: null, llm: LLM });
    expect(result).toBeNull();
    expect(warnings).toContain('effective_date_llm_invalid');
  });

  test('a model error never throws and leaves no result', async () => {
    setEffectiveDateLlmForTests(async () => {
      throw new Error('boom');
    });
    const { result, warnings } = await extractEffectiveDates(TEXT, { language: 'en', primary: null, llm: LLM });
    expect(result).toBeNull();
    expect(warnings).toContain('effective_date_llm_failed');
  });

  test('the model is not called when the rules found a date, and the rule result stays', async () => {
    const call = vi.fn(async () => ({ effective_from: '2020-01-01', confidence: 1, evidence_quote: 'x' }));
    setEffectiveDateLlmForTests(call);
    const { result } = await extractEffectiveDates('It is effective from 1 March 2024.', { language: 'en', primary: null, llm: LLM });
    expect(call).not.toHaveBeenCalled();
    expect(result).toMatchObject({ from: '2024-03-01', source: 'rule' });
  });

  test('only a bounded excerpt of the text is sent', async () => {
    const seen: EffectiveDateLlmInput[] = [];
    setEffectiveDateLlmForTests(async (input) => {
      seen.push(input);
      return { effective_from: null, effective_to: null, confidence: 0.1, evidence_quote: 'neutral' };
    });
    await extractEffectiveDates('neutral words '.repeat(5000), { language: 'en', primary: null, llm: LLM });
    expect(seen[0]!.text.length).toBeLessThanOrEqual(MAX_LLM_TEXT_CHARS);
  });

  test('without the llm option no model is called', async () => {
    const call = vi.fn(async () => ({}));
    setEffectiveDateLlmForTests(call);
    await extractEffectiveDates(TEXT, { language: 'en', primary: null });
    expect(call).not.toHaveBeenCalled();
  });
});

describe('extract stage: effective dates', () => {
  beforeEach(() => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => {
    uninstallIngestDeps();
    setEffectiveDateLlmForTests(null);
    vi.restoreAllMocks();
  });

  function setOutcome(outcome: string) {
    return (args: Record<string, unknown>) => [
      { outcome, document_id: args.p_document_id, effective_from: args.p_from, effective_to: args.p_to, effective_dates_origin: args.p_origin, effective_dates_confidence: args.p_confidence, chunks_updated: 0 },
    ];
  }

  function run(text: string, options: { env?: Record<string, string>; setAnswer?: string; proposeAnswer?: string } = {}) {
    const { db, calls } = fakeIngestDb({
      answers: {
        rag_set_document_effective_dates: setOutcome(options.setAnswer ?? 'set'),
        rag_propose_document_effective_dates: (args) => [{ outcome: options.proposeAnswer ?? 'stored', document_id: args.p_document_id }],
      },
    });
    installIngestDeps({ db, env: options.env ?? {}, now: () => NOW });
    return ingest({
      scope,
      source: 'config_upload',
      sourceKey: 'root/note.md',
      text,
      filename: 'note.md',
      mimeType: 'text/markdown',
      signal,
    }).then((result) => ({ result, calls }));
  }

  const PAST = '# Note\n\nThis note is effective from 1 March 2024 and describes a neutral process for every reader.\n';
  const FUTURE = '# Note\n\nThis note is effective from 1 March 2027 and describes a neutral process for every reader.\n';

  function only(calls: RecordedRpc[], fn: string): Record<string, unknown> {
    const found = callsOf(calls, fn);
    expect(found).toHaveLength(1);
    return found[0]!.args;
  }

  test('a start date in the past is applied with origin extracted', async () => {
    const { result, calls } = await run(PAST);
    expect(result.status).toBe('ready');
    expect(only(calls, 'rag_set_document_effective_dates')).toMatchObject({
      p_from: '2024-03-01',
      p_to: null,
      p_origin: 'extracted',
      p_confidence: RULE_CONFIDENCE,
      p_actor: null,
    });
    expect(callsOf(calls, 'rag_propose_document_effective_dates')).toHaveLength(0);
  });

  test('a start date after today is stored as a proposal and the columns stay unset', async () => {
    const { result, calls } = await run(FUTURE);
    expect(result.status).toBe('ready');
    expect(callsOf(calls, 'rag_set_document_effective_dates')).toHaveLength(0);
    expect(only(calls, 'rag_propose_document_effective_dates')).toMatchObject({
      p_from: '2027-03-01',
      p_to: null,
      p_status: 'awaiting_confirmation',
    });
  });

  test('a document with admin dates is left alone', async () => {
    const { result, calls } = await run(PAST, { setAnswer: 'kept_admin' });
    expect(result.status).toBe('ready');
    expect(callsOf(calls, 'rag_set_document_effective_dates')).toHaveLength(1);
    expect(callsOf(calls, 'rag_propose_document_effective_dates')).toHaveLength(0);
    expect(result.warnings.filter((warning) => warning.startsWith('effective_date'))).toEqual([]);
  });

  test('a text without a date calls nothing', async () => {
    const { calls } = await run('# Note\n\nThis note describes a neutral process for every reader.\n');
    expect(callsOf(calls, 'rag_set_document_effective_dates')).toHaveLength(0);
    expect(callsOf(calls, 'rag_propose_document_effective_dates')).toHaveLength(0);
  });

  test('an unavailable setter never fails the stage', async () => {
    const { db, calls } = fakeIngestDb({ failures: { rag_set_document_effective_dates: { code: 'XX000', message: 'boom' } } });
    installIngestDeps({ db, now: () => NOW });
    const result = await ingest({ scope, source: 'config_upload', sourceKey: 'root/note.md', text: PAST, filename: 'note.md', mimeType: 'text/markdown', signal });
    expect(result.status).toBe('ready');
    expect(result.warnings).toContain('effective_dates_unavailable');
    expect(callsOf(calls, 'rag_publish_document_version')).toHaveLength(1);
  });

  test('with the model switch off no model is called; with it on an unquoted answer is a gap and the stage goes on', async () => {
    const call = vi.fn(async () => ({ effective_from: '2024-03-01', confidence: 0.95, evidence_quote: 'not in the text' }));
    setEffectiveDateLlmForTests(call);
    const text = '# Note\n\nThis note takes effect on the first day of March 2024 for every reader.\n';
    const off = await run(text);
    expect(call).not.toHaveBeenCalled();
    expect(callsOf(off.calls, 'rag_set_document_effective_dates')).toHaveLength(0);
    uninstallIngestDeps();

    const on = await run(text, { env: { RAG_EFFECTIVE_DATE_LLM_EXTRACT: 'true' } });
    expect(call).toHaveBeenCalledTimes(1);
    expect(on.result.status).toBe('ready');
    expect(on.result.warnings).toContain('effective_date_llm_unquoted');
    expect(callsOf(on.calls, 'rag_set_document_effective_dates')).toHaveLength(0);
    expect(callsOf(on.calls, 'rag_propose_document_effective_dates')).toHaveLength(0);
  });

  test('with the model switch on a quoted answer goes through the same apply rule', async () => {
    setEffectiveDateLlmForTests(async () => ({ effective_from: '2024-03-01', confidence: 0.85, evidence_quote: 'takes effect on the first day of March 2024' }));
    const text = '# Note\n\nThis note takes effect on the first day of March 2024 for every reader.\n';
    const { calls } = await run(text, { env: { RAG_EFFECTIVE_DATE_LLM_EXTRACT: 'true' } });
    expect(only(calls, 'rag_set_document_effective_dates')).toMatchObject({ p_from: '2024-03-01', p_origin: 'extracted', p_confidence: 0.85 });
  });
});
