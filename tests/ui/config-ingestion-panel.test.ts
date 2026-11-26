import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const require = createRequire(import.meta.url);
const repoRoot = path.resolve(import.meta.dirname, '../..');

function loadStatusMonitor() {
  return require('../../scripts/config-ui/document-processing/status-monitor.js') as {
    INGEST_STATUS_LABELS: Record<'en' | 'zh' | 'it', Record<string, string>>;
    ingestLabel: (key: string, locale: 'en' | 'zh' | 'it', vars?: Record<string, unknown>) => string;
    ingestJobStatusView: (job: Record<string, unknown>, locale: 'en' | 'zh' | 'it') => {
      label: string;
      terminal: boolean;
      showRetry?: boolean;
    };
    nextIngestPollDelay: (elapsedMs: number, step: number) => number;
  };
}

function loadProcessDocuments() {
  return require('../../scripts/config-ui/document-processing/process-documents.js') as {
    pollQueuedUpload: (opts: Record<string, unknown>) => Promise<void>;
  };
}

function loadIngestion() {
  return require('../../scripts/config-ui/rag-panels/ingestion.js') as {
    INGESTION_LABELS: Record<'en' | 'zh' | 'it', Record<string, string>>;
    INGESTION_STATUS_FILTERS: Record<string, string[]>;
    ingestionLabel: (key: string, locale: 'en' | 'zh' | 'it', vars?: Record<string, unknown>) => string;
    buildJobRowView: (job: Record<string, unknown>, locale: 'en' | 'zh' | 'it', docType?: string) => Record<string, unknown>;
    buildJobDetailView: (job: Record<string, unknown>, locale: 'en' | 'zh' | 'it', docType?: string) => Record<string, unknown>;
    buildBudgetView: (body: Record<string, unknown>, locale: 'en' | 'zh' | 'it') => Record<string, unknown>;
    buildTierPutBody: (docType: string, min: string, max: string) => { docType: string; minTier: string | null; maxTier: string | null };
    mapIngestionError: (result: Record<string, unknown>, locale: 'en' | 'zh' | 'it', context?: string) => { key: string; message: string };
  };
}

const HIDDEN_JOB_MARKERS: Record<string, unknown> = {
  original_ref: 'MARKER_ORIGINAL',
  settings: { secret: 1 },
  stage_state: 'MARKER_STAGE',
  source_key: 'MARKER_SOURCE',
  file_sha256: 'MARKER_SHA',
  locked_by: 'MARKER_LOCK',
  timings: { secret: 1 },
  trace_id: 'MARKER_TRACE',
  lease_until: '2099-01-01',
  run_after: '2099-01-01',
  runner: 'MARKER_RUNNER',
  lineage_id: 'MARKER_LINEAGE',
  preflight_ref: 'MARKER_PREFLIGHT',
  detect_counts: { x: 1 },
  routing_note: 'MARKER_ROUTE',
  embedding_profile: 'MARKER_EMBED',
  priority: 99,
};

describe('ingestion labels disjoint', () => {
  it('disjoint label tables, locales and ingestionLabel falls back to ingestLabel', () => {
    const { INGEST_STATUS_LABELS, ingestLabel } = loadStatusMonitor();
    const { INGESTION_LABELS, ingestionLabel } = loadIngestion();
    const sharedKeys = new Set<string>();
    for (const loc of ['en', 'zh', 'it'] as const) {
      for (const key of Object.keys(INGEST_STATUS_LABELS[loc])) sharedKeys.add(key);
    }
    const panelKeys = new Set<string>();
    for (const loc of ['en', 'zh', 'it'] as const) {
      for (const key of Object.keys(INGESTION_LABELS[loc])) {
        panelKeys.add(key);
        expect(INGESTION_LABELS[loc][key]?.length).toBeGreaterThan(0);
        expect(INGESTION_LABELS.en[key]).toBeTruthy();
        expect(INGESTION_LABELS.zh[key]).toBeTruthy();
        expect(INGESTION_LABELS.it[key]).toBeTruthy();
      }
    }
    for (const key of sharedKeys) {
      expect(panelKeys.has(key)).toBe(false);
      expect(INGEST_STATUS_LABELS.en[key]).toBeTruthy();
      expect(INGEST_STATUS_LABELS.zh[key]).toBeTruthy();
      expect(INGEST_STATUS_LABELS.it[key]).toBeTruthy();
    }
    expect(ingestionLabel('action.retry', 'en')).toBe(ingestLabel('action.retry', 'en'));
    expect(ingestionLabel('settings.RAG_PARSE_PROGRESSIVE.help', 'en')).toContain(ingestLabel('status.provisional', 'en'));
  });
});

