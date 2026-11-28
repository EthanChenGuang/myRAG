import { create } from 'zustand';
import type { AnswerRecord } from '@/lib/rag-eval/contracts.generated';

interface AnswerRecordsState {
  records: Record<string, AnswerRecord>;
  upsert: (record: AnswerRecord) => void;
  upsertMany: (records: AnswerRecord[]) => void;
  /** Replaces one record's feedback (optimistic vote or rollback); no-op when the record is not loaded. */
  setFeedback: (answerId: string, feedback: AnswerRecord['feedback']) => void;
}

function isNewer(incoming: AnswerRecord, current: AnswerRecord | undefined): boolean {
  if (!current) return true;
  const a = Date.parse(incoming.updatedAt);
  const b = Date.parse(current.updatedAt);
  if (Number.isNaN(b)) return true;
  if (Number.isNaN(a)) return false;
  return a > b || (a === b && JSON.stringify(incoming) !== JSON.stringify(current));
}

function upsertAll(records: Record<string, AnswerRecord>, incoming: AnswerRecord[]): Record<string, AnswerRecord> {
  let next = records;
  for (const record of incoming) {
    if (!isNewer(record, next[record.answerId])) continue;
    if (next === records) next = { ...records };
    next[record.answerId] = record;
  }
  return next;
}

export const useAnswerRecordsStore = create<AnswerRecordsState>()((set) => ({
  records: {},
  upsert: (record) => set((state) => {
    const records = upsertAll(state.records, [record]);
    return records === state.records ? state : { records };
  }),
  upsertMany: (incoming) => set((state) => {
    const records = upsertAll(state.records, incoming);
    return records === state.records ? state : { records };
  }),
  setFeedback: (answerId, feedback) => set((state) => {
    const current = Object.prototype.hasOwnProperty.call(state.records, answerId) ? state.records[answerId] : undefined;
    if (!current || current.feedback === feedback) return state;
    const updatedAt = feedback && Date.parse(feedback.updatedAt) > Date.parse(current.updatedAt) ? feedback.updatedAt : current.updatedAt;
    return { records: { ...state.records, [answerId]: { ...current, feedback, updatedAt } } };
  }),
}));
