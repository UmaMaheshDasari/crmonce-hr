/**
 * Goal Reminder Settings — company-setting field metadata + pure helpers (no React).
 * Unit-tested via `node --test`. The backend reads these keys at run time
 * (reminder.service resolveGoalSettings / goalMilestone); this module only backs the
 * Company Settings UI (rendering the toggles + overdue interval, normalizing values).
 */
export const GOAL_MILESTONES = Object.freeze([
  { key: 'hr_goalrem_m3', label: '3 calendar months before due date' },
  { key: 'hr_goalrem_m2', label: '2 calendar months before due date' },
  { key: 'hr_goalrem_m1', label: '1 calendar month before due date' },
  { key: 'hr_goalrem_d15', label: '15 days before due date' },
  { key: 'hr_goalrem_d7', label: '7 days before due date' },
  { key: 'hr_goalrem_d3', label: '3 days before due date' },
  { key: 'hr_goalrem_d1', label: '1 day before due date' },
  { key: 'hr_goalrem_due', label: 'On the due date' },
  { key: 'hr_goalrem_overdue', label: 'Overdue reminders' },
]);

export const GOAL_OVERDUE_INTERVAL = Object.freeze({
  key: 'hr_goaloverdueintervaldays',
  label: 'Overdue Reminder Interval (Days)',
  min: 1, max: 30, default: 3,
  help: 'How often to repeat reminders after a goal becomes overdue.',
});

/** Truthy company-setting value → boolean (settings store 'true'/'false' strings). */
export function isEnabled(v) {
  return v === true || /^(true|1|yes|on)$/i.test(String(v ?? ''));
}

/** Normalize a loaded company object's goal-toggle fields (string → boolean) for the form,
 *  defaulting a missing/blank value to ON (matches COMPANY_DEFAULTS). */
export function normalizeGoalToggles(company = {}) {
  const out = {};
  for (const m of GOAL_MILESTONES) {
    const v = company[m.key];
    out[m.key] = (v === undefined || v === null || v === '') ? true : isEnabled(v);
  }
  return out;
}
