# RBAC — Role Matrix (Target)

_Target role structure. Proposed design — pending approval. No code changed._

## Four logical roles (hierarchy is conceptual; access is granular, not auto-inherited)

```
Employee  →  Manager  →  HR  →  Super Admin
(L1)         (L2)         (L3)   (L4)
```

> Per Phase 6: higher levels are NOT auto-granted in the frontend. Each role is a
> concrete set of granular permissions; a higher role simply has a larger set.

| Role | Maps from (current) | Responsibility | Data scope |
|---|---|---|---|
| **Employee** | `employee` (19 users) | Own HR information only | **Self** only |
| **Manager** | _NEW_ (0 today) | Team operational access + approvals | **Team** = direct reports via `_hr_manager_value` |
| **HR** | `hr_manager` (1 user) | Full HR operational access | **All employees** |
| **Super Admin** | `super_admin` (1 user) | Full unrestricted system access (`*`) | **All** |

- **`recruiter` (0 users):** dormant. Proposal → leave the choice value in place (not deleted, Phase 0), grant it Employee-level + recruitment permissions. No user is affected.
- **"IT Services / Admin":** does not exist and will not be created (Phase 5/13).

## Responsibilities in words

- **Employee** — view own attendance; punch in/out (where enabled); apply Late Login / Early Logout / Leave / Comp Off; view & print own payslip; view own leave/comp-off balance. No edits to attendance, no approvals, no admin.
- **Manager** — everything an Employee can do for themselves, plus: view **team** attendance/leave/comp-off; approve/reject team requests (leave, comp-off, attendance corrections, late login, early logout). No punch deletion, no payroll/salary, no admin **by default**.
- **HR** — full operational HR: employees (view/create/edit; delete = Super Admin), full attendance management (edit/add/edit/delete punch, delete attendance, override, approve/reject, export), full leave & comp-off & late-login & early-logout, reports, HR settings, view audit logs. Payroll/salary **only if those permissions are explicitly assigned** (`payroll.*`, `salary.view`). Roles/Permissions management only if explicitly assigned.
- **Super Admin** — everything, unrestricted (`*`), including Users, Roles & Permissions, Company Settings, Audit export.

## Team scope for Manager

"Team" = employees whose `_hr_manager_value` (reporting manager) equals the manager's employee id — the field already used for leave L1/L2 routing and manager notifications. Manager views/approvals are filtered to that set on the backend (never client-only).

## Sensitive actions (require a reason, written to the Audit Log — Phase 11/12)

Delete Punch · Edit Attendance · Delete Attendance · Attendance Override · Change Leave Balance · Create Manual Comp Off · Delete Comp Off · Payroll Adjustment · Salary Change · Role Change · Permission Change · Company/HR Setting Change.
