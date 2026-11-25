import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  detectorsConfigVersion,
  loadInjectionDetectorConfig,
  resetInjectionDetectorConfigForTests,
} from '@/lib/rag/security/detectors';
import committed from '../../../config/rag/injection-detectors.json';

const tempDirs: string[] = [];

function writeTemp(body: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'detectors-config-'));
  tempDirs.push(dir);
  const file = path.join(dir, 'injection-detectors.json');
  fs.writeFileSync(file, body);
  return file;
}

afterEach(() => {
  resetInjectionDetectorConfigForTests();
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe('loadInjectionDetectorConfig', () => {
  it('returns the committed values', () => {
    const config = loadInjectionDetectorConfig();
    expect(config.version).toBe(committed.version);
    expect(config.lakera.detector_types).toEqual(committed.lakera.detector_types);
    expect(config.lakera.concurrency).toBe(committed.lakera.concurrency);
    expect(config.lakera.min_level).toBeNull();
    expect(config.cache.max_entries).toBe(committed.cache.max_entries);
    expect(config.prompt_guard.threshold).toBe(committed.prompt_guard.threshold);
  });

  it('loads the committed file once per process', () => {
    expect(loadInjectionDetectorConfig()).toBe(loadInjectionDetectorConfig());
  });

  it('detectorsConfigVersion returns the version field', () => {
    expect(detectorsConfigVersion()).toBe(committed.version);
  });

  it('reads a valid file through the path option', () => {
    const file = writeTemp(JSON.stringify({ ...committed, version: '2026-12-01.3' }));
    expect(loadInjectionDetectorConfig({ path: file }).version).toBe('2026-12-01.3');
  });

  it('throws on an invalid file and names the failing field without repeating its value', () => {
    const secretish = 'value-that-must-not-appear-in-the-error';
    const bad = { ...committed, lakera: { ...committed.lakera, profiles: [secretish] } };
    const file = writeTemp(JSON.stringify(bad));
    let message = '';
    try {
      loadInjectionDetectorConfig({ path: file });
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toContain('lakera.profiles');
    expect(message).not.toContain(secretish);
  });

  it('throws on an out-of-range number and names the field', () => {
    const file = writeTemp(JSON.stringify({ ...committed, lakera: { ...committed.lakera, concurrency: 99 } }));
    expect(() => loadInjectionDetectorConfig({ path: file })).toThrow(/lakera\.concurrency/);
  });

  it('throws on a file that is not JSON without echoing its contents', () => {
    const file = writeTemp('{"version": "leaked-fragment", ');
    let message = '';
    try {
      loadInjectionDetectorConfig({ path: file });
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toMatch(/not valid JSON/);
    expect(message).not.toContain('leaked-fragment');
  });

  it('rejects an unknown top-level field', () => {
    const file = writeTemp(JSON.stringify({ ...committed, extra: true }));
    expect(() => loadInjectionDetectorConfig({ path: file })).toThrow(/injection detector config invalid/);
  });
});
