import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Static scan of the Phase 4.4 migration block (0900 to 0919, D-04; D-31, D-32): every function sets an empty search_path, the listed
 * built-ins are always schema-qualified, every function taking p_tenant_key asserts the key before any other statement, no GRANT names a
 * client role, and no file in the block creates, replaces, alters or drops hybrid_search_chunks. Each offence prints its file and line.
 */
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const MIGRATIONS = path.join(REPO_ROOT, 'supabase/migrations');
const BLOCK = /^09(0\d|1\d)_.+\.sql$/;
const EXPECTED_FIRST = ['0900', '0901', '0902', '0903', '0904'];
/** Phase 4.4 files numbered outside the block: 0938 (p_df_mode), 0746 (lexical purge hook), 1014 (compaction guard, T-04.4-09). */
const EXTRA_FILES = ['0938', '0746', '1014'];
const BUILTINS = ['unnest', 'ts_rank', 'ts_rank_cd', 'cardinality', 'ln', 'quote_literal'];
/**
 * The one function that takes p_tenant_key without the guard: 0902's shared compaction body. Its callers assert (rag_lexstats_compact) or
 * read the key from rag_lexical_stats_state rows that rag_lexstats_enable asserted (rag_lexstats_compact_all), and it is service_role only
 * (tests/rag-db/lexical-stats-grants.test.mts). Plan 04.4-04 made that choice so one stray key cannot stop compact_all. Migration 1014
 * (outside this block, T-04.4-09) redefines it with the guard first and makes compact_all skip a refused key
 * (tests/rag-db/lexical-stats-compact-guard.test.mts); this exception covers only the superseded 0902 and 0905 bodies.
 */
const UNGUARDED_BODIES = new Set(['rag_lexstats_compact_tenant']);

interface SqlFile {
  name: string;
  /** Lines with -- comments blanked, same line numbers as the file. */
  lines: string[];
  code: string;
}

function stripComments(line: string): string {
  let inString = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (ch === "'") inString = !inString;
    if (!inString && ch === '-' && line[i + 1] === '-') return line.slice(0, i);
  }
  return line;
}

function loadBlock(): SqlFile[] {
  return fs
    .readdirSync(MIGRATIONS)
    .filter((name) => BLOCK.test(name))
    .sort()
    .map((name) => {
      const lines = fs.readFileSync(path.join(MIGRATIONS, name), 'utf8').split('\n').map(stripComments);
      return { name, lines, code: lines.join('\n') };
    });
}

function lineOf(file: SqlFile, index: number): number {
  return file.code.slice(0, index).split('\n').length;
}

interface FunctionDef {
  file: SqlFile;
  name: string;
  line: number;
  header: string;
  body: string;
}

