import fs from 'node:fs';
import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';
import { FakeDocument, FakeElement, FakeText, type FakeNode } from './helpers/html-fake-dom';

const require = createRequire(import.meta.url);

type FetchResult = { ok: boolean; status: number; body?: unknown };
type Fetcher = (path: string, init?: { method?: string }) => Promise<FetchResult>;

interface Banner {
  gatesUiBannerPlan: (config: Record<string, unknown> | null | undefined) => { alerts: boolean; uncal: boolean };
  gatesUiMountBanner: (config: Record<string, unknown> | null | undefined, deps: Record<string, unknown>) => Promise<unknown>;
  gatesUiRefreshBanner: () => Promise<unknown>;
}

function load(): Banner {
  return require('../../scripts/config-ui/rag-panels/gates-ui.js') as Banner;
}

function text(node: FakeNode): string {
  if (node instanceof FakeText) return node.data;
  return node.childNodes.map(text).join('');
}

const ALERTS = '/api/rag/admin/monitor/alerts?status=open&limit=1';
const REFUSAL = '/api/rag/admin/refusal-calibration';

function fakeFetcher(routes: Record<string, FetchResult>) {
  const calls: string[] = [];
  const fetcher: Fetcher = async (path, init) => {
    calls.push(`${init?.method ?? 'GET'} ${path}`);
    return routes[path] ?? { ok: false, status: 404, body: { error: 'Not found' } };
  };
  return { fetcher, calls };
}

async function withPage<T>(fn: (doc: FakeDocument, host: FakeElement) => Promise<T>): Promise<T> {
  const doc = new FakeDocument();
  const holder = globalThis as unknown as { document?: unknown };
  const previous = holder.document;
  holder.document = doc;
  const main = doc.createElement('div');
  main.className = 'p-6';
  const host = doc.createElement('div');
  host.id = 'rag-attention-banner';
  main.appendChild(host);
  doc.body.appendChild(main);
  try {
    return await fn(doc, host);
  } finally {
    holder.document = previous;
  }
}

const alertsBody = (open: number, severity = 'warn') => ({
  monitor: { enabled: true },
  counts: { open, acknowledged: 0 },
  alerts: open > 0 ? [{ id: 'a-01', status: 'open', severity }] : [],
  next_cursor: null,
});

const refusalBody = (pending: Array<Record<string, unknown> | null>) => ({
  success: true,
  cells: pending.map((p, i) => ({ key: `k-${i}`, model: 'm', pending: p })),
  warnings: [],
});

describe('banner plan from the loaded configuration (D-21, UI-SPEC 6.6)', () => {
  it('requests alerts only with RAG_MONITOR=true and thresholds when RAG_CONFIG_GATE is not off or RAG_MONITOR=true', () => {
    const { gatesUiBannerPlan } = load();
    expect(gatesUiBannerPlan({ RAG_MONITOR: 'false', RAG_CONFIG_GATE: 'off' })).toEqual({ alerts: false, uncal: false });
    expect(gatesUiBannerPlan({})).toEqual({ alerts: false, uncal: false });
    expect(gatesUiBannerPlan(null)).toEqual({ alerts: false, uncal: false });
    expect(gatesUiBannerPlan({ RAG_MONITOR: 'true', RAG_CONFIG_GATE: 'off' })).toEqual({ alerts: true, uncal: true });
    expect(gatesUiBannerPlan({ RAG_MONITOR: 'false', RAG_CONFIG_GATE: 'warn' })).toEqual({ alerts: false, uncal: true });
    expect(gatesUiBannerPlan({ RAG_MONITOR: 'false', RAG_CONFIG_GATE: 'enforce' })).toEqual({ alerts: false, uncal: true });
  });
});

