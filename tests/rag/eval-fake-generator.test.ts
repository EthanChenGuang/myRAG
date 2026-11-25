import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { generateText, streamText } from 'ai';
import { createCitationSession, type ContextBlock } from '@/lib/rag';
import { requestGroundedness } from '@/lib/rag/generation/groundedness-client';
import { findCitationMarkers } from '@/lib/citations/marker-grammar';
import {
  fakeCitationAnswer,
  installFakeCitationGenerator,
  splitForStreaming,
} from '../../eval/harness/fake-citation-generator.mts';
import { startFakeGroundedness, type FakeGroundedness } from '../../eval/harness/fake-groundedness.mts';

function block(index: number, text: string): ContextBlock {
  return {
    documentId: `doc-${index}`,
    documentName: `doc-${index}.md`,
    documentVersion: 1,
    chunkIds: [`chunk-${index}`],
    page: null,
    sectionPath: null,
    title: `doc-${index}.md`,
    text,
    isImage: false,
    alias: `S${index}`,
  };
}

const BLOCK_TEXTS = [
  'Annual plans can be refunded within 30 days of purchase. Monthly plans are not refundable.',
  'Support is available on weekdays from 9:00 to 18:00 CET. Weekend tickets wait until Monday.',
  'The data retention period is 90 days for deleted workspaces.',
];

function labelledSystem(texts: string[] = BLOCK_TEXTS): string {
  const body = texts.map((text, index) => `[S${index + 1}] doc-${index + 1}.md\n${text}\n`).join('\n');
  return `You are a helpful AI assistant.\n\n=== RELEVANT INFORMATION FROM DOCUMENTS ===\n${body}\nCite with [S<number>].`;
}

const QUESTIONS = Array.from({ length: 50 }, (_, index) => `Fixture question number ${index + 1}: what does the policy say?`);

function aliasesOf(text: string): string[] {
  return findCitationMarkers(text).flatMap((marker) => marker.aliases);
}

describe('fake citation generator', () => {
  it('answers deterministically for the same system prompt, question and seed', () => {
    const system = labelledSystem();
    const first = fakeCitationAnswer({ system, question: QUESTIONS[0], seed: 'a' });
    expect(first.length).toBeGreaterThan(0);
    expect(fakeCitationAnswer({ system, question: QUESTIONS[0], seed: 'a' })).toBe(first);
    const answers = new Set(QUESTIONS.map((question) => fakeCitationAnswer({ system, question, seed: 'a' })));
    expect(answers.size).toBeGreaterThan(1);
  });

  it('cites one or two existing aliases and adds S99 for about one item in five', () => {
    const system = labelledSystem();
    let withInvalid = 0;
    for (const question of QUESTIONS) {
      const aliases = aliasesOf(fakeCitationAnswer({ system, question }));
      const valid = new Set(aliases.filter((alias) => alias !== 'S99'));
      expect(valid.size).toBeGreaterThanOrEqual(1);
      expect(valid.size).toBeLessThanOrEqual(2);
      for (const alias of valid) expect(['S1', 'S2', 'S3']).toContain(alias);
      if (aliases.includes('S99')) withInvalid += 1;
    }
    expect(withInvalid).toBeGreaterThanOrEqual(5);
    expect(withInvalid).toBeLessThanOrEqual(15);
  });

  it('answers from the cited block text so the answer is grounded in it', () => {
    const answer = fakeCitationAnswer({ system: labelledSystem(), question: QUESTIONS[3] });
    const first = aliasesOf(answer)[0];
    const index = Number(first.slice(1)) - 1;
    const sentence = BLOCK_TEXTS[index].split('. ')[0];
    expect(answer).toContain(sentence);
  });

  it('answers without markers when the prompt has no labelled blocks', () => {
    const answer = fakeCitationAnswer({ system: 'You are a helpful AI assistant.\n\nContext:\nNo relevant context found.', question: QUESTIONS[0] });
    expect(answer.length).toBeGreaterThan(0);
    expect(aliasesOf(answer)).toEqual([]);
  });

  it('splits every marker across stream chunks without losing text', () => {
    for (const question of QUESTIONS.slice(0, 10)) {
      const text = fakeCitationAnswer({ system: labelledSystem(), question });
      const chunks = splitForStreaming(text);
      expect(chunks.join('')).toBe(text);
      expect(chunks.length).toBeGreaterThan(1);
      for (const chunk of chunks) expect(findCitationMarkers(chunk)).toEqual([]);
    }
  });

  it('serves the same text through generateText and streamText, and the session validates the streamed markers', async () => {
    const factory = installFakeCitationGenerator('seed-1');
    const system = labelledSystem();
    const generated = await generateText({ model: factory('any/model'), system, prompt: QUESTIONS[4] });
    expect(generated.text).toBe(fakeCitationAnswer({ system, question: QUESTIONS[4], seed: 'seed-1' }));

    for (const question of QUESTIONS.slice(0, 10)) {
      const session = createCitationSession({
        capabilities: { citations: true },
        ragMode: 'strict',
        modelId: 'any/model',
        language: 'en',
        config: { citations: true },
      });
      session.attach({ blocks: BLOCK_TEXTS.map((text, index) => block(index + 1, text)) });
      const streamed = streamText({
        model: installFakeCitationGenerator('seed-1')('any/model'),
        system,
        prompt: question,
        experimental_transform: session.transforms(),
      });
      const text = await streamed.text;
      const expected = fakeCitationAnswer({ system, question, seed: 'seed-1' });
      expect(text).toBe(expected);
      const records = session.fullRecords();
      const valid = [...new Set(aliasesOf(expected).filter((alias) => alias !== 'S99'))];
      expect(records?.citations.map((record) => record.alias)).toEqual(valid);
      expect(records?.invalidCitations).toBe(aliasesOf(expected).filter((alias) => alias === 'S99').length);
    }
  });
});

