// Contract with Phase 7 plans 07-38 and 07-39 (A-14): they read a caller's access groups only through scopeAccessFilter from @/lib/rag
// and the column document_chunks.access_groups. Renaming the accessor, its type or the keys of its three result shapes breaks that phase.
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import * as rag from '@/lib/rag';
import type { ScopeAccessFilter } from '@/lib/rag';
import { resetRagConfigForTests } from '@/lib/rag/config';
import { resetRagDepsForTests, setRagDepsForTests } from '@/lib/rag/deps';
import { mintAccessScope } from '@/lib/rag/tenant/access';
import { mintScope, withAccess } from '@/lib/rag/tenant/scope';

const REPO_ROOT = path.resolve(__dirname, '../../..');
const USER_A = '00000000-0000-4000-8000-0000000000a1';
const GROUP_A = 'g:00000000-0000-4000-8000-0000000000f1';

afterEach(() => {
  resetRagDepsForTests();
  resetRagConfigForTests();
});

describe('Phase 7 seams (A-14)', () => {
  test('scopeAccessFilter is exported from @/lib/rag under this name', () => {
    expect(typeof rag.scopeAccessFilter).toBe('function');
    const source = fs.readFileSync(path.join(REPO_ROOT, 'src/lib/rag/index.ts'), 'utf8');
    expect(source).toMatch(/export \{ scopeAccessFilter \} from '\.\/tenant\/access';/);
    expect(source).toMatch(/export type \{ ScopeAccessFilter \} from '\.\/tenant\/access';/);
  });

  test('the three result shapes have exactly the keys mode, keys and setHash as A-14 states', () => {
    setRagDepsForTests({ ragEnv: () => ({ RAG_DOC_ACCESS_GROUPS: 'off' }) });
    resetRagConfigForTests();
    const base = mintScope('personal', USER_A, null);
    const shapes: ScopeAccessFilter[] = [
      rag.scopeAccessFilter(base),
      rag.scopeAccessFilter(withAccess(base, mintAccessScope('admin_all', []))),
      rag.scopeAccessFilter(withAccess(base, mintAccessScope('keys', ['all', GROUP_A]))),
    ];
    expect(shapes.map((shape) => Object.keys(shape).sort())).toEqual([['mode'], ['mode'], ['keys', 'mode', 'setHash']]);
    expect(shapes.map((shape) => shape.mode)).toEqual(['off', 'admin_all', 'keys']);
    const keyed = shapes[2] as Extract<ScopeAccessFilter, { mode: 'keys' }>;
    expect(keyed.keys).toEqual(['all', GROUP_A]);
    expect(keyed.setHash).toMatch(/^[0-9a-f]{64}$/);
  });

  test('the chunk column is declared text[] NOT NULL DEFAULT {all} with the all / g:<uuid> / u:<uuid> key format', () => {
    const sql = fs.readFileSync(path.join(REPO_ROOT, 'supabase/migrations/0921_access_groups_columns.sql'), 'utf8');
    expect(sql).toContain("ALTER TABLE public.document_chunks ADD COLUMN IF NOT EXISTS access_groups text[] NOT NULL DEFAULT '{all}';");
    expect(sql).toContain("'^(all|[gu]:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$'");
  });
});
