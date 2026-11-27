import { describe, expect, it } from 'vitest';
import type { LanguageModelV3StreamPart } from '@ai-sdk/provider';
import { jsonSchema, stepCountIs, streamText, tool, type StreamTextTransform, type ToolSet, type UIMessageChunk } from 'ai';
import { MockLanguageModelV3, convertArrayToReadableStream } from 'ai/test';

import fixture from '../../fixtures/output-guard/answers.json';
import { createAnswerCollector } from '@/lib/rag/generation/answer-collector';
import { readAnswerConfig } from '@/lib/rag/generation/answer-config';
import { buildAnswerTransforms } from '@/lib/rag/generation/answer-transforms';
import type { AnswerChannel } from '@/lib/rag/generation/answer-turn';
import { emitNotice } from '@/lib/rag/generation/notices';
import { fixedText } from '@/lib/rag/lang/texts';
import { createOutputLinkPolicy } from '@/lib/rag/security/link-targets';
import {
  applyBlockedRanges,
  createOutputGuard,
  guardWholeText,
  type OutputGuardLinkSummary,
  type OutputGuardPolicy,
} from '@/lib/rag/security/output-guard';
import { outputGuardTransform } from '@/lib/rag/security/output-guard-stream';
import { streamModelFromPieces, type MockFinishReason, type StreamModelOptions } from '../../helpers/stream-model';

type Transform = StreamTextTransform<ToolSet>;

interface FixtureAnswer {
  id: string;
  language: string;
  text: string;
  documentNames: string[];
  allowlist: string;
  webResultUrls: { url: string; flagged: boolean }[];
  userMessage: string;
  flaggedContext?: boolean;
  expect: { removed: string[]; kept: string[]; credential?: { blocked: number; warned: number; late: boolean } };
}

const answers = fixture.answers as FixtureAnswer[];
const byId = (id: string) => answers.find((answer) => answer.id === id)!;

const lookup = tool({
  description: 'Look something up',
  inputSchema: jsonSchema<{ query: string }>({ type: 'object', properties: { query: { type: 'string' } }, required: ['query'] }),
  execute: async () => ({ results: [{ url: 'https://tool-output.test/x' }] }),
});

function policyFor(answer: FixtureAnswer, mode: 'flag' | 'enforce', extra: Partial<OutputGuardPolicy> = {}): OutputGuardPolicy {
  return {
    mode,
    placeholder: fixture.placeholder,
    credentialBlocked: fixture.credentialBlocked,
    flaggedContext: answer.flaggedContext === true,
    links: createOutputLinkPolicy({
      allowlistValue: answer.allowlist,
      siteUrl: fixture.siteUrl,
      webResultUrls: answer.webResultUrls,
      userMessage: answer.userMessage,
      documentNames: answer.documentNames,
    }),
    ...extra,
  };
}

const fields = (summary: OutputGuardLinkSummary) => ({ ...summary, removedTargets: [...summary.removedTargets] });

interface RunResult {
  text: string;
  chunks: UIMessageChunk[];
  summaries: OutputGuardLinkSummary[];
}

async function run(
  model: MockLanguageModelV3,
  chain: (onSummary: (summary: OutputGuardLinkSummary) => void) => Transform[],
): Promise<RunResult> {
  const summaries: OutputGuardLinkSummary[] = [];
  const result = streamText({
    model,
    prompt: 'question',
    tools: { lookup },
    stopWhen: stepCountIs(4),
    experimental_transform: chain((summary) => summaries.push(summary)),
    onError: () => {},
  });
  const chunks: UIMessageChunk[] = [];
  const reader = result.toUIMessageStream({ onError: () => 'stream error' }).getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
  }
  const text = chunks
    .filter((chunk): chunk is Extract<UIMessageChunk, { type: 'text-delta' }> => chunk.type === 'text-delta')
    .map((chunk) => chunk.delta)
    .join('');
  return { text, chunks, summaries };
}

function guardOnly(policy: OutputGuardPolicy) {
  return (onSummary: (summary: OutputGuardLinkSummary) => void) => [
    outputGuardTransform({ createGuard: () => createOutputGuard(policy), onSummary }),
  ];
}

async function streamPieces(
  pieces: string[],
  policy: OutputGuardPolicy,
  finishReason: MockFinishReason = 'stop',
  options: StreamModelOptions = {},
): Promise<RunResult> {
  return run(streamModelFromPieces(pieces.filter((piece) => piece !== ''), finishReason, options), guardOnly(policy));
}

