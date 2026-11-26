export interface VersionLabelInfo {
  version: number;
  isCurrent: boolean;
  effectiveFrom: string | null;
  effectiveTo: string | null;
}

export function versionLabelLine(_info: VersionLabelInfo, _language: string | null | undefined): string {
  return '';
}
