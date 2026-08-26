# RBAC — Permission Matrix (Target)

_Proposed granular permissions and the baseline grant per role. Pending approval; no code changed._
_Legend: ✓ granted · ✗ not granted · ⚙ only if explicitly assigned · (self) = own records only · (team) = direct reports._

## Permission catalogue (module.action)

Names follow a `module.action` convention (a light evolution of the existing `module:read` strings).

| Module | Permissions |
|---|---|
| employees | `employees.view` `employees.create` `employees.edit` `employees.delete` |
| attendance | `attendance.view` `attendance.edit` `attendance.add_punch` `attendance.edit_punch` `attendance.delete_punch` `attendance.delete` `attendance.override` `attendance.approve_request` `attendance.reject_request` `attendance.export` |
| leave | `leave.view` `leave.apply` `leave.edit` `leave.delete` `leave.approve` `leave.reject` `leave.manage_balance` `leave.export` |
| compoff | `compoff.view` `compoff.create` `compoff.edit` `compoff.delete` `compoff.approve` `compoff.reject` `compoff.manage_balance` `compoff.configure` |
| latelogin / earlylogout | `latelogin.apply` `latelogin.approve` `latelogin.reject` · `earlylogout.apply` `earlylogout.approve` `earlylogout.reject` |
| payroll | `payroll.view` `payroll.process` `payroll.edit` `payroll.export` |
| salary | `salary.view` `salary.edit` |
| payslip | `payslip.view` `payslip.print` |
| performance | `performance.view` `performance.create` `performance.edit` `performance.delete` |
| reports | `reports.view` `reports.export` |
| settings | `settings.view` `settings.edit` |
| users | `users.view` `users.create` `users.edit` `users.delete` `users.disable` |
| roles | `roles.view` `roles.create` `roles.edit` `roles.delete` |
| permissions | `permissions.view` `permissions.manage` |
| audit | `audit.view` `audit.export` |

`super_admin` holds `*` (implicit all) and is never restricted.

## Baseline grant per role

| Permission | Employee | Manager | HR | Super Admin |
|---|:--:|:--:|:--:|:--:|
| **employees.view** | ✓ (self) | ✓ (team) | ✓ | ✓ |
| employees.create / edit | ✗ | ✗ | ✓ | ✓ |
| employees.delete | ✗ | ✗ | ✗ | ✓ |
| **attendance.view** | ✓ (self) | ✓ (team) | ✓ | ✓ |
| attendance.edit | ✗ | ✗ | ✓ | ✓ |
| attendance.add_punch / edit_punch | ✗ | ✗ | ✓ | ✓ |
| attendance.delete_punch | ✗ | ✗ | ✓ | ✓ |
| attendance.delete | ✗ | ✗ | ✓ | ✓ |
| attendance.override | ✗ | ✗ | ✓ | ✓ |
| attendance.approve_request / reject_request | ✗ | ✓ (team) | ✓ | ✓ |
| attendance.export | ✗ | ✗ | ✓ | ✓ |
| **leave.apply / leave.view** | ✓ (self) | ✓ (self+team) | ✓ | ✓ |
| leave.approve / reject | ✗ | ✓ (team) | ✓ | ✓ |
| leave.manage_balance / edit / delete / export | ✗ | ✗ | ✓ | ✓ |
| **compoff.view / compoff.create(self apply)** | ✓ (self) | ✓ (self+team) | ✓ | ✓ |
| compoff.approve / reject | ✗ | ✓ (team) | ✓ | ✓ |
| compoff.edit / delete / manage_balance / configure | ✗ | ✗ | ✓ | ✓ |
| **latelogin.apply / earlylogout.apply** | ✓ | ✓ | ✓ | ✓ |
| latelogin/earlylogout.approve / reject | ✗ | ✓ (team) | ✓ | ✓ |
| **payslip.view / payslip.print** | ✓ (self) | ✓ (self) | ✓ | ✓ |
| **payroll.view / process / edit / export** | ✗ | ✗ | ⚙ | ✓ |
| **salary.view** | ✗ | ✗ | ⚙ | ✓ |
| salary.edit | ✗ | ✗ | ⚙ | ✓ |
| **performance.view** | ✓ (self) | ✓ (team) | ✓ | ✓ |
| performance.create / edit / delete | ✗ | ✗ | ✓ | ✓ |
| **reports.view / export** | ✗ | ✗ | ✓ | ✓ |
| **settings.view** | ✗ | ✗ | ✓ | ✓ |
| settings.edit | ✗ | ✗ | ✓ (HR settings) | ✓ (all) |
| **users.view / create / edit / disable** | ✗ | ✗ | ✗ | ✓ |
| users.delete | ✗ | ✗ | ✗ | ✓ |
| **roles.* / permissions.*** | ✗ | ✗ | ⚙ | ✓ |
| **audit.view** | ✗ | ✗ | ✓ | ✓ |
| audit.export | ✗ | ✗ | ✗ | ✓ |

**⚙ notes:** HR does **not** get `payroll.*`, `salary.*`, or `roles/permissions.*` by default — each must be explicitly assigned to a specific HR user (matches the current reality where payroll settings write is Super-Admin-only). `settings.edit` for HR = HR/attendance/leave/comp-off policy; company-wide settings stay Super Admin.

## Backend↔permission alignment (business logic unchanged — Phase 22)

The permissions only decide **who may call** an endpoint. The endpoint's calculation is untouched. Example enforcement targets (illustrative, not exhaustive):

| Endpoint (existing) | Required permission (new) |
|---|---|
| `DELETE /attendance/punch/:id` (via edit modal) | `attendance.delete_punch` |
| attendance edit / add punch (`AttendanceEditModal` save) | `attendance.edit` / `attendance.add_punch` |
| `PATCH /attendance-requests/:id/approve` | `attendance.approve_request` |
| leave approve/reject | `leave.approve` / `leave.reject` |
| comp-off approve / manual create / delete | `compoff.approve` / `compoff.create` / `compoff.delete` |
| `POST /payroll/run`, payroll edits | `payroll.process` / `payroll.edit` |
| salary structure read / write, `salary.view` gate on salary APIs | `salary.view` / `salary.edit` |
| `PUT /payroll-settings`, `PATCH /company` | `settings.edit` (+ super-admin for company) |
| roles/permissions admin APIs (new) | `roles.*` / `permissions.*` |
| audit log read/export (new) | `audit.view` / `audit.export` |
