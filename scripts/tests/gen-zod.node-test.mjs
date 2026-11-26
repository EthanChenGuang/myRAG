import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const GEN = path.join(ROOT, 'scripts', 'gen-zod.mjs');

function tmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'gen-zod-'));
}

function writeSchema(dir, file, schema) {
  fs.writeFileSync(path.join(dir, file), `${JSON.stringify(schema, null, 2)}\n`);
}

function run(schemasDir, out) {
  return spawnSync(process.execPath, [GEN, '--schemas-dir', schemasDir, '--out', out], {
    cwd: ROOT,
    encoding: 'utf8',
  });
}

const simple = (title) => ({
  title,
  type: 'object',
  properties: { a: { type: 'string' } },
  required: ['a'],
  additionalProperties: false,
});

test('gen-zod exits 1 on an empty schema directory and leaves --out untouched', () => {
  const dir = tmp();
  const out = path.join(dir, 'out.ts');
  const result = run(dir, out);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /no .*schema/i);
  assert.equal(fs.existsSync(out), false);
});

test('gen-zod keeps an existing --out when it fails', () => {
  const dir = tmp();
  const out = path.join(dir, 'out.ts');
  fs.writeFileSync(out, 'KEEP');
  const result = run(dir, out);
  assert.equal(result.status, 1);
  assert.equal(fs.readFileSync(out, 'utf8'), 'KEEP');
});

test('gen-zod exits 1 when two files declare the same model title', () => {
  const dir = tmp();
  const out = path.join(dir, 'out.ts');
  writeSchema(dir, 'A.schema.json', simple('Same'));
  writeSchema(dir, 'B.schema.json', simple('Same'));
  const result = run(dir, out);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /duplicate/i);
  assert.equal(fs.existsSync(out), false);
});

test('gen-zod exits 1 naming the cycle for a self-referencing $defs entry', () => {
  const dir = tmp();
  const out = path.join(dir, 'out.ts');
  writeSchema(dir, 'Tree.schema.json', {
    title: 'Tree',
    type: 'object',
    properties: { child: { $ref: '#/$defs/Node' } },
    $defs: {
      Node: { type: 'object', properties: { next: { $ref: '#/$defs/Node' } } },
    },
  });
  const result = run(dir, out);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /cyclic \$ref.*Node/);
  assert.equal(fs.existsSync(out), false);
});

test('gen-zod emits a oneOf carrying discriminator as a union', () => {
  const dir = tmp();
  const out = path.join(dir, 'out.ts');
  writeSchema(dir, 'Shape.schema.json', {
    title: 'Shape',
    type: 'object',
    properties: {
      item: {
        discriminator: { propertyName: 'kind' },
        oneOf: [
          { type: 'object', properties: { kind: { const: 'a' } }, required: ['kind'], additionalProperties: false },
          { type: 'object', properties: { kind: { const: 'b' } }, required: ['kind'], additionalProperties: false },
        ],
      },
    },
    required: ['item'],
  });
  const result = run(dir, out);
  assert.equal(result.status, 0, result.stderr);
  const text = fs.readFileSync(out, 'utf8');
  assert.match(text, /z\.union\(/);
  assert.doesNotMatch(text, /z\.core|\$ZodIssue/);
});

test('gen-zod writes through a temp file and leaves no temp files behind', () => {
  const dir = tmp();
  const out = path.join(dir, 'out.ts');
  writeSchema(dir, 'One.schema.json', simple('One'));
  const result = run(dir, out);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(fs.readdirSync(dir).filter((f) => f.endsWith('.tmp')), []);
  assert.match(fs.readFileSync(out, 'utf8'), /export const OneSchema/);
});

test('committed schemas generate RagTraceSchema and RunManifestSchema without untyped schemas', () => {
  const dir = tmp();
  const out = path.join(dir, 'out.ts');
  const result = run(path.join(ROOT, 'rag-sidecar', 'schemas'), out);
  assert.equal(result.status, 0, result.stderr);
  const text = fs.readFileSync(out, 'utf8');
  assert.match(text, /export const RagTraceSchema/);
  assert.match(text, /export const RunManifestSchema/);
  assert.doesNotMatch(text, /z\.any\(\)/);
  assert.doesNotMatch(text, /from "zod"/);
});

function runTexts(registry, textsOut) {
  const dir = tmp();
  writeSchema(dir, 'A.schema.json', simple('A'));
  return spawnSync(process.execPath, [GEN, '--schemas-dir', dir, '--out', path.join(dir, 'out.ts'), '--registry', registry, '--texts-out', textsOut], {
    cwd: ROOT,
    encoding: 'utf8',
  });
}

test('gen-zod writes the notices and labels subset of the registry, stable across runs', () => {
  const dir = tmp();
  const registry = path.join(dir, 'packs.json');
  fs.writeFileSync(
    registry,
    JSON.stringify({
      packs: [
        { code: 'xb', texts: { notices: { z: 'Z', a: 'A' }, labels: { l: 'L' }, instructions: { i: 'secret prompt' } } },
        { code: 'xa', texts: { notices: { a: 'A2', z: null }, labels: { l: 'L2' }, instructions: { i: 'prompt' } } },
      ],
    }),
  );
  const out = path.join(dir, 'texts.generated.ts');
  const first = runTexts(registry, out);
  assert.equal(first.status, 0, first.stderr);
  const text = fs.readFileSync(out, 'utf8');
  assert.match(text, /^\/\/ GENERATED by scripts\/gen-zod\.mjs/);
  assert.match(text, /export const FIXED_TEXTS/);
  assert.doesNotMatch(text, /instructions|prompt/);
  assert.ok(text.indexOf('"xb"') < text.indexOf('"xa"'), 'languages keep registry order');
  assert.ok(text.indexOf('"a": "A"') < text.indexOf('"z": "Z"'), 'keys are sorted');
  assert.equal(runTexts(registry, out).status, 0);
  assert.equal(fs.readFileSync(out, 'utf8'), text);
});

test('gen-zod writes no texts module when --out is given without --texts-out', () => {
  const dir = tmp();
  writeSchema(dir, 'A.schema.json', simple('A'));
  const result = run(dir, path.join(dir, 'out.ts'));
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(fs.readdirSync(dir).sort(), ['A.schema.json', 'out.ts']);
});

