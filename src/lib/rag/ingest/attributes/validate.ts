import type { AttributeDefinition } from '@/lib/rag-eval/contracts.generated';
import type { IngestAttributeValues } from '../types';

export const ATTRIBUTE_LIMITS = Object.freeze({ maxDefinitions: 0, maxValueLength: 0, maxListValues: 0 });
export const ATTRIBUTE_KEY_PATTERN = /^$/;
export type AttributeErrorCode = 'unknown_attribute' | 'invalid_attribute_type' | 'too_many_values' | 'value_too_long';
export interface AttributeError {
  key: string;
  code: AttributeErrorCode;
  index?: number;
}
export type ValidateAttributesResult = { ok: true; values: IngestAttributeValues } | { ok: false; errors: AttributeError[] };

export function validateAttributes(_definitions: readonly AttributeDefinition[], _raw: unknown): ValidateAttributesResult {
  return { ok: true, values: {} };
}
