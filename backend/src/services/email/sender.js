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

// ── Purpose-based sender routing ──────────────────────────────────────────────
// Centralised so every caller routes by BUSINESS PURPOSE, not ad-hoc:
//   • HR-owned (HR approvals/rejections, ALL Late Login notifications, HR notices)
//     → the configured HR mailbox (HR_EMAIL_SENDER, default HR@crmonce.com).
//   • INFO-owned (genuinely informational: celebrations, generic notices)
//     → the configured INFO mailbox (GRAPH_SENDER, default info@crmonce.com).
//   • Employee request submissions → the employee's OWN mailbox when it is a valid
//     company mailbox; otherwise fall back to the INFO system mailbox with Reply-To
//     set to the employee (never spoof an external From).
const HR_SENDER_DEFAULT = 'HR@crmonce.com';
const INFO_SENDER_DEFAULT = 'info@crmonce.com';
function hrSender() { return process.env.HR_EMAIL_SENDER || HR_SENDER_DEFAULT; }
function infoSender() { return process.env.GRAPH_SENDER || INFO_SENDER_DEFAULT; }

/**
 * Employee-origin routing with a safe, non-spoofing fallback (sync; no mailbox-existence
 * check — callers that already verify the mailbox via Graph keep doing so). Returns an opts
 * fragment to spread into sendEmail: { from } when the employee has a valid company mailbox,
 * else { from: INFO, replyTo: <employee email if syntactically valid> }.
 */
function employeeOrigin(email) {
  const v = resolveSender({ email, label: 'Employee' });
  if (v.ok) return { from: v.sender };
  const e = String(email || '').trim();
  return EMAIL_RE.test(e) ? { from: infoSender(), replyTo: e } : { from: infoSender() };
}

// ── Recipient / CC routing (spec §A–§E) ───────────────────────────────────────
/** Normalize an address input (string | comma/semicolon list | array of
 *  strings/{email}|{address}) into a clean string[] (trimmed, empties dropped). */
function toAddrArray(v) {
  if (!v) return [];
  const arr = Array.isArray(v) ? v : String(v).split(/[,;]/);
  return arr
    .map(x => (typeof x === 'string' ? x : (x?.email || x?.address || '')))
    .map(s => String(s).trim())
    .filter(Boolean);
}

/**
 * Merge one or more CC inputs into a clean, de-duplicated CC list:
 *   • accepts strings, comma/semicolon lists, or arrays (mixed),
 *   • drops placeholder/seed-domain addresses,
 *   • drops any address already on the TO line (`excludeTo`),
 *   • drops the sender itself (`from`) so a mailbox is never CC'd on its own mail.
 * Returns string[] (possibly empty). Case-insensitive de-dup; preserves first-seen casing.
 */
function mergeCc(lists = [], { excludeTo = [], from = null } = {}) {
  const ex = new Set(toAddrArray(excludeTo).map(s => s.toLowerCase()));
  if (from) ex.add(String(from).trim().toLowerCase());
  const seen = new Set();
  const out = [];
  for (const list of (Array.isArray(lists) ? lists : [lists])) {
    for (const addr of toAddrArray(list)) {
      const lc = addr.toLowerCase();
      if (ex.has(lc) || seen.has(lc) || isPlaceholder(addr)) continue;
      seen.add(lc);
      out.push(addr);
    }
  }
  return out;
}

/**
 * Approval / rejection routing (spec §C/§D). Derived from the AUTHENTICATED approver's
 * own identity (the server-side `approver` object built from req.user) — NEVER from an
 * untrusted request-body field:
 *   • the approver IS the INFO mailbox  → From info@, CC HR@   (§D)
 *   • any other authorized approver     → From HR@,  CC info@  (§C: HR / Super Admin / manager)
 * @param {{email?:string}} approver
 * @returns {{ from:string, cc:string }}
 */
function decisionRouting(approver = {}) {
  const email = String(approver?.email || '').trim().toLowerCase();
  if (email && email === infoSender().toLowerCase()) return { from: infoSender(), cc: hrSender() };
  return { from: hrSender(), cc: infoSender() };
}

module.exports = {
  resolveSender, validateCompanyEmail, isPlaceholder, inTenant, tenantDomains, PLACEHOLDER_DOMAINS,
  hrSender, infoSender, employeeOrigin, toAddrArray, mergeCc, decisionRouting,
};
