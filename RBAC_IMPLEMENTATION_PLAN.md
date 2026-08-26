# RBAC — Implementation Plan

_Approach (approved 2026-08-26): **code-defined granular permission matrix**; roles **Employee / HR / Super Admin** (Manager deferred); **additive & non-destructive** (rollback = git tag `rbac-before-implementation` @ `aa63db7`). No HR data or business calculations change (Phase 22). No auto-deploy — stop for "APPROVED TO DEPLOY"._

## Guardrails (every phase)
- Delete nothing (users, roles, permissions, data). `recruiter` value kept dormant.
- Change no attendance/leave/comp-off/payroll/salary/half-day/monthly-hours calculations.
- `etime-agent` stays unauthenticated. Login stays working (Azure SSO + password).
- Backend permission check is the real security; frontend gating is UX only.
- Every batch: run backend tests + frontend build; commit; **do not deploy** until approved.

---

## PHASE A — Permission model (single source of truth)
**Objective:** one canonical granular matrix + resolver, enforced backend & frontend.
**Files:** `backend/src/config/permissions.js` (NEW — full `module.action` catalogue + `ROLE_PERMISSIONS` for employee/hr_manager/super_admin/recruiter, with `*`/module-wildcard/`:self` semantics preserved), `backend/src/middleware/auth.middleware.js` (import the catalogue; keep `requirePermission`; add `hasPermission(user, perm)` helper + `requireAnyPermission`), `backend/src/modules/auth/auth.routes.js` (`/auth/me` also returns the resolved permission list for the user's role, so the frontend gets it without a schema).
**DB changes:** none.
**Result:** `req.user` role → known permission set; `/auth/me` returns `permissions: string[]`.
**Validation:** unit test the resolver (wildcards, `:self`, unknown → false); existing 850+ tests green.
**Rollback:** delete the config file + revert middleware; nothing else references it yet.

## PHASE B — Backend enforcement (consistency pass)
**Objective:** replace the 3 inconsistent guards with `requirePermission(...)` on protected endpoints, preserving today's effective access exactly (HR = hr_manager keeps everything it has; employee stays self-scoped).
**Files:** the route files in the audit's §8 table — convert `requireRole('super_admin','hr_manager')` and inline `['super_admin','hr_manager']` checks to the matching permission (e.g. attendance writes → `attendance.edit`/`.add_punch`/`.delete_punch`/`.delete`/`.override`; approvals → `*.approve_request`/`leave.approve`/`compoff.approve`; payroll → `payroll.*`; settings → `settings.edit`). Self-scoping (`req.user.role==='employee'`) unchanged.
**DB changes:** none. **No new endpoints** (keeps existing routes).
**Result:** identical behaviour for current roles, now driven by one permission map; a 403 is returned consistently.
**Validation:** Phase-27 direct-API tests per role (employee delete-punch → 403; HR → 200); full regression (Phase 28).
**Rollback:** revert per-file; guards are 1-line swaps.

## PHASE C — Audit log (sensitive actions + reasons)
**Objective:** a unified, persisted audit trail for sensitive actions (Phase 11/12).
**Files:** `backend/src/services/provision-audit-log.js` (NEW — provisions `hr_auditlogs`: user, role, action, module, entity, entityId, employee, oldValue, newValue, reason, timestamp — following the existing self-provisioning pattern, resilient/idempotent), `backend/src/services/audit-log.service.js` (NEW — `record()` / `list()`), wire `record()` into the sensitive mutations (punch add/edit/delete, attendance edit/delete/override, leave-balance change, comp-off manual create/delete, payroll adjust, salary change, setting change). Frontend passes a `reason` for the destructive ones (Phase 11) — reuse the existing confirm-modal pattern; reason stored in the log.
**DB changes:** **one new additive table** `hr_auditlogs` (self-provisioned; no existing table altered).
**Result:** every sensitive action recorded with who/what/old→new/reason/when.
**Validation:** perform each action → row appears; unauthorized action → 403 and no row.
**Rollback:** stop calling `record()`; the table can remain (harmless, additive).

## PHASE D — Frontend permission layer
**Objective:** central `hasPermission` + real page/route guards + a 403 page; convert button gating.
**Files:** `frontend/src/context/AuthContext.jsx` (store `permissions` from `/auth/me`; add `hasPermission(perm)` + keep `hasRole`/`isHR` as thin wrappers for compat), `frontend/src/App.jsx` (`ProtectedRoute` gains `permission` prop → renders a real **Access Denied (403)** page instead of silent redirect), `frontend/src/components/AccessDenied.jsx` (NEW), `frontend/src/layouts/AppShell.jsx` (nav items gated by `permission` where appropriate, `roles` kept as fallback), and the ~30 components using `isHR()` for actions migrated to `hasPermission('…')` (Edit/Delete/Add Punch/Approve/Reject/Settings/Reports).
**DB changes:** none.
**Result:** UI hides/disables what the user can't do; direct URL to a forbidden page shows 403; backend still enforces.
**Validation:** as each role, menus/buttons/pages match the matrix; backend blocks anyway.
**Rollback:** revert per-file; `hasRole`/`isHR` untouched keep old behaviour.

## PHASE E — Administration UI (Roles & Permissions + Audit Logs)
**Objective:** `Administration → Roles & Permissions` (read-only matrix, grouped by module, Employee/HR/Super Admin) and `Administration → Audit Logs` (filterable list + export for Super Admin). No IT/Admin role.
**Files:** `frontend/src/modules/admin/RolesPermissionsPage.jsx` (NEW — reads the catalogue from a new read-only `GET /permissions/matrix`), `frontend/src/modules/admin/AuditLogsPage.jsx` (NEW — `GET /audit-logs`), routes in `App.jsx` (`roles.view` / `audit.view`), nav entries in `AppShell.jsx`, and `backend/src/modules/admin/*` (NEW read-only endpoints: matrix + audit list/export, guarded by `roles.view`/`audit.view`).
**DB changes:** none (matrix is code; audit table from Phase C).
**Result:** Super Admin/authorized HR can see the exact role→permission grid and the audit trail.
**Validation:** page renders the matrix; audit list paginates/filters; unauthorized → 403 page.
**Rollback:** remove routes/pages; backend endpoints are additive.

## PHASE F — Salary permission integration (Phase 19)
**Objective:** salary DATA access requires `salary.view` at the API (not just UI masking).
**Files:** salary/payroll read endpoints (`salary-structure.routes`, payroll salary fields) gate on `salary.view`; the existing `SensitiveAmount` masking stays as the UI layer on top. Payslip PDF (backend) keeps showing real values for anyone authorized to fetch the payslip.
**DB changes:** none.
**Result:** unauthorized users don't receive salary data at all; authorized users see masked-by-default with reveal.
**Validation:** a user without `salary.view` → salary API 403; payslip PDF still correct for authorized users.
**Rollback:** revert the guard; masking already deployed.

## PHASE G — Verify → Report → (await) Deploy
Backend tests + frontend build + Phase 26/27/28 role/API/regression matrices → **Phase-30 report** → **STOP** and wait for "APPROVED TO DEPLOY". Deploy = git pull + build + `pm2 restart` (+ run the audit-log provisioner once on the VPS).

---

## Sequencing & size
A → B → C → D → E → F, each its own commit(s), each with tests+build. A–B restore consistent, enforced backend security with zero behaviour change for current roles; C adds the audit trail; D–E deliver the UI; F closes the salary gap. Manager role + a DB-editable matrix are documented follow-ups, not in this plan.

## Rollback (whole feature)
`git reset --hard rbac-before-implementation` (code). The additive `hr_auditlogs` table can stay (unused) or be ignored. No employee/role/permission/HR data is ever deleted or recalculated.
