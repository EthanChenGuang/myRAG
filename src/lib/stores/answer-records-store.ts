import { create } from 'zustand';
import type { AnswerRecord } from '@/lib/rag-eval/contracts.generated';

interface AnswerRecordsState {
  records: Record<string, AnswerRecord>;
  upsert: (record: AnswerRecord) => void;
  upsertMany: (records: AnswerRecord[]) => void;
}

export const useAnswerRecordsStore = create<AnswerRecordsState>()(() => ({
  records: {},
  upsert: () => {},
  upsertMany: () => {},
}));
