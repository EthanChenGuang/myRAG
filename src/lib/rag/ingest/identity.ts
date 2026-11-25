import { normalizeScrapedUrl } from '@/lib/scrapers/url-utils';
import type { IngestSource } from './types';

export type SourceKeyParts =
  | { folderId?: string | null; filename: string }
  | { providerFileId: string }
  | { url: string }
  | { storagePath: string };

/** NFKC, directory part and control characters removed, trimmed. */
export function normalizeFilename(filename: string): string {
  const base = filename.normalize('NFKC').replace(/\\/g, '/').split('/').pop() ?? '';
  const cleaned = base.replace(/\p{Cc}/gu, '').trim();
  return cleaned === '' ? 'untitled' : cleaned;
}

function requireText(label: string, value: unknown): string {
  if (typeof value !== 'string' || value.trim() === '') throw new Error(`[Ingest] source key needs ${label}`);
  return value.trim();
}

/**
 * The stable identity part of (tenant_key, source, source_key), D-10: uploads use the logical folder
 * (or root) plus the normalised filename, Nango the provider file id, scrapers the canonical URL, image
 * uploads the storage path.
 */
export function buildSourceKey(source: IngestSource, parts: SourceKeyParts): string {
  if (source === 'nango') {
    return requireText('providerFileId', 'providerFileId' in parts ? parts.providerFileId : undefined);
  }
  if (source === 'scraper') {
    return normalizeScrapedUrl(requireText('url', 'url' in parts ? parts.url : undefined));
  }
  if (source === 'image_upload') {
    return requireText('storagePath', 'storagePath' in parts ? parts.storagePath : undefined);
  }
  if (!('filename' in parts)) throw new Error('[Ingest] source key needs filename');
  const folder = typeof parts.folderId === 'string' && parts.folderId.trim() !== '' ? parts.folderId.trim() : 'root';
  return `${folder}/${normalizeFilename(parts.filename)}`;
}
