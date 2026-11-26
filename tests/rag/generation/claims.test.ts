import type { SupabaseClient } from '@supabase/supabase-js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  AnswerChecksSchema,
  type AnswerChecks,
  type AnswerSentence,
  type ClaimCheckRequest,
  type ClaimCheckResult,
} from '@/lib/rag-eval/contracts.generated';
import { mintScope } from '@/lib/rag/tenant/scope';
import type { AnswerFinishInput, AnswerPendingContext } from '@/lib/rag/generation/answer-finish';
import { createPendingStep } from '@/lib/rag/generation/answer-finish';
import {
  buildClaimInputs,
  createClaimStep,
  requestClaimCheck,
  type ClaimStepConfig,
  type ClaimStepDeps,
} from '@/lib/rag/generation/claims';
import type { JudgeClaimsInput, JudgeClaimsResult } from '@/lib/rag/generation/judge';
import { buildSentenceRecords } from '@/lib/rag/generation/sentences-record';
import type { LangfuseScoreInput } from '@/lib/rag/trace/scores';
import type { LangfuseConfig } from '@/lib/rag/trace/config';

afterEach(() => {
  vi.restoreAllMocks();
});

const ANSWER_ID = '00000000-0000-4000-8000-0000000025a1';
const USER = '00000000-0000-4000-8000-0000000025b1';
const NOW = new Date('2026-11-26T10:00:00.000Z');
const TRACE_ID = '0123456789abcdef0123456789abcdef';

const BLOCK_ONE = 'The blue module stores ten records in its local table.';
const BLOCK_TWO = 'The red module stores four records and reads them every hour.';
const BLOCK_THREE = 'The green module was removed in the last release.';
const BLOCKS = [
  { alias: 'S1', text: BLOCK_ONE },
  { alias: 'S2', text: BLOCK_TWO },
  { alias: 'S3', text: BLOCK_THREE },
];
const ALIASES = new Set(['S1', 'S2', 'S3']);
const EN_ANSWER = 'The blue module stores ten records [S1]. The red module stores four records [S2]. The green module stores no records.';
const IT_ANSWER =
  'Il modulo blu conserva dieci record nella sua tabella locale [S1]. Il modulo rosso conserva quattro record e li legge ogni ora [S2].';

const CONFIG: ClaimStepConfig = {
  claimCheck: true,
  llmJudge: false,
  judgeModel: '',
  vectaraOptIn: false,
  vectaraMultiTenantAck: false,
  maxPremiseTokens: 2000,
  groundednessTimeoutMs: 20000,
};

function sentencesOf(text: string, language: string): AnswerSentence[] {
  return buildSentenceRecords({ text, part: 0, language, aliases: ALIASES });
}

function finishInput(overrides: Partial<AnswerFinishInput> = {}, language = 'en'): AnswerFinishInput {
  const answerText = overrides.answerText ?? EN_ANSWER;
  return {
    answerId: ANSWER_ID,
    scope: mintScope('single', null, null),
    userId: USER,
    chatId: null,
    traceId: TRACE_ID,
    modelId: 'openai/gpt-4o-mini',
    ragMode: 'strict',
    queryText: 'Which module stores records?',
    citations: [],
    citationStrategy: 'chunk-alias',
    invalidCitations: 0,
    answerText,
    aborted: false,
    groundednessEligible: true,
    toolOutputUsed: false,
    premise: { blocks: BLOCKS, webSearchTexts: [] },
    requestLanguage: language,
    checks: { sentences: sentencesOf(answerText, language), truncated: false, finish_reason: 'stop' },
    answerLanguage: language,
    refusedByModel: false,
    ...overrides,
  };
}

function langfuse(overrides: Partial<LangfuseConfig> = {}): LangfuseConfig {
  return {
    enabled: true,
    publicKey: 'pk-test',
    secretKey: 'sk-test',
    baseUrl: 'http://127.0.0.1:1',
    sampleRate: 1,
    reviewSampleRate: 0,
    captureContent: false,
    ...overrides,
  };
}