describe('fake groundedness sidecar', () => {
  let fake: FakeGroundedness;

  beforeEach(async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    fake = await startFakeGroundedness({ secret: 'fake-sidecar-secret-placeholder' });
  });

  afterEach(async () => {
    await fake.close();
  });

  const request = (overrides: Record<string, unknown> = {}) => ({
    request_id: 'r1',
    language: 'en',
    premise_texts: ['Annual plans can be refunded within 30 days of purchase.'],
    hypothesis: 'Annual plans can be refunded within 30 days.',
    allow_vectara: false,
    ...overrides,
  });

  it('refuses a request without the shared secret', async () => {
    const response = await fetch(`${fake.url}/v1/groundedness`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-sidecar-secret': 'wrong' },
      body: JSON.stringify(request()),
    });
    expect(response.status).toBe(401);
    const missing = await fetch(`${fake.url}/v1/groundedness`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(request()),
    });
    expect(missing.status).toBe(401);
  });

  it('scores en with hhem_2_1_open from token overlap', async () => {
    const options = { url: fake.url, secret: fake.secret, timeoutMs: 2000 };
    const grounded = await requestGroundedness(request(), options);
    expect(grounded.status).toBe('scored');
    expect(grounded.scorer).toBe('hhem_2_1_open');
    expect(grounded.score).toBe(1);
    const ungrounded = await requestGroundedness(request({ hypothesis: 'Penguins migrate across the frozen desert every winter.' }), options);
    expect(ungrounded.status).toBe('scored');
    expect(ungrounded.score).toBeLessThan(0.5);
    expect(fake.requests).toHaveLength(2);
  });

  it('scores zh-Hans with hhem_2_3_vectara only when allow_vectara is true', async () => {
    const options = { url: fake.url, secret: fake.secret, timeoutMs: 2000 };
    const zh = { language: 'zh-Hans', premise_texts: ['年度计划可在购买后三十天内退款。'], hypothesis: '年度计划可在三十天内退款。' };
    const allowed = await requestGroundedness(request({ ...zh, allow_vectara: true }), options);
    expect(allowed.status).toBe('scored');
    expect(allowed.scorer).toBe('hhem_2_3_vectara');
    expect(allowed.score).toBeGreaterThan(0.5);
    const local = await requestGroundedness(request({ ...zh, allow_vectara: false }), options);
    expect(local).toMatchObject({ status: 'not_checked', scorer: 'none', reason: 'scorer_unavailable' });
  });

  it('answers not_checked unsupported_language for it and other languages', async () => {
    const options = { url: fake.url, secret: fake.secret, timeoutMs: 2000 };
    for (const language of ['it', 'zh-Hant', 'fr']) {
      const result = await requestGroundedness(request({ language, allow_vectara: true }), options);
      expect(result).toMatchObject({ status: 'not_checked', scorer: 'none', reason: 'unsupported_language' });
    }
  });
});
