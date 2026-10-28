/**
 * Pure helpers for the "Automated Reminder Interval (Days)" company setting
 * (hr_reminderintervaldays). No React — unit-tested via `node --test`.
 *
 * The backend reads this value at runtime (company.service → reminder.service
 * resolveIntervalDays); this module only backs the Company Settings UI field:
 * loading/normalizing the current value and validating admin input (1–30 days).
 */
export const REMINDER_INTERVAL = Object.freeze({
  key: 'hr_reminderintervaldays',
  label: 'Automated Reminder Interval (Days)',
  min: 1,
  max: 30,
  default: 3,
  help: 'Controls how often eligible employees receive repeat reminders.',
});

/** Parse a raw setting value to a whole number, or null when not numeric. */
export function parseInterval(v) {
  if (v === '' || v === null || v === undefined) return null;
  const n = Number(v);
  return Number.isFinite(n) ? Math.trunc(n) : null;
}

/** Normalize a loaded/entered value into [min,max]; invalid/empty → default. */
export function clampReminderInterval(v) {
  const n = parseInterval(v);
  if (n === null) return REMINDER_INTERVAL.default;
  return Math.min(REMINDER_INTERVAL.max, Math.max(REMINDER_INTERVAL.min, n));
}

/** react-hook-form `validate`: returns true when valid, else an error message. */
export function validateReminderInterval(v) {
  const n = parseInterval(v);
  if (n === null) return 'Enter a whole number of days.';
  if (n < REMINDER_INTERVAL.min || n > REMINDER_INTERVAL.max) {
    return `Must be between ${REMINDER_INTERVAL.min} and ${REMINDER_INTERVAL.max} days.`;
  }
  return true;
}