describe('ingestJobStatusView', () => {
  const { ingestJobStatusView, ingestLabel } = loadStatusMonitor();

  it('provisional only when boolean true on non-terminal status', () => {
    const parsing = ingestJobStatusView({ status: 'parsing', provisional: true }, 'en');
    expect(parsing.label).toBe(ingestLabel('status.provisional', 'en'));
    expect(parsing.terminal).toBe(false);

    const absent = ingestJobStatusView({ status: 'parsing' }, 'en');
    expect(absent.label).not.toBe(ingestLabel('status.provisional', 'en'));

    const stringProvisional = ingestJobStatusView({ status: 'parsing', provisional: 'true' }, 'en');
    expect(stringProvisional.label).not.toBe(ingestLabel('status.provisional', 'en'));
  });

  it('failed and needs_review expose retry with localized reasons', () => {
    const failed = ingestJobStatusView({ status: 'failed', error_class: 'budget_exhausted' }, 'en');
    expect(failed.showRetry).toBe(true);
    expect(failed.label).toContain('budget');

    const review = ingestJobStatusView({ status: 'needs_review', needs_review_reason: 'ocr_failed' }, 'en');
    expect(review.showRetry).toBe(true);
    expect(review.label.toLowerCase()).toMatch(/review|ocr/);
  });
});

describe('nextIngestPollDelay and pollQueuedUpload', () => {
  it('nextIngestPollDelay matches 2s then backoff steps', () => {
    const { nextIngestPollDelay } = loadStatusMonitor();
    expect(nextIngestPollDelay(0, 0)).toBe(2000);
    expect(nextIngestPollDelay(59_000, 0)).toBe(2000);
    expect(nextIngestPollDelay(60_000, 0)).toBe(5000);
    expect(nextIngestPollDelay(60_000, 1)).toBe(10_000);
    expect(nextIngestPollDelay(60_000, 2)).toBe(20_000);
    expect(nextIngestPollDelay(60_000, 5)).toBe(30_000);
  });

  it('pollQueuedUpload stops at ready and honors abort', async () => {
    vi.useFakeTimers();
    const { pollQueuedUpload } = loadProcessDocuments();

    const updates: unknown[] = [];
    let calls = 0;
    const fetcher = vi.fn(async (): Promise<{ ok: boolean; status: number; body: { job: { status: string; id: string } } }> => {
      calls += 1;
      if (calls === 1) {
        return { ok: true, status: 200, body: { job: { status: 'parsing', id: 'j1' } } };
      }
      return { ok: true, status: 200, body: { job: { status: 'ready', id: 'j1' } } };
    });

    const ac = new AbortController();
    const done = pollQueuedUpload({
      jobId: 'j1',
      organizationId: 'org-1',
      onUpdate: (u: unknown) => updates.push(u),
      signal: ac.signal,
      fetcher,
      now: () => Date.now(),
      wait: (ms: number) => vi.advanceTimersByTimeAsync(ms),
    });

    await vi.runAllTimersAsync();
    await done;

    expect(fetcher).toHaveBeenCalled();
    const firstPath = String((fetcher.mock.calls as unknown as Array<[string, ...unknown[]]>)[0][0]);
    expect(firstPath).toContain('admin/ingest-jobs/j1');
    expect(firstPath).toContain('organizationId=org-1');
    expect(updates.some((u) => (u as { job?: { status: string } }).job?.status === 'ready')).toBe(true);
    vi.useRealTimers();
  });
});

