/**
 * Regression tests for decoder-failure classification.
 *
 * The harness wraps EVERY decoder failure as "corrupt Zstandard session log"
 * (dsh-session-persistence-jsonl/lib/index.js:3150), so a transient allocation failure is
 * indistinguishable from corruption unless we classify it ourselves. Getting this wrong is
 * expensive in one direction only: a "repair" of a healthy file destroys the session.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));

// Load the built entry; classifyDecodeFailure must be reachable from it.
// Windows: an absolute path is not a valid ESM specifier — build a file:// URL.
const mod = await import(pathToFileURL(join(here, '..', 'dist', 'index.js')).href);
const { classifyDecodeFailure } = mod;

test('an allocation failure is NOT corruption', () => {
  const err = { code: 'ZSTD_error_memory_allocation', stderr: 'zstd: error 64 : Allocation error : not enough memory\n' };
  assert.equal(classifyDecodeFailure(err), 'out-of-memory');
});

test('a missing zstd CLI is a tooling problem, not a file problem', () => {
  assert.equal(classifyDecodeFailure({ code: 'ENOENT', message: 'spawn zstd ENOENT' }), 'no-zstd-cli');
});

test('real format errors are the only thing worth repairing', () => {
  assert.equal(classifyDecodeFailure({ stderr: 'zstd: error 1 : unsupported frame' }), 'format');
  assert.equal(classifyDecodeFailure({ stderr: 'not a zstandard file' }), 'format');
});

test('unknown failures stay unknown (never silently treated as corruption)', () => {
  assert.equal(classifyDecodeFailure({ stderr: 'something else entirely' }), 'unknown');
  assert.equal(classifyDecodeFailure(undefined), 'unknown');
});

test('the repair path carries the hard guard against resource failures', () => {
  const src = readFileSync(join(here, '..', 'src', 'index.ts'), 'utf8');
  assert.match(src, /refusing to rewrite/, 'repair must refuse when the decoder failed for a resource reason');
  assert.match(src, /DECODE_OUT_OF_MEMORY/, 'the scan must label OOM separately from corruption');
  assert.match(src, /advisories/, 'unknown event vocabulary must be an advisory, not a problem');
});