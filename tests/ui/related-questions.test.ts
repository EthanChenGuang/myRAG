import { isValidElement, type ReactElement, type ReactNode } from 'react';
import { describe, expect, test, vi } from 'vitest';

vi.mock('react', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react')>();
  return { ...actual, useId: () => 'related-heading' };
});

const { RelatedQuestions } = await import('@/components/ui/related-questions');

type AnyElement = ReactElement<Record<string, unknown> & { children?: ReactNode }>;

function collect(node: ReactNode, match: (el: AnyElement) => boolean, out: AnyElement[] = []): AnyElement[] {
  if (Array.isArray(node)) {
    for (const child of node) collect(child, match, out);
    return out;
  }
  if (!isValidElement(node)) return out;
  const el = node as AnyElement;
  if (match(el)) out.push(el);
  collect(el.props.children, match, out);
  return out;
}

function render(props: Parameters<typeof RelatedQuestions>[0]) {
  return RelatedQuestions(props) as ReactNode;
}

const QUESTIONS = ['First question?', 'Second question?'];

describe('RelatedQuestions', () => {
  test('each row is a full-width button that sends its question when clicked', () => {
    const onSelect = vi.fn();
    const tree = render({ questions: QUESTIONS, heading: 'Related', onSelect });
    const buttons = collect(tree, (el) => el.type === 'button');
    expect(buttons).toHaveLength(2);
    for (const button of buttons) {
      expect(button.props.type).toBe('button');
      expect(button.props.disabled).toBe(false);
      expect(String(button.props.className)).toContain('w-full');
      expect(String(button.props.className)).toContain('min-h-[44px]');
      expect(String(button.props.className)).toContain('focus-visible:ring-2');
    }
    (buttons[1].props.onClick as () => void)();
    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(onSelect).toHaveBeenCalledWith('Second question?');
  });

  test('rows are disabled while a response is streaming', () => {
    const tree = render({ questions: QUESTIONS, heading: 'Related', onSelect: vi.fn(), disabled: true });
    const buttons = collect(tree, (el) => el.type === 'button');
    expect(buttons.every((b) => b.props.disabled === true)).toBe(true);
  });

  test('without a send handler the rows are static text, not buttons', () => {
    const tree = render({ questions: QUESTIONS, heading: 'Related' });
    expect(collect(tree, (el) => el.type === 'button')).toHaveLength(0);
    expect(collect(tree, (el) => el.type === 'li')).toHaveLength(2);
  });

  test('renders nothing for an empty list', () => {
    expect(render({ questions: [], heading: 'Related', onSelect: vi.fn() })).toBeNull();
  });
});
