import { domainToASCII } from 'node:url';

/**
 * The link allowlist (D-35): RAG_OUTPUT_LINK_ALLOWLIST as a normalized domain set that always holds the host of NEXT_PUBLIC_SITE_URL.
 * Pure: no network call, no DNS lookup, no logging. The ingestion link check uses it, and Phase 5.2 (SEC-06) reuses it unchanged at
 * answer time.
 */

const MAX_HOST = 253;
const IPV4 = /^\d{1,3}(?:\.\d{1,3}){3}$/;

/**
 * Normalizes a host, a URL or an allowlist entry to its lower-case ASCII (punycode) host without a trailing dot, through the WHATWG URL
 * parser and domainToASCII. Returns null for anything that is not a host.
 */
export function normalizeHost(input: string): string | null {
  let value = input.trim();
  if (value === '') return null;
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) value = `http://${value.replace(/^\*?\.+/, '')}`;
  let hostname: string;
  try {
    hostname = new URL(value).hostname;
  } catch {
    return null;
  }
  if (hostname.startsWith('[')) return hostname.length <= MAX_HOST ? hostname.toLowerCase() : null;
  hostname = hostname.replace(/\.+$/, '');
  if (hostname === '') return null;
  const ascii = domainToASCII(hostname).toLowerCase().replace(/\.+$/, '');
  if (ascii === '' || ascii.length > MAX_HOST || ascii.split('.').some((label) => label === '')) return null;
  return ascii;
}

/** RAG_OUTPUT_LINK_ALLOWLIST (comma-separated domains) plus the host of the app's own URL; invalid entries are left out. */
export function parseLinkAllowlist(value: string | null | undefined, siteUrl?: string | null): ReadonlySet<string> {
  const hosts = new Set<string>();
  for (const entry of (value ?? '').split(',')) {
    const host = normalizeHost(entry);
    if (host) hosts.add(host);
  }
  const own = siteUrl ? normalizeHost(siteUrl) : null;
  if (own) hosts.add(own);
  return hosts;
}

/**
 * A host is allowed when it equals an entry or is a subdomain of one (it ends with "." + entry). Never a substring or a suffix without
 * the dot: evilexample.com does not match example.com. An IP address matches only itself.
 */
export function isAllowedHost(host: string, allowlist: ReadonlySet<string>): boolean {
  const normalized = normalizeHost(host);
  if (normalized === null) return false;
  if (allowlist.has(normalized)) return true;
  if (normalized.startsWith('[') || IPV4.test(normalized)) return false;
  for (const entry of allowlist) {
    if (entry.startsWith('[') || IPV4.test(entry)) continue;
    if (normalized.endsWith(`.${entry}`)) return true;
  }
  return false;
}