function scoredResult(request: ClaimCheckRequest, scores: Record<number, number>): ClaimCheckResult {
  return {
    claims: request.claims.map((claim) => ({
      index: claim.index,
      status: 'scored',
      scorer: 'hhem_2_1_open',
      score: scores[claim.index] ?? 0.9,
      reason: null,
    })),
    latency_ms: 30,
  };
}

function harness(overrides: Partial<ClaimStepDeps> = {}, config: Partial<ClaimStepConfig> = {}) {
  const requests: ClaimCheckRequest[] = [];
  const requestOptions: unknown[] = [];
  const checksWrites: AnswerChecks[] = [];
  const reasons: string[] = [];
  const scores: LangfuseScoreInput[] = [];
  const groundednessWrites: unknown[] = [];
  const judgeCalls: JudgeClaimsInput[] = [];
  const deps: Partial<ClaimStepDeps> = {
    readConfig: () => ({ ...CONFIG, ...config }),
    multiTenant: () => false,
    request: vi.fn(async (request: ClaimCheckRequest, options?: unknown) => {
      requests.push(request);
      requestOptions.push(options);
      return scoredResult(request, {});
    }),
    judge: vi.fn(async (input: JudgeClaimsInput): Promise<JudgeClaimsResult> => {
      judgeCalls.push(input);
      return { status: 'not_checked', reason: 'judge_not_configured', judgeModel: null, judgeVersion: null, usage: null };
    }),
    updateChecks: vi.fn(async (_admin: SupabaseClient, input: { id: string; checks: AnswerChecks }) => {
      checksWrites.push(input.checks);
      return true;
    }),
    updateGroundedness: vi.fn(async (_admin: SupabaseClient, input: { id: string; groundedness: unknown }) => {
      groundednessWrites.push(input.groundedness);
      return true;
    }),
    appendReviewReason: vi.fn(async (_admin: SupabaseClient, input: { id: string; reason: string }) => {
      reasons.push(input.reason);
      return true;
    }),
    exportReview: vi.fn(async () => 'exported' as const),
    langfuse: () => langfuse({ enabled: false }),
    exportTrace: vi.fn(async () => undefined),
    postScores: vi.fn(async (batch: readonly LangfuseScoreInput[]) => {
      scores.push(...batch);
      return { status: 'accepted' as const, httpStatus: 200 };
    }),
    now: () => NOW,
    ...overrides,
  } as Partial<ClaimStepDeps>;
  const step = createClaimStep(deps);
  const context = (input: AnswerFinishInput): AnswerPendingContext => ({ answerId: input.answerId, input, admin: {} as SupabaseClient });
  return { step, context, requests, requestOptions, checksWrites, reasons, scores, groundednessWrites, judgeCalls, deps };
}

describe('buildClaimInputs', () => {
  it('references the cited blocks of a cited sentence and the top blocks within the cap for an uncited one, markers stripped', () => {
    const sentences = sentencesOf(EN_ANSWER, 'en');
    const built = buildClaimInputs({ text: EN_ANSWER, sentences, blocks: BLOCKS, aliases: ALIASES, capPerClaim: 2000 });
    expect(built.premises).toEqual([
      { ref: 'S1', text: BLOCK_ONE },
      { ref: 'S2', text: BLOCK_TWO },
      { ref: 'S3', text: BLOCK_THREE },
    ]);
    expect(built.claims).toEqual([
      { index: 0, hypothesis: 'The blue module stores ten records.', premise_refs: ['S1'] },
      { index: 1, hypothesis: 'The red module stores four records.', premise_refs: ['S2'] },
      { index: 2, hypothesis: 'The green module stores no records.', premise_refs: ['S1', 'S2', 'S3'] },
    ]);
    expect(built.skipped).toEqual([]);
  });

  it('keeps an uncited sentence within the per-claim cap', () => {
    const sentences = sentencesOf(EN_ANSWER, 'en');
    const words = (text: string) => text.split(/\s+/).filter(Boolean).length;
    const cap = words(BLOCK_ONE) + words(BLOCK_TWO);
    const built = buildClaimInputs({ text: EN_ANSWER, sentences, blocks: BLOCKS, aliases: ALIASES, capPerClaim: cap, countTokens: words });
    expect(built.claims[2]!.premise_refs).toEqual(['S1', 'S2']);
    expect(built.premises.map((premise) => premise.ref)).toEqual(['S1', 'S2']);
  });

  it('sends at most 40 claims and marks the rest too_many', () => {
    const text = Array.from({ length: 45 }, (_, i) => `Entry number ${i + 1} is stored in the blue module [S1].`).join(' ');
    const sentences = sentencesOf(text, 'en');
    expect(sentences.filter((sentence) => sentence.factual)).toHaveLength(45);
    const built = buildClaimInputs({ text, sentences, blocks: BLOCKS, aliases: ALIASES, capPerClaim: 2000 });
    expect(built.claims).toHaveLength(40);
    expect(built.skipped).toHaveLength(5);
    expect(built.skipped.every((entry) => entry.reason === 'too_many')).toBe(true);
  });
});