function settled(result: RunResult): { text: string; summary: ReturnType<typeof fields> } {
  expect(result.summaries).toHaveLength(1);
  const summary = result.summaries[0]!;
  const ids = [...new Set(summary.blockedRanges.map((range) => range.textId))];
  expect(ids.length).toBeLessThanOrEqual(1);
  const text = ids.length === 0 ? result.text : applyBlockedRanges(result.text, summary.blockedRanges, fixture.credentialBlocked, ids[0]);
  return { text, summary: { ...fields(summary) } };
}

function wholeExpected(answer: FixtureAnswer) {
  const whole = guardWholeText(answer.text, policyFor(answer, 'enforce'));
  return { text: whole.text, summary: fields(whole.summary) };
}

describe('outputGuardTransform on the real streamText (D-35, D-38)', () => {
  describe('enforce: every fixture answer split at every character equals guardWholeText', () => {
    for (const answer of answers) {
      it(answer.id, async () => {
        const policy = policyFor(answer, 'enforce');
        const expected = wholeExpected(answer);
        const { text } = answer;
        expect(settled(await streamPieces(Array.from(text), policy))).toEqual(expected);
        for (let i = 0; i <= text.length; i += 1) {
          const got = settled(await streamPieces([text.slice(0, i), text.slice(i)], policy));
          expect(got, `split at ${i}`).toEqual(expected);
        }
      });
    }
  });

  describe('flag: the streamed text is the model text and the summary carries the enforce counts', () => {
    for (const answer of answers) {
      it(answer.id, async () => {
        const pieces = Array.from(answer.text);
        const flagged = await streamPieces(pieces, policyFor(answer, 'flag'));
        const enforced = await streamPieces(pieces, policyFor(answer, 'enforce'));
        expect(flagged.text).toBe(answer.text);
        const { mode: _flagMode, ...flagCounts } = fields(flagged.summaries[0]!);
        const { mode: _enforceMode, ...enforceCounts } = fields(enforced.summaries[0]!);
        expect(flagCounts).toEqual(enforceCounts);
        expect(flagged.summaries[0]!.mode).toBe('flag');
      });
    }
  });

  it('a tool step followed by a text step: tool parts pass unchanged, both text steps are filtered', async () => {
    const answer = byId('en-url-removed');
    const policy = policyFor(answer, 'enforce');
    const expected = guardWholeText(answer.text, policy).text;
    const result = await streamPieces(Array.from(answer.text), policy, 'stop', {
      before: [{ pieces: ['First https://other.test/z', ' end.'], toolCall: { toolName: 'lookup', input: { query: 'https://other.test/q' } } }],
    });
    const first = guardWholeText('First https://other.test/z end.', policy).text;
    expect(result.text).toBe(first + expected);
    const input = result.chunks.find((chunk) => chunk.type === 'tool-input-available') as { input?: unknown } | undefined;
    expect(input?.input).toEqual({ query: 'https://other.test/q' });
    const output = result.chunks.find((chunk) => chunk.type === 'tool-output-available') as { output?: unknown } | undefined;
    expect(output?.output).toEqual({ results: [{ url: 'https://tool-output.test/x' }] });
    expect(result.summaries).toHaveLength(1);
    expect(result.summaries[0]!.links_removed).toBe(2);
  });

  it('a reasoning part is not filtered or held', async () => {
    const policy = policyFor(byId('en-url-removed'), 'enforce');
    const reasoning = 'Think about https://other.test/r first.';
    const parts: LanguageModelV3StreamPart[] = [
      { type: 'stream-start', warnings: [] },
      { type: 'reasoning-start', id: 'r1' },
      { type: 'reasoning-delta', id: 'r1', delta: reasoning.slice(0, 20) },
      { type: 'reasoning-delta', id: 'r1', delta: reasoning.slice(20) },
      { type: 'reasoning-end', id: 'r1' },
      { type: 'text-start', id: 't1' },
      { type: 'text-delta', id: 't1', delta: 'Plain answer.' },
      { type: 'text-end', id: 't1' },
      {
        type: 'finish',
        finishReason: { unified: 'stop', raw: 'stop' },
        usage: { inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 1, text: 1, reasoning: 0 } },
      },
    ];
    const model = new MockLanguageModelV3({ doStream: async () => ({ stream: convertArrayToReadableStream(parts) }) });
    const result = await run(model, guardOnly(policy));
    const reasoningText = result.chunks
      .filter((chunk): chunk is Extract<UIMessageChunk, { type: 'reasoning-delta' }> => chunk.type === 'reasoning-delta')
      .map((chunk) => chunk.delta)
      .join('');
    expect(reasoningText).toBe(reasoning);
    expect(result.text).toBe('Plain answer.');
    expect(result.summaries[0]!.links_checked).toBe(0);
  });

  it('finish reason length while a URL is held: the URL is decided at flush and the truncation notice still follows', async () => {
    const policy = policyFor(byId('en-url-removed'), 'enforce');
    const collector = createAnswerCollector({
      turn: { config: { anyNonDefault: true, citationPerSentence: false, claimCheck: false }, answerLanguage: 'en' },
      channel: 'whatsapp',
    });
    const model = streamModelFromPieces(['The page is https://other.test/pa', 'th/deep'], 'length');
    const result = await run(model, (onSummary) =>
      buildAnswerTransforms({
        citationTransforms: [],
        guard: outputGuardTransform({ createGuard: () => createOutputGuard(policy), onSummary }),
        noticeCollector: collector.transforms(),
      }),
    );
    expect(result.text).toBe(`The page is ${fixture.placeholder}\n\n${fixedText('notices.answer_truncated', 'en')}`);
    expect(collector.truncated()).toBe(true);
    expect(collector.finalText()).toBe(result.text);
    expect(result.summaries[0]!.links_removed).toBe(1);
  });

  for (const channel of ['web', 'whatsapp'] as AnswerChannel[]) {
    it(`onNotice requests reach the collector and render for the ${channel} channel`, async () => {
      const collector = createAnswerCollector({
        turn: { config: { anyNonDefault: true, citationPerSentence: false, claimCheck: false }, answerLanguage: 'en' },
        channel,
      });
      const answer = byId('en-cred-warn');
      const policy = policyFor(answer, 'enforce', {
        onNotice: (notice) => collector.addNotice(emitNotice(notice.kind, { language: 'en' })),
      });
      const result = await run(streamModelFromPieces(Array.from(answer.text)), (onSummary) =>
        buildAnswerTransforms({
          citationTransforms: [],
          guard: outputGuardTransform({ createGuard: () => createOutputGuard(policy), onSummary }),
          noticeCollector: collector.transforms(),
        }),
      );
      const warning = emitNotice('credential_request_warning', { language: 'en' });
      expect(collector.notices()).toEqual([warning]);
      if (channel === 'whatsapp') expect(result.text).toBe(`${answer.text}\n\n${warning.text}`);
      else {
        expect(result.text).toBe(answer.text);
        expect(collector.finishMetadata().notices).toEqual([warning]);
      }
    });
  }

  it('a late block requests the blocked notice once, after the warned sentence was released', async () => {
    const collector = createAnswerCollector({
      turn: { config: { anyNonDefault: true, citationPerSentence: false, claimCheck: false }, answerLanguage: 'en' },
      channel: 'web',
    });
    const answer = byId('en-cred-late');
    const policy = policyFor(answer, 'enforce', {
      onNotice: (notice) => collector.addNotice(emitNotice(notice.kind, { language: 'en' })),
    });
    const result = await run(streamModelFromPieces(Array.from(answer.text)), (onSummary) =>
      buildAnswerTransforms({
        citationTransforms: [],
        guard: outputGuardTransform({ createGuard: () => createOutputGuard(policy), onSummary }),
        noticeCollector: collector.transforms(),
      }),
    );
    const kinds = collector.notices().map((notice) => notice.kind);
    expect(kinds).toContain('credential_request_blocked');
    expect(kinds.filter((kind) => kind === 'credential_request_blocked')).toHaveLength(1);
    expect(result.summaries[0]!.blockedRanges).toHaveLength(1);
  });
});

