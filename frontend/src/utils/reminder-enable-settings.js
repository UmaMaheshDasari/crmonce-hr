/**
 * Master ON/OFF reminder toggles (company settings, DB-backed) — pure helpers (no React).
 * These persist as 'true'/'false' strings like every company setting; the backend scheduler
 * reads them at run time (reminder.service isGoalRemindersEnabled / isProfileRemindersEnabled).
 * Effective enablement also requires the env master flag (GOAL_REMINDERS / PROFILE_DOC_REMINDERS).
 */
export const GOAL_REMINDERS_ENABLED = Object.freeze({
  key: 'hr_goalremindersenabled',
  label: 'Goal Reminders',
  help: 'When off, scheduled goal reminder emails are not sent (milestone settings are preserved).',
});
export const PROFILE_REMINDERS_ENABLED = Object.freeze({
  key: 'hr_profileremindersenabled',
  label: 'Profile & Required Document Reminders',
  help: 'When off, scheduled profile/document completion reminder emails are not sent.',
});
export const REMINDER_ENABLE_KEYS = Object.freeze([GOAL_REMINDERS_ENABLED.key, PROFILE_REMINDERS_ENABLED.key]);

/** Truthy company-setting value → boolean. */
export function isEnabled(v) {
  return v === true || /^(true|1|yes|on)$/i.test(String(v ?? ''));
}

/** Normalize the enable-toggle fields (string → boolean) for the form; missing/blank → ON. */
export function normalizeEnableToggles(company = {}) {
  const out = {};
  for (const k of REMINDER_ENABLE_KEYS) {
    const v = company[k];
    out[k] = (v === undefined || v === null || v === '') ? true : isEnabled(v);
  }
  return out;
}
