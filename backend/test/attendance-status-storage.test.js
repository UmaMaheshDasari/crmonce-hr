/**
 * hr_status is an optionset (Edm.Int32). The computed display status 'in_progress'
 * (today's open session) has NO optionset value, so it must be mapped to 'incomplete'
 * via statusForStorage() BEFORE toValue() at every persist site — otherwise the raw
 * string 'in_progress' is sent to Dataverse and rejected with 0x80048d19
 * ("Cannot convert the literal 'in_progress' to the expected type 'Edm.Int32'").
 *
 * These tests pin the storage conversion so the correction-approval / historical /
 * import write paths can never send a non-numeric hr_status again.
 */
process.env.NODE_ENV = 'test';

const { test } = require('node:test');
const assert = require('node:assert');
const { statusForStorage } = require('../src/services/attendance.util');
const { toValue, PICKLISTS } = require('../src/services/picklist');

test('statusForStorage maps in_progress → incomplete, passes every other status through', () => {
  assert.strictEqual(statusForStorage('in_progress'), 'incomplete');
  for (const s of ['present', 'absent', 'half_day', 'incomplete', 'holiday']) {
    assert.strictEqual(statusForStorage(s), s);
  }
});

test('the optionset has NO in_progress value (so a raw label would be sent literally)', () => {
  assert.strictEqual(PICKLISTS.hr_attendance_status.in_progress, undefined);
  // toValue returns unknown labels UNCHANGED — proving why the raw string reached Dataverse.
  assert.strictEqual(toValue('hr_attendance_status', 'in_progress'), 'in_progress');
});

test('storage conversion yields a NUMBER for every computed status (never a string)', () => {
  // This is exactly what the persist sites now do: toValue(name, statusForStorage(c.status)).
  for (const status of ['present', 'absent', 'half_day', 'incomplete', 'holiday', 'in_progress']) {
    const stored = toValue('hr_attendance_status', statusForStorage(status));
    assert.strictEqual(typeof stored, 'number', `${status} → ${stored} must be an Int32, not a string`);
  }
});

test('in_progress is stored as the incomplete optionset value', () => {
  assert.strictEqual(
    toValue('hr_attendance_status', statusForStorage('in_progress')),
    PICKLISTS.hr_attendance_status.incomplete,
  );
});
