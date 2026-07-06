/**
 * Signed, short-lived tokens for email "Approve / Reject" links.
 *
 * Reuses the existing JWT infrastructure (jsonwebtoken + JWT_SECRET) — no new
 * dependency. These tokens ONLY prove that an approval link is authentic and
 * un-expired; they never grant access on their own. The email-action endpoint
 * additionally requires a valid login JWT + role + current-status check before
 * anything is written to D365 (defence in depth).
 */
const jwt = require('jsonwebtoken');

const SECRET = process.env.APPROVAL_TOKEN_SECRET || process.env.JWT_SECRET;
const TTL = process.env.APPROVAL_LINK_EXPIRY || '3d';

/** Sign a single-purpose approval-link token bound to {type,id,level,action}. */
function signApprovalToken({ type, id, level, action }) {
  return jwt.sign({ typ: 'approval', type, id, level, action }, SECRET, { expiresIn: TTL });
}

/** Verify + decode an approval-link token. Throws on invalid / expired / tampered. */
function verifyApprovalToken(token) {
  const decoded = jwt.verify(token, SECRET);
  if (decoded.typ !== 'approval') throw new Error('Not an approval token');
  return decoded;
}

module.exports = { signApprovalToken, verifyApprovalToken };
