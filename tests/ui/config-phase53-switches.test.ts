import fs from 'node:fs';
import { describe, expect, it } from 'vitest';

const html = fs.readFileSync('scripts/config-ui/index.html', 'utf8');

const SELECTS: Record<string, string[]> = {
  RAG_CONFIG_GATE: ['off', 'warn', 'enforce'],
  RAG_CONFIG_GATE_LIVE: ['false', 'true'],
  RAG_MONITOR: ['false', 'true'],
  RAG_REPRESENTATIVE_SAMPLE: ['false', 'true'],
};
const WRITE_ONLY = ['RAG_MONITOR_WEBHOOK_URL', 'RAG_MONITOR_WEBHOOK_SECRET'];
const ALL = [...Object.keys(SELECTS), ...WRITE_ONLY];
const GROUPS: Record<string, string[]> = {
  gate: ['RAG_CONFIG_GATE', 'RAG_CONFIG_GATE_LIVE'],
  monitor: ['RAG_MONITOR', 'RAG_MONITOR_WEBHOOK_URL', 'RAG_MONITOR_WEBHOOK_SECRET'],
  sample: ['RAG_REPRESENTATIVE_SAMPLE'],
};

function block(): string {
  const start = html.indexOf('<!-- rag-phase053-settings:start -->');
  const end = html.indexOf('<!-- rag-phase053-settings:end -->');
  expect(start).toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);
  return html.slice(start, end);
}

function groupHtml(name: string): string {
  const b = block();
  const start = b.indexOf(`<div data-rag-settings-group="${name}">`);
  expect(start, `group ${name}`).toBeGreaterThan(-1);
  const next = b.indexOf('<div data-rag-settings-group="', start + 1);
  return b.slice(start, next === -1 ? undefined : next);
}

function openingTag(id: string): string {
  const matches = [...html.matchAll(new RegExp(`<(input|select)\\b[^>]*\\bid="${id}"[^>]*>`, 'g'))];
  expect(matches, `exactly one control with id ${id}`).toHaveLength(1);
  return matches[0]![0];
}

function attr(tag: string, name: string): string | undefined {
  return new RegExp(`\\s${name}="([^"]*)"`).exec(tag)?.[1];
}

describe('Phase 5.3 settings block in the Config UI (UI-SPEC 6.12)', () => {
  it('is one hidden block inside the RAG administration tab', () => {
    const tags = [...html.matchAll(/<div\b[^>]*\bid="rag-phase053-settings"[^>]*>/g)];
    expect(tags).toHaveLength(1);
    expect(attr(tags[0]![0], 'class')).toBe('hidden');
    const tabStart = html.indexOf('id="rag-administration"');
    expect(tabStart).toBeGreaterThan(-1);
    expect(html.indexOf('id="rag-phase053-settings"')).toBeGreaterThan(tabStart);
  });

  it('holds the groups gate, monitor and sample with their controls', () => {
    for (const [group, ids] of Object.entries(GROUPS)) {
      const g = groupHtml(group);
      for (const id of ids) expect(g, `${id} in ${group}`).toContain(`id="${id}"`);
    }
  });

  it('each of the six ids exists once and its name equals the env name', () => {
    for (const id of ALL) {
      expect(html.split(`id="${id}"`).length - 1, id).toBe(1);
      expect(attr(openingTag(id), 'name'), id).toBe(id);
    }
  });

  it('every select option value is an env value, with the default selected', () => {
    for (const [id, values] of Object.entries(SELECTS)) {
      const start = html.indexOf(openingTag(id));
      const body = html.slice(start, html.indexOf('</select>', start));
      const options = [...body.matchAll(/<option\b[^>]*>/g)].map((m) => m[0]);
      expect(options.map((o) => attr(o, 'value')), id).toEqual(values);
      const selected = options.filter((o) => /\sselected[\s>]/.test(o));
      expect(selected, `${id} default`).toHaveLength(1);
      expect(attr(selected[0]!, 'value'), id).toBe(values[0]);
    }
  });

  it('the webhook URL and secret are write-only: no value attribute, autofill off', () => {
    for (const id of WRITE_ONLY) {
      const tag = openingTag(id);
      expect(attr(tag, 'value'), id).toBeUndefined();
      expect(tag, id).not.toMatch(/\svalue[\s=>]/);
      expect(attr(tag, 'autocomplete'), id).toBe('off');
      expect(attr(tag, 'spellcheck'), id).toBe('false');
    }
    expect(attr(openingTag('RAG_MONITOR_WEBHOOK_URL'), 'type')).toBe('url');
    expect(attr(openingTag('RAG_MONITOR_WEBHOOK_URL'), 'inputmode')).toBe('url');
    expect(attr(openingTag('RAG_MONITOR_WEBHOOK_SECRET'), 'type')).toBe('password');
  });

  it('the secret has a named, non-submitting reveal button', () => {
    const button = /<button\b[^>]*data-for="RAG_MONITOR_WEBHOOK_SECRET"[^>]*>/.exec(html)?.[0] ?? '';
    expect(attr(button, 'type')).toBe('button');
    expect(attr(button, 'aria-label')).toMatch(/webhook secret/);
  });

  it('every control has a visible label, a tied help line and its env name as untranslated code', () => {
    const b = block();
    for (const id of ALL) {
      expect(b, `label for ${id}`).toMatch(new RegExp(`<label\\b[^>]*\\bfor="${id}"`));
      const describedBy = attr(openingTag(id), 'aria-describedby');
      expect(describedBy, id).toBeTruthy();
      expect(b).toContain(`id="${describedBy}"`);
      expect(b).toContain(`<code class="font-mono text-xs break-all" translate="no">${id}</code>`);
    }
  });

  it('carries data-rag-i18n keys for the zh and it texts', () => {
    const keys = [...block().matchAll(/data-rag-i18n="([^"]+)"/g)].map((m) => m[1]);
    for (const key of ['settings.gate.label', 'mode.enforce', 'settings.live.on', 'settings.monitor.label', 'settings.webhook.label', 'settings.secret.label', 'settings.sample.label', 'value.on', 'value.off', 'settings.saveHint']) {
      expect(keys, key).toContain(key);
    }
  });

  it('adds no script, inline handler or request to the page', () => {
    const b = block();
    expect(b).not.toMatch(/<script\b/i);
    expect(b).not.toMatch(/\son[a-z]+=/i);
    expect(b).not.toMatch(/fetch\(|src="/);
  });

  it('the webhook secret joins the 32-character warning in saveConfig', () => {
    const line = /const shortSecrets = \[([^\]]*)\]/.exec(html)?.[1] ?? '';
    expect(line).toContain("'RAG_MONITOR_WEBHOOK_SECRET'");
  });
});
