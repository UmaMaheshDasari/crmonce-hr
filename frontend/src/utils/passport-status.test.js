/**
 * Passport Pending workflow — the pure status helper (passport-status.js), frontend mirror.
 * Covers pending (no due date / approaching), overdue-required (inclusive on the due date),
 * completed, isDueReached, daysUntil, istToday (Asia/Kolkata), and the mandatory message.
 * Run: `node --test src/utils/passport-status.test.js`
 */
import { test } from 'node:test';
import assert from 'node:assert';
import {
  PASSPORT_STATUS, PASSPORT_STATUS_LABELS, PASSPORT_MANDATORY_MESSAGE,
  dateOnly, isPassportEmpty, daysUntil, isDueReached, passportStatus, istToday,
} from './passport-status.js';

const DUE = '2026-11-15';

test('pending — no passport and no due date set', () => {
  assert.strictEqual(passportStatus({ passport: '', dueDate: '', today: '2026-10-28' }), PASSPORT_STATUS.PENDING);
});

test('pending — before the due date (approaching / day before)', () => {
  assert.strictEqual(passportStatus({ passport: '', dueDate: DUE, today: '2026-11-10' }), PASSPORT_STATUS.PENDING);
  assert.strictEqual(passportStatus({ passport: '', dueDate: DUE, today: '2026-11-14' }), PASSPORT_STATUS.PENDING);
  assert.strictEqual(daysUntil('2026-11-10', DUE), 5);
});

test('overdue/required — ON the due date and after (inclusive) with no passport', () => {
  assert.strictEqual(passportStatus({ passport: '', dueDate: DUE, today: DUE }), PASSPORT_STATUS.OVERDUE);
  assert.strictEqual(passportStatus({ passport: '', dueDate: DUE, today: '2026-11-16' }), PASSPORT_STATUS.OVERDUE);
  assert.strictEqual(daysUntil('2026-11-16', DUE), -1);
});

test('completed — passport on record (due date irrelevant)', () => {
  assert.strictEqual(passportStatus({ passport: 'A1234567', dueDate: DUE, today: '2026-11-16' }), PASSPORT_STATUS.COMPLETED);
  assert.strictEqual(passportStatus({ passport: 'A1234567', dueDate: '2020-01-01', today: '2026-10-28' }), PASSPORT_STATUS.COMPLETED);
});

test('isDueReached — inclusive; false with no/invalid date', () => {
  assert.strictEqual(isDueReached(DUE, '2026-11-14'), false);
  assert.strictEqual(isDueReached(DUE, DUE), true);
  assert.strictEqual(isDueReached(DUE, '2026-11-20'), true);
  assert.strictEqual(isDueReached('', '2026-11-20'), false);
});

test('helpers — isPassportEmpty, dateOnly', () => {
  assert.strictEqual(isPassportEmpty('  '), true);
  assert.strictEqual(isPassportEmpty('A1'), false);
  assert.strictEqual(dateOnly('2026-11-15T00:00:00Z'), '2026-11-15');
  assert.strictEqual(dateOnly('nope'), '');
});

test('istToday returns a YYYY-MM-DD string in Asia/Kolkata', () => {
  assert.match(istToday(new Date('2026-10-28T20:00:00Z')), /^\d{4}-\d{2}-\d{2}$/);
  // 2026-10-28 20:00 UTC = 2026-10-29 01:30 IST → the IST civil date rolls to the 29th
  assert.strictEqual(istToday(new Date('2026-10-28T20:00:00Z')), '2026-10-29');
});

test('labels + mandatory message', () => {
  assert.strictEqual(PASSPORT_STATUS_LABELS.overdue, 'Passport Overdue');
  assert.strictEqual(PASSPORT_MANDATORY_MESSAGE, 'Your passport submission due date has arrived. Please enter your Passport Number.');
});
