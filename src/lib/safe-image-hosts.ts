export interface ImageHostSources {
  supabaseUrl?: string | null;
  headerLogoUrl?: string | null;
  aiLogoUrl?: string | null;
}

export interface ImageHostAllowlist {
  supabaseHost: string | null;
  logoHosts: string[];
}

const REPLICATE_HOST = 'replicate.delivery';
const REPLICATE_PATH_PREFIX = '/xezq/';
const SUPABASE_PUBLIC_PATH_PREFIX = '/storage/v1/object/public/';
const SAME_ORIGIN_BASE = 'https://same-origin.invalid';
const SAME_ORIGIN_HOST = 'same-origin.invalid';
// Whitespace, control characters and backslashes change how browsers resolve a URL.
function hasUnsafeUrlChars(src: string): boolean {
  for (let i = 0; i < src.length; i += 1) {
    const code = src.charCodeAt(i);
    if (code <= 0x20 || code === 0x7f || code === 0x5c || /\s/.test(src[i])) return true;
  }
  return false;
}

function parseHost(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    const host = new URL(url).hostname.toLowerCase();
    return host || null;
  } catch {
    return null;
  }
}

export function allowedImageHosts(sources: ImageHostSources): ImageHostAllowlist {
  const logoHosts: string[] = [];
  for (const value of [sources.headerLogoUrl, sources.aiLogoUrl]) {
    const host = parseHost(value);
    if (host && !logoHosts.includes(host)) logoHosts.push(host);
  }
  return { supabaseHost: parseHost(sources.supabaseUrl), logoHosts };
}

let defaultHosts: ImageHostAllowlist | null = null;

function deploymentImageHosts(): ImageHostAllowlist {
  if (!defaultHosts) {
    defaultHosts = allowedImageHosts({
      supabaseUrl: process.env.NEXT_PUBLIC_SUPABASE_URL,
      headerLogoUrl: process.env.NEXT_PUBLIC_HEADER_LOGO_URL,
      aiLogoUrl: process.env.NEXT_PUBLIC_AI_RESPONSE_LOGO_URL,
    });
  }
  return defaultHosts;
}

export function isAllowedImageUrl(src: unknown, hosts: ImageHostAllowlist = deploymentImageHosts()): boolean {
  if (typeof src !== 'string' || src.length === 0 || hasUnsafeUrlChars(src)) return false;

  if (src.startsWith('/')) {
    if (src.startsWith('//')) return false;
    try {
      const url = new URL(src, SAME_ORIGIN_BASE);
      return url.protocol === 'https:' && url.hostname === SAME_ORIGIN_HOST && url.port === '';
    } catch {
      return false;
    }
  }

  let url: URL;
  try {
    url = new URL(src);
  } catch {
    return false;
  }
  if (url.protocol !== 'https:' || url.username !== '' || url.password !== '' || url.port !== '') return false;

  const host = url.hostname.toLowerCase();
  if (host === REPLICATE_HOST && url.pathname.startsWith(REPLICATE_PATH_PREFIX)) return true;
  if (hosts.supabaseHost && host === hosts.supabaseHost && url.pathname.startsWith(SUPABASE_PUBLIC_PATH_PREFIX)) {
    return true;
  }
  return hosts.logoHosts.includes(host);
}

export function imageLinkHref(src: unknown): string | null {
  if (typeof src !== 'string' || src.length === 0 || hasUnsafeUrlChars(src)) return null;
  try {
    const url = new URL(src);
    return url.protocol === 'https:' || url.protocol === 'http:' ? src : null;
  } catch {
    return null;
  }
}
