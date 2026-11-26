import type { ImageHostAllowlist } from '@/lib/safe-image-hosts';

export type CandidateKind = 'url' | 'bare_domain' | 'email' | 'obfuscated' | 'opaque_scheme' | 'marker' | 'none';
export type AllowRule = 'allowlist' | 'web_result' | 'server_url' | 'user_message' | 'relative' | 'not_link';
export type RejectReason =
  | 'link_not_allowlisted'
  | 'link_obfuscated'
  | 'link_opaque_scheme'
  | 'link_userinfo'
  | 'link_host_changed';

export interface WebResultUrl {
  url: string;
  flagged?: boolean;
}

export interface OutputLinkPolicy {
  allowlist: ReadonlySet<string>;
  webResultUrls: readonly WebResultUrl[];
  serverUrls: readonly string[];
  imageHosts: ImageHostAllowlist | null;
  userMessage: string;
  documentNames: readonly string[];
}

export interface OutputLinkPolicyInput {
  allowlistValue?: string | null;
  siteUrl?: string | null;
  webResultUrls?: readonly (string | WebResultUrl)[];
  serverUrls?: readonly string[];
  imageHosts?: ImageHostAllowlist | null;
  userMessage?: string | null;
  documentNames?: readonly string[];
}

export function createOutputLinkPolicy(_input: OutputLinkPolicyInput): OutputLinkPolicy {
  return { allowlist: new Set(), webResultUrls: [], serverUrls: [], imageHosts: null, userMessage: '', documentNames: [] };
}
export function normalizeHost(_raw: string): string | null {
  return null;
}
export function isPublicTld(_label: string): boolean {
  return false;
}
export function classifyCandidate(_text: string, _options?: { documentNames?: readonly string[] }): CandidateKind {
  return 'none';
}
export function isLinkAllowed(
  _candidate: string,
  _policy: OutputLinkPolicy,
): { allowed: boolean; rule: AllowRule | RejectReason; kind: CandidateKind } {
  return { allowed: true, rule: 'not_link', kind: 'none' };
}
