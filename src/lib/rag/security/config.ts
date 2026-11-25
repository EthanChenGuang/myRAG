export type InjectionCheckMode = 'off' | 'flag' | 'drop' | 'downweight';
export type ToolResultGuardMode = 'off' | 'tag' | 'tag_and_flag';

export interface SecurityConfigWarning {
  readonly code: string;
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
  readonly anyNonDefault: boolean;
  readonly warnings: readonly SecurityConfigWarning[];
}

export type SecurityEnvSource = Record<string, string | undefined>;

export const DEFAULT_LAKERA_BASE_URL = '';

export function readSecurityConfig(_source: SecurityEnvSource = process.env): SecurityConfig {
  return {
    contextTagging: true,
    injectionCheck: 'drop',
    promptGuard: true,
    lakera: true,
    lakeraApiKey: '',
    lakeraBaseUrl: '',
    lakeraMultiTenantAck: true,
    toolResultGuard: 'tag',
    anyNonDefault: true,
    warnings: [],
  };
}
