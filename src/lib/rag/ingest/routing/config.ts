import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { z } from 'zod/v3';
import { ParseRoutingConfigSchema } from '@/lib/rag-eval/contracts.generated';
import rawRouting from '../../../../../config/rag/parse-routing.json';

export type ParseRoutingConfig = z.infer<typeof ParseRoutingConfigSchema>;

let loaded: ParseRoutingConfig | null = null;

const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));

export function defaultRoutingConfigPath(): string {
  return path.resolve(MODULE_DIR, '../../../../../config/rag/parse-routing.json');
}

export function resetRoutingConfigForTests(): void {
  loaded = null;
}

export function parseRoutingConfig(raw: unknown): ParseRoutingConfig {
  return ParseRoutingConfigSchema.parse(raw);
}

export function loadRoutingConfig(routingPath?: string): ParseRoutingConfig {
  if (!routingPath) {
    if (!loaded) loaded = parseRoutingConfig(rawRouting);
    return loaded;
  }
  const raw = JSON.parse(fs.readFileSync(routingPath, 'utf8')) as unknown;
  return parseRoutingConfig(raw);
}