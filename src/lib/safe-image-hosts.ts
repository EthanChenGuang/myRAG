export interface ImageHostSources {
  supabaseUrl?: string | null;
  headerLogoUrl?: string | null;
  aiLogoUrl?: string | null;
}

export interface ImageHostAllowlist {
  supabaseHost: string | null;
  logoHosts: string[];
}

export function allowedImageHosts(_sources: ImageHostSources): ImageHostAllowlist {
  return { supabaseHost: null, logoHosts: [] };
}

export function isAllowedImageUrl(_src: unknown, _hosts?: ImageHostAllowlist): boolean {
  return true;
}
