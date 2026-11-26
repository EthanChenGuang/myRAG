export interface VersionSource {
  version?: number | null;
  version_label?: string | null;
  effective_from?: string | null;
  doc_date?: string | null;
}

export function versionLabelOf(_row: VersionSource, _language: string): string | null {
  return null;
}

export function effectiveDateOf(_row: VersionSource): string | null {
  return null;
}

export function versionHeaderSuffix(_row: VersionSource, _language: string): string {
  return '';
}
