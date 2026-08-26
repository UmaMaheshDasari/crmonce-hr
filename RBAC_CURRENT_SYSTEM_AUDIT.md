# RBAC — Current System Audit

_Read-only audit of the existing authentication/authorization before any RBAC change._
_Date: 2026-08-26 · Code snapshot: git tag `rbac-before-implementation` @ `aa63db7`_

> **No code was changed to produce this document.** This records WHAT EXISTS TODAY.

---

## 0. Platform reality

- **Backend datastore = Microsoft Dataverse (Dynamics 365), cloud-hosted** — accessed via the OData Web API (`d365.service.js`). There is **no local SQL database**. A `pg_dump`/`mysqldump` is not possible; a data snapshot must be taken from the **Power Platform Admin Center** (system/manual backup) or the app's own export.
- Backend: Node/Express, PM2 cluster (`hr-backend`) on the VPS. Frontend: React/Vite. Deploy = git pull + `npm run build` + `pm2 restart`.

## 1. Authentication architecture

- **Stateless JWT (HS256), no server sessions.** `backend/src/middleware/auth.middleware.js` `authenticateToken` (L17-28) reads `Authorization: Bearer <token>`, verifies with `JWT_SECRET`, sets `req.user` = the decoded claims **directly** (not re-fetched from DB per request).
- **JWT claims** (`auth.service.js` `generateTokens`, L18-32): access token `{ id, email, role, name }`, expiry `JWT_ACCESS_EXPIRY` (default 15m); refresh token `{ id }` (default 7d). `role` = `toLabel('hr_role', hr_role)` — the string label of the employee's role choice.
- **Login** (`auth/auth.routes.js`): primary = **Azure AD SSO/MSAL** (`/azure/login` → `/azure/callback`, L21/34); the callback finds the employee by `hr_email` + active, or **auto-creates** one with role `employee` (L67-77). Fallback email/password `/login` (L99) → `auth.service.login()` (`bcrypt` vs `hr_password`).
- `GET /api/auth/me` (auth.routes L123) echoes `req.user`; the frontend hydrates from it.

## 2. User & employee model

- **No separate `users` table — the Dataverse employee record `hr_hremployees` IS the user.** Login loads the employee by email.
- Role identity = the **`hr_role` choice column** on `hr_hremployees`.
- Reporting hierarchy = the **`_hr_manager_value` lookup** (reporting manager) on the employee — a **data field, not a role**. Used for leave L1/L2 approval routing and manager email notifications.

## 3. Roles (current)

`hr_role` choice values (`picklist.js` L8-13): `employee` (123140000), `hr_manager` (123140001), `recruiter` (123140002), `super_admin` (123140003).

**Live counts (read-only query, 2026-08-26): 21 employees, all active —**

| Current role | Users | Effective access today |
|---|---|---|
| `employee` | **19** | Self-scoped: own attendance/leave/comp-off/payslip only |
| `hr_manager` | **1** | Full HR operational access (treated as "HR") |
| `super_admin` | **1** | Full unrestricted access (`*`) |
| `recruiter` | **0** | Dormant — value exists but no users; effectively employee-level + recruitment applications |

**There is NO "Admin"/"IT Services" role and NO team-level "Manager" role.** "HR" throughout the code = the pair `['super_admin','hr_manager']`.

## 4. Authorization model (current)

Predominantly **role-based**, with a *thin, mostly-unused* permission layer.

- **Static in-code map** `PERMISSIONS` (`auth.middleware.js` L10-15): `super_admin:['*']`, `hr_manager:['employee:*','attendance:*','payroll:*','leave:*','performance:*','document:*','recruitment:read']`, `recruiter:['recruitment:*','employee:read']`, `employee:[…:self]`. **Not stored in the DB.**
- **Three parallel guard mechanisms** are used inconsistently:
  1. `requirePermission(perm)` (L39-61) — supports `*`, module-wildcard, `:self`. **But only 6 coarse strings are actually wired**, mostly on GETs: `employee:read`, `attendance:read`, `payroll:read`, `recruitment:read|write`, `performance:read|write`, `document:read|write`.
  2. `requireRole(...roles)` (L30-37) — membership check; used on most WRITE endpoints.
  3. Inline `['super_admin','hr_manager'].includes(req.user.role)` — scattered through ~15 route files.
- All `:self` grants in the map are **never checked**; self-scoping is done ad-hoc via `req.user.role === 'employee'` → `targetId = self`.
- **`etime-agent.routes.js` is intentionally UNAUTHENTICATED** (device push endpoint; `server.js:113`). Must stay open.