describe('ingestion builders and mapIngestionError', () => {
  const { buildJobRowView, buildJobDetailView, buildBudgetView, buildTierPutBody, mapIngestionError } = loadIngestion();

  it('dry_run ready row is labelled as dry run, not ingested ready', () => {
    const view = buildJobRowView({ kind: 'dry_run', status: 'ready', filename: 'x.pdf' }, 'en', '');
    expect(view.statusKey).toBe('status.dryRunReady');
    expect(view.statusLabel).toMatch(/dry run/i);
  });

  it('buildTierPutBody maps empty strings to null', () => {
    expect(buildTierPutBody('general', '', 'premium')).toEqual({ docType: 'general', minTier: null, maxTier: 'premium' });
    expect(buildTierPutBody('general', 'fast', '')).toEqual({ docType: 'general', minTier: 'fast', maxTier: null });
  });

  it('buildBudgetView aggregates tenant usage', () => {
    const view = buildBudgetView(
      { month: '2026-11', budgetPages: 500, maxPagesPerDoc: 200, tenants: [{ tenantKey: 't1', used: 10, vlmUsed: 2, reserved: 3 }] },
      'en',
    );
    expect(view.used).toBe('10');
    expect(view.vlmUsed).toBe('2');
    expect(view.reserved).toBe('3');
    expect(view.remaining).toBe('485');
  });

  it('allow-list hides server-only fields', () => {
    const job = {
      ...HIDDEN_JOB_MARKERS,
      id: 'visible-id',
      kind: 'ingest',
      status: 'failed',
      filename: '<img src=x onerror=alert(1)>',
      error_class: 'transient',
      needs_review_reason: 'garbled',
      doc_class: 'general',
      page_ranges: [{ start: 1, end: 2, tier: 'fast', preset: 'fast', layer: 1, status: 'ok', signals: ['tables'], parser: 'evil', cache_id: 'cache' }],
      attempts: [{ attempt_no: 1, parser: '<script>', parser_version: '1', reason: 'initial', tier: 'fast', preset: 'fast' }],
    };
    const row = buildJobRowView(job, 'en', 'General');
    const detail = buildJobDetailView(job, 'en', 'General');
    const merged = JSON.stringify({ row, detail });
    for (const marker of Object.values(HIDDEN_JOB_MARKERS)) {
      expect(merged).not.toContain(String(marker));
    }
    expect(merged).not.toContain('cache');
    expect(row.filename).toContain('<img');
  });

  it('mapIngestionError maps workspace 403 and network throws', () => {
    const workspace = mapIngestionError({ status: 403, body: { error: 'Forbidden' } }, 'en', 'jobs');
    expect(workspace.key).toBe('error.workspace');

    const net = mapIngestionError({ thrown: true }, 'en');
    expect(net.key).toBe('error.network');
  });
});

