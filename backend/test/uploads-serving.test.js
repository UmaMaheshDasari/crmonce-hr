/**
 * Proves the profile-photo serving path: /api/uploads returns HTTP 200 + image/*
 * for a real image file, and 404 for non-images or missing files. This is the exact
 * middleware server.js mounts (imageUploadsStatic), exercised over real HTTP.
 */
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const express = require('express');
const { imageUploadsStatic, IMAGE_RE } = require('../src/middleware/uploads.middleware');

let server, base, dir;

before(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'uploads-test-'));
  // A minimal but real JPEG (SOI + APP0/JFIF + EOI) so express serves image/jpeg.
  fs.writeFileSync(path.join(dir, 'photo.jpg'), Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0xff, 0xd9]));
  fs.writeFileSync(path.join(dir, 'resume.pdf'), Buffer.from('%PDF-1.4 fake'));

  const app = express();
  app.use('/api/uploads', imageUploadsStatic(dir));
  await new Promise((resolve) => { server = app.listen(0, '127.0.0.1', resolve); });
  base = `http://127.0.0.1:${server.address().port}`;
});

after(() => { server?.close(); try { fs.rmSync(dir, { recursive: true, force: true }); } catch {} });

function get(urlPath) {
  return new Promise((resolve, reject) => {
    http.get(base + urlPath, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, type: res.headers['content-type'], len: Buffer.concat(chunks).length }));
    }).on('error', reject);
  });
}

test('IMAGE_RE matches image extensions only', () => {
  for (const f of ['a.jpg', 'a.jpeg', 'A.PNG', 'b.gif', 'c.webp', 'd.bmp']) assert.ok(IMAGE_RE.test(f), f);
  for (const f of ['a.pdf', 'a.docx', 'a.exe', 'a.txt', 'noext']) assert.ok(!IMAGE_RE.test(f), f);
});

test('CASE 7: a real image → HTTP 200 with Content-Type image/*', async () => {
  const r = await get('/api/uploads/photo.jpg');
  assert.strictEqual(r.status, 200);
  assert.match(r.type, /^image\//);
  assert.ok(r.len > 0, 'image bytes streamed');
});

test('a non-image file is never served through /api/uploads → 404', async () => {
  const r = await get('/api/uploads/resume.pdf');
  assert.strictEqual(r.status, 404);
});

test('a missing image → 404 (frontend Avatar then shows initials — never a broken image)', async () => {
  const r = await get('/api/uploads/does-not-exist.jpg');
  assert.strictEqual(r.status, 404);
});
