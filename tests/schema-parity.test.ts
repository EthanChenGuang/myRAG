import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const ROOT = path.resolve(__dirname, '..');
const SCHEMAS_DIR = path.join(ROOT, 'rag-sidecar', 'schemas');
const COMMITTED = path.join(ROOT, 'src', 'lib', 'rag-eval', 'contracts.generated.ts');
const GEN = path.join(ROOT, 'scripts', 'gen-zod.mjs');

let work: string;
let counter = 0;

function copyCase(): string {
  counter += 1;
  const dir = path.join(work, `case-${counter}`);
  fs.mkdirSync(dir, { recursive: true });
  for (const file of fs.readdirSync(SCHEMAS_DIR)) fs.copyFileSync(path.join(SCHEMAS_DIR, file), path.join(dir, file));
  return dir;
}

let outCounter = 0;

function gen(schemasDir: string, out = path.join(work, `out-${(outCounter += 1)}.ts`)) {
  const result = spawnSync('node', [GEN, '--schemas-dir', schemasDir, '--out', out], { encoding: 'utf8', cwd: work });
  return { status: result.status, stderr: result.stderr, out };
}

beforeAll(() => {
  work = fs.mkdtempSync(path.join(os.tmpdir(), 'schema-parity-'));
});

afterAll(() => {
  fs.rmSync(work, { recursive: true, force: true });
});

describe('gen-zod parity with the committed Pydantic schemas', () => {
  it('regenerates the committed contracts.generated.ts byte for byte, from any working directory', () => {
    const { status, out } = gen(copyCase());
    expect(status).toBe(0);
    expect(fs.readFileSync(out)).toEqual(fs.readFileSync(COMMITTED));
  });

  it('produces identical output on a second run', () => {
    const dir = copyCase();
    const first = gen(dir, path.join(work, 'first.ts'));
    const second = gen(dir, path.join(work, 'second.ts'));
    expect([first.status, second.status]).toEqual([0, 0]);
    expect(fs.readFileSync(second.out)).toEqual(fs.readFileSync(first.out));
  });

  it('detects a changed schema: one property type changed gives different output', () => {
    const dir = copyCase();
    const file = path.join(dir, 'SidecarInfo.schema.json');
    const schema = JSON.parse(fs.readFileSync(file, 'utf8'));
    schema.properties.version.type = 'integer';
    fs.writeFileSync(file, JSON.stringify(schema, null, 2));
    const { status, out } = gen(dir);
    expect(status).toBe(0);
    expect(fs.readFileSync(out, 'utf8')).not.toEqual(fs.readFileSync(COMMITTED, 'utf8'));
    expect(fs.readFileSync(out, 'utf8')).toContain('"version": z.number().int()');
  });

  it('exits 1 for a directory with no schema files', () => {
    const dir = path.join(work, 'empty');
    fs.mkdirSync(dir);
    const { status, stderr, out } = gen(dir);
    expect(status).toBe(1);
    expect(stderr).toContain('no *.schema.json files');
    expect(fs.existsSync(out)).toBe(false);
  });

  it('exits 1 when two files share a title', () => {
    const dir = copyCase();
    fs.copyFileSync(path.join(dir, 'SidecarInfo.schema.json'), path.join(dir, 'SidecarInfoCopy.schema.json'));
    const { status, stderr } = gen(dir);
    expect(status).toBe(1);
    expect(stderr).toContain('duplicate model title SidecarInfo');
  });

  it('exits 1 for a cyclic $ref', () => {
    const dir = copyCase();
    const cyclic = {
      title: 'Cyclic',
      $ref: '#/$defs/Node',
      $defs: {
        Node: { type: 'object', properties: { next: { $ref: '#/$defs/Node' } } },
      },
    };
    fs.writeFileSync(path.join(dir, 'Cyclic.schema.json'), JSON.stringify(cyclic));
    const { status, stderr } = gen(dir);
    expect(status).toBe(1);
    expect(stderr).toContain('cyclic $ref');
  });

  it('leaves no temp file and no partial output when generation fails', () => {
    const dir = copyCase();
    fs.writeFileSync(path.join(dir, 'Broken.schema.json'), '{ not json');
    const out = path.join(work, 'failed-out.ts');
    const { status } = gen(dir, out);
    expect(status).toBe(1);
    expect(fs.existsSync(out)).toBe(false);
    expect(fs.readdirSync(work).filter((name) => name.endsWith('.tmp'))).toEqual([]);
  });
});