### Backend route files → guard style (summary)
`employee.routes` (perm GET + role writes), `attendance.routes` (perm GET + role writes; mounts leave/comp-off/late-login/historical), `attendance-request.routes` (perm + role), `leave.routes` (perm + role + inline), `comp-off.routes` (inline HR), `late-login.routes` (inline HR), `historical-attendance.routes` (perm + inline HR), `holiday.routes` (role), `leave-opening/shift-history/requests/import-export/celebrations` (inline HR), `payroll.routes` (perm GET + inline), `payroll-settings.routes` (role; PUT super_admin), `salary-structure/advance/payroll-automation/pt-master` (role), `tax-declaration` (self + 1 role), `recruitment.routes` (perm + role for job POST), `goals.routes` (role; delete super_admin), `perf-doc.routes` (perm + role writes), `company.routes` (PATCH super_admin; GET open), `dashboard.routes` (role on admin-summary + self), `activity.routes` (auth only), `auth.routes` (public login).

## 5. Frontend authorization (current)

- `frontend/src/context/AuthContext.jsx`: `user` from `/auth/me`; tokens in `localStorage`. Helpers: **`hasRole(...roles)`** and **`isHR()` = `hasRole('super_admin','hr_manager')`**. **No `hasPermission`, no `isManager`, no `isAdmin`.**
- Sidebar (`AppShell.jsx`): nav items carry `roles:[...]`, filtered at render (L207/209). e.g. Employees/Documents/Salary Structure = `['super_admin','hr_manager']`; Company Settings = `['super_admin']`.
- Route protection (`App.jsx` `ProtectedRoute`, L48-58): requires auth; optional `roles` prop redirects unauthorized users to `/`. **No dedicated 403/Access-Denied page** (silent redirect). Many pages have no `roles` prop and self-scope internally.
- Button/action gating is via `isHR()` across ~30 components (EmployeeList, LeavePage, PayrollPage, AttendancePage, GoalsPage, …).

## 6. Audit logging (current)

**No single general-purpose audit log.** Three separate mechanisms:
1. **Activity feed** (`activity.service.js`) — a *display* feed: derives events from `createdon/modifiedon` on records + a 200-item **in-memory** ring buffer (`record()`). **Not persisted to an audit table.** Shape `{id,category,type,title,name,meta,time}`.
2. **Settings audit** (`settings-audit.service.js`) — **persisted, append-only**, table **`hr_settingsaudits`**. Proper `(scope, field, label, oldValue, newValue, changedBy, changedOn, effectiveDate, ruleVersion, reason, name)` trail. **Scoped to settings only** — only caller is `payroll-settings.routes` (PUT + history). Company settings PATCH does **not** write it.
3. **Profile audit** (`provision-profile-audit.js` + `profile.service.js`) — a separate employee-profile-change table.

## 7. Company settings (current)

- **Company Settings** (`company.service.js`, table `hr_companysettings`): `GET /`,`/config` open (branding/payslip); **`PATCH /` = `requireRole('super_admin')`** — no audit row written.
- **Payroll Settings** (`payroll-settings.service.js`, table `hr_payrollsettings`, ~60 fields incl. all attendance/leave/comp-off policy): `GET /`,`/history` = `super_admin`+`hr_manager`; **`PUT /` = `super_admin` only** → writes Setting History + live-reloads the attendance policy provider. `hr_manager` can view but not change.

## 8. Module permission facts (business rules NOT to change — Phase 22)

These live in **Company/Payroll Settings** and drive calculations; RBAC controls **who may change them**, never their values:
- Comp Off min worked hours (5h), auto-scan, manual, work report, approval, 0.5-day.
- Attendance daily thresholds (Full ≥7h / Half 5–<7h), full-day expected 9h, effective date 2026-08-01.
- Monthly hour balance (WorkingDays×9 − ApprovedLeave − ApprovedAdjustment − ApprovedEarlyLogout − Absent×9), no carry-forward, negative-only hourly deduction.
- Late Login (info-only), Early Logout & Hour Adjustment (approved → reduce required hours), Leave/half-day (0.5), Payroll/LOP/salary deductions, Shift history.
- Salary privacy: `SensitiveAmount` masks money in the web UI; payslip PDF (backend) always shows real values.

---

## Implications for the RBAC design
1. The **`PERMISSIONS` map in `auth.middleware.js` is the natural single seam** to centralize on — today it's vestigial. A granular permission model should extend it and be enforced consistently (replacing the three parallel mechanisms).
2. **Role mapping is clean and non-destructive**: `employee`→Employee, `hr_manager`→HR, `super_admin`→Super Admin. `recruiter` (0 users) is dormant. **"Manager" is brand-new** (needs a role + team scoping via `_hr_manager_value`).
3. There is **no unified persisted audit log** — one must be added for sensitive actions (attendance/punch/comp-off/salary/role/permission/setting changes with reason).
4. Adding a role value or new permission tables means **Dataverse schema provisioning** (Choice option or new tables) — the app already self-provisions tables elsewhere, so the pattern exists, but each is a metadata change.
5. `etime-agent` must remain unauthenticated.
