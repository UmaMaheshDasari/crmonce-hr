# RBAC — Changelog

_Every RBAC implementation change, newest first. Nothing here is deployed until "APPROVED TO DEPLOY"._

## Phase C — Security audit logging (RBAC-protected admin actions)
**Date:** 2026-08-26 · **Status:** implemented locally, NOT committed, NOT deployed · **Approved:** "APPROVED TO IMPLEMENT PHASE C ONLY".

**Changed:** Added an append-only security audit log for RBAC-guarded admin actions, captured centrally with **zero route-handler edits** (all business logic/calculations untouched). Complements — does not duplicate — the three existing field-diff trails (`hr_settingsaudits`, `hr_attendanceaudits`, `hr_profileaudits`).

**Mechanism:** the two guard helpers stash what they check on `req._audit` (purely additive); a global `res.on('finish')` middleware records a best-effort row for guarded **mutations** (POST/PUT/PATCH/DELETE) and **denied attempts** (403). Routine GET reads are not logged. Never throws, never blocks a request.

**Files (NEW):**
- `backend/src/services/provision-audit-log.js` — self-provisions `hr_auditlogs` (mirrors provision-settings-audit).
- `backend/src/services/audit-log.service.js` — `shouldAudit`/`buildEntry` (pure), `record`/`list` (best-effort), `pathTemplate`.
- `backend/src/middleware/audit.middleware.js` — `auditSensitiveActions` (res 'finish' recorder).
- `backend/src/modules/audit/audit.routes.js` — `GET /api/audit`, gated by `requireAnyPermission('audit.view')` (super_admin + HR).
- `backend/test/rbac-audit-log.test.js` — 9 tests.

**Files (EDITED):**
- `backend/src/middleware/auth.middleware.js` — `requireRole` & `requireAnyPermission` stash `req._audit` (additive; verified no behaviour change by full suite).
- `backend/src/server.js` — mount audit middleware on `/api` before routes; mount `/api/audit`; boot-provision `hr_auditlogs`.

**Fields captured:** action, category, actor, actorId, actorRole, required, method, path (id-templated), targetId, outcome (success/denied/error), statusCode, ip, occurredOn, details.

**DB changes:** ONE new table `hr_auditlogs` (auto-provisioned on boot). Zero changes to existing tables/columns/data.

**Retention:** append-only, retained indefinitely — consistent with the existing audit trails; no automated purge (reads capped, default top=500, max 2000). Future scheduled purge noted, not built.

**Validation:** 9/9 new tests pass; full backend suite **884/884**; 0 regressions; all new/edited files pass `node --check`.

**Rollback:** delete the 4 new source files + `backend/test/rbac-audit-log.test.js`; revert `auth.middleware.js` (remove the two `req._audit` stash lines) and `server.js` (remove the 3 added lines). The `hr_auditlogs` table, if already provisioned, is inert once the middleware is gone.

## Phase B — Backend authorization enforcement (migrate guards onto the catalogue)
**Date:** 2026-08-26 · **Status:** implemented locally, NOT committed, NOT deployed · **Approved:** "APPROVED TO IMPLEMENT PHASE B ONLY".

**Changed:** Migrated the three inconsistent backend guard mechanisms onto the Phase A granular catalogue via `requireAnyPermission('module.action', …)`, **preserving today's effective access exactly**. No route's role reachability changed (verified role-by-role). No calculation, business rule, DB structure, scope logic, or frontend was touched.

**Guard mechanisms migrated:**
- `requirePermission('module:read'|'module:write')` (legacy colon map) → `requireAnyPermission('module.view'|…)`. Payroll reads → `('payroll.view','payslip.view')` so employees keep own-payslip access.
- `requireRole('super_admin','hr_manager')` / `requireRole(...HR)` → `requireAnyPermission('<module.action>')` (both roles hold it; employee/recruiter don't).
- `requireRole('super_admin')` → `employees.delete` / `settings.edit` where those cleanly isolate super_admin; otherwise **retained** (see below).

**Inline `isHR` scope checks inside handlers were left UNCHANGED** (own/team/all scoping is not a guard).

**Deliberately retained `requireRole(...)`** (migrating would have changed behaviour — documented, not omissions):
- `requireRole('super_admin')`: payroll `/:id/unlock`, salary-structure `DELETE /:id`, goals `DELETE /:id`, attendance-requests `/setup`. hr_manager holds each module's `*`, so no granular perm isolates super_admin from HR here.
- `requireRole('super_admin','hr_manager')`: recruitment `POST /jobs` (role semantics — hr_manager yes, recruiter no — invert under the `recruitment.*` grant), and the peripheral celebrations routes (no catalogue module).

**Files:** 22 route files under `backend/src/modules/**` (attendance ×8, payroll ×6, employees, company, dashboard, performance/goals, recruitment, shared ×3). `backend/test/rbac-authorization.test.js` (NEW) — 11 guard-contract tests.

**Bug found & fixed during Phase B:** comp-off `/scan`, `/scan-month` and leave `POST /compoff` were first mapped to `compoff.create` — but employees hold `compoff.create` (self-raise), which would have let an employee trigger the HR bulk scan/grant. Remapped to `compoff.configure` / `compoff.manage_balance` (HR-only). Caught by the new employee→mutation→403 test.

**DB changes:** none. **Frontend:** untouched (no build needed).

**Validation:** 11/11 new authorization tests pass; full backend suite **875/875**; 0 regressions.

**Rollback:** `git checkout -- backend/src/modules` (all route edits) and delete `backend/test/rbac-authorization.test.js`. The Phase A catalogue/middleware are independent and can stay. Nothing is committed or deployed.

## Phase A — Permission model (single source of truth)
**Date:** 2026-08-26 · **Status:** implemented locally, NOT committed, NOT deployed · **Approved:** "APPROVED TO IMPLEMENT PHASE A ONLY".

**Changed:** Added a canonical granular permission catalogue + per-role grants + a pure resolver, and exposed the caller's resolved permissions on `GET /auth/me`. **Additive only — no authorization enforcement changed.**

**Files:**
- `backend/src/config/permissions.js` (NEW) — `CATALOGUE` (module→actions), `ALL_PERMISSIONS`, `ROLE_PERMISSIONS` (super_admin/hr_manager/recruiter/employee, mirroring today's effective access), `hasPermission(roleOrUser, perm)`, `permissionsForRole(role)`.
- `backend/src/middleware/auth.middleware.js` — imports the catalogue; adds `requireAnyPermission(...)`, `requireGranular(...)`, and re-exports `hasPermission`/`permissionsForRole`/catalogue. **Legacy `PERMISSIONS` map + `requirePermission` left UNCHANGED** (still drive all current checks).
- `backend/src/modules/auth/auth.routes.js` — `GET /auth/me` now also returns `permissions: string[]` (resolved for the caller's role). Existing clients reading only `user` are unaffected.
- `backend/test/rbac-permissions.test.js` (NEW) — 9 resolver unit tests.

**DB changes:** none.

**Reason:** Establish one authoritative granular permission model + resolver so Phase B can migrate the three inconsistent backend guards onto it, and Phase D can drive the frontend `hasPermission`.

**Impact:** No behaviour change. `/auth/me` carries a new `permissions` array (unused until Phase D). New middleware helpers are exported but attached to **no route yet**.

**Validation:** 9/9 new unit tests pass; full backend suite 864/864; frontend build clean.

**Rollback:** delete `backend/src/config/permissions.js` and `backend/test/rbac-permissions.test.js`; revert the two edited files (or `git checkout` them). No other code references the new module.
