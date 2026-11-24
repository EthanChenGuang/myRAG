import type { StoredObject } from './object-store';

export const PARSE_ARTIFACT = 'parse.md';
export const DOCLING_ARTIFACT = 'docling.json';

export interface ArtifactContext {
  identity: { tenantKey: string } | null;
  document: { lineageId: string; version: number } | null;
  signal: AbortSignal;
  state: { artifacts: Record<string, string> };
}

export function versionPrefix(_tenantKey: string, _lineageId: string, _version: number): string {
  return '';
}

export function originalName(_filename: string): string {
  return '';
}

export function originalKey(_prefix: string, _filename: string): string {
  return '';
}

export async function saveArtifact(_ctx: ArtifactContext, _name: string, _bytes: Uint8Array, _contentType: string): Promise<string> {
  return '';
}

export async function loadArtifact(_ctx: ArtifactContext, _name: string): Promise<StoredObject | null> {
  return null;
}
