import { createElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, test, vi } from 'vitest';

vi.mock('@/components/providers/auth-provider', () => ({ useAuth: () => ({ user: null }) }));
vi.mock('@/components/theme-provider', () => ({ useTheme: () => ({ theme: 'light', resolvedTheme: 'light' }) }));
vi.mock('@/components/providers/text-size-provider', () => ({ useTextSize: () => ({ textSize: 'default' }) }));
vi.mock('@/components/providers/font-provider', () => ({ useFont: () => ({ fontFamily: 'inter' }) }));
vi.mock('@/components/providers/artifact-provider', () => ({ useArtifact: () => ({ openArtifact: () => {} }) }));
vi.mock('@/components/providers/model-provider', () => ({ useModel: () => ({ selectedModel: 'test/model' }) }));
vi.mock('@/components/providers/language-provider', () => ({
  useLanguage: () => ({ language: 'en', setLanguage: () => {}, t: (key: string) => key }),
}));
vi.mock('@/components/ui/use-toast', () => ({ useToast: () => ({ toast: () => {} }) }));
vi.mock('@/components/ui/markdown', async () => {
  const { default: ReactMarkdown } = await import('react-markdown');
  return {
    Markdown: ({ children, components }: { children?: string; components?: Record<string, unknown> }) =>
      createElement(ReactMarkdown as never, { components }, children),
  };
});
vi.mock('@/components/providers/sources-provider', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/components/providers/sources-provider')>();
  return {
    ...actual,
    useSources: () => ({ sources: [], setSources: () => {}, isSourcesOpen: false, trackedSetIsSourcesOpen: () => {}, hasAvailableSources: false }),
  };
});

const { ChatMessage, visibleToolParts } = (await import('@/components/ui/chat-message')) as typeof import('@/components/ui/chat-message');

const TEXT = 'The total is 12, from 5 plus 7.';
const TOOL_BOX = 'tool-invocation-wrapper';

function render(content: unknown): string {
  return renderToStaticMarkup(
    createElement(ChatMessage as never, {
      message: { id: 'm-1', role: 'assistant', parts: [], content },
      isLastMessage: false,
    }) as ReactNode as never,
  );
}

const calcCall = (id: string) => ({ type: 'tool-call', toolName: 'calculate', toolCallId: id, args: { operation: 'sum', operands: ['5', '7'] } });
const calcResult = (id: string, output: unknown) => ({ type: 'tool-result', toolName: 'calculate', toolCallId: id, output });

describe('calculate tool part (UI-SPEC 14.1, 14.5 decision 22)', () => {
  test('an ok calculate call and result render no tool box and no approval prompt', () => {
    const html = render([{ type: 'text', text: TEXT }, calcCall('c1'), calcResult('c1', { status: 'ok', value: '12' })]);
    expect(html).toContain('The total is 12');
    expect(html).not.toContain(TOOL_BOX);
    expect(html).not.toMatch(/approve/i);
    expect(html).not.toMatch(/calculate/i);
  });

  test('a rejected calculate result is also silent and the text continues', () => {
    const html = render([{ type: 'text', text: TEXT }, calcCall('c2'), calcResult('c2', { status: 'rejected', reason: 'too_many_operands' })]);
    expect(html).toContain('The total is 12');
    expect(html).not.toContain(TOOL_BOX);
    expect(html).not.toContain('too_many_operands');
  });

  test('a calculate result without a tool name is dropped with its call', () => {
    const html = render([{ type: 'text', text: TEXT }, calcCall('c3'), { type: 'tool-result', toolCallId: 'c3', output: { status: 'ok' } }]);
    expect(html).not.toContain(TOOL_BOX);
  });

  test('an approval marker naming calculate shows no approval prompt', () => {
    const html = render(`${TEXT}\n__REQUIRES_APPROVAL__:c4:calculate`);
    expect(html).not.toContain(TOOL_BOX);
    expect(html).not.toMatch(/approve/i);
  });

  test('another tool call still renders its tool box', () => {
    const html = render([{ type: 'text', text: TEXT }, { type: 'tool-call', toolName: 'gmail_find_email', toolCallId: 'm1', args: {} }]);
    expect(html).toContain(TOOL_BOX);
  });

  test('visibleToolParts drops calculate calls and their results only', () => {
    expect(typeof visibleToolParts).toBe('function');
    const web = { type: 'tool-result', toolName: 'webSearch', toolCallId: 'w1', output: [] };
    const mcp = { type: 'tool-call', toolName: 'gmail_find_email', toolCallId: 'm1', args: {} };
    const text = { type: 'text', text: TEXT };
    const parts = [text, calcCall('c1'), calcResult('c1', {}), { type: 'tool-result', toolCallId: 'c1', output: {} }, web, mcp];
    expect(visibleToolParts(parts as never)).toEqual([text, web, mcp]);
    const plain = [text, web, mcp];
    expect(visibleToolParts(plain as never)).toBe(plain);
  });
});

describe('review queue reasons for calculations (UI-SPEC 14.4)', () => {
  test('calc_mismatch and calc_unverified are listed and labelled in en, zh and it', async () => {
    const mod = (await import('../../scripts/config-ui/rag-panels/review-labelling.js')) as unknown as {
      default?: { REVIEW_LABELLING_LABELS: Record<string, Record<string, string>>; REVIEW_LABELLING_REASONS: string[] };
      REVIEW_LABELLING_LABELS: Record<string, Record<string, string>>;
      REVIEW_LABELLING_REASONS: string[];
    };
    const lib = mod.default ?? mod;
    expect(lib.REVIEW_LABELLING_REASONS).toEqual(expect.arrayContaining(['calc_mismatch', 'calc_unverified']));
    const expected: Record<string, [string, string]> = {
      en: ['Calculation corrected', 'Calculation not verified'],
      zh: ['计算已更正', '计算未核实'],
      it: ['Calcolo corretto', 'Calcolo non verificato'],
    };
    for (const [locale, [mismatch, unverified]] of Object.entries(expected)) {
      expect(lib.REVIEW_LABELLING_LABELS[locale]!['reason.calc_mismatch'], locale).toBe(mismatch);
      expect(lib.REVIEW_LABELLING_LABELS[locale]!['reason.calc_unverified'], locale).toBe(unverified);
    }
  });
});
