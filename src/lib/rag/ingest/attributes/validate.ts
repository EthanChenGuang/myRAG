import type { AttributeDefinition } from '@/lib/rag-eval/contracts.generated';
import type { IngestAttributeValues } from '../types';

/**
 * Pure validation of attribute values against a tenant's loaded definitions (TPL-08, D-12, D-22). No database, clock or log. Errors carry
 * the key, a code word and the list index only, never a value. Lengths count code points, as SQL length() does.
 */
export const ATTRIBUTE_LIMITS = Object.freeze({ maxDefinitions: 30, maxValueLength: 200, maxListValues: 50 });

export const ATTRIBUTE_KEY_PATTERN = /^[a-z][a-z0-9_]{0,39}$/;

export type AttributeErrorCode = 'unknown_attribute' | 'invalid_attribute_type' | 'too_many_values' | 'value_too_long';

export interface AttributeError {
  key: string;
  code: AttributeErrorCode;
  index?: number;
}

export type ValidateAttributesResult = { ok: true; values: IngestAttributeValues } | { ok: false; errors: AttributeError[] };

type ScalarCheck = { ok: true; value: string } | { ok: false; code: AttributeErrorCode };

function isPlainObject(raw: unknown): raw is Record<string, unknown> {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return false;
  const proto = Object.getPrototypeOf(raw);
  return proto === Object.prototype || proto === null;
}

function codePoints(value: string): number {
  return Array.from(value).length;
}

function checkScalar(raw: unknown): ScalarCheck {
  if (typeof raw !== 'string') return { ok: false, code: 'invalid_attribute_type' };
  const value = raw.trim();
  if (value.length === 0) return { ok: false, code: 'invalid_attribute_type' };
  if (codePoints(value) > ATTRIBUTE_LIMITS.maxValueLength) return { ok: false, code: 'value_too_long' };
  return { ok: true, value };
}

function checkList(key: string, raw: unknown, errors: AttributeError[]): string[] | null {
  if (!Array.isArray(raw) || raw.length === 0) {
    errors.push({ key, code: 'invalid_attribute_type' });
    return null;
  }
  const before = errors.length;
  if (raw.length > ATTRIBUTE_LIMITS.maxListValues) errors.push({ key, code: 'too_many_values' });
  const seen = new Set<string>();
  const values: string[] = [];
  raw.forEach((item: unknown, index) => {
    const checked = checkScalar(item);
    if (!checked.ok) {
      errors.push({ key, code: checked.code, index });
      return;
    }
    if (seen.has(checked.value)) {
      errors.push({ key, code: 'invalid_attribute_type', index });
      return;
    }
    seen.add(checked.value);
    values.push(checked.value);
  });
  return errors.length === before ? values : null;
}

export function validateAttributes(definitions: readonly AttributeDefinition[], raw: unknown): ValidateAttributesResult {
  if (!isPlainObject(raw)) return { ok: false, errors: [{ key: '', code: 'invalid_attribute_type' }] };
  const types = new Map<string, AttributeDefinition['type']>(definitions.map((definition) => [definition.key, definition.type]));
  const errors: AttributeError[] = [];
  const accepted = new Map<string, string | string[]>();
  for (const key of Object.keys(raw)) {
    const type = types.get(key);
    if (type === undefined) {
      errors.push({ key, code: 'unknown_attribute' });
      continue;
    }
    const value = raw[key];
    if (type === 'text_list') {
      const list = checkList(key, value, errors);
      if (list !== null) accepted.set(key, list);
      continue;
    }
    const checked = checkScalar(value);
    if (checked.ok) accepted.set(key, checked.value);
    else errors.push({ key, code: checked.code });
  }
  if (errors.length > 0) return { ok: false, errors };
  const values: IngestAttributeValues = {};
  for (const key of [...accepted.keys()].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))) values[key] = accepted.get(key) as string | string[];
  return { ok: true, values };
}
