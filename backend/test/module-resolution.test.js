/**
 * Module-resolution smoke test (regression for the Phase L production crash).
 *
 * The Phase K deploy crash-looped because backend/src/server.js required
 * './services/permission-overrides' while the file is 'permission-overrides.service.js'.
 * Unit tests passed because they required the service directly and never exercised
 * server.js's boot require path.
 *
 * This test statically walks EVERY .js under backend/src and confirms each relative
 * require('./…') / require('../…') resolves to a real file — WITHOUT executing any
 * module (require.resolve only resolves the path) and WITHOUT connecting to Dataverse.
 * It would have caught the bad require in server.js.
 */
process.env.NODE_ENV = 'test';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const SRC = path.resolve(__dirname, '../src');

function walk(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) { if (entry.name !== 'node_modules') out.push(...walk(p)); }
    else if (entry.name.endsWith('.js')) out.push(p);
  }
  return out;
}

// Match require('<relative path>') / require("<relative path>") string literals.
const REQ = /require\(\s*(['"])(\.\.?\/[^'"]+)\1\s*\)/g;

test('every relative require() under backend/src resolves to a real file', () => {
  const files = walk(SRC);
  assert.ok(files.length > 50, `expected to scan the backend src tree, found ${files.length} files`);
  const failures = [];
  for (const file of files) {
    const code = fs.readFileSync(file, 'utf8');
    let m;
    while ((m = REQ.exec(code)) !== null) {
      const rel = m[2];
      try {
        require.resolve(path.resolve(path.dirname(file), rel));   // resolves .js/.json/index; throws if missing
      } catch {
        failures.push(`${path.relative(SRC, file)} → require('${rel}') does not resolve`);
      }
    }
  }
  assert.deepEqual(failures, [], `Unresolvable relative requires:\n  ${failures.join('\n  ')}`);
});

test('server.js specifically resolves the permission-overrides service (Phase L regression)', () => {
  const serverJs = path.join(SRC, 'server.js');
  const code = fs.readFileSync(serverJs, 'utf8');
  // The boot line must reference the real service file, not the missing bare path.
  assert.ok(/permission-overrides\.service/.test(code), 'server.js must require permission-overrides.service');
  assert.doesNotThrow(() => require.resolve(path.resolve(SRC, './services/permission-overrides.service')));
});
