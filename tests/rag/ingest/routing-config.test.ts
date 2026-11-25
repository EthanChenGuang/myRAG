import fs from 'node:fs';
import path from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ParseRoutingConfigSchema } from '@/lib/rag-eval/contracts.generated';
import {
  defaultRoutingConfigPath,
  loadRoutingConfig,
  parseRoutingConfig,
  resetRoutingConfigForTests,
} from '@/lib/rag/ingest/routing/config';

const ROOT = path.resolve(__dirname, '../../..');
const ROUTING_PATH = path.join(ROOT, 'config/rag/parse-routing.json');

const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value));

beforeEach(() => {
  vi.restoreAllMocks();
  resetRoutingConfigForTests();
});

describe('parse routing config loader', () => {
  it('points at the committed routing file', () => {
    expect(defaultRoutingConfigPath()).toBe(ROUTING_PATH);
  });

  it('loads and validates the bundled routing data once per process', () => {
    const parse = vi.spyOn(ParseRoutingConfigSchema, 'parse');
    const first = loadRoutingConfig();
    expect(loadRoutingConfig()).toBe(first);
    expect(parse).toHaveBeenCalledTimes(1);
    expect(first.version).toBe('1');
    expect(first.ladder.pdf).toEqual(['fast', 'structured', 'premium']);
    expect(first.office_formats).toEqual({
      docx: 'native',
      html: 'native',
      pptx: 'structured',
      xlsx: 'structured',
    });
    expect(first.presets.structured_ocr?.ocr).toBe(true);
    expect(first.ranges.max_pages_per_conversion).toBe(24);
  });

  it('rejects unknown keys and missing cost provenance', () => {
    const raw = clone(JSON.parse(fs.readFileSync(ROUTING_PATH, 'utf8')));
    expect(() => parseRoutingConfig({ ...raw, rogue: true })).toThrow();
    const broken = clone(raw);
    broken.costs.tier.fast.source = '';
    expect(() => parseRoutingConfig(broken)).toThrow();
  });

  it('reads an override path for tests', () => {
    const raw = clone(JSON.parse(fs.readFileSync(ROUTING_PATH, 'utf8')));
    raw.thresholds_ref = 'eval/routing/report.json';
    const tmp = path.join(ROOT, 'tests', 'rag', 'ingest', '.tmp-routing.json');
    fs.writeFileSync(tmp, JSON.stringify(raw));
    try {
      const parsed = loadRoutingConfig(tmp);
      expect(parsed.thresholds_ref).toBe('eval/routing/report.json');
    } finally {
      fs.unlinkSync(tmp);
    }
  });
});