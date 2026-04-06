# HR System — React + Node.js + D365 CRM + eTime Office

A full-featured HR Management System with biometric attendance integration via eTime Office and Microsoft Dynamics 365 CRM as the backend data store.

---

## Tech Stack

| Layer | Technology |
|---|---|
| Frontend | React 18, Vite, Tailwind CSS, React Query, React Router |
| Backend | Node.js, Express, Socket.io |
| Database | Microsoft Dynamics 365 CRM (OData Web API) |
| Attendance | eTime Office SDK/API |
| Auth | Azure AD OAuth 2.0 + JWT |
| Realtime | Socket.io |
| Cache | Redis |
| Audit logs | PostgreSQL |
| Hosting | Hostinger VPS + Nginx + PM2 |

---

## Modules

- **Dashboard** — KPI cards, attendance charts, headcount trend
- **Employees** — Master data, profiles, search, RBAC
- **Attendance** — eTime device logs, manual correction, sync trigger
- **Leave** — Apply, approve/reject, leave balance
- **Payroll** — Bulk process, payslip records
- **Recruitment** — Job posting, application kanban pipeline
- **Performance** — Review cycles, star ratings, KPIs
- **Documents** — Drag-and-drop upload, preview, download
- **Notifications** — Real-time Socket.io + email alerts

---

## Prerequisites

- Node.js 20+
- A Microsoft Dynamics 365 Online environment
- Azure AD App Registration with D365 permissions
- eTime Office installed and running
- Hostinger VPS (Ubuntu 22.04 recommended)

---

## Step 1 — Azure AD App Registration