describe('requestClaimCheck', () => {
  const request: ClaimCheckRequest = {
    request_id: ANSWER_ID,
    language: 'en',
    allow_vectara: false,
    premises: [{ ref: 'S1', text: BLOCK_ONE }],
    claims: [
      { index: 0, hypothesis: 'The blue module stores ten records.', premise_refs: ['S1'] },
      { index: 1, hypothesis: 'The blue module has a table.', premise_refs: ['S1'] },
    ],
  };
  const options = { url: 'http://sidecar.test', secret: 'test-secret', timeoutMs: 1000 };

  it('posts to /v1/groundedness/claims with the shared secret and returns the parsed result', async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const fetchImpl = vi.fn(async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return new Response(JSON.stringify(scoredResult(request, { 1: 0.1 })), { status: 200 });
    }) as unknown as typeof fetch;
    const result = await requestClaimCheck(request, { ...options, fetch: fetchImpl });
    expect(calls[0]!.url).toBe('http://sidecar.test/v1/groundedness/claims');
    expect((calls[0]!.init.headers as Record<string, string>)['x-sidecar-secret']).toBe('test-secret');
    expect(JSON.parse(calls[0]!.init.body as string)).toEqual(request);
    expect(result.claims.map((claim) => claim.score)).toEqual([0.9, 0.1]);
  });

  it('maps an HTTP error, an invalid body and a missing sidecar to not_checked error for every claim, never throwing', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const failing = [
      async () => new Response('{}', { status: 500 }),
      async () => new Response(JSON.stringify({ claims: 'nope' }), { status: 200 }),
      async () => {
        throw new TypeError('network down');
      },
    ];
    for (const impl of failing) {
      const result = await requestClaimCheck(request, { ...options, fetch: vi.fn(impl) as unknown as typeof fetch });
      expect(result.claims).toEqual([
        { index: 0, status: 'not_checked', scorer: 'none', score: null, reason: 'error' },
        { index: 1, status: 'not_checked', scorer: 'none', score: null, reason: 'error' },
      ]);
    }
    const unset = await requestClaimCheck(request, { url: '', secret: '', timeoutMs: 1000 });
    expect(unset.claims.every((claim) => claim.status === 'not_checked' && claim.reason === 'error')).toBe(true);
  });

  it('maps a timeout to not_checked timeout', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const fetchImpl = vi.fn(
      (_url: string, init: RequestInit) =>
        new Promise<Response>((_, reject) => {
          init.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
        }),
    ) as unknown as typeof fetch;
    const result = await requestClaimCheck(request, { ...options, timeoutMs: 20, fetch: fetchImpl });
    expect(result.claims.every((claim) => claim.status === 'not_checked' && claim.reason === 'timeout')).toBe(true);
  });
});

