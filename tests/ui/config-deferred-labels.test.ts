import path from 'node:path';
import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const panels = path.resolve(import.meta.dirname, '../../scripts/config-ui/rag-panels');
type Locale = 'en' | 'zh' | 'it';
const LOCALES: Locale[] = ['en', 'zh', 'it'];

const purge = require(path.join(panels, 'purge.js')) as {
  purgeStoreLabel: (store: string, locale: Locale) => { label: string; known: boolean };
};
const monitor = require(path.join(panels, 'monitor.js')) as {
  monitorRuleLabel: (rule: string, locale: Locale) => string | null;
};

describe('purge panel names the lexical_stats and golden_items stores', () => {
  for (const store of ['lexical_stats', 'golden_items']) {
    it.each(LOCALES)(`${store} has a %s label`, (locale) => {
      const view = purge.purgeStoreLabel(store, locale);
      expect(view.known).toBe(true);
      expect(view.label).not.toBe(store);
    });
  }
  it('the three locales use different words', () => {
    const labels = LOCALES.map((locale) => purge.purgeStoreLabel('lexical_stats', locale).label);
    expect(new Set(labels).size).toBe(3);
  });
});

describe('monitor panel names the Phase 6.3 rules', () => {
  const rules = ['stale_index_drop_rate', 'source_reconcile_paused', 'source_reconcile_overdue', 'source_reconcile_failed', 'source_reconcile_incomplete'];
  for (const rule of rules) {
    it.each(LOCALES)(`${rule} has a %s label`, (locale) => {
      const label = monitor.monitorRuleLabel(rule, locale);
      expect(label).toBeTruthy();
      expect(label).not.toBe(rule);
    });
  }
});
