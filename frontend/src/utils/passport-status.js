/**
 * Passport Pending workflow — derive a passport status from the employee's Passport
 * Number, the admin-configured Submission Due Date, and today's civil date.
 *
 * Pure + unit-testable. Mirrors backend/src/services/passport-status.js — keep the
 * status values + rules in sync. Dates are civil 'YYYY-MM-DD' strings; comparisons use
 * Asia/Kolkata (the business timezone) via istToday().
 *
 * Status:
 *   completed → a Passport Number is on record (workflow done; due date irrelevant)
 *   pending   → no passport yet, and either no due date is set, or today is BEFORE it
 *   overdue   → no passport yet, a due date is set, and today is ON or AFTER it (Required)
 *
 * On/after the due date the Passport Number becomes MANDATORY for the Identity submission.
 */

export const PASSPORT_STATUS = { COMPLETED: 'completed', PENDING: 'pending', OVERDUE: 'overdue' };

export const PASSPORT_STATUS_LABELS = {
  completed: 'Passport Completed',
  pending: 'Passport Pending',
  overdue: 'Passport Overdue',
};

// Shown when the due date has arrived and the Passport Number is still empty.
export const PASSPORT_MANDATORY_MESSAGE = 'Your passport submission due date has arrived. Please enter your Passport Number.';

/** Normalise a date-ish value to a civil 'YYYY-MM-DD' string, or '' when unusable. */
export function dateOnly(v) {
  const m = String(v ?? '').trim().match(/^(\d{4})-(\d{2})-(\d{2})/);
  return m ? `${m[1]}-${m[2]}-${m[3]}` : '';
}

/** A passport value counts as empty when null/undefined or blank after trimming. */
export function isPassportEmpty(v) {
  return String(v ?? '').trim() === '';
}

/** Whole days from `today` until `dueDate` (negative when overdue); null if either is unusable. */
export function daysUntil(today, dueDate) {
  const t = dateOnly(today);
  const due = dateOnly(dueDate);
  if (!t || !due) return null;
  const [ty, tm, td] = t.split('-').map(Number);
  const [dy, dm, dd] = due.split('-').map(Number);
  return Math.round((Date.UTC(dy, dm - 1, dd) - Date.UTC(ty, tm - 1, td)) / 86400000);
}

/**
 * True when a due date is CONFIGURED and today (civil) is ON or AFTER it. No due date →
 * never reached (existing optional/pending behavior retained). Caller passes Asia/Kolkata today.
 */
export function isDueReached(dueDate, today) {
  const due = dateOnly(dueDate);
  const t = dateOnly(today);
  return !!due && !!t && t >= due;
}

/**
 * Compute the passport workflow status.
 * @param {{passport?:string, dueDate?:string, today?:string}} o
 * @returns {'completed'|'pending'|'overdue'}
 */
export function passportStatus({ passport, dueDate, today } = {}) {
  if (!isPassportEmpty(passport)) return PASSPORT_STATUS.COMPLETED;
  return isDueReached(dueDate, today) ? PASSPORT_STATUS.OVERDUE : PASSPORT_STATUS.PENDING;
}

/** 'YYYY-MM-DD' for the given instant in Asia/Kolkata (business TZ), independent of browser TZ. */
export function istToday(date = new Date()) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(date);
}
