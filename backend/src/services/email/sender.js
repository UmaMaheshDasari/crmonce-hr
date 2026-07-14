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

const isPlaceholder = (email) =>
  !email || PLACEHOLDER_DOMAINS.some(d => String(email).toLowerCase().endsWith('@' + d));

const inTenant = (email) => {
  const e = String(email || '').toLowerCase();
  return tenantDomains().some(d => e.endsWith('@' + d));
};

/**
 * Resolve the mailbox `user` is allowed to send FROM.
 * @returns {{ ok: true, sender: string } | { ok: false, reason: string }}
 */
function resolveSender({ email, label = 'Employee' } = {}) {
  if (!email) {
    return { ok: false, reason: `${label} email not configured` };
  }
  if (isPlaceholder(email)) {
    return { ok: false, reason: `${label} email is a placeholder address (${email}); configure a real company mailbox` };
  }
  if (!inTenant(email)) {
    return {
      ok: false,
      reason: `Cannot send as ${email}: Microsoft Graph can only send from a mailbox in the M365 tenant (${tenantDomains().join(', ')}). ` +
              `External addresses are not supported — configure a company mailbox for this user.`,
    };
  }
  return { ok: true, sender: email };
}

module.exports = { resolveSender, isPlaceholder, inTenant, tenantDomains, PLACEHOLDER_DOMAINS };