describe('createClaimStep', () => {
  it('does nothing with RAG_CLAIM_CHECK off', async () => {
    const h = harness({}, { claimCheck: false });
    const outcome = await h.step(h.context(finishInput()));
    expect(outcome).toBeNull();
    expect(h.deps.request).not.toHaveBeenCalled();
    expect(h.checksWrites).toEqual([]);
  });

  it('sends one request per answer with the claims, then marks the unsupported sentence, counts it and queues it for review', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const h = harness({
      request: vi.fn(async (request: ClaimCheckRequest) => {
        h.requests.push(request);
        return scoredResult(request, { 2: 0.2 });
      }),
      langfuse: () => langfuse(),
    });
    const input = finishInput();
    const before = input.answerText;
    await h.step(h.context(input));

    expect(h.requests).toHaveLength(1);
    expect(h.requests[0]).toMatchObject({ request_id: ANSWER_ID, language: 'en', allow_vectara: false });
    expect(h.requests[0]!.claims.map((claim) => claim.premise_refs)).toEqual([['S1'], ['S2'], ['S1', 'S2', 'S3']]);
    expect(h.requests[0]!.claims.every((claim) => !/\[S\d\]/.test(claim.hypothesis))).toBe(true);

    expect(h.checksWrites).toHaveLength(1);
    const checks = AnswerChecksSchema.parse(h.checksWrites[0]);
    expect(checks.sentences!.map((sentence) => sentence.support)).toEqual(['supported', 'supported', 'unsupported']);
    expect(checks.sentences!.every((sentence) => sentence.scorer === 'hhem_2_1_open')).toBe(true);
    expect(checks.claims).toMatchObject({ total: 3, unsupported: 1, not_checked: 0, scorer: 'hhem_2_1_open' });
    expect(checks.finish_reason).toBe('stop');

    expect(h.reasons).toEqual(['claim_unsupported']);
    const share = h.scores.find((score) => score.name === 'unsupported_claim_share');
    expect(share?.value).toBeCloseTo(1 / 3, 10);
    expect(share?.dataType).toBe('NUMERIC');
    expect(input.answerText).toBe(before);
    expect(h.groundednessWrites).toEqual([]);
  });

  it('records the trace counts on a claim_check span', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const traces: Array<{ stages: Array<{ name: string; attributes?: Record<string, unknown> }> }> = [];
    const h = harness({
      request: vi.fn(async (request: ClaimCheckRequest) => scoredResult(request, { 2: 0.2 })),
      langfuse: () => langfuse(),
      exportTrace: vi.fn(async (trace) => {
        traces.push(trace as never);
      }),
    });
    await h.step(h.context(finishInput()));
    const stage = traces[0]!.stages.find((entry) => entry.name === 'claim_check');
    expect(stage?.attributes).toMatchObject({ claims_total: 3, claims_unsupported: 1, claims_not_checked: 0 });
  });

  it('turns a sidecar timeout into not_checked timeout, with no unsupported mark and no review reason', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const h = harness({
      request: vi.fn(async (request: ClaimCheckRequest) => ({
        claims: request.claims.map((claim) => ({ index: claim.index, status: 'not_checked' as const, scorer: 'none' as const, score: null, reason: 'timeout' as const })),
        latency_ms: 20000,
      })),
    });
    await h.step(h.context(finishInput()));
    const checks = h.checksWrites[0]!;
    expect(checks.sentences!.filter((sentence) => sentence.factual).every((sentence) => sentence.support === 'not_checked' && sentence.reason === 'timeout')).toBe(true);
    expect(checks.claims).toMatchObject({ total: 3, unsupported: 0, not_checked: 3, reasons: { timeout: 3 } });
    expect(h.reasons).toEqual([]);
  });

  it('marks every claim timeout without a request when the shared deadline has passed', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const h = harness();
    await h.step(h.context(finishInput()), { deadlineAt: Date.now() - 1 });
    expect(h.deps.request).not.toHaveBeenCalled();
    expect(h.checksWrites[0]!.claims).toMatchObject({ not_checked: 3, reasons: { timeout: 3 } });
  });

  it('passes the remaining time of the shared deadline to the sidecar request', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const h = harness();
    await h.step(h.context(finishInput()), { deadlineAt: Date.now() + 5000 });
    const options = h.requestOptions[0] as { timeoutMs: number };
    expect(options.timeoutMs).toBeGreaterThan(0);
    expect(options.timeoutMs).toBeLessThanOrEqual(5000);
  });

  it('marks the sentences beyond 40 not_checked too_many', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const text = Array.from({ length: 45 }, (_, i) => `Entry number ${i + 1} is stored in the blue module [S1].`).join(' ');
    const h = harness();
    await h.step(h.context(finishInput({ answerText: text, checks: { sentences: sentencesOf(text, 'en'), truncated: false, finish_reason: 'stop' } })));
    expect(h.requests[0]!.claims).toHaveLength(40);
    expect(h.checksWrites[0]!.claims).toMatchObject({ total: 45, not_checked: 5, reasons: { too_many: 5 } });
  });

  it('sends no request for a sentinel refusal, a ghost chat, tool output or an ineligible answer', async () => {
    for (const overrides of [
      { refusedByModel: true },
      { chatId: 'ghost-1234' },
      { toolOutputUsed: true },
      { groundednessEligible: false },
      { aborted: true },
    ] satisfies Array<Partial<AnswerFinishInput>>) {
      const h = harness();
      expect(await h.step(h.context(finishInput(overrides)))).toBeNull();
      expect(h.deps.request).not.toHaveBeenCalled();
      expect(h.checksWrites).toEqual([]);
    }
  });

  it('marks every sentence of a language without HHEM not_checked unsupported_language with the judge off, without a sidecar call', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const h = harness();
    await h.step(h.context(finishInput({ answerText: IT_ANSWER }, 'it')));
    expect(h.deps.request).not.toHaveBeenCalled();
    expect(h.judgeCalls).toEqual([]);
    const checks = h.checksWrites[0]!;
    const factual = checks.sentences!.filter((sentence) => sentence.factual);
    expect(factual.length).toBeGreaterThan(0);
    expect(factual.every((sentence) => sentence.support === 'not_checked' && sentence.reason === 'unsupported_language')).toBe(true);
    expect(h.reasons).toEqual([]);
  });

  it('never throws when a dependency throws', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const h = harness({
      updateChecks: vi.fn(async () => {
        throw new Error('db down');
      }),
    });
    await expect(h.step(h.context(finishInput()))).resolves.not.toThrow();
  });
});

