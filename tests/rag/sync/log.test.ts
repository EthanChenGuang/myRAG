import { describe, expect, it } from 'vitest';
import type { VectorSyncSliceReport } from '@/lib/rag-eval/contracts.generated';
import { drainSlice } from '@/lib/rag/sync/drain';
import { logVectorSync } from '@/lib/rag/sync/log';
import { createFakeVectorStore } from '@/lib/rag/sync/stores/fake';
import { traceVectorSync } from '@/lib/rag/sync/trace';
import type { LangfuseConfig } from '@/lib/rag/trace/config';
import type { CollectedTrace } from '@/lib/rag/trace/langfuse';
import { createFakeRpc, fakeClock } from './fake-rpc';

const TENANT = 'u:00000000-0000-4000-8000-0000000000a1';
const DOC = '00000000-0000-4000-8000-d00000000001';
const MARKER = 'zqxmarkerzqx';
const FIELDS = ['claimed', 'dead', 'deleted', 'elapsedMs', 'failed', 'lagSeconds', 'mode', 'upserted'];

const REPORT: VectorSyncSliceReport = {
  mode: 'drain',
  claimed: 3,
  upserted: 2,
  deleted: 1,
  failed: 0,
  dead: 0,
  lag_seconds: 1.5,
  elapsed_ms: 12,
  budget_ms: 45000,
  more_pending: false,
};

function config(enabled: boolean): LangfuseConfig {
  return {
    enabled,
    publicKey: enabled ? 'pk-placeholder' : '',
    secretKey: enabled ? 'sk-placeholder' : '',
    baseUrl: 'http://localhost:0',
    sampleRate: 1,
    reviewSampleRate: 0,
    captureContent: false,
  };
}

function parse(line: string): Record<string, unknown> {
  expect(line.startsWith('[Vector Sync] ')).toBe(true);
  return JSON.parse(line.slice('[Vector Sync] '.length)) as Record<string, unknown>;
}

describe('logVectorSync', () => {
  it('writes one line with exactly the fixed fields', () => {
    const lines: string[] = [];
    logVectorSync(REPORT, (line) => lines.push(line));
    expect(lines).toHaveLength(1);
    const payload = parse(lines[0]);
    expect(Object.keys(payload).sort()).toEqual(FIELDS);
    expect(payload).toMatchObject({ mode: 'drain', claimed: 3, upserted: 2, deleted: 1, lagSeconds: 1.5, elapsedMs: 12 });
  });

  it('drops an extra key to the fixed field list', () => {
    const lines: string[] = [];
    logVectorSync({ ...REPORT, text: MARKER, tenant_key: TENANT } as unknown as VectorSyncSliceReport, (line) => lines.push(line));
    expect(lines).toHaveLength(1);
    expect(Object.keys(parse(lines[0])).sort()).toEqual(FIELDS);
    expect(lines[0]).not.toContain(MARKER);
    expect(lines[0]).not.toContain(TENANT);
  });
});

describe('drain logging', () => {
  it('a full drain over marker text logs one line per slice with no marker, lexical token or tenant key', async () => {
    const clock = fakeClock();
    const rpc = createFakeRpc(clock);
    rpc.addDocument({ id: DOC, tenant_key: TENANT }, [
      {
        id: '00000000-0000-4000-8000-000000000001',
        document_id: DOC,
        tenant_key: TENANT,
        vector: [1, 0, 0],
        lexical_text: `${MARKER}lex alpha`,
        content: `neutral synthetic sentence ${MARKER}`,
      },
    ]);
    rpc.enqueue({ entity: 'document', entity_id: DOC, tenant_key: TENANT });
    rpc.enqueue({ entity: 'tenant', entity_id: TENANT, tenant_key: TENANT });
    const lines: string[] = [];
    const store = createFakeVectorStore('qdrant');
    await drainSlice({ store, rpc: rpc.client, now: clock.now, sink: (line) => lines.push(line), trace: false });
    expect(lines).toHaveLength(1);
    expect(Object.keys(parse(lines[0])).sort()).toEqual(FIELDS);
    for (const line of lines) {
      expect(line).not.toContain(MARKER);
      expect(line).not.toContain('alpha');
      expect(line).not.toContain(TENANT);
      expect(line).not.toContain(DOC);
    }
  });
});

describe('traceVectorSync', () => {
  it('sends nothing when Langfuse is disabled', async () => {
    const sent: CollectedTrace[] = [];
    traceVectorSync(REPORT, { config: config(false), exportTrace: async (t) => void sent.push(t) });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(sent).toEqual([]);
  });

  it('sends one vector_sync trace with numbers only when enabled', async () => {
    const sent: CollectedTrace[] = [];
    traceVectorSync({ ...REPORT, note: MARKER } as unknown as VectorSyncSliceReport, {
      config: config(true),
      exportTrace: async (t) => void sent.push(t),
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(sent).toHaveLength(1);
    const [trace] = sent;
    expect(trace.name).toBe('vector_sync');
    const attributes = trace.stages.flatMap((stage) => Object.values(stage.attributes ?? {}));
    expect(attributes.length).toBeGreaterThan(0);
    expect(attributes.every((value) => typeof value === 'number' || value === 'drain' || typeof value === 'boolean')).toBe(true);
    expect(JSON.stringify(trace)).not.toContain(MARKER);
  });

  it('never blocks the slice', async () => {
    const clock = fakeClock();
    const rpc = createFakeRpc(clock);
    let calls = 0;
    const report = await drainSlice({
      store: createFakeVectorStore('qdrant'),
      rpc: rpc.client,
      now: clock.now,
      sink: () => undefined,
      trace: {
        config: config(true),
        exportTrace: () => {
          calls += 1;
          return new Promise<void>(() => undefined);
        },
      },
    });
    expect(report.mode).toBe('drain');
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(calls).toBe(1);
  });
});
