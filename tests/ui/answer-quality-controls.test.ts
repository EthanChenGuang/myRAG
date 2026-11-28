import { createElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, test, vi } from 'vitest';

const lang = vi.hoisted(() => ({ current: 'en' }));

vi.mock('@/components/providers/auth-provider', () => ({ useAuth: () => ({ user: null }) }));
vi.mock('@/components/theme-provider', () => ({ useTheme: () => ({ theme: 'light', resolvedTheme: 'light' }) }));
vi.mock('@/components/providers/text-size-provider', () => ({ useTextSize: () => ({ textSize: 'default' }) }));
vi.mock('@/components/providers/font-provider', () => ({ useFont: () => ({ fontFamily: 'inter' }) }));
vi.mock('@/components/providers/artifact-provider', () => ({ useArtifact: () => ({ openArtifact: () => {} }) }));
vi.mock('@/components/providers/model-provider', () => ({ useModel: () => ({ selectedModel: 'test/model' }) }));
vi.mock('@/components/providers/language-provider', () => ({
  useLanguage: () => ({ language: lang.current, setLanguage: () => {}, t: (key: string) => key }),
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
    useSources: () => ({
      sources: [],
      setSources: () => {},
      isSourcesOpen: false,
      trackedSetIsSourcesOpen: () => {},
      hasAvailableSources: false,
    }),
  };
});

const { ChatMessage } = await import('@/components/ui/chat-message');
const { GroundednessBadge } = await import('@/components/ui/groundedness-badge');
const { AnswerFeedback } = await import('@/components/ui/answer-feedback');
const { useAnswerRecordsStore } = await import('@/lib/stores/answer-records-store');
type AnswerRecord = import('@/lib/rag-eval/contracts.generated').AnswerRecord;

const ANSWER_ID = '7d4a2c8e-1f3b-4c5d-9e6f-0a1b2c3d4e5f';
const CHAT_ID = '22222222-2222-4222-8222-222222222222';

function groundedness(status: 'pending' | 'scored' | 'not_checked', label: string | null, reason: string | null = null): AnswerRecord['groundedness'] {
  return {
    checkedAt: null, label: label as never, latencyMs: 12, reason, score: status === 'scored' ? 0.8731 : null,
    scorer: 'hhem_2_1_open', status, threshold: 0.5, thresholdSource: 'default', truncated: false,
  };
}

function record(overrides: Partial<AnswerRecord> = {}): AnswerRecord {
  return {
    answerId: ANSWER_ID, answerLanguage: 'en', chatId: CHAT_ID, citationStrategy: null, createdAt: '2026-11-25T09:00:00.000Z',
    feedback: null, feedbackEnabled: true, groundedness: groundedness('scored', 'verified'), invalidCitations: 0,
    modelId: 'test/model', ragMode: 'strict', traceId: 'trace-1', updatedAt: '2026-11-25T09:00:00.000Z', ...overrides,
  };
}

const badge = (props: Record<string, unknown> = {}) =>
  renderToStaticMarkup(createElement(GroundednessBadge, { answerId: ANSWER_ID, ...props }) as ReactNode as never);
const feedback = () => renderToStaticMarkup(createElement(AnswerFeedback, { answerId: ANSWER_ID }) as ReactNode as never);

// renderToStaticMarkup reads zustand's server snapshot, the initial state, so records are written into that object.
const serverRecords = useAnswerRecordsStore.getInitialState().records;
function put(r: AnswerRecord) {
  serverRecords[r.answerId] = r;
}

beforeEach(() => {
  lang.current = 'en';
  for (const key of Object.keys(serverRecords)) delete serverRecords[key];
});

describe('GroundednessBadge', () => {
  test.each([
    ['verified', groundedness('scored', 'verified'), 'Verified'],
    ['possibly_unreliable', groundedness('scored', 'possibly_unreliable'), 'Possibly Unreliable'],
    ['not_checked', groundedness('not_checked', 'not_checked', 'unsupported_language'), 'Not Checked'],
  ] as const)('shows the %s pill with its sentence and no number', (state, g, text) => {
    put(record({ groundedness: g }));
    const html = badge();
    expect(html).toContain(`data-groundedness-badge="${state}"`);
    expect(html).toContain(text);
    expect(html.replace(/<[^>]*>/g, ' ')).not.toMatch(/\d/);
    expect(html).not.toMatch(/0\.87|87%|data-score|score=/);
  });

  test.each([
    ['pending', record({ groundedness: groundedness('pending', null) })],
    ['flexible mode', record({ ragMode: 'flexible' })],
    ['bypass mode', record({ ragMode: 'bypass' })],
    ['refusal (not_eligible)', record({ groundedness: groundedness('not_checked', 'not_checked', 'not_eligible') })],
    ['switch off', record({ groundedness: groundedness('not_checked', 'not_checked', 'disabled') })],
    ['aborted', record({ groundedness: groundedness('not_checked', 'not_checked', 'aborted') })],
  ])('renders nothing when %s', (_name, r) => {
    put(r);
    expect(badge()).toBe('');
  });

  test('without a record (ghost chat) and without metadata it renders nothing; shared-chat metadata still shows', () => {
    expect(badge()).toBe('');
    expect(badge({ fallback: groundedness('scored', 'possibly_unreliable') })).toContain('Possibly Unreliable');
  });

  test('labels are localized in zh and it', () => {
    put(record());
    lang.current = 'zh';
    expect(badge()).toContain('已核验');
    lang.current = 'it';
    expect(badge()).toContain('Verificata');
  });
});

describe('AnswerFeedback', () => {
  test('renders nothing without a record or when feedback is disabled', () => {
    expect(feedback()).toBe('');
    put(record({ feedbackEnabled: false }));
    expect(feedback()).toBe('');
  });

  test('renders thumbs up and down with the current vote pressed', () => {
    put(
      record({ feedback: { vote: 'not_helpful', reasons: ['wrong'], comment: '<b>x</b>', updatedAt: '2026-11-25T09:00:01.000Z' } }),
    );
    const html = feedback();
    expect(html).toContain('aria-label="Helpful"');
    expect(html).toContain('aria-label="Not Helpful"');
    expect(html).toMatch(/aria-pressed="true"[^>]*aria-label="Not Helpful"/);
    expect(html).toMatch(/aria-pressed="false"[^>]*aria-label="Helpful"/);
    expect(html).not.toContain('<b>x</b>');
  });
});

describe('ChatMessage action row', () => {
  const render = () =>
    renderToStaticMarkup(
      createElement(ChatMessage as never, {
        message: { id: 'm-1', role: 'assistant', parts: [], content: [{ type: 'text', text: 'Paris is big.' }], metadata: { answerId: ANSWER_ID } },
        isLastMessage: true,
      }) as ReactNode as never,
    );

  test('shows the badge and the feedback control for a recorded answer', () => {
    put(record());
    const html = render();
    expect(html).toContain('data-groundedness-badge="verified"');
    expect(html).toContain(`data-answer-feedback="${ANSWER_ID}"`);
  });

  test('shows neither for a message without a record', () => {
    const html = render();
    expect(html).not.toContain('data-groundedness-badge');
    expect(html).not.toContain('data-answer-feedback');
  });
});
