import type { IngestConfig } from '../config';

/** Attribute header (plan 03.3-15): not implemented yet (RED). */
export const ATTRIBUTE_HEADER_STAMP_KEY = 'attribute_header_stamp';
export const ATTRIBUTE_HEADER_STAMP_NONE = 'none';
export function attributeHeaderEnabled(_config?: IngestConfig): boolean {
  return false;
}
export function placeholdersOf(_template: string): string[] {
  return [];
}
export function renderAttributeHeader(_template: string, _attributes: unknown, _separator: string): { header: string; row: Record<string, string | null> } {
  return { header: '', row: {} };
}
export function attributeHeaderStamp(_version: number, _row: Record<string, string | null>): string {
  return '';
}
export async function getHeaderTemplate(_input: unknown): Promise<unknown> {
  return { ok: false, reason: 'unavailable' };
}
export async function setHeaderTemplate(_input: unknown, _template: string | null): Promise<unknown> {
  return { ok: false, reason: 'unavailable' };
}
export async function loadHeaderTemplate(_tenantKey: string, _options: unknown): Promise<unknown> {
  return { ok: false, reason: 'unavailable' };
}
export function resetHeaderTemplateCacheForTests(): void {}
export async function documentHeadersFor(_tenantKey: string, _ids: readonly string[], _options: unknown): Promise<Map<string, unknown>> {
  return new Map();
}
export async function chunkHeadersFor(_chunks: unknown[], _options: unknown): Promise<Map<string, string>> {
  return new Map();
}
export async function listStaleHeaderDocuments(_tenantKey: string, _options: unknown): Promise<unknown> {
  return { ok: false, reason: 'unavailable' };
}
