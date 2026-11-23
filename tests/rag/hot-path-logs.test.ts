import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { voiceKeywordFallback } from '@/lib/rag/voice/keyword-fallback';
import { resolveDocumentRefs } from '@/lib/rag/refs/resolve';
import { mintScope } from '@/lib/rag/tenant/scope';

const SECRET_WORD = 'zebrafishquartz';

function builder(result: { data: unknown[]; error: null }) {
  const chain: Record<string, unknown> = {};
  for (const name of ['select', 'eq', 'is', 'in', 'ilike', 'or', 'limit', 'order', 'abortSignal', 'not', 'gt']) chain[name] = () => chain;
  chain.then = (resolve: (value: unknown) => unknown, reject?: (reason: unknown) => unknown) => Promise.resolve(result).then(resolve, reject);
  return chain;
}

const emptyAdmin = { from: () => builder({ data: [], error: null }), rpc: () => builder({ data: [], error: null }) } as never;

function loggedText(): string {
  const spies = [console.log, console.info, console.debug, console.warn];
  return spies
    .flatMap((spy) => vi.mocked(spy).mock.calls)
    .map((call) => call.map((part) => (typeof part === 'string' ? part : JSON.stringify(part))).join(' '))
    .join('\n');
}

beforeEach(() => {
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  vi.spyOn(console, 'info').mockImplementation(() => undefined);
  vi.spyOn(console, 'debug').mockImplementation(() => undefined);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});

afterEach(() => vi.restoreAllMocks());

describe('retrieval hot paths do not log user query content', () => {
  test('voice keyword fallback', async () => {
    await voiceKeywordFallback({
      query: `tell me about ${SECRET_WORD} pricing`,
      scope: mintScope('single', null, null),
      admin: emptyAdmin,
      signal: new AbortController().signal,
      existing: [],
    });
    expect(loggedText()).not.toContain(SECRET_WORD);
  });

  test('document mention resolution', async () => {
    await resolveDocumentRefs({
      scope: mintScope('single', null, null),
      mentions: [SECRET_WORD],
      documentParts: [],
      admin: emptyAdmin,
      signal: new AbortController().signal,
    });
    expect(loggedText()).not.toContain(SECRET_WORD);
  });
});