describe('guard slot of buildAnswerTransforms (D-35, D-36)', () => {
  it('off installs no guard transform: the 05.2-09 array is unchanged', () => {
    expect(readAnswerConfig({ RAG_OUTPUT_GUARD: 'off' }).outputGuard).toBe('off');
    const citation: Transform = () => new TransformStream();
    expect(buildAnswerTransforms({ citationTransforms: [citation] })).toEqual([citation]);
  });
});

describe('guardSlot (D-36)', () => {
  const options = { createGuard: () => createOutputGuard(policyFor(byId('en-url-removed'), 'enforce')) };
  it('off: no transform; flag and enforce: one transform between the sentinel and the notice collector', async () => {
    const { guardSlot } = await import('@/lib/rag/generation/answer-transforms');
    expect(guardSlot('off', options)).toBeNull();
    const citation: Transform = () => new TransformStream();
    const sentinel: Transform = () => new TransformStream();
    const collector: Transform = () => new TransformStream();
    for (const mode of ['flag', 'enforce'] as const) {
      const guard = guardSlot(mode, options);
      expect(typeof guard).toBe('function');
      expect(buildAnswerTransforms({ citationTransforms: [citation], sentinel, guard, noticeCollector: [collector] })).toEqual([
        citation,
        sentinel,
        guard,
        collector,
      ]);
    }
  });
});
