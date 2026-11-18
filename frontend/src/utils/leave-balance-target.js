/**
 * Resolves WHOSE leave balance the balance cards display.
 *
 * Precedence:
 *   1. fixedId  → a balance pinned to one person (HR Employee Details, or the Leave
 *      page's single Employee selector).
 *   2. HR with an explicit selection (legacy picker signature) → that employee.
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

/**
 * Decides what the Leave Balance block renders when driven by the Leave page's single
 * Employee selector. One selector controls the whole page, so:
 *   - `controlled` HR with NO employee chosen ("All Employees") → show a placeholder
 *     (no individual or aggregate balance is fetched or invented).
 *   - a chosen employee (fixedId) → that employee's balance.
 *   - non-HR → their own balance (targetId undefined → self).
 * `controlled` is false for standalone uses (e.g. HR Employee Details), which always
 * pin a fixedId and therefore never hit the placeholder.
 */
export function resolveBalanceView({ controlled = false, hr = false, fixedId } = {}) {
  return {
    showPlaceholder: controlled && hr && !fixedId,
    targetId: resolveBalanceTargetId({ fixedId }),
  };
}