describe('gatesUiMountBanner', () => {
  it('with both switches off makes no request and renders no banner element', async () => {
    await withPage(async (_doc, host) => {
      const { gatesUiMountBanner } = load();
      const { fetcher, calls } = fakeFetcher({});
      await gatesUiMountBanner({ RAG_MONITOR: 'false', RAG_CONFIG_GATE: 'off' }, { fetcher, locale: 'en' });
      expect(calls).toEqual([]);
      expect(host.childNodes).toHaveLength(0);
    });
  });

  it('open alerts with a severity alert: alert-error with the count row and Review alerts', async () => {
    await withPage(async (_doc, host) => {
      const { gatesUiMountBanner } = load();
      const { fetcher, calls } = fakeFetcher({ [ALERTS]: { ok: true, status: 200, body: alertsBody(3, 'alert') }, [REFUSAL]: { ok: true, status: 200, body: refusalBody([null]) } });
      await gatesUiMountBanner({ RAG_MONITOR: 'true', RAG_CONFIG_GATE: 'off' }, { fetcher, locale: 'en' });
      expect(calls.sort()).toEqual([`GET ${ALERTS}`, `GET ${REFUSAL}`].sort());
      const banner = host.querySelector('.alert') as FakeElement;
      expect(banner.className).toContain('alert-error');
      expect(banner.className).toContain('mb-6');
      expect(banner.getAttribute('role')).toBeNull();
      expect(banner.getAttribute('lang')).toBe('en');
      expect(text(banner)).toContain('Needs attention');
      const rows = banner.querySelectorAll('li');
      expect(rows).toHaveLength(1);
      expect(text(rows[0])).toContain('Open monitoring alerts: 3');
      const button = rows[0].querySelector('button') as FakeElement;
      expect(button.textContent).toBe('Review alerts');
      expect(button.className).toContain('btn btn-sm');
      expect(button.className).not.toContain('btn-primary');
    });
  });

  it('only warn-severity alerts give alert-warning', async () => {
    await withPage(async (_doc, host) => {
      const { gatesUiMountBanner } = load();
      const { fetcher } = fakeFetcher({ [ALERTS]: { ok: true, status: 200, body: alertsBody(2, 'warn') }, [REFUSAL]: { ok: true, status: 200, body: refusalBody([]) } });
      await gatesUiMountBanner({ RAG_MONITOR: 'true' }, { fetcher, locale: 'en' });
      const banner = host.querySelector('.alert') as FakeElement;
      expect(banner.className).toContain('alert-warning');
      expect(banner.className).not.toContain('alert-error');
    });
  });

  it('RAG_CONFIG_GATE warn with two pending cells: the thresholds row with Open refusal calibration; score shifts do not count', async () => {
    await withPage(async (_doc, host) => {
      const { gatesUiMountBanner } = load();
      const { fetcher, calls } = fakeFetcher({
        [REFUSAL]: {
          ok: true,
          status: 200,
          body: refusalBody([
            { reason: 'reranker_model', since: '2026-11-01' },
            { reason: 'embedding_model', since: '2026-11-02' },
            { reason: 'score_shift', since: '2026-11-03', alert_id: 'a-01' },
            null,
          ]),
        },
      });
      let opened = 0;
      await gatesUiMountBanner({ RAG_MONITOR: 'false', RAG_CONFIG_GATE: 'warn' }, { fetcher, locale: 'en', openRefusal: () => (opened += 1) });
      expect(calls).toEqual([`GET ${REFUSAL}`]);
      const rows = host.querySelectorAll('li');
      expect(rows).toHaveLength(1);
      expect(text(rows[0])).toContain('Refusal thresholds not applied after a setting change: 2');
      const button = rows[0].querySelector('button') as FakeElement;
      expect(button.textContent).toBe('Open refusal calibration');
      button.click();
      expect(opened).toBe(1);
    });
  });

  it('both counts 0: no banner element', async () => {
    await withPage(async (_doc, host) => {
      const { gatesUiMountBanner } = load();
      const { fetcher } = fakeFetcher({ [ALERTS]: { ok: true, status: 200, body: alertsBody(0) }, [REFUSAL]: { ok: true, status: 200, body: refusalBody([null]) } });
      await gatesUiMountBanner({ RAG_MONITOR: 'true', RAG_CONFIG_GATE: 'enforce' }, { fetcher, locale: 'en' });
      expect(host.childNodes).toHaveLength(0);
    });
  });

  for (const status of [401, 403, 404, 500, 503]) {
    it(`both requests answering ${status}: no banner element and no error text`, async () => {
      await withPage(async (_doc, host) => {
        const { gatesUiMountBanner } = load();
        const failed = { ok: false, status, body: { error: 'x' } };
        const { fetcher } = fakeFetcher({ [ALERTS]: failed, [REFUSAL]: failed });
        await gatesUiMountBanner({ RAG_MONITOR: 'true', RAG_CONFIG_GATE: 'warn' }, { fetcher, locale: 'en' });
        expect(host.childNodes).toHaveLength(0);
        expect(text(host)).toBe('');
      });
    });
  }

  it('a thrown request leaves its row out; the other row still shows', async () => {
    await withPage(async (_doc, host) => {
      const { gatesUiMountBanner } = load();
      const fetcher: Fetcher = async (path) => {
        if (path === ALERTS) throw new Error('network');
        return { ok: true, status: 200, body: refusalBody([{ reason: 'tokenizer', since: '2026-11-01' }]) };
      };
      await gatesUiMountBanner({ RAG_MONITOR: 'true' }, { fetcher, locale: 'en' });
      const rows = host.querySelectorAll('li');
      expect(rows).toHaveLength(1);
      expect(text(rows[0])).toContain('Refusal thresholds not applied after a setting change: 1');
    });
  });

  it('Review alerts activates RAG administration, selects the Alerts sub-tab, scrolls and focuses the Monitoring heading', async () => {
    await withPage(async (doc, host) => {
      const { gatesUiMountBanner } = load();
      const link = doc.createElement('a');
      link.className = 'menu-item';
      link.setAttribute('data-tab', 'rag-administration');
      let activated = 0;
      link.addEventListener('click', () => (activated += 1));
      doc.body.appendChild(link);
      const section = doc.createElement('section');
      section.id = 'rag-administration-monitor';
      const heading = doc.createElement('h3');
      heading.setAttribute('tabindex', '-1');
      section.appendChild(heading);
      const tab = doc.createElement('button');
      tab.setAttribute('role', 'tab');
      tab.setAttribute('data-monitor-tab', 'alerts');
      let tabClicked = 0;
      tab.addEventListener('click', () => (tabClicked += 1));
      section.appendChild(tab);
      let scrolled = 0;
      section.scrollIntoView = () => {
        scrolled += 1;
      };
      doc.body.appendChild(section);
      const { fetcher } = fakeFetcher({ [ALERTS]: { ok: true, status: 200, body: alertsBody(1) }, [REFUSAL]: { ok: true, status: 200, body: refusalBody([]) } });
      await gatesUiMountBanner({ RAG_MONITOR: 'true' }, { fetcher, locale: 'en' });
      (host.querySelector('button') as FakeElement).click();
      expect(activated).toBe(1);
      expect(tabClicked).toBe(1);
      expect(scrolled).toBe(1);
      expect(doc.activeElement).toBe(heading);
    });
  });

  it('gatesUiRefreshBanner reloads with the last configuration; nothing polls', async () => {
    await withPage(async (_doc, host) => {
      const { gatesUiMountBanner, gatesUiRefreshBanner } = load();
      let open = 1;
      const calls: string[] = [];
      const fetcher: Fetcher = async (path) => {
        calls.push(path);
        if (path === ALERTS) return { ok: true, status: 200, body: alertsBody(open) };
        return { ok: true, status: 200, body: refusalBody([]) };
      };
      await gatesUiMountBanner({ RAG_MONITOR: 'true' }, { fetcher, locale: 'en' });
      expect(text(host)).toContain('Open monitoring alerts: 1');
      open = 4;
      await gatesUiRefreshBanner();
      expect(text(host)).toContain('Open monitoring alerts: 4');
      open = 0;
      await gatesUiRefreshBanner();
      expect(host.childNodes).toHaveLength(0);
      const before = calls.length;
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(calls.length).toBe(before);
    });
  });

  it('renders zh and it rows', async () => {
    await withPage(async (_doc, host) => {
      const { gatesUiMountBanner } = load();
      const { fetcher } = fakeFetcher({ [ALERTS]: { ok: true, status: 200, body: alertsBody(3) }, [REFUSAL]: { ok: true, status: 200, body: refusalBody([]) } });
      await gatesUiMountBanner({ RAG_MONITOR: 'true' }, { fetcher, locale: 'zh' });
      expect(text(host)).toContain('未处理的监控告警：3');
      await gatesUiMountBanner({ RAG_MONITOR: 'true' }, { fetcher, locale: 'it' });
      expect(text(host)).toContain('Avvisi di monitoraggio aperti: 3');
    });
  });
});

describe('index.html wiring', () => {
  const html = fs.readFileSync('scripts/config-ui/index.html', 'utf8');

  it('#rag-attention-banner is the first child of the main content block', () => {
    expect(html).toMatch(/<!-- Main Content -->\s*<div class="p-6">\s*<div id="rag-attention-banner"[^>]*><\/div>/);
  });

  it('loads gates-ui.js right after rag-fetch.js', () => {
    expect(html).toMatch(/<script src="rag-panels\/rag-fetch\.js"><\/script>\s*<script src="rag-panels\/gates-ui\.js"><\/script>/);
  });

  it('mounts the banner from the loaded configuration', () => {
    const start = html.indexOf('async loadConfig()');
    const body = html.slice(start, html.indexOf('populateFields()', start));
    expect(body).toContain('gatesUiMountBanner(this.savedConfig)');
  });
});
