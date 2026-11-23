import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, test } from 'vitest';

const PINS: Record<string, string> = {
  '@langfuse/tracing': '6.1.1',
  '@langfuse/otel': '6.1.1',
  '@opentelemetry/sdk-trace-base': '2.12.1',
  '@opentelemetry/core': '2.12.1',
  '@opentelemetry/exporter-trace-otlp-http': '0.223.2',
  '@opentelemetry/otlp-exporter-base': '0.223.2',
  '@opentelemetry/api': '1.9.0',
};

const ROOT = process.cwd();

function readJson(file: string): { version?: string; dependencies?: Record<string, string> } {
  return JSON.parse(readFileSync(file, 'utf8'));
}

describe('langfuse and opentelemetry pins', () => {
  const manifest = readJson(path.join(ROOT, 'package.json'));

  test.each(Object.entries(PINS))('%s is declared without a range', (name, version) => {
    expect(manifest.dependencies?.[name]).toBe(version);
  });

  test.each(Object.entries(PINS))('%s resolves to the pinned version', (name, version) => {
    const installed = readJson(path.join(ROOT, 'node_modules', ...name.split('/'), 'package.json'));
    expect(installed.version).toBe(version);
  });

  test('the global OpenTelemetry node SDK is not a dependency', () => {
    expect(manifest.dependencies?.['@opentelemetry/sdk-node']).toBeUndefined();
  });
});
