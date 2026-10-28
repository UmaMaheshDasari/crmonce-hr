/**
 * Passport Pending workflow — the pure status helper (passport-status.js).
 * Covers: pending (no due date), pending (approaching/day-before), overdue/required
 * (ON the due date and after — inclusive), completed, isDueReached, daysUntil, and the
 * mandatory message. No network, no production data.
 * Run: `node --test test/passport-status.test.js`
 */
const { test } = require('node:test');
const assert = require('node:assert');
const {
  PASSPORT_STATUS, PASSPORT_STATUS_LABELS, PASSPORT_MANDATORY_MESSAGE,
  dateOnly, isPassportEmpty, daysUntil, isDueReached, passportStatus,
} = require('../src/services/passport-status');

const DUE = '2026-11-15';

test('pending — no passport and no due date set yet', () => {
  assert.strictEqual(passportStatus({ passport: '', dueDate: '', today: '2026-10-28' }), PASSPORT_STATUS.PENDING);
  assert.strictEqual(passportStatus({ passport: null, dueDate: null, today: '2026-10-28' }), PASSPORT_STATUS.PENDING);
});

test('pending — before the due date (approaching); passport still optional', () => {
  assert.strictEqual(passportStatus({ passport: '', dueDate: DUE, today: '2026-11-10' }), PASSPORT_STATUS.PENDING);
  assert.strictEqual(passportStatus({ passport: '', dueDate: DUE, today: '2026-11-14' }), PASSPORT_STATUS.PENDING);  // one day before
  assert.strictEqual(daysUntil('2026-11-10', DUE), 5);   // "due in 5 days"
});

test('overdue/required — ON the due date and after (inclusive) with no passport', () => {
  assert.strictEqual(passportStatus({ passport: '', dueDate: DUE, today: DUE }), PASSPORT_STATUS.OVERDUE);           // on the due date
  assert.strictEqual(passportStatus({ passport: '', dueDate: DUE, today: '2026-11-16' }), PASSPORT_STATUS.OVERDUE);  // after
  assert.strictEqual(passportStatus({ passport: '   ', dueDate: DUE, today: '2027-01-01' }), PASSPORT_STATUS.OVERDUE);
  assert.strictEqual(daysUntil('2026-11-16', DUE), -1);  // 1 day overdue
});

test('completed — a passport number is on record (any date/due date)', () => {
  assert.strictEqual(passportStatus({ passport: 'A1234567', dueDate: DUE, today: '2026-11-16' }), PASSPORT_STATUS.COMPLETED);
  assert.strictEqual(passportStatus({ passport: 'A1234567', dueDate: '', today: '2026-10-28' }), PASSPORT_STATUS.COMPLETED);
  // a completed passport is NEVER overdue, even past the due date
  assert.notStrictEqual(passportStatus({ passport: 'X999', dueDate: '2020-01-01', today: '2026-10-28' }), PASSPORT_STATUS.OVERDUE);
});

test('isDueReached — inclusive from the due date; false with no/invalid date', () => {
  assert.strictEqual(isDueReached(DUE, '2026-11-14'), false);   // before
  assert.strictEqual(isDueReached(DUE, DUE), true);             // on the date (inclusive)
  assert.strictEqual(isDueReached(DUE, '2026-11-20'), true);    // after
  assert.strictEqual(isDueReached('', '2026-11-20'), false);    // no due date → never mandatory
  assert.strictEqual(isDueReached('bad', '2026-11-20'), false);
  assert.strictEqual(isDueReached(DUE, 'bad'), false);
});

test('isPassportEmpty + dateOnly helpers', () => {
  assert.strictEqual(isPassportEmpty(''), true);
  assert.strictEqual(isPassportEmpty('   '), true);
  assert.strictEqual(isPassportEmpty('A1'), false);
  assert.strictEqual(dateOnly('2026-11-15T00:00:00Z'), '2026-11-15');
  assert.strictEqual(dateOnly('not-a-date'), '');
});

test('labels + mandatory message', () => {
  assert.strictEqual(PASSPORT_STATUS_LABELS.pending, 'Passport Pending');
  assert.strictEqual(PASSPORT_STATUS_LABELS.overdue, 'Passport Overdue');
  assert.strictEqual(PASSPORT_STATUS_LABELS.completed, 'Passport Completed');
  assert.strictEqual(PASSPORT_MANDATORY_MESSAGE, 'Your passport submission due date has arrived. Please enter your Passport Number.');
});
