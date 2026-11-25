import type { QueryLlm } from '../../src/lib/rag/query/llm';

export interface FakeQueryLlmTable {
  version: 1;
  entries: unknown[];
}

export function createFakeQueryLlm(_options: { table: FakeQueryLlmTable }): QueryLlm {
  return {
    model: 'fake-query-llm',
    async generate() {
      throw new Error('not implemented');
    },
  };
}

export function loadFakeQueryLlmTable(_path?: string): { version: 1; entries: Array<any> } {
  return { version: 1, entries: [] };
}

export function normalizeFakeQuery(text: string): string {
  return text;
}
