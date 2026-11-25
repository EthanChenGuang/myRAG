import type { DocumentFields } from './writer';
import type { IngestOptions } from './types';

const MAX_VALUE_LENGTH = 2048;

function plain(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' && value.length <= MAX_VALUE_LENGTH ? value : null;
}

/**
 * The provider fields and metadata a source names for its document (a scraper's URL, a connector's file id),
 * reduced to plain strings. Anything else a caller puts there is dropped, never written.
 */
export function originFields(options: IngestOptions | undefined): DocumentFields | null {
  const origin = options?.origin;
  if (origin === null || typeof origin !== 'object') return null;

  const fields: DocumentFields = {};
  const sourceProvider = plain(origin.sourceProvider);
  const sourceFileId = plain(origin.sourceFileId);
  const sourceConnectionId = plain(origin.sourceConnectionId);
  if (sourceProvider !== null) fields.source_provider = sourceProvider;
  if (sourceFileId !== null) fields.source_file_id = sourceFileId;
  if (sourceConnectionId !== null) fields.source_connection_id = sourceConnectionId;

  const metadata: Record<string, string> = {};
  if (origin.metadata !== null && typeof origin.metadata === 'object') {
    for (const [key, value] of Object.entries(origin.metadata)) {
      const text = plain(value);
      if (text !== null) metadata[key] = text;
    }
  }
  if (Object.keys(metadata).length > 0) fields.metadata = metadata;

  return Object.keys(fields).length > 0 ? fields : null;
}
