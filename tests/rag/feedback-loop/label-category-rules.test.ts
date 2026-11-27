import { describe, expect, it } from 'vitest';
import { LabelRequestSchema } from '@/lib/rag/feedback-loop/labels';

const evidence = [
  { chunk_id: 'chunk-0001', document_id: '00000000-0000-4000-8000-000000000001', document_name: 'Document A', quote: 'Item A takes 4 units.', section: 'Section 1' },
];

function label(category: string, answerable: boolean) {
  return {
    status: 'labelled',
    label: {
      answerable,
      category,
      evidence: answerable ? evidence : [],
      expected_answer: answerable ? 'Item A takes 4 units.' : null,
      language: 'en',
      triage: ['kb_gap'],
    },
  };
}

describe('ExpertLabel category rules match the Pydantic UNANSWERABLE_CATEGORIES (05.2-27)', () => {
  it('treats off_topic_context as unanswerable', () => {
    expect(LabelRequestSchema.safeParse(label('off_topic_context', false)).success).toBe(true);
    expect(LabelRequestSchema.safeParse(label('off_topic_context', true)).success).toBe(false);
  });

  it('keeps partial_answer and stale_version answerable', () => {
    for (const category of ['partial_answer', 'stale_version']) {
      expect(LabelRequestSchema.safeParse(label(category, true)).success).toBe(true);
      expect(LabelRequestSchema.safeParse(label(category, false)).success).toBe(false);
    }
  });

  it('keeps no_answer and small_talk unanswerable', () => {
    for (const category of ['no_answer', 'small_talk']) {
      expect(LabelRequestSchema.safeParse(label(category, false)).success).toBe(true);
      expect(LabelRequestSchema.safeParse(label(category, true)).success).toBe(false);
    }
  });
});
