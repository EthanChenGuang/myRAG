import vm from 'node:vm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { FakeDocument, FakeElement, functionSource } from './helpers/html-fake-dom';
import { EMBED_RATING_STRINGS } from '@/app/embed/embed-rating-strings';

const env = process.env as Record<string, string | undefined>;
const TOKEN = 'eyJ2IjoxfQ.c2lnbmF0dXJlLXBsYWNlaG9sZGVy';
const ORIGIN = 'http://localhost';

interface FeedbackCall {
  url: string;
  init: { method?: string; credentials?: string; headers?: Record<string, string>; body?: string; signal?: unknown };
}

interface Harness {
  doc: FakeDocument;
  logs: string[];
  feedbackCalls: FeedbackCall[];
  setFeedbackResponse: (next: () => Promise<{ ok: boolean; status: number }>) => void;
  ask: (question: string, lines: string[]) => Promise<FakeElement>;
}

async function servedScript(): Promise<string> {
  const { GET } = await import('@/app/embed/chat.js/route');
  const response = await GET(new NextRequest(`${ORIGIN}/embed/chat.js`));
  expect(response.status).toBe(200);
  return response.text();
}

async function flush(): Promise<void> {
  for (let i = 0; i < 30; i += 1) await new Promise((resolve) => setImmediate(resolve));
}

function streamBody(lines: string[]) {
  const encoder = new TextEncoder();
  const chunks = lines.map((line) => encoder.encode(line + '\n'));
  let index = 0;
  return {
    getReader() {
      return {
        read: async () => (index < chunks.length ? { done: false, value: chunks[index++] } : { done: true, value: undefined }),
      };
    },
  };
}

async function boot(script: string, language = 'en-US'): Promise<Harness> {
  const doc = new FakeDocument();
  doc.readyState = 'complete';
  (doc as unknown as { currentScript: FakeElement }).currentScript = new FakeElement('script', doc);
  const logs: string[] = [];
  const record = (...args: unknown[]) => {
    logs.push(args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a) ?? String(a))).join(' '));
  };
  const feedbackCalls: FeedbackCall[] = [];
  let feedbackResponse: () => Promise<{ ok: boolean; status: number }> = async () => ({ ok: true, status: 200 });
  let pendingLines: string[] = [];

  const fetchMock = vi.fn(async (url: string, init: FeedbackCall['init']) => {
    if (url === `${ORIGIN}/api/embed/chat`) return { ok: true, status: 200, body: streamBody(pendingLines) };
    if (url === `${ORIGIN}/api/embed/feedback`) {
      feedbackCalls.push({ url, init });
      return feedbackResponse();
    }
    throw new Error(`unexpected fetch ${url}`);
  });

  const sandbox: Record<string, unknown> = {
    document: doc,
    navigator: { language },
    fetch: fetchMock,
    console: { log: record, warn: record, error: record, debug: record, info: record },
    TextDecoder,
    TextEncoder,
    AbortController,
    setTimeout,
    clearTimeout,
  };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  new vm.Script(script).runInContext(sandbox);

  return {
    doc,
    logs,
    feedbackCalls,
    setFeedbackResponse: (next) => {
      feedbackResponse = next;
    },
    ask: async (question, lines) => {
      pendingLines = lines;
      const input = doc.getElementById('myrag-input')!;
      input.value = question;
      doc.getElementById('myrag-send-btn')!.click();
      await flush();
      const messages = doc.getElementById('myrag-messages')!;
      return messages.children[messages.children.length - 1]!;
    },
  };
}

function answerLines(options: { token?: string; text?: string; error?: boolean } = {}): string[] {
  const start = options.token
    ? { type: 'start', messageId: 'm1', messageMetadata: { feedbackToken: options.token } }
    : { type: 'start', messageId: 'm1' };
  const lines = [`data: ${JSON.stringify(start)}`, `data: ${JSON.stringify({ type: 'text-start', id: 't1' })}`];
  if (options.error) lines.push(`data: ${JSON.stringify({ type: 'error', errorText: 'server failure' })}`);
  lines.push(
    `data: ${JSON.stringify({ type: 'text-delta', id: 't1', delta: options.text ?? 'A neutral synthetic answer.' })}`,
    `data: ${JSON.stringify({ type: 'text-end', id: 't1' })}`,
    `data: ${JSON.stringify({ type: 'finish' })}`,
    'data: [DONE]',
  );
  return lines;
}

const group = (answer: FakeElement) => answer.querySelector('.myrag-fb');
const thumbs = (answer: FakeElement) => {
  const found = answer.querySelectorAll('button.myrag-fb-btn');
  expect(found).toHaveLength(2);
  return found;
};
const chips = (answer: FakeElement) => answer.querySelectorAll('button.myrag-fb-chip');
const statusText = (answer: FakeElement) => answer.querySelector('.myrag-fb-status')?.textContent ?? '';

