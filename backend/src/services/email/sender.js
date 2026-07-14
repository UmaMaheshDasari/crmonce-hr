/**
 * Dynamic sender resolution for the Leave email workflow.
 *
 * Rule: a user may only ever send FROM their OWN company mailbox.
 *   - Employee  → employee's own hr_email
 *   - HR        → HR's own hr_email        (e.g. hr@crmonce.com)
 *   - Super Admin → Super Admin's own hr_email (e.g. umamahesh@crmonce.com)
 *
 * Microsoft Graph app-only (client credentials, Mail.Send application) can send
 * AS any mailbox that actually exists in the M365 tenant. It CANNOT send from an
 * external address (gmail, etc.) or an unlicensed user — so we validate and, on
 * failure, return the EXACT reason. We NEVER silently fall back to info@crmonce.
 */

// Seed/placeholder domains that must never be used as a sender or recipient.
const PLACEHOLDER_DOMAINS = ['yourcompany.com', 'yourdomain.com', 'example.com'];

/** Tenant mail domains whose mailboxes Graph app-only can send as. Configurable. */
function tenantDomains() {
  return String(process.env.TENANT_MAIL_DOMAINS || 'crmonce.com')
    .split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
}

// Basic RFC-ish email shape (one @, a dot in the domain, no whitespace).
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const isPlaceholder = (email) =>
  !email || PLACEHOLDER_DOMAINS.some(d => String(email).toLowerCase().endsWith('@' + d));

const inTenant = (email) => {
  const e = String(email || '').toLowerCase();
  return tenantDomains().some(d => e.endsWith('@' + d));
};

/**
 * Validate that an address is a usable COMPANY mailbox:
 *   - not empty
 *   - valid email format
 *   - not a placeholder domain
 *   - belongs to a tenant domain (@crmonce.com) — external providers rejected
 * @returns {{ ok: true, email: string } | { ok: false, reason: string }}
 */
function validateCompanyEmail(email, label = 'Employee') {
  const e = String(email || '').trim();
  if (!e) return { ok: false, reason: `${label} email not configured` };
  if (!EMAIL_RE.test(e)) return { ok: false, reason: `${label} email format is invalid (${email})` };
  if (isPlaceholder(e)) return { ok: false, reason: `${label} email is a placeholder address (${e}); configure a real company mailbox` };
  if (!inTenant(e)) {
    return {
      ok: false,
      reason: `${label} email must be a company mailbox (${tenantDomains().join(', ')}). ` +
              `External providers (gmail, yahoo, outlook, etc.) are not allowed.`,
    };
  }
  return { ok: true, email: e };
}

/**
 * Resolve the mailbox a user is allowed to send FROM (always their OWN mailbox).
 * No fallback — an unusable mailbox returns the exact reason.
 * @returns {{ ok: true, sender: string } | { ok: false, reason: string }}
 */
function resolveSender({ email, label = 'Employee' } = {}) {
  const v = validateCompanyEmail(email, label);
  return v.ok ? { ok: true, sender: v.email } : { ok: false, reason: v.reason };
}

module.exports = { resolveSender, validateCompanyEmail, isPlaceholder, inTenant, tenantDomains, PLACEHOLDER_DOMAINS };
