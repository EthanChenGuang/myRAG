import fs from 'node:fs';
import { InjectionDetectorConfigSchema, type InjectionDetectorConfig } from '@/lib/rag-eval/contracts.generated';
import type { TenantScope } from '@/lib/rag/tenant/scope';
import rawConfig from '../../../../config/rag/injection-detectors.json';

export type DetectorId = 'prompt_guard' | 'lakera';
export type DetectorProfile = 'chat' | 'embed' | 'eval';

/** What a cache may hold: the verdict only, never the screened text. */
export interface DetectorVerdict {
  flagged: boolean;
  score?: number;
  level?: string | null;
  at: number;
}

export interface DetectorClassifyOptions {
  signal: AbortSignal;
  profile: DetectorProfile;
  traceId: string | null;
  scope: TenantScope;
}

/** One outcome per input item, in input order. Failures are values; classify never throws. */
export type DetectorOutcome<Reason extends string = string> =
  | { kind: 'verdict'; verdict: DetectorVerdict }
  | { kind: 'unavailable'; reason: Reason };

export interface Detector<Reason extends string = string> {
  readonly id: DetectorId;
  readonly version: string;
  classify(items: readonly string[], opts: DetectorClassifyOptions): Promise<DetectorOutcome<Reason>[]>;
}

export interface LoadDetectorConfigOptions {
  /** Reads this file instead of the committed config; not memoised. */
  path?: string;
}

function invalid(where: string, code: string): never {
  throw new Error(`[RAG Security] injection detector config invalid (${where}): ${code}`);
}

/** The error names the field path and the issue code only; values from the file are never repeated. */
function parse(raw: unknown): InjectionDetectorConfig {
  const parsed = InjectionDetectorConfigSchema.safeParse(raw);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const where = issue && issue.path.length > 0 ? issue.path.join('.') : 'file';
    const extra = issue?.code === 'unrecognized_keys' ? ' unknown field' : '';
    return invalid(where, `${issue?.code ?? 'schema_mismatch'}${extra}`);
  }
  return Object.freeze(parsed.data) as InjectionDetectorConfig;
}

function readFile(file: string): unknown {
  let text: string;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return invalid('file', 'unreadable');
  }
  try {
    return JSON.parse(text);
  } catch {
    return invalid('file', 'not valid JSON');
  }
}

let loaded: InjectionDetectorConfig | null = null;

/** config/rag/injection-detectors.json, validated with the generated schema once per process. Throws when invalid. */
export function loadInjectionDetectorConfig(options: LoadDetectorConfigOptions = {}): InjectionDetectorConfig {
  if (options.path !== undefined) return parse(readFile(options.path));
  if (!loaded) loaded = parse(rawConfig);
  return loaded;
}

export function detectorsConfigVersion(): string {
  return loadInjectionDetectorConfig().version;
}

export function resetInjectionDetectorConfigForTests(): void {
  loaded = null;
}