describe('embed widget answer rating (D-11)', () => {
  let savedEnabled: string | undefined;
  let script: string;

  beforeEach(async () => {
    savedEnabled = env.NEXT_PUBLIC_EMBED_ENABLED;
    env.NEXT_PUBLIC_EMBED_ENABLED = 'true';
    vi.resetModules();
    script = await servedScript();
  });

  afterEach(() => {
    if (savedEnabled === undefined) delete env.NEXT_PUBLIC_EMBED_ENABLED;
    else env.NEXT_PUBLIC_EMBED_ENABLED = savedEnabled;
    vi.resetModules();
  });

  it('renders nothing new without a token: the answer holds only its label and bubble and no style is added', async () => {
    const h = await boot(script);
    const answer = await h.ask('first question', answerLines());
    expect(answer.children).toHaveLength(2);
    expect(answer.children[0]!.textContent).toBe('Assistant');
    expect(answer.children[1]!.textContent).toContain('A neutral synthetic answer.');
    expect(h.doc.querySelectorAll('.myrag-fb')).toHaveLength(0);
    expect(h.doc.querySelectorAll('style').some((s) => s.textContent.includes('myrag-fb'))).toBe(false);
    expect(h.feedbackCalls).toHaveLength(0);
  });

  it('renders the two thumbs under a finished answer that carried a token, with accessible names', async () => {
    const h = await boot(script);
    const answer = await h.ask('first question', answerLines({ token: TOKEN }));
    const row = group(answer);
    expect(row).not.toBeNull();
    expect(row!.getAttribute('role')).toBe('group');
    expect(row!.getAttribute('aria-label')).toBe('Rate This Answer');
    const [up, down] = thumbs(answer);
    expect(up!.getAttribute('aria-label')).toBe('Helpful');
    expect(down!.getAttribute('aria-label')).toBe('Not Helpful');
    expect(up!.getAttribute('type')).toBe('button');
    expect(up!.getAttribute('aria-pressed')).toBe('false');
    expect(chips(answer)).toHaveLength(0);
    expect(answer.children.indexOf(row!)).toBeGreaterThan(answer.children.indexOf(answer.children[1]!));
  });

  it('never renders the control after an error event, even with a token', async () => {
    const h = await boot(script);
    const answer = await h.ask('first question', answerLines({ token: TOKEN, error: true }));
    expect(group(answer)).toBeNull();
  });

  it('thumb up posts once without cookies, with the token in the JSON body, and shows the saved state', async () => {
    const h = await boot(script);
    const answer = await h.ask('first question', answerLines({ token: TOKEN }));
    thumbs(answer)[0]!.click();
    await flush();
    expect(h.feedbackCalls).toHaveLength(1);
    const call = h.feedbackCalls[0]!;
    expect(call.init.method).toBe('POST');
    expect(call.init.credentials).toBe('omit');
    expect(JSON.parse(call.init.body!)).toEqual({ token: TOKEN, vote: 'helpful', reasons: [] });
    expect(thumbs(answer)[0]!.getAttribute('aria-pressed')).toBe('true');
    expect(statusText(answer)).toBe('Thanks for your feedback.');
    thumbs(answer)[0]!.click();
    await flush();
    expect(h.feedbackCalls).toHaveLength(1);
  });

  it('thumb down shows three chips; a chip posts once more with the reasons; thumb up removes the chips', async () => {
    const h = await boot(script);
    const answer = await h.ask('first question', answerLines({ token: TOKEN }));
    thumbs(answer)[1]!.click();
    await flush();
    expect(JSON.parse(h.feedbackCalls[0]!.init.body!)).toEqual({ token: TOKEN, vote: 'not_helpful', reasons: [] });
    const chipButtons = chips(answer);
    expect(chipButtons.map((c) => c.textContent)).toEqual(['Wrong', 'Incomplete', 'Not Relevant']);
    expect(answer.querySelector('.myrag-fb-legend')!.textContent).toBe('What Went Wrong? (Optional)');
    chipButtons[1]!.click();
    await flush();
    expect(h.feedbackCalls).toHaveLength(2);
    expect(JSON.parse(h.feedbackCalls[1]!.init.body!)).toEqual({ token: TOKEN, vote: 'not_helpful', reasons: ['incomplete'] });
    expect(chips(answer)[1]!.getAttribute('aria-pressed')).toBe('true');
    expect(answer.querySelectorAll('textarea, input')).toHaveLength(0);
    thumbs(answer)[0]!.click();
    await flush();
    expect(chips(answer)).toHaveLength(0);
    expect(JSON.parse(h.feedbackCalls[2]!.init.body!)).toEqual({ token: TOKEN, vote: 'helpful', reasons: [] });
  });

  it('a 404 removes the control for that answer', async () => {
    const h = await boot(script);
    const answer = await h.ask('first question', answerLines({ token: TOKEN }));
    h.setFeedbackResponse(async () => ({ ok: false, status: 404 }));
    thumbs(answer)[1]!.click();
    await flush();
    expect(answer.querySelectorAll('.myrag-fb, .myrag-fb-reasons')).toHaveLength(0);
    expect(answer.children[1]!.textContent).toContain('A neutral synthetic answer.');
  });

  it('a network error restores the earlier state and shows the retry hint; selecting again retries', async () => {
    const h = await boot(script);
    const answer = await h.ask('first question', answerLines({ token: TOKEN }));
    h.setFeedbackResponse(async () => {
      throw new TypeError('network down');
    });
    thumbs(answer)[0]!.click();
    await flush();
    expect(thumbs(answer)[0]!.getAttribute('aria-pressed')).toBe('false');
    expect(statusText(answer)).toBe('Your rating was not saved. Select it again to retry.');
    expect(answer.querySelector('.myrag-fb-status')!.className).toContain('myrag-fb-status-error');
    h.setFeedbackResponse(async () => ({ ok: true, status: 200 }));
    thumbs(answer)[0]!.click();
    await flush();
    expect(h.feedbackCalls).toHaveLength(2);
    expect(statusText(answer)).toBe('Thanks for your feedback.');
    const next = await h.ask('second question', answerLines({ token: TOKEN, text: 'Another synthetic answer.' }));
    expect(group(next)).not.toBeNull();
  });

  it('a 429 shows the rate-limit hint', async () => {
    const h = await boot(script);
    const answer = await h.ask('first question', answerLines({ token: TOKEN }));
    h.setFeedbackResponse(async () => ({ ok: false, status: 429 }));
    thumbs(answer)[0]!.click();
    await flush();
    expect(statusText(answer)).toBe('Too many ratings just now. Wait a moment, then select it again.');
  });

  it('keeps each answer bound to its own token', async () => {
    const h = await boot(script);
    const first = await h.ask('first question', answerLines({ token: 'first.token' }));
    const second = await h.ask('second question', answerLines({ token: 'second.token', text: 'Second synthetic answer.' }));
    thumbs(first)[0]!.click();
    await flush();
    thumbs(second)[1]!.click();
    await flush();
    expect(h.feedbackCalls.map((c) => JSON.parse(c.init.body!).token)).toEqual(['first.token', 'second.token']);
  });

  it('uses zh and it strings from navigator.language', async () => {
    for (const [language, locale] of [['zh-CN', 'zh'], ['it-IT', 'it']] as const) {
      const h = await boot(script, language);
      const answer = await h.ask('question', answerLines({ token: TOKEN }));
      expect(group(answer)).not.toBeNull();
      expect(group(answer)!.getAttribute('aria-label')).toBe(EMBED_RATING_STRINGS[locale].group);
      expect(thumbs(answer)[0]!.getAttribute('aria-label')).toBe(EMBED_RATING_STRINGS[locale].helpful);
    }
  });

  it('never writes the token to the DOM or to the console', async () => {
    const h = await boot(script);
    const answer = await h.ask('first question', answerLines({ token: TOKEN }));
    thumbs(answer)[1]!.click();
    await flush();
    expect(h.doc.documentElement.innerHTML).not.toContain(TOKEN);
    expect(h.logs.join('\n')).not.toContain(TOKEN);
    expect(h.logs.join('\n')).not.toContain(TOKEN.split('.')[1]);
  });

  it('adds one namespaced style element inside the widget container', async () => {
    const h = await boot(script);
    await h.ask('first question', answerLines({ token: TOKEN }));
    await h.ask('second question', answerLines({ token: TOKEN }));
    const container = h.doc.getElementById('myrag-widget-container')!;
    const styles = container.querySelectorAll('style');
    expect(styles).toHaveLength(1);
    const css = styles[0]!.textContent.replace(/@media[^{]*\{/g, '');
    const selectors = css
      .split('}')
      .map((block) => block.split('{')[0]!.trim())
      .filter(Boolean)
      .flatMap((s) => s.split(',').map((part) => part.trim()));
    expect(selectors.length).toBeGreaterThan(5);
    for (const selector of selectors) expect(selector.startsWith('#myrag-widget-container .myrag-fb')).toBe(true);
    expect(h.doc.head.querySelectorAll('style').some((s) => s.textContent.includes('myrag-fb'))).toBe(false);
  });

  it('builds the new markup without innerHTML or template strings (static check)', () => {
    for (const name of ['attachRating', 'ensureRatingStyles', 'ratingIcon', 'ratingQuietChunk']) {
      expect(script).toMatch(new RegExp(`function ${name}\\s*\\(`));
      const body = functionSource(script, name);
      expect(body).not.toContain('innerHTML');
      expect(body).not.toContain('insertAdjacentHTML');
      expect(body).not.toContain('`');
    }
    expect(script).toContain('/api/embed/feedback');
  });

  it('inlines the shared strings table', () => {
    const match = /const RATING_STRINGS = (\{.*?\});\n/.exec(script);
    expect(match).not.toBeNull();
    expect(JSON.parse(match![1]!)).toEqual(EMBED_RATING_STRINGS);
  });
});
