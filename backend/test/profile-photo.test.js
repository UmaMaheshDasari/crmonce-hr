/**
 * Employee profile photo — resolver priority + image-only URL validation.
 *
 * Two SEPARATE fields so HR's default photo and the employee's personal photo never
 * overwrite each other:
 *   hr_photourl          → HR/Admin DEFAULT
 *   hr_personalphotourl  → employee PERSONAL (wins)
 * resolvePhoto: personal → default → '' (caller shows initials — never a broken img).
 */
process.env.NODE_ENV = 'test';
process.env.AZURE_CLIENT_ID = process.env.AZURE_CLIENT_ID || 'test-client';
process.env.AZURE_CLIENT_SECRET = process.env.AZURE_CLIENT_SECRET || 'test-secret';
process.env.AZURE_TENANT_ID = process.env.AZURE_TENANT_ID || 'test-tenant';

const { test } = require('node:test');
const assert = require('node:assert');
const employees = require('../src/modules/employees/employee.routes');
const { resolvePhoto, validPhotoUrl } = employees;

// ── resolver priority (mirrors the frontend getEmployeeProfilePhoto) ──
test('resolvePhoto: personal photo WINS over the HR default', () => {
  assert.strictEqual(
    resolvePhoto({ hr_personalphotourl: '/uploads/me.jpg', hr_photourl: '/uploads/hr.jpg' }),
    '/uploads/me.jpg',
  );
});

test('resolvePhoto: HR default shows when there is no personal photo', () => {
  assert.strictEqual(resolvePhoto({ hr_photourl: '/uploads/hr.jpg' }), '/uploads/hr.jpg');
});

test('resolvePhoto: neither photo → "" (caller renders initials, never a broken image)', () => {
  assert.strictEqual(resolvePhoto({}), '');
  assert.strictEqual(resolvePhoto(null), '');
});

test('resolvePhoto: hr_photoremoved="true" SUPPRESSES the default → "" (show initials)', () => {
  // The employee removed their photo: personal cleared + removed flag set. The default
  // (CRMONCE) is NOT restored — the resolver returns '' so the Avatar shows initials.
  assert.strictEqual(resolvePhoto({ hr_photourl: '/uploads/crmonce.png', hr_photoremoved: 'true' }), '');
  assert.strictEqual(resolvePhoto({ hr_personalphotourl: '', hr_photourl: '/uploads/hr.jpg', hr_photoremoved: 'true' }), '');
});

test('resolvePhoto: a personal photo still wins even if the removed flag is stale true', () => {
  // Uploading a new photo clears the flag, but even if it lingered, personal wins.
  assert.strictEqual(resolvePhoto({ hr_personalphotourl: '/uploads/new.jpg', hr_photoremoved: 'true' }), '/uploads/new.jpg');
});

test('resolvePhoto: without the removed flag, default still shows (unchanged)', () => {
  assert.strictEqual(resolvePhoto({ hr_personalphotourl: '', hr_photourl: '/uploads/hr.jpg' }), '/uploads/hr.jpg');
});

// ── image-only URL validation (server-side; never trust the client) ──
test('validPhotoUrl: accepts an uploaded image under /uploads', () => {
  assert.strictEqual(validPhotoUrl('/uploads/abc123.png'), '/uploads/abc123.png');
  assert.strictEqual(validPhotoUrl('/uploads/abc.jpeg'), '/uploads/abc.jpeg');
});

test('validPhotoUrl: accepts an absolute http(s) image URL', () => {
  assert.strictEqual(validPhotoUrl('https://cdn.example.com/x.webp'), 'https://cdn.example.com/x.webp');
});

test('validPhotoUrl: empty → "" (a clear/remove is allowed)', () => {
  assert.strictEqual(validPhotoUrl(''), '');
  assert.strictEqual(validPhotoUrl(null), '');
});

test('validPhotoUrl: REJECTS non-image files (a PDF can never be a profile photo)', () => {
  assert.strictEqual(validPhotoUrl('/uploads/resume.pdf'), null);
  assert.strictEqual(validPhotoUrl('/uploads/malware.exe'), null);
});

test('validPhotoUrl: REJECTS non-upload / traversal / scheme tricks', () => {
  assert.strictEqual(validPhotoUrl('/etc/passwd'), null);
  assert.strictEqual(validPhotoUrl('/uploads/../secret.png'), null);   // path chars not allowed
  assert.strictEqual(validPhotoUrl('javascript:alert(1)'), null);
  assert.strictEqual(validPhotoUrl('data:image/png;base64,AAAA'), null);
});
