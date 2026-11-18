/**
 * Resolves WHOSE leave balance the balance cards display.
 *
 * This is deliberately INDEPENDENT of the request-list employee filter (LeavePage's
 * `empF`). The balance block answers "whose balance am I looking at", the request
 * filter answers "whose requests am I listing" — they are separate controls and must
 * never be coupled.
 *
 * Precedence:
 *   1. fixedId  → a balance pinned to one person (My Profile / HR Employee Details).
 *   2. HR with an explicit picker selection → that employee.
 *   3. otherwise → undefined, which the backend resolves to the signed-in user (self).
 *
 * It NEVER returns an arbitrary/other employee without an explicit selection — the
 * default is always the viewer's own balance.
 */
export function resolveBalanceTargetId({ fixedId, hr, selectedEmp } = {}) {
  if (fixedId) return fixedId;
  if (hr && selectedEmp) return selectedEmp;
  return undefined;
}
