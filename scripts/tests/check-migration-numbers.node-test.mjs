import { test } from 'node:test';
import assert from 'node:assert/strict';

import { checkMigrationNumbers, migrationNumberProblems } from '../ci/check-migration-numbers.mjs';

test('the repository migrations pass', () => {
  assert.deepEqual(checkMigrationNumbers(), []);
});

test('a common file and its mode files count as one migration', () => {
  assert.deepEqual(
    migrationNumberProblems(['0724_scrub.sql', '0724_scrub.single-tenant.sql', '0724_scrub.multi-tenant.sql', '0725_other.sql']),
    [],
  );
});

test('two migrations under one number fail, also when one of them is a mode file only', () => {
  assert.equal(migrationNumberProblems(['0986_doc_types.sql', '0986_review_writers.sql']).length, 1);
  assert.equal(migrationNumberProblems(['0986_doc_types.sql', '0986_review_writers.single-tenant.sql']).length, 1);
});

test('the shipped 0316 pair is allowed, but a third migration joining it fails', () => {
  assert.deepEqual(migrationNumberProblems(['0316_quarantine_access.sql', '0316_quarantine_admin.sql']), []);
  assert.equal(migrationNumberProblems(['0316_quarantine_access.sql', '0316_quarantine_admin.sql', '0316_new.sql']).length, 1);
});

test('a badly named sql file fails and other files are ignored', () => {
  assert.equal(migrationNumberProblems(['986_short.sql']).length, 1);
  assert.deepEqual(migrationNumberProblems(['0425_expected_pre_hashes.json', 'README.md']), []);
});
