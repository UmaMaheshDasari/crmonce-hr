/**
 * Leave Reason length policy — the SINGLE source of truth shared by the backend
 * guard, the frontend counter and the Dataverse column width, so no layer disagrees.
 *
 * 4000 = the maximum for a Dataverse Single-Line-of-Text column (the type hr_reason
 * uses). This replaces the old artificial 100-char limit. Nothing is ever truncated:
 * within the limit it saves as-is; beyond it, the user gets a clear message.
 */
const LEAVE_REASON_MAX = 4000;

/** @returns {{ok:true}|{ok:false,error:string}} — never truncates. */
function validateLeaveReason(reason) {
  const len = String(reason ?? '').length;
  if (len > LEAVE_REASON_MAX) {
    return { ok: false, error: `Reason is too long (${len} characters). Please keep it within ${LEAVE_REASON_MAX} characters.` };
  }
  return { ok: true };
}

module.exports = { LEAVE_REASON_MAX, validateLeaveReason };
