/**
 * Centralised, env-driven email configuration (no hardcoded branding/values).
 * Every template and notifier reads from here.
 */
const int = (v, d) => { const n = parseInt(v, 10); return Number.isFinite(n) ? n : d; };

module.exports = {
  brand: {
    name:        process.env.EMAIL_BRAND_NAME    || 'CRMONCE',
    tagline:     process.env.EMAIL_BRAND_TAGLINE || 'HR Management System',
    primary:     process.env.EMAIL_BRAND_PRIMARY || '#E84C88',
    primaryDark: process.env.EMAIL_BRAND_PRIMARY_DARK || '#D81B60',
    navy:        process.env.EMAIL_BRAND_NAVY    || '#1B4F72',
    appUrl:      (process.env.FRONTEND_URL || 'https://hr.crmonce.com').replace(/\/$/, ''),
    supportEmail: process.env.EMAIL_SUPPORT || process.env.GRAPH_SENDER || 'info@crmonce.com',
  },
  leave: {
    // Configurable annual entitlement used to compute a leave balance.
    annualEntitlement: int(process.env.ANNUAL_LEAVE_ENTITLEMENT, 24),
  },
  reminders: {
    enabled:           process.env.LEAVE_REMINDERS_ENABLED === 'true',
    reminderAfterHours: int(process.env.LEAVE_REMINDER_HOURS, 24),
    escalateAfterHours: int(process.env.LEAVE_ESCALATE_HOURS, 48),
    cron:              process.env.LEAVE_REMINDER_CRON || '0 * * * *', // hourly
  },
  ccOnDecision: process.env.NOTIFY_CC_ON_DECISION === 'true',
  // ── Notification recipient rules (configurable — NEVER hard-coded HR/info CC) ──
  // The DEFAULTS implement the correct behaviour: informational emails go to the
  // EMPLOYEE ONLY, with no automatic HR/manager CC. Recipients are always resolved
  // live from Dataverse (role + reporting-manager), never a hard-coded address.
  notify: {
    // Missing-punch email: add age-based manager (≥48h) / HR (≥72h) CC only if a
    // company explicitly opts in. Default OFF → employee only (§7, §14).
    exceptionEscalationCc: process.env.NOTIFY_EXCEPTION_ESCALATION_CC === 'true',
    // Auto "Late Entry" informational email to the EMPLOYEE (ONE per employee/day via
    // the ledger) when a check-in is past the 5-minute grace. ON by default; set
    // NOTIFY_LATE_LOGIN=false to disable. Dedupe always applies (§9).
    lateLoginNotice: process.env.NOTIFY_LATE_LOGIN !== 'false',
  },
  teams: {
    enabled:    !!process.env.TEAMS_WEBHOOK_URL,
    webhookUrl: process.env.TEAMS_WEBHOOK_URL || '',
  },
};
