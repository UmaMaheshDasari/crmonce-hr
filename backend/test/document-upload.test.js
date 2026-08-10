/**
 * Document upload — end-to-end through the REAL docRouter + multer.
 *
 * Proves the upload code path works: a real multipart/form-data request is parsed by
 * multer (req.file), the file is written to disk, and the document record is created
 * with the correct metadata + employee binding. Also proves the upload directory is
 * auto-created (the fix) and that a missing file / blocked type are handled.
 *
 * Uses Node's global fetch/FormData/Blob (no network to Dataverse — d365 is stubbed).
 */
process.env.NODE_ENV = 'test';
process.env.AZURE_CLIENT_ID = process.env.AZURE_CLIENT_ID || 'test-client';
process.env.AZURE_CLIENT_SECRET = process.env.AZURE_CLIENT_SECRET || 'test-secret';
process.env.AZURE_TENANT_ID = process.env.AZURE_TENANT_ID || 'test-tenant';

const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');
// A CUSTOM, not-yet-existing upload dir → also verifies the "ensure dir exists" fix.
const UPLOAD_DIR = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'docup-')), 'nested', 'uploads');
process.env.UPLOAD_DIR = UPLOAD_DIR;

const { test, before, after, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert');
const express = require('express');
const d365 = require('../src/services/d365.service');
const { docRouter } = require('../src/modules/shared/perf-doc.routes');   // ← module ensures UPLOAD_DIR on load

let server, base, saved, created;

before(async () => {
  const app = express();
  app.use((req, res, next) => { req.user = { id: 'EMP1', role: 'employee', name: 'Emp One', email: 'e@crmonce.com' }; next(); });
  app.use('/documents', docRouter);
  // Same JSON error contract as server.js (so a failure surfaces err.message, §11).
  app.use((err, req, res, next) => { res.status(err.status || 500).json({ error: err.message || 'Internal server error' }); });   // eslint-disable-line no-unused-vars
  await new Promise((r) => { server = app.listen(0, '127.0.0.1', r); });
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => { server?.close(); try { fs.rmSync(UPLOAD_DIR, { recursive: true, force: true }); } catch {} });

beforeEach(() => {
  created = null;
  saved = { create: d365.create, getById: d365.getById, getList: d365.getList };
  d365.create = async (entity, payload) => { created = payload; return { hr_hrdocumentid: 'doc-1', ...payload }; };
  d365.getById = async () => ({ hr_hremployee1: 'Emp One' });
  d365.getList = async () => ({ data: [] });   // HR-notify lookup
});
afterEach(() => { Object.assign(d365, saved); });

async function upload(filename, contentType, bytes = '%PDF-1.4 test', fields = {}) {
  const fd = new FormData();
  fd.append('file', new Blob([Buffer.from(bytes)], { type: contentType }), filename);
  fd.append('employeeId', fields.employeeId ?? 'EMP1');
  fd.append('documentType', fields.documentType ?? 'PAN Card');
  fd.append('name', fields.name ?? 'My PAN');
  const res = await fetch(`${base}/documents/upload`, { method: 'POST', body: fd });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}

test('ensure-dir fix: the custom UPLOAD_DIR was auto-created on module load', () => {
  assert.ok(fs.existsSync(UPLOAD_DIR), 'upload dir exists');
});

test('PDF upload → 201, file written to disk, record has correct metadata + employee bind', async () => {
  const before = fs.readdirSync(UPLOAD_DIR).length;
  const { status, body } = await upload('statement.pdf', 'application/pdf');
  assert.strictEqual(status, 201);
  assert.strictEqual(created.hr_originalname, 'statement.pdf');
  assert.strictEqual(created.hr_contenttype, 'application/pdf');
  assert.match(created.hr_fileurl, /^\/uploads\/[a-f0-9-]+\.pdf$/);
  assert.strictEqual(created['hr_hremployee@odata.bind'], '/hr_hremployees(EMP1)');   // bound to the uploader
  assert.strictEqual(created.hr_documenttype, 'PAN Card');
  assert.strictEqual(created.hr_status, 'pending');
  assert.ok(created.hr_filesize > 0);
  assert.strictEqual(fs.readdirSync(UPLOAD_DIR).length, before + 1, 'exactly one new file on disk');
  assert.strictEqual(body.status, 'pending');
});

test('DOCX / XLSX / PNG all upload (201) with the right content type', async () => {
  const r1 = await upload('resume.docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
  assert.strictEqual(r1.status, 201); assert.match(created.hr_fileurl, /\.docx$/);
  const r2 = await upload('data.xlsx', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  assert.strictEqual(r2.status, 201); assert.match(created.hr_fileurl, /\.xlsx$/);
  const r3 = await upload('photo.png', 'image/png', '\x89PNG\r\n');
  assert.strictEqual(r3.status, 201); assert.strictEqual(created.hr_contenttype, 'image/png');
});

test('an employee uploads ONLY to themselves — a spoofed employeeId is ignored', async () => {
  await upload('x.pdf', 'application/pdf', '%PDF', { employeeId: 'SOMEONE-ELSE' });
  assert.strictEqual(created['hr_hremployee@odata.bind'], '/hr_hremployees(EMP1)');   // forced to req.user.id
});

test('missing file → 400 "No file uploaded" (not a crash)', async () => {
  const fd = new FormData();
  fd.append('employeeId', 'EMP1'); fd.append('documentType', 'PAN Card');
  const res = await fetch(`${base}/documents/upload`, { method: 'POST', body: fd });
  assert.strictEqual(res.status, 400);
  assert.match((await res.json()).error, /No file uploaded/i);
});

test('a real Dataverse write failure surfaces its reason (not just "upload failed")', async () => {
  d365.create = async () => { const e = new Error('Dataverse 400 on create: property hr_hremployee does not exist'); throw e; };
  const { status, body } = await upload('x.pdf', 'application/pdf');
  assert.strictEqual(status, 500);
  assert.match(body.error, /Dataverse 400 on create/);   // real reason reaches the client (§11)
});