describe('index.html script load already declared', () => {
  it('already declared: classic scripts load in one vm context without redeclaration errors', () => {
    const html = fs.readFileSync(path.join(repoRoot, 'scripts/config-ui/index.html'), 'utf8');
    const scriptTagRe = /<script(\s[^>]*)?>([\s\S]*?)<\/script>|<script(\s[^>]*?)\s*\/?>(?!<)/gi;
    const scripts: Array<{ type: string; code: string; src?: string }> = [];
    let match: RegExpExecArray | null;
    while ((match = scriptTagRe.exec(html)) !== null) {
      const attrs = match[1] || match[3] || '';
      const type = (attrs.match(/type\s*=\s*["']([^"']+)["']/i) || [])[1] || 'text/javascript';
      if (type !== 'text/javascript' && !type.includes('javascript')) continue;
      const src = (attrs.match(/src\s*=\s*["']([^"']+)["']/i) || [])[1];
      if (src) {
        if (/^https?:\/\//i.test(src)) continue;
        const local = path.join(repoRoot, 'scripts/config-ui', src.replace(/\?.*$/, ''));
        if (!fs.existsSync(local)) continue;
        scripts.push({ type, code: fs.readFileSync(local, 'utf8'), src });
      } else {
        scripts.push({ type, code: match[2] || '' });
      }
    }

    const context: Record<string, unknown> = {
      window: {},
      document: {
        addEventListener: () => {},
        querySelector: () => null,
        querySelectorAll: () => [],
        getElementById: () => null,
        createElement: () => ({ style: {}, appendChild: () => {}, setAttribute: () => {}, addEventListener: () => {} }),
        hidden: false,
        visibilityState: 'visible',
      },
      console,
      setTimeout,
      clearTimeout,
      setInterval,
      clearInterval,
      fetch: async () => ({ ok: true, json: async () => ({}) }),
      FormData,
      File,
      Blob,
      AbortController,
      CustomEvent,
      Event,
      DOMException,
      navigator: { language: 'en' },
      location: { origin: 'http://localhost:3333', href: 'http://localhost:3333' },
    };
    context.globalThis = context;
    context.window = context;
    vm.createContext(context);

    const redeclare = /has already been declared/i;
    for (const script of scripts) {
      try {
        const compiled = new vm.Script(script.code, { filename: script.src || 'inline.html' });
        compiled.runInContext(context, { timeout: 2000 });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (redeclare.test(msg)) throw err;
      }
    }
  });
});

describe('relocated ingestion settings region', () => {
  it('holds twelve env ids once and excludes secrets', () => {
    const html = fs.readFileSync(path.join(repoRoot, 'scripts/config-ui/index.html'), 'utf8');
    const region = html.match(/rag-ingestion-settings:start([\s\S]*?)rag-ingestion-settings:end/)?.[1] ?? '';
    const ids = [
      'RAG_PARSE_ROUTING',
      'RAG_INGEST_ASYNC',
      'RAG_PARSER_ALLOW_CLOUD',
      'RAG_PARSE_ESCALATION',
      'RAG_PARSE_PROGRESSIVE',
      'RAG_PARSE_PREMIUM_PAGE_BUDGET',
      'RAG_PARSE_PREMIUM_MAX_PAGES_PER_DOC',
      'RAG_PARSE_VLM_DETECT',
      'RAG_PARSE_VLM_MODEL',
      'RAG_INGEST_WORKER_CONCURRENCY',
      'RAG_EMBED_BATCH_MODE',
      'NEXT_PUBLIC_RAG_INGEST_REALTIME',
    ];
    for (const id of ids) {
      expect(region).toContain(`id="${id}"`);
      expect((html.match(new RegExp(`id="${id}"`, 'g')) || []).length).toBe(1);
    }
    expect(region).not.toMatch(/VOYAGE_API_KEY|type="password"|id="[A-Z0-9_]*(KEY|SECRET|TOKEN|PASSWORD)/);
  });
});

describe('the held or skipped status filter includes pending_review (UI-SPEC decision 16, 12.8)', () => {
  it('the other group asks for quarantined, skipped_duplicate and pending_review', () => {
    const { INGESTION_STATUS_FILTERS } = loadIngestion();
    expect(INGESTION_STATUS_FILTERS?.other).toEqual(['quarantined', 'skipped_duplicate', 'pending_review']);
    expect(Object.values(INGESTION_STATUS_FILTERS ?? {}).flat().filter((s) => s === 'pending_review')).toHaveLength(1);
  });

  it('labels the group Held or skipped in en, zh and it, and in the static radio name', () => {
    const { ingestionLabel } = loadIngestion();
    expect(ingestionLabel('filter.other', 'en')).toBe('Held or skipped');
    expect(ingestionLabel('filter.other', 'zh')).toBe('已暂缓或跳过');
    expect(ingestionLabel('filter.other', 'it')).toBe('Trattenuti o saltati');
    const html = fs.readFileSync(path.join(repoRoot, 'scripts/config-ui/index.html'), 'utf8');
    expect(html).toContain('name="ingestion-status" value="other" aria-label="Held or skipped"');
    expect(html).not.toContain('Quarantined or skipped');
  });

  it('a pending_review job reads Awaiting approval, with 等待批准 in zh, and is terminal for polling', () => {
    const { buildJobRowView } = loadIngestion();
    const { ingestJobStatusView } = loadStatusMonitor();
    expect(buildJobRowView({ id: 'j1', status: 'pending_review', filename: 'a.pdf' }, 'en', '').statusLabel).toBe('Awaiting approval');
    expect(buildJobRowView({ id: 'j1', status: 'pending_review', filename: 'a.pdf' }, 'zh', '').statusLabel).toBe('等待批准');
    const view = ingestJobStatusView({ status: 'pending_review' }, 'it') as { label: string; terminal: boolean; icon?: string };
    expect(view.label).toBe('In attesa di approvazione');
    expect(view.terminal).toBe(true);
    expect(view.icon).toBe('bi-hourglass');
  });
});
