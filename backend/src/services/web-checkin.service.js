/**
 * Web Check-In access — per-employee permission, Admin-controlled.
 *
 * Web Check-In (the browser punch at POST /api/attendance/checkin|checkout) is
 * DISABLED by default and only usable by employees an Admin has explicitly enabled.
 * The flag lives on the employee record as the String column `hr_webcheckinenabled`
 * ('true' | 'false'; absent/empty = DISABLED — mirrors the existing hr_photoremoved
 * flag). Never a Boolean/Two-Options attribute (this codebase uses string flags).
 *
 * This is ONLY an access gate. It does not touch punch calculation, shift/late-login
 * logic, attendance records, or the separate eTime/device sync path.
 */
const d365 = require('./d365.service');

const EMP = d365.constructor.entities.employee;
const FIELD = 'hr_webcheckinenabled';

/** String/boolean → boolean. Matches the payroll-settings bool() idiom. */
const bool = (v) => v === true || /^(true|yes|1|on)$/i.test(String(v ?? ''));

/**
 * Is Web Check-In enabled for this employee? Reads the flag off the employee
 * record. Defaults to FALSE on any error / missing column (fail-closed: a read
 * failure must never silently grant access). Never throws.
 * @param {string} employeeId Dataverse employee GUID (req.user.id)
 * @returns {Promise<boolean>}
 */
async function isEnabled(employeeId) {
  if (!employeeId) return false;
  try {
    const e = await d365.getByIdOptional(EMP, employeeId, {
      select: 'hr_hremployeeid', optionalSelect: FIELD,
    });
    return bool(e?.[FIELD]);
  } catch {
    return false;   // fail-closed
  }
}

module.exports = { isEnabled, bool, FIELD };