describe('createPendingStep', () => {
  it('runs the claim step after the answer-level step with the shared deadline and returns the answer-level label', async () => {
    const order: string[] = [];
    let deadline: number | undefined;
    const label = { status: 'scored', label: 'verified' } as never;
    const step = createPendingStep({
      groundedness: async () => {
        order.push('groundedness');
        return label;
      },
      claims: async (_context, options) => {
        order.push('claims');
        deadline = options?.deadlineAt;
        return null;
      },
      timeoutMs: () => 20000,
    });
    const started = Date.now();
    const input = finishInput();
    const result = await step({ answerId: input.answerId, input, admin: {} as SupabaseClient });
    expect(order).toEqual(['groundedness', 'claims']);
    expect(result).toBe(label);
    expect(deadline).toBeGreaterThanOrEqual(started + 20000);
    expect(deadline).toBeLessThanOrEqual(Date.now() + 20000);
  });

  it('returns the groundedness the claim step stored for a judge language', async () => {
    const judged = { status: 'scored', label: 'verified', scorer: 'llm_judge' } as never;
    const step = createPendingStep({
      groundedness: async () => ({ status: 'not_checked' }) as never,
      claims: async () => ({ groundedness: judged }),
      timeoutMs: () => 20000,
    });
    const input = finishInput();
    expect(await step({ answerId: input.answerId, input, admin: {} as SupabaseClient })).toBe(judged);
  });
});
