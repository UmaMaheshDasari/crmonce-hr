/**
 * Attendance Exception detection — pure, testable, no I/O.
 *
 * Given a computed session (computeSession result) for a COMPLETED day, report the
 * exceptions that need the employee's action. A day with no punches is "absent"
 * (handled by the absent engine), not a punch exception. An OPEN session for the
 * current day is normal (still working) — callers must only scan past days.
 *
 * Exception codes align 1:1 with the Attendance Correction types so an alert can
 * pre-fill the correction form.
 */
const EXCEPTIONS = {
  missing_check_in:  { label: 'Missing Check In',  priority: 'high' },
  missing_check_out: { label: 'Missing Check Out', priority: 'high' },
  missed_break_out:  { label: 'Missed Break Out',  priority: 'medium' },
  missed_break_in:   { label: 'Missed Break In',   priority: 'medium' },
};

/**
 * @param {object} c computeSession() result ({ count, punches:[{t,d}], attendanceIssue, status })
 * @returns {Array<{code,label,priority}>}
 */
function detectExceptions(c) {
  if (!c || (c.count || 0) === 0) return [];        // no punches → absent, not an exception
  const punches = Array.isArray(c.punches) ? c.punches : [];

  // Odd punch count → a CHECK punch is missing (in or out).
  if (c.count % 2 === 1) {
    const firstIsOut = punches[0] && punches[0].d === 'out';
    const code = (c.attendanceIssue === 'Missing Check In' || firstIsOut) ? 'missing_check_in' : 'missing_check_out';
    return [{ code, ...EXCEPTIONS[code] }];
  }

  // Even count but two CONSECUTIVE punches in the same direction → a BREAK punch
  // is missing between them (in,in ⇒ missed break-out ; out,out ⇒ missed break-in).
  for (let i = 1; i < punches.length; i++) {
    if (punches[i].d === punches[i - 1].d) {
      const code = punches[i].d === 'in' ? 'missed_break_out' : 'missed_break_in';
      return [{ code, ...EXCEPTIONS[code] }];
    }
  }
  return [];   // clean, well-paired day
}

module.exports = { detectExceptions, EXCEPTIONS };
