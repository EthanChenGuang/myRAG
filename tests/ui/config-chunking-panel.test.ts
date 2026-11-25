import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const repoRoot = path.resolve(import.meta.dirname, '../..');
const panelDir = path.join(repoRoot, 'scripts/config-ui/rag-panels');

type Findings = { errors: string[]; warnings: string[] };
type ValidationContext = Record<string, number | undefined>;

interface CaseRow {
  input: Record<string, unknown>;
  errors: string[];
  warnings: string[];
}

interface CaseTable {
  cases: CaseRow[];
  default_context: { max_child_tokens: number; top_k: number; context_budget: number };
  error_codes: string[];
  warning_codes: string[];
}

function loadValidator() {
  return require('../../scripts/config-ui/rag-panels/chunking-validate.js') as {
    CHUNKING_PRESETS: Record<string, { child_tokens: number; parent_tokens: number; parent_mode: string }>;
    validateChunking: (input: Record<string, unknown>, context?: ValidationContext) => Findings;
    chunkingPresetSizes: (
      preset: string,
      custom?: Record<string, unknown>,
    ) => { preset: string; child_tokens: unknown; parent_tokens: unknown; parent_mode: unknown } | null;
  };
}

function loadCaseTable(): CaseTable {
  return JSON.parse(fs.readFileSync(path.join(repoRoot, 'rag-sidecar/schemas/chunking-profile-cases.json'), 'utf8')) as CaseTable;
}

describe('chunking validator parity with chunking-profile-cases.json (D-21)', () => {
  const table = loadCaseTable();
  const { validateChunking } = loadValidator();
  const camel = {
    maxChildTokens: table.default_context.max_child_tokens,
    topK: table.default_context.top_k,
    contextBudget: table.default_context.context_budget,
  };

  it('the case table has rows', () => {
    expect(table.cases.length).toBeGreaterThanOrEqual(5);
  });

  it.each(loadCaseTable().cases.map((row) => [String(row.input.id), row] as const))('row %s gives the Pydantic errors and warnings', (_id, row) => {
    expect(validateChunking(row.input, camel)).toEqual({ errors: row.errors, warnings: row.warnings });
  });

  it('accepts the context in the case table spelling too', () => {
    for (const row of table.cases) {
      expect(validateChunking(row.input, table.default_context as unknown as ValidationContext)).toEqual({ errors: row.errors, warnings: row.warnings });
    }
  });

  it('reports only codes the case table names', () => {
    const known = new Set([...table.error_codes, ...table.warning_codes]);
    for (const row of table.cases) {
      const found = validateChunking(row.input, camel);
      for (const code of [...found.errors, ...found.warnings]) expect(known.has(code)).toBe(true);
    }
  });

  it('skips a rule whose context value is missing (UI-SPEC section 14 row 1)', () => {
    const contextCodes = new Set(['child_exceeds_embedding_input', 'top_k_parent_over_budget']);
    for (const row of table.cases) {
      const expected = {
        errors: row.errors.filter((code) => !contextCodes.has(code)),
        warnings: row.warnings.filter((code) => !contextCodes.has(code)),
      };
      expect(validateChunking(row.input, {})).toEqual(expected);
      expect(validateChunking(row.input)).toEqual(expected);
    }
    const partial = validateChunking({ child_tokens: 256, parent_mode: 'structure', parent_tokens: 1024 }, { topK: 8 });
    expect(partial.warnings).not.toContain('top_k_parent_over_budget');
  });

  it('answers invalid_shape for sizes that are not whole numbers of 1 or more', () => {
    expect(validateChunking({ child_tokens: 0, parent_mode: 'structure', parent_tokens: 1024 }, camel).errors).toEqual(['invalid_shape']);
    expect(validateChunking({ child_tokens: 256.5, parent_mode: 'fixed', parent_tokens: 1024 }, camel).errors).toEqual(['invalid_shape']);
    expect(validateChunking({ child_tokens: 256, parent_mode: 'sideways', parent_tokens: 1024 }, camel).errors).toEqual(['invalid_shape']);
    expect(validateChunking({ child_tokens: 256, parent_mode: 'fixed', parent_tokens: '1024' }, camel).errors).toEqual(['invalid_shape']);
  });
});

describe('chunking presets', () => {
  const { CHUNKING_PRESETS, chunkingPresetSizes } = loadValidator();

  it('128/512, 256/1024 and 256/2048 expand to their sizes with structure parents', () => {
    expect(chunkingPresetSizes('128/512')).toEqual({ preset: '128/512', child_tokens: 128, parent_tokens: 512, parent_mode: 'structure' });
    expect(chunkingPresetSizes('256/1024')).toEqual({ preset: '256/1024', child_tokens: 256, parent_tokens: 1024, parent_mode: 'structure' });
    expect(chunkingPresetSizes('256/2048')).toEqual({ preset: '256/2048', child_tokens: 256, parent_tokens: 2048, parent_mode: 'structure' });
    expect(Object.keys(CHUNKING_PRESETS)).toEqual(['128/512', '256/1024', '256/2048']);
  });

  it('a preset ignores typed values; custom keeps them', () => {
    expect(chunkingPresetSizes('256/2048', { child_tokens: 1, parent_tokens: 2, parent_mode: 'fixed' })).toMatchObject({
      child_tokens: 256,
      parent_tokens: 2048,
      parent_mode: 'structure',
    });
    expect(chunkingPresetSizes('custom', { child_tokens: 300, parent_tokens: 1800, parent_mode: 'fixed' })).toEqual({
      preset: 'custom',
      child_tokens: 300,
      parent_tokens: 1800,
      parent_mode: 'fixed',
    });
  });
});

describe('chunking-validate.js runs in the browser', () => {
  it('has no import or require and defines window.validateChunking in a classic-script context', () => {
    const code = fs.readFileSync(path.join(panelDir, 'chunking-validate.js'), 'utf8');
    expect(code).not.toMatch(/^\s*import\s/m);
    expect(code).not.toMatch(/\brequire\(/);
    const context: Record<string, unknown> = {};
    context.window = context;
    vm.createContext(context);
    new vm.Script(code, { filename: 'chunking-validate.js' }).runInContext(context);
    const validate = context.validateChunking as (input: Record<string, unknown>, ctx?: ValidationContext) => Findings;
    expect(typeof validate).toBe('function');
    expect(validate({ child_tokens: 256, parent_mode: 'fixed', parent_tokens: 400 }, {})).toEqual({
      errors: ['parent_below_twice_child'],
      warnings: [],
    });
  });
});
