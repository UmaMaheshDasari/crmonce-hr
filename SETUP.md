# HR System — Local Setup Guide

## Prerequisites
- Node.js 20+ → https://nodejs.org
- Git

## Step 1 — Install dependencies

```bash
cd hr-system
npm run install:all
```

## Step 2 — Configure backend environment

```bash
cd backend
cp .env.example .env
```

Open `backend/.env` and fill in:

| Key | Where to get it |
|---|---|
| `AZURE_TENANT_ID` | Azure Portal → Azure AD → Overview |
| `AZURE_CLIENT_ID` | Azure Portal → App registrations → your app |
| `AZURE_CLIENT_SECRET` | App registrations → Certificates & secrets |
| `D365_BASE_URL` | Your D365 URL e.g. `https://yourorg.crm.dynamics.com` |
| `JWT_SECRET` | Run: `node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"` |

Optional (can leave defaults for local dev):
- `PG_*` — PostgreSQL for audit logs (app works without it)
- `REDIS_*` — Redis for caching (app works without it)
- `ETIME_*` — eTime Office (attendance sync won't work without it)
- `SMTP_*` — Email notifications (optional)

## Step 3 — Configure frontend environment

```bash
cd frontend
cp .env.example .env
```

The default `VITE_API_URL=http://localhost:5000/api` works for local dev.

## Step 4 — Set up D365 entities

```bash
# From project root:
npm run setup:d365
```

Follow the printed instructions to create the tables in Power Apps maker portal (make.powerapps.com).

## Step 5 — Test D365 connection

```bash
npm run test:d365
```

All entities should show ✅.

## Step 6 — Seed initial data

```bash
npm run seed
```

This creates:
- Admin user: `admin@yourcompany.com` / `Admin@1234`
- HR Manager: `priya.sharma@yourcompany.com` / `HRManager@1234`
- 8 departments
- 11 designations

## Step 7 — Run the project

```bash
# From project root — starts BOTH backend and frontend:
npm run dev
```

- Frontend → http://localhost:3000
- Backend API → http://localhost:5000
- Health check → http://localhost:5000/health

## Running separately

```bash
# Backend only
npm run dev:backend

# Frontend only
npm run dev:frontend
```

## Project structure

```
hr-system/
├── backend/              ← Node.js + Express API
│   ├── src/
│   │   ├── server.js
│   │   ├── services/     ← D365, eTime, Auth, Notifications
│   │   ├── middleware/   ← JWT + RBAC
│   │   ├── modules/      ← Route handlers per module
│   │   └── jobs/         ← Cron jobs
│   └── scripts/          ← Setup, seed, test scripts
├── frontend/             ← React + Tailwind
│   └── src/
│       ├── api/          ← Axios client
│       ├── context/      ← Auth state
│       ├── layouts/      ← Sidebar shell
│       ├── components/   ← Shared components
│       └── modules/      ← Feature pages
├── package.json          ← Root scripts (runs both)
└── SETUP.md              ← This file
```

## Modules

| Module | Route | Access |
|---|---|---|
| Dashboard | / | All |
| Employees | /employees | All (HR can edit) |
| Attendance | /attendance | All (HR sees all) |
| Leave | /leave | All (HR approves) |
| Payroll | /payroll | HR only |
| Recruitment | /recruitment | All |
| Performance | /performance | All |
| Documents | /documents | All |

## Default roles

| Role | Permissions |
|---|---|
| `super_admin` | Full access |
| `hr_manager` | All except super admin |
| `recruiter` | Recruitment + read employees |
| `employee` | Own data only |