/** Every CREATE [OR REPLACE] FUNCTION public.x: the header up to its AS $tag$, and the body between the dollar tags. */
function functions(file: SqlFile): FunctionDef[] {
  const out: FunctionDef[] = [];
  const re = /CREATE\s+(?:OR\s+REPLACE\s+)?FUNCTION\s+public\.([a-z0-9_]+)\s*\(/gi;
  for (let m = re.exec(file.code); m; m = re.exec(file.code)) {
    const rest = file.code.slice(m.index);
    const as = /\bAS\s+(\$[a-z0-9_]*\$)/i.exec(rest);
    assert.ok(as, `${file.name}:${lineOf(file, m.index)}: function ${m[1]} has no dollar-quoted body`);
    const tag = as[1] as string;
    const bodyStart = as.index + as[0].length;
    const bodyEnd = rest.indexOf(tag, bodyStart);
    assert.ok(bodyEnd > 0, `${file.name}:${lineOf(file, m.index)}: function ${m[1]} body is not closed`);
    out.push({ file, name: (m[1] as string).toLowerCase(), line: lineOf(file, m.index), header: rest.slice(0, as.index), body: rest.slice(bodyStart, bodyEnd) });
  }
  return out;
}

/** The first statement of a plpgsql body after BEGIN, or of a sql body. */
function firstStatement(def: FunctionDef): string {
  const begin = /\bBEGIN\b/i.exec(def.body);
  const tail = begin ? def.body.slice(begin.index + begin[0].length) : def.body;
  return (tail.split(';')[0] ?? '').replace(/\s+/g, ' ').trim();
}

describe('Phase 4.4 migration block, static scan', () => {
  const files = loadBlock();
  const defs = files.flatMap(functions);

  test('the block holds 0900 to 0904 and at least one function', () => {
    assert.deepEqual(files.slice(0, EXPECTED_FIRST.length).map((file) => file.name.slice(0, 4)), EXPECTED_FIRST);
    assert.ok(defs.length >= 14, `found ${defs.length} function definitions`);
  });

  test('the scan also covers the Phase 4.4 files outside the block: 0938, 0746 and 1014', () => {
    const scanned = files.map((file) => file.name.slice(0, 4));
    for (const number of EXTRA_FILES) assert.ok(scanned.includes(number), `${number} is not scanned`);
  });

  test("every CREATE OR REPLACE FUNCTION public.* sets search_path = ''", () => {
    const offences = defs.filter((def) => !/\bSET\s+search_path\s*=\s*''/i.test(def.header)).map((def) => `${def.file.name}:${def.line}: ${def.name}`);
    assert.deepEqual(offences, [], `functions without SET search_path = '':\n${offences.join('\n')}`);
  });

  test('unnest, ts_rank, ts_rank_cd, cardinality, ln and quote_literal are always schema-qualified', () => {
    const re = new RegExp(`(?<![.\\w"])(${BUILTINS.join('|')})\\s*\\(`, 'gi');
    const offences: string[] = [];
    for (const file of files) {
      file.lines.forEach((line, i) => {
        for (const m of line.matchAll(re)) offences.push(`${file.name}:${i + 1}: unqualified ${m[1]}(`);
      });
    }
    assert.deepEqual(offences, [], offences.join('\n'));
  });

  test('every function with a p_tenant_key asserts it with rag_assert_tenant_key before any other statement', () => {
    const offences: string[] = [];
    let guarded = 0;
    for (const def of defs) {
      if (!/\bp_tenant_key\b/i.test(def.header) || UNGUARDED_BODIES.has(def.name)) continue;
      guarded += 1;
      const first = firstStatement(def);
      if (!/^PERFORM\s+public\.rag_assert_tenant_key\s*\(\s*p_tenant_key\s*\)$/i.test(first)) offences.push(`${def.file.name}:${def.line}: ${def.name} starts with "${first.slice(0, 80)}"`);
    }
    assert.ok(guarded >= 8, `guarded functions found: ${guarded}`);
    assert.deepEqual(offences, [], offences.join('\n'));
  });

  test('the unguarded compaction body stays the only exception and is never granted beyond service_role', () => {
    const unguarded = defs.filter((def) => /\bp_tenant_key\b/i.test(def.header) && !/^PERFORM\s+public\.rag_assert_tenant_key/i.test(firstStatement(def)));
    assert.deepEqual([...new Set(unguarded.map((def) => def.name))], [...UNGUARDED_BODIES]);
  });

  test('no GRANT names anon, authenticated or PUBLIC', () => {
    const offences: string[] = [];
    for (const file of files) {
      const re = /\bGRANT\b[\s\S]*?;/gi;
      for (let m = re.exec(file.code); m; m = re.exec(file.code)) {
        const to = m[0].split(/\bTO\b/i).slice(1).join(' TO ');
        if (/\b(anon|authenticated|PUBLIC)\b/i.test(to)) offences.push(`${file.name}:${lineOf(file, m.index)}: ${m[0].replace(/\s+/g, ' ')}`);
      }
    }
    assert.deepEqual(offences, [], offences.join('\n'));
  });

  test('no file in the block creates, replaces, alters or drops hybrid_search_chunks', () => {
    const re = /\b(CREATE\s+(?:OR\s+REPLACE\s+)?FUNCTION|ALTER\s+FUNCTION|DROP\s+FUNCTION(?:\s+IF\s+EXISTS)?)\s+(?:public\.)?"?hybrid_search_chunks\b/gi;
    const offences: string[] = [];
    for (const file of files) {
      for (let m = re.exec(file.code); m; m = re.exec(file.code)) offences.push(`${file.name}:${lineOf(file, m.index)}: ${m[1]} hybrid_search_chunks`);
    }
    assert.deepEqual(offences, [], offences.join('\n'));
  });
});