1. Go to [portal.azure.com](https://portal.azure.com)
2. **Azure Active Directory → App registrations → New registration**
   - Name: `HR System Backend`
   - Supported account types: Single tenant
3. Copy the **Application (client) ID** → `AZURE_CLIENT_ID`
4. Copy the **Directory (tenant) ID** → `AZURE_TENANT_ID`
5. **Certificates & secrets → New client secret**
   - Copy the secret value → `AZURE_CLIENT_SECRET`
6. **API permissions → Add a permission → Dynamics CRM → user_impersonation**
7. Click **Grant admin consent**

---

## Step 2 — D365 Entity Setup

Run the setup guide script to see all entities you need to create:

```bash
cd backend
node scripts/setup-d365-entities.js
```

Then go to [make.powerapps.com](https://make.powerapps.com) and create each table.

### Required Tables (all prefixed `hr_`)

| Table | Key Fields |
|---|---|
| `hr_department` | hr_name, hr_code |
| `hr_designation` | hr_name, hr_level |
| `hr_employee` | hr_fullname, hr_email, hr_role, hr_status, hr_salary, hr_etime_code |
| `hr_attendance` | hr_date, hr_intime, hr_outtime, hr_workedhours, hr_status, hr_source |
| `hr_leave` | hr_leavetype, hr_fromdate, hr_todate, hr_days, hr_status |
| `hr_payroll` | hr_month, hr_year, hr_basic, hr_allowances, hr_deductions, hr_netpay |
| `hr_job` | hr_title, hr_department, hr_openings, hr_status |
| `hr_application` | hr_candidatename, hr_email, hr_stage |
| `hr_performance` | hr_cycle, hr_rating, hr_goals, hr_status |
| `hr_document` | hr_name, hr_type, hr_fileurl, hr_filesize |

### D365 Security Role
Create role **"HR System App User"** with Read/Write/Create/Delete on all `hr_*` tables and assign it to your Azure AD app.

---

## Step 3 — eTime Office Setup

1. In eTime Office admin panel, enable the **API/SDK**
2. Generate an **API key**
3. Note your eTime server URL (e.g. `http://192.168.1.100:8080`)
4. Make sure each employee has a matching **eTime employee code** — set this in `hr_etime_code` field on the D365 employee record

---

## Step 4 — Local Development

### Backend

```bash
cd backend
cp .env.example .env
# Fill in all values in .env

npm install
npm install @azure/msal-node   # ensure this is installed

# Test D365 connection
node scripts/test-d365-connection.js

# Seed initial data (admin user + departments)
node scripts/seed.js

# Start server
node src/server.js
```

Backend runs at: `http://localhost:5000`

### Frontend

```bash
cd frontend
cp .env.example .env
# Set VITE_API_URL=http://localhost:5000/api

npm install
npm run dev
```

Frontend runs at: `http://localhost:3000`

---

## Step 5 — Hostinger VPS Deployment

### One-time VPS setup

```bash
# SSH into your VPS
ssh root@your-vps-ip

# Upload and run the setup script
chmod +x setup-vps.sh
./setup-vps.sh
```

### Deploy the app

```bash
# On VPS: clone your repo
git clone https://github.com/youruser/hr-system /var/www/hr-system
cd /var/www/hr-system

# Backend .env
cp backend/.env.example backend/.env
nano backend/.env   # fill in production values

# Install deps
cd backend && npm ci --production && cd ..

# Build frontend
cd frontend && npm ci
VITE_API_URL=https://yourdomain.com/api npm run build
cd ..

# Start with PM2
pm2 start ecosystem.config.js
pm2 save

# SSL certificate
certbot --nginx -d yourdomain.com -d www.yourdomain.com
```

### Auto-deploy via GitHub Actions

1. Push your code to GitHub
2. Add these secrets in **GitHub → Settings → Secrets**:

| Secret | Value |
|---|---|
| `VPS_HOST` | Your VPS IP |
| `VPS_USER` | `root` |
| `VPS_SSH_KEY` | Contents of `~/.ssh/id_rsa` |
| `VITE_API_URL` | `https://yourdomain.com/api` |

3. Every push to `main` will auto-deploy

---

## Default Login

After running `node scripts/seed.js`:

| Role | Email | Password |
|---|---|---|
| Super Admin | admin@yourcompany.com | Admin@1234 |
| HR Manager | priya.sharma@yourcompany.com | HRManager@1234 |

> **Change these passwords immediately after first login.**

---

## Environment Variables Reference

### Backend `.env`

```env
PORT=5000
NODE_ENV=production

# Azure AD / D365
AZURE_TENANT_ID=xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx
AZURE_CLIENT_ID=xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx
AZURE_CLIENT_SECRET=your-secret-here
D365_BASE_URL=https://yourorg.crm.dynamics.com
D365_API_VERSION=9.2

# JWT
JWT_SECRET=minimum-32-character-random-string-here
JWT_ACCESS_EXPIRY=15m
JWT_REFRESH_EXPIRY=7d

# PostgreSQL (audit logs)
PG_HOST=localhost
PG_PORT=5432
PG_DB=hr_system
PG_USER=hr_user
PG_PASSWORD=YourStrongPassword123!

# Redis
REDIS_HOST=localhost
REDIS_PORT=6379

# eTime Office
ETIME_BASE_URL=http://your-etime-server:8080
ETIME_API_KEY=your-etime-api-key
ETIME_SYNC_INTERVAL=*/15 * * * *

# Email
SMTP_HOST=smtp.gmail.com
SMTP_PORT=587
SMTP_USER=hr@yourcompany.com
SMTP_PASS=your-app-password
SMTP_FROM=HR System <hr@yourcompany.com>

# CORS
FRONTEND_URL=https://yourdomain.com

# File uploads
UPLOAD_DIR=./uploads
MAX_FILE_SIZE=10485760
```

### Frontend `.env`

```env
VITE_API_URL=https://yourdomain.com/api
```

---

## Folder Structure

```
hr-system/
├── backend/
│   ├── src/
│   │   ├── server.js                    # Express entry point
│   │   ├── services/
│   │   │   ├── d365.service.js          # D365 Web API client
│   │   │   ├── auth.service.js          # Azure AD + JWT
│   │   │   ├── etime.service.js         # eTime Office sync
│   │   │   └── notification.service.js  # Socket.io + email
│   │   ├── middleware/
│   │   │   └── auth.middleware.js       # JWT + RBAC
│   │   ├── modules/                     # Route handlers
│   │   │   ├── auth/
│   │   │   ├── employees/
│   │   │   ├── attendance/
│   │   │   ├── payroll/
│   │   │   ├── recruitment/
│   │   │   ├── performance/
│   │   │   └── documents/
│   │   └── jobs/                        # Cron jobs
│   └── scripts/                         # Setup + seed scripts
├── frontend/
│   └── src/
│       ├── api/                         # Axios client + endpoints
│       ├── context/                     # Auth context
│       ├── layouts/                     # AppShell (sidebar + topbar)
│       ├── components/                  # NotificationBell, shared UI
│       └── modules/                     # Feature pages
├── ecosystem.config.js                  # PM2 config
├── nginx.conf                           # Nginx config
├── setup-vps.sh                         # VPS bootstrap script
└── .github/workflows/deploy.yml         # CI/CD pipeline
```

---

## RBAC Roles

| Role | Access |
|---|---|
| `super_admin` | Full access to everything |
| `hr_manager` | All employee, attendance, payroll, leave, performance, document operations |
| `recruiter` | Recruitment module + read employees |
| `employee` | Own profile, own attendance, own leave, own documents, own payslips |

---

## eTime Sync Flow

```
eTime Device (biometric punch)
    ↓
eTime Office Server
    ↓  (API pull every 15 min via cron)
Node.js Sync Service
    ↓  (map employee code → D365 GUID)
D365 hr_attendance records
    ↓  (anomaly check)
Socket.io notification to HR manager
```

Manual sync available via **Attendance → Sync eTime** button.
