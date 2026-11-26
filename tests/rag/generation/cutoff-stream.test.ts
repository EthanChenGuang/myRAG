import { describe, expect, it } from 'vitest';
import { AnswerChecksSchema } from '@/lib/rag-eval/contracts.generated';
import { buildAnswerChecksInput } from '@/lib/rag/generation/answer-checks';
import { emitNotice } from '@/lib/rag/generation/notices';
import { runAnswerChain } from '../../helpers/answer-chain';

const CUT = ['Fact one ', '[S1]. Fact two ', '[S'];

describe('cut-off at the output limit (D-33)', () => {
  it('keeps the citation before the cut, counts the half marker and records a truncated tail', async () => {
    const out = await runAnswerChain({ pieces: CUT, finishReason: 'length', citations: true, perSentence: true });
    expect(out.text).toBe('Fact one [S1]. Fact two [S');
    expect(out.session.fullRecords()?.citations.map((record) => record.alias)).toEqual(['S1']);
    expect(out.session.truncatedMarkers()).toBe(1);

    const sentences = out.collector.sentences();
    expect(sentences).not.toBeNull();
    const last = sentences![sentences!.length - 1]!;
    expect(last.kind).toBe('truncated');
    expect(last.factual).toBe(false);
    expect(sentences![0]!.cited).toBe(true);
    expect(sentences![0]!.factual).toBe(true);

    const notice = emitNotice('answer_truncated', { language: 'en' });
    expect(out.collector.notices()).toEqual([notice]);
    expect(out.finishMetadata?.notices).toEqual([notice]);
    expect(out.finishMetadata?.truncated).toBe(true);

    const checks = buildAnswerChecksInput({ collector: out.collector, citationRecords: out.session.fullRecords()?.citations ?? [] });
    expect(checks.truncated).toBe(true);
    expect(checks.finish_reason).toBe('length');
    expect(checks.sentences).toEqual(sentences);
    expect(AnswerChecksSchema.safeParse(checks).success).toBe(true);
  });

  it('on a plain-text channel appends the truncation notice after a blank line', async () => {
    const out = await runAnswerChain({ pieces: CUT, finishReason: 'length', citations: true, channel: 'whatsapp' });
    const notice = emitNotice('answer_truncated', { language: 'en' });
    expect(out.text).toBe(`Fact one [S1]. Fact two [S\n\n${notice.text}`);
    expect(out.collector.finalText()).toBe(out.responseText);
    expect(out.session.fullRecords()?.citations.map((record) => record.alias)).toEqual(['S1']);
  });

  it('records finish_reason stop and no truncation for a complete answer', async () => {
    const out = await runAnswerChain({ pieces: ['Fact one [S1].'], citations: true, perSentence: true });
    const checks = buildAnswerChecksInput({ collector: out.collector });
    expect(checks.finish_reason).toBe('stop');
    expect(checks.truncated).toBe(false);
    expect(out.collector.notices()).toEqual([]);
    expect(out.session.truncatedMarkers()).toBe(0);
  });

  it('never reports a sentinel refusal as cut', async () => {
    const out = await runAnswerChain({ pieces: ['%%NO_ANSWER_IN_CONTEXT%%', ' more'], finishReason: 'length', sentinel: true });
    expect(out.collector.refusedByModel()).toBe(true);
    expect(out.collector.truncated()).toBe(false);
    expect(out.collector.notices()).toEqual([]);
  });
});
