import { create } from 'zustand';
import type { AnswerRecord } from '@/lib/rag-eval/contracts.generated';

interface AnswerRecordsState {
  records: Record<string, AnswerRecord>;
  upsert: (record: AnswerRecord) => void;
  upsertMany: (records: AnswerRecord[]) => void;
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
}));
