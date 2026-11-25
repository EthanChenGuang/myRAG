export type InjectionCheckMode = 'off' | 'flag' | 'drop' | 'downweight';
export type ToolResultGuardMode = 'off' | 'tag' | 'tag_and_flag';

export type SecurityConfigWarningCode =
  | 'invalid_injection_check'
  | 'invalid_tool_result_guard'
  | 'insecure_lakera_base_url'
  | 'invalid_lakera_base_url';

/** The message names the variable only; a configured value is never repeated in it. */
export interface SecurityConfigWarning {
  readonly code: SecurityConfigWarningCode;
  readonly message: string;
}

export interface SecurityConfig {
  readonly contextTagging: boolean;
  readonly injectionCheck: InjectionCheckMode;
  readonly promptGuard: boolean;
  readonly lakera: boolean;
  readonly lakeraApiKey: string | null;
  readonly lakeraBaseUrl: string;
  readonly lakeraMultiTenantAck: boolean;
  readonly toolResultGuard: ToolResultGuardMode;
  /** True when any switch differs from its default; the key and base URL alone change no behaviour. */
  readonly anyNonDefault: boolean;
  readonly warnings: readonly SecurityConfigWarning[];
}

export type SecurityEnvSource = Record<string, string | undefined>;

export const DEFAULT_LAKERA_BASE_URL = 'https://api.lakera.ai';

const INJECTION_CHECK_MODES: readonly InjectionCheckMode[] = ['off', 'flag', 'drop', 'downweight'];
const TOOL_RESULT_GUARD_MODES: readonly ToolResultGuardMode[] = ['off', 'tag', 'tag_and_flag'];
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost']);

function isOn(raw: string | undefined): boolean {
  return raw?.trim() === 'true';
}

function parseMode<T extends string>(
  raw: string | undefined,
  modes: readonly T[],
  warning: SecurityConfigWarning,
  warnings: SecurityConfigWarning[],
): T {
  const text = raw?.trim() ?? '';
  if (text === '') return modes[0];
  const mode = modes.find((candidate) => candidate === text);
  if (mode) return mode;
  warnings.push(warning);
  return modes[0];
}

function parseLakeraBaseUrl(raw: string | undefined, warnings: SecurityConfigWarning[]): string {
  const text = raw?.trim() ?? '';
  if (text === '') return DEFAULT_LAKERA_BASE_URL;
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    warnings.push({ code: 'invalid_lakera_base_url', message: 'LAKERA_GUARD_BASE_URL is not a valid URL; using the default host' });
    return DEFAULT_LAKERA_BASE_URL;
  }
  if (url.username !== '' || url.password !== '' || url.search !== '' || url.hash !== '') {
    warnings.push({
      code: 'invalid_lakera_base_url',
      message: 'LAKERA_GUARD_BASE_URL must not carry credentials, a query or a fragment; using the default host',
    });
    return DEFAULT_LAKERA_BASE_URL;
  }
  const secure = url.protocol === 'https:' || (url.protocol === 'http:' && LOOPBACK_HOSTS.has(url.hostname));
  if (!secure) {
    warnings.push({
      code: 'insecure_lakera_base_url',
      message: 'LAKERA_GUARD_BASE_URL must use https (http only for 127.0.0.1 or localhost); using the default host',
    });
    return DEFAULT_LAKERA_BASE_URL;
  }
  return text.replace(/\/+$/, '');
}

/** Read at call time, never cached or logged; a malformed value falls back to the off state with a warning code. */
export function readSecurityConfig(source: SecurityEnvSource = process.env): SecurityConfig {
  const warnings: SecurityConfigWarning[] = [];
  const contextTagging = isOn(source.RAG_CONTEXT_TAGGING);
  const injectionCheck = parseMode(
    source.RAG_INJECTION_CHECK,
    INJECTION_CHECK_MODES,
    { code: 'invalid_injection_check', message: 'RAG_INJECTION_CHECK is not off, flag, drop or downweight; using off' },
    warnings,
  );
  const promptGuard = isOn(source.RAG_INJECTION_PROMPT_GUARD);
  const lakera = isOn(source.RAG_INJECTION_LAKERA);
  const apiKey = source.LAKERA_GUARD_API_KEY?.trim() ?? '';
  const lakeraBaseUrl = parseLakeraBaseUrl(source.LAKERA_GUARD_BASE_URL, warnings);
  const lakeraMultiTenantAck = isOn(source.RAG_INJECTION_LAKERA_MULTI_TENANT_ACK);
  const toolResultGuard = parseMode(
    source.RAG_TOOL_RESULT_GUARD,
    TOOL_RESULT_GUARD_MODES,
    { code: 'invalid_tool_result_guard', message: 'RAG_TOOL_RESULT_GUARD is not off, tag or tag_and_flag; using off' },
    warnings,
  );
  const anyNonDefault =
    contextTagging ||
    injectionCheck !== 'off' ||
    promptGuard ||
    lakera ||
    lakeraMultiTenantAck ||
    toolResultGuard !== 'off';

  return Object.freeze({
    contextTagging,
    injectionCheck,
    promptGuard,
    lakera,
    lakeraApiKey: apiKey === '' ? null : apiKey,
    lakeraBaseUrl,
    lakeraMultiTenantAck,
    toolResultGuard,
    anyNonDefault,
    warnings: Object.freeze(warnings.map((warning) => Object.freeze({ ...warning }))),
  });
}
