/**
 * Document module — Content-Type resolution + upload filter. Guards the bug where
 * every file was effectively served as HTML/PDF: the served mime must match the
 * file's extension, and non-executable types must be accepted for upload.
 */
process.env.NODE_ENV = 'test';
process.env.AZURE_CLIENT_ID = process.env.AZURE_CLIENT_ID || 'test-client';
process.env.AZURE_CLIENT_SECRET = process.env.AZURE_CLIENT_SECRET || 'test-secret';
process.env.AZURE_TENANT_ID = process.env.AZURE_TENANT_ID || 'test-tenant';

const { test } = require('node:test');
const assert = require('node:assert');
const { _mimeFromName: mimeFromName, _BLOCKED_EXT: BLOCKED, _MIME_BY_EXT: MAP } = require('../src/modules/shared/perf-doc.routes');

test('each file type resolves to its OWN mime — never a blanket application/pdf', () => {
  const expected = {
    'a.pdf': 'application/pdf',
    'a.png': 'image/png', 'a.jpg': 'image/jpeg', 'a.jpeg': 'image/jpeg', 'a.gif': 'image/gif',
    'a.txt': 'text/plain', 'a.csv': 'text/csv', 'a.html': 'text/html', 'a.htm': 'text/html',
    'a.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'a.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'a.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    'a.zip': 'application/zip', 'a.rar': 'application/vnd.rar',
  };
  for (const [name, mime] of Object.entries(expected)) assert.strictEqual(mimeFromName(name), mime, name);
  // Only the .pdf case is application/pdf.
  const pdfish = Object.keys(expected).filter(n => mimeFromName(n) === 'application/pdf');
  assert.deepStrictEqual(pdfish, ['a.pdf']);
});

test('unknown/extension-less files fall back to octet-stream (still downloadable, not HTML/PDF)', () => {
  assert.strictEqual(mimeFromName('noext'), 'application/octet-stream');
  assert.strictEqual(mimeFromName('a.weirdext'), 'application/octet-stream');
});

test('upload filter blocks executables/scripts but accepts documents', () => {
  for (const bad of ['.exe', '.sh', '.php', '.js', '.bat', '.msi']) assert.ok(BLOCKED.has(bad), `${bad} blocked`);
  for (const ok of ['.pdf', '.docx', '.xlsx', '.pptx', '.png', '.jpg', '.jpeg', '.txt', '.csv', '.zip', '.rar', '.html']) assert.ok(!BLOCKED.has(ok), `${ok} allowed`);
});

test('all user-listed types are present in the mime map', () => {
  for (const ext of ['.pdf', '.png', '.jpg', '.jpeg', '.docx', '.xlsx', '.pptx', '.txt', '.csv', '.zip', '.rar', '.html']) assert.ok(MAP[ext], `${ext} mapped`);
});
