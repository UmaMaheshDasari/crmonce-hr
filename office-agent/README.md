# CRMONCE HR — Office eTime Sync Agent

Reads attendance punches from the office ZK/eTime device on the **office LAN** and pushes
them to the production HR backend over **HTTPS**. This solves the fundamental problem that
the production VPS cannot reach a private office IP such as `192.168.1.199:4370`.

```
Office ZK device (192.168.1.199:4370)
        │  (office LAN)
        ▼
   Office Sync Agent  ── HTTPS + agent key ──►  https://hr.crmonce.com/api/etime/sync
        ▲                                              │
        └── local spool (spool.json, retries)          ▼
                                                    Dataverse → Attendance page
```

Port **4370 is never exposed to the internet.** Only the agent (outbound HTTPS) talks to
the backend.

## Requirements
- An **office Windows PC/server** that can reach the device (`ping 192.168.1.199`) and the
  internet. Keep the PC's clock/timezone on **India Standard Time** (punch times are read
  as the PC's local wall-clock).
- **Node.js 18+**.

## Setup
```powershell
cd office-agent
npm ci            # or: npm install
copy .env.example .env
notepad .env      # set HR_API_URL and ETIME_AGENT_KEY (must match the backend)
```
On the **backend/VPS**, set the same secret in the backend environment:
```
ETIME_AGENT_KEY=<the-same-long-random-value>
```
(and restart the backend). Generate a value with e.g. `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`.

## Run (foreground, to test)
```powershell
npm start
```
You should see it read the device, push batches, and print `received/created/updated/…`.
On the HR **Attendance** page, click **Sync eTime** — it shows the agent status + latest
counts. In the CRM, attendance rows appear with source **eTime Device**.

## Run as a Windows service (starts on boot, restarts on crash)

**Option A — NSSM (simple, recommended):**
```powershell
# Download nssm.exe (https://nssm.cc), then from an elevated prompt:
nssm install CrmonceEtimeAgent "C:\Program Files\nodejs\node.exe" "C:\path\to\office-agent\agent.js"
nssm set   CrmonceEtimeAgent AppDirectory "C:\path\to\office-agent"
nssm set   CrmonceEtimeAgent AppStdout    "C:\path\to\office-agent\agent.log"
nssm set   CrmonceEtimeAgent AppStderr    "C:\path\to\office-agent\agent.err.log"
nssm start CrmonceEtimeAgent
```

**Option B — node-windows:**
```powershell
npm i -g node-windows
# create a small install script that uses node-windows Service to install agent.js
```

**Option C — Task Scheduler:** create a task “At startup”, action `node.exe agent.js`,
“Run whether user is logged on or not”, and set **Restart on failure**.

## Backfill punches missed during an outage

The device keeps its punches internally. To pull the ones missed while sync was down, run
the agent once with a date window (it reads the device's stored log, pushes to the backend,
which **creates the missing days and skips duplicates**, then exits):

```powershell
# PowerShell — one-time backfill of a window (adjust dates)
$env:RUN_ONCE="true"; $env:SYNC_FROM_DATE="2026-08-01"; $env:SYNC_TO_DATE="2026-08-17"; npm start
```
Or set `RUN_ONCE`/`SYNC_FROM_DATE`/`SYNC_TO_DATE` in `.env`. It prints
`pushed N → created … updated … duplicates …` and then `RUN_ONCE complete`. Run it as many
times as you like — it's idempotent, so nothing is duplicated. Then start the agent normally
(without `RUN_ONCE`) for ongoing sync. (Only punches still stored on the device can be
recovered; if its internal log already overwrote very old records, those are gone — a device
limitation, not the agent.)

## Behavior
- **Retries / offline:** if the device, internet, or VPS is down, punches stay in
  `spool.json` and are flushed on the next cycle — nothing is lost.
- **Idempotent:** the backend de-dupes by `employee + date + time`; re-sending a punch
  never creates a second attendance record.
- **Employee mapping:** the device user ID is matched to the employee's `hr_etimecode`
  in Dataverse — the Dataverse GUID is never used as the device id.

## Environment variables (names only)
`HR_API_URL`, `ETIME_AGENT_KEY`, `ZK_DEVICE_IP`, `ZK_DEVICE_PORT`, `ZK_TIMEOUT`,
`SYNC_INTERVAL_MS`, `SYNC_BATCH_SIZE`, `SPOOL_FILE`.

## Troubleshooting
- `ZK device … unavailable` → the PC can't reach the device: check the IP/port and that
  the PC is on the office LAN.
- `backend unreachable/failed` → check `HR_API_URL`, internet, and that `ETIME_AGENT_KEY`
  matches the backend (a 401 means the keys differ).
