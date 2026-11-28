import fs from 'node:fs';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, test } from 'vitest';
import {
  ConnectorReconcileNote,
  ConnectorReconcilePill,
  connectorReconcileKind,
} from '@/components/ui/nango/connector-grid';
import { en } from '@/translations/en';
import { zh } from '@/translations/zh';

type Dict = Record<string, string>;
const tFor = (dict: Dict) => (key: string) => dict[key] ?? (en as unknown as Dict)[key] ?? key;
const tEn = tFor(en as unknown as Dict);
const tZh = tFor(zh as unknown as Dict);

function render(state: unknown, t = tEn) {
  return {
    pill: renderToStaticMarkup(createElement(ConnectorReconcilePill, { state, t })),
    note: renderToStaticMarkup(createElement(ConnectorReconcileNote, { state, t })),
  };
}

describe('connector card reconcile warning (UI-SPEC 6.8)', () => {
  test('paused renders the amber pill with PauseCircle and the paused note', () => {
    const { pill, note } = render('paused');
    expect(pill).toContain('Removal paused');
    expect(pill).toContain('bg-amber-500/10');
    expect(pill).toContain('h-5');
    expect(pill).toMatch(/<svg[^>]*aria-hidden="true"[^>]*lucide-circle-pause|<svg[^>]*lucide-(circle-)?pause[^>]*aria-hidden="true"/);
    expect(note).toContain('The last sync found many files missing at the source and removed nothing.');
    expect(note).toMatch(/^<p class="[^"]*text-xs text-amber-700 dark:text-amber-300 mb-4/);
  });

  test('overdue renders AlertTriangle with the overdue strings', () => {
    const { pill, note } = render('overdue');
    expect(pill).toContain('Deletion check overdue');
    expect(pill).toMatch(/lucide-(triangle-alert|alert-triangle)/);
    expect(note).toContain('Files deleted at the source may still be used in answers');
  });

  test('ok, a missing field and an unknown value render nothing', () => {
    for (const state of ['ok', undefined, null, 'mystery']) {
      const { pill, note } = render(state);
      expect(pill).toBe('');
      expect(note).toBe('');
      expect(connectorReconcileKind(state)).toBeNull();
    }
  });

  test('adds no button, link or count', () => {
    for (const state of ['paused', 'overdue']) {
      const { pill, note } = render(state);
      expect(pill + note).not.toMatch(/<(button|a)\b/);
      expect(pill + note).not.toMatch(/\d/);
    }
  });

  test('zh renders the zh copy', () => {
    const { pill, note } = render('paused', tZh);
    expect(pill).toContain('移除已暂停');
    expect(note).toContain('需要管理员确认后才会移除');
    expect(render('overdue', tZh).pill).toContain('删除检查已逾期');
  });

  test('the grid places the pill after the Connected pill and the note after the last-synced line, card classes unchanged', () => {
    const src = fs.readFileSync('src/components/ui/nango/connector-grid.tsx', 'utf8');
    const connected = src.indexOf("t('connectorStatusConnected')");
    const pill = src.indexOf('<ConnectorReconcilePill');
    const lastSynced = src.indexOf("t('connectorLastSyncedLabel')");
    const note = src.indexOf('<ConnectorReconcileNote');
    expect(connected).toBeGreaterThan(-1);
    expect(pill).toBeGreaterThan(connected);
    expect(note).toBeGreaterThan(lastSynced);
    expect(src).toContain('"border-blue-500/30 bg-blue-500/5"');
    expect(src).toContain('connection.reconcile_state');
  });
});
