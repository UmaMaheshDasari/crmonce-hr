/**
 * Email Notification Category registry — the single source of truth for the automated,
 * employee-directed email categories an employee can opt out of. Categories reflect the
 * email functionality that ACTUALLY exists in this HRMS (certification/training/announcement
 * categories are intentionally omitted — no such emails are sent).
 *
 * Each automated send tags itself with `opts.meta.type` (and the notification ledger's `type`).
 * `categoryForType()` maps those tags to a stable category key so the central email pipeline
 * (notification.service.sendEmail) can suppress a disabled category for an employee.
 *
 * An email whose type maps to NO category is "uncategorized" and is ALWAYS delivered
 * (operational mail — e.g. approval requests to HR) — preferences never suppress it.
 */

// Ordered for display. key = stable storage key; name/description for the UI.
const CATEGORIES = [
  { key: 'birthday',     name: 'Birthday',               description: 'Birthday wishes.' },
  { key: 'anniversary',  name: 'Work Anniversary',       description: 'Work and marriage anniversary wishes.' },
  { key: 'attendance',   name: 'Attendance',             description: 'Late login, early logout, missing punch and absent notices.' },
  { key: 'leave',        name: 'Leave',                  description: 'Leave and comp-off request updates and decisions.' },
  { key: 'payroll',      name: 'Payroll',                description: 'Payslips and payroll notices.' },
  { key: 'performance',  name: 'Performance',            description: 'Goal assignments, changes and goal reminders.' },
  { key: 'reminders',    name: 'Reminders',              description: 'Profile and passport completion reminders.' },
  { key: 'other',        name: 'Other HR Notifications', description: 'Advance salary, profile-change decisions and other HR emails.' },
];

const CATEGORY_KEYS = CATEGORIES.map((c) => c.key);
const isValidCategory = (key) => CATEGORY_KEYS.includes(String(key || ''));

// Administrative roles whose ROUTINE PERSONAL reminders are suppressed by default (§2C): HR
// Managers and Super Admins are administrative users and should not receive routine
// employee-action nudges addressed to them personally — unless they opt in (a "personal
// exception" = an explicit enabled preference row). This NEVER affects OPERATIONAL emails
// (approval requests etc.), which are uncategorized / not keyed to the admin's employeeId and so
// are never evaluated here.
const ADMIN_ROLES = new Set(['super_admin', 'hr_manager']);

// The routine personal-reminder categories that default OFF for admins. These are the daily/
// missing-punch/late/early attendance nudges and the profile/passport completion reminders.
// Decisions, payslips, celebrations, performance and "other" stay ON by default for everyone.
const ROUTINE_PERSONAL_CATEGORIES = new Set(['attendance', 'reminders']);

const isAdminRole = (role) => ADMIN_ROLES.has(String(role || ''));
const isRoutinePersonal = (category) => ROUTINE_PERSONAL_CATEGORIES.has(String(category || ''));

/** Default enabled state for a category given the recipient's role (before explicit overrides). */
function defaultEnabledFor(category, role) {
  if (isAdminRole(role) && isRoutinePersonal(category)) return false;   // §2C: admin routine → OFF
  return true;                                                          // everything else → ON
}

// Default for a NORMAL employee: ALL categories enabled (preserves existing email behaviour).
function defaultPreferences() {
  return Object.fromEntries(CATEGORY_KEYS.map((k) => [k, true]));
}

/** Role-aware default map (admins get routine-personal categories OFF). */
function defaultPreferencesFor(role) {
  return Object.fromEntries(CATEGORY_KEYS.map((k) => [k, defaultEnabledFor(k, role)]));
}

/**
 * Map an email `meta.type` / ledger `type` tag to a category key, or null when the email is
 * uncategorized (always delivered). Pure; order of checks matters (specific → general).
 */
function categoryForType(type) {
  const t = String(type || '');
  if (!t) return null;
  const lo = t.toLowerCase();

  // Celebrations
  if (lo.startsWith('celebration_birthday')) return 'birthday';
  if (lo.startsWith('celebration_')) return 'anniversary';          // work / marriage anniversary

  // Reminders (profile / passport) vs performance (goal reminders)
  if (lo.startsWith('goal_reminder') || lo.startsWith('goal_')) return 'performance';
  if (lo.startsWith('profile_reminder') || lo.startsWith('passport_reminder')) return 'reminders';

  // Attendance / permission notices
  if (lo.startsWith('late_login') || lo.startsWith('missing_punch') || lo.startsWith('early_logout')
      || lo.startsWith('absent_') || lo === 'permission_policy' || lo === 'hist_attendance'
      || lo.startsWith('late_permission')) return 'attendance';

  // Payroll
  if (lo === 'payslip' || lo.startsWith('payroll')) return 'payroll';

  // Leave + comp-off
  if (lo.startsWith('leave') || lo === 'comp_off') return 'leave';

  // Other employee-directed HR mail
  if (lo === 'advance' || lo === 'profile_decision' || lo === 'lifecycle') return 'other';

  return null;   // uncategorized → always delivered
}

module.exports = {
  CATEGORIES, CATEGORY_KEYS, isValidCategory, defaultPreferences, categoryForType,
  ADMIN_ROLES, ROUTINE_PERSONAL_CATEGORIES, isAdminRole, isRoutinePersonal,
  defaultEnabledFor, defaultPreferencesFor,
};
