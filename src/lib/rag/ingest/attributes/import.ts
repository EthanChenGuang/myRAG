export const IMPORT_MAX_ROWS = 0;

export async function readImportFile(_path: string, _options: { signal: AbortSignal }): Promise<{ rows: Array<{ line: number; source: string; sourceKey: string }>; errors: Array<{ line: number; code: string }> }> {
  return { rows: [], errors: [] };
}
