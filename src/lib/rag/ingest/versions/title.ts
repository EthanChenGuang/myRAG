export function titleOf(_filename: string | null | undefined): string {
  return '';
}
export function versionMarkersFor(_language: string | null | undefined): string[] {
  return [];
}
export function normalizeTitle(_title: string | null | undefined, _markers: readonly string[]): string | null {
  return '';
}
export function hasVersionMarker(_title: string | null | undefined, _markers: readonly string[]): boolean {
  return false;
}
export function titleYear(_title: string | null | undefined, _markers: readonly string[], _yearPattern: string): number | null {
  return null;
}
export interface VersionFacts {
  year: number | null;
  docDate: string | null;
  effectiveFrom: string | null;
}
export function directionFor(_a: VersionFacts, _b: VersionFacts): 'a' | 'b' | null {
  return null;
}
