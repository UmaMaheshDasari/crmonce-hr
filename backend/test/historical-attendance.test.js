/**
 * Historical Attendance Requests — regression coverage for the production list-failure bug
 * (table `hr_histattendances` missing columns → list $select 400 → silent empty UI).
 *
 * Covers: idempotent schema-drift repair (provisioner), resilient list/getRaw (missing optional
 * column degrades, never 400s the whole query), explicit-fail duplicate guard when hr_date is
 * absent, and approval refusal on a dateless record. Dataverse + email are stubbed — no network,
 * no real emails, no production credentials.
 */
process.env.NODE_ENV = 'test';
process.env.EMAIL_DRY_RUN = 'true';
process.env.AZURE_CLIENT_ID = process.env.AZURE_CLIENT_ID || 'x';
process.env.AZURE_CLIENT_SECRET = process.env.AZURE_CLIENT_SECRET || 'x';
process.env.AZURE_TENANT_ID = process.env.AZURE_TENANT_ID || 'x';

const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert');
const axios = require('axios');
const d365 = require('../src/services/d365.service');
const notif = require('../src/services/notification.service');
const svc = require('../src/services/historical-attendance.service');
const provision = require('../src/services/provision-historical-attendance');

const HIST = 'hr_histattendances';
const EMP = d365.constructor.entities.employee;
// A 400 "property not found" error shaped like Dataverse/axios (what _isMissingProperty reads).
const missingPropErr = (prop) => Object.assign(new Error(`Could not find a property named '${prop}'.`), { response: { status: 400, data: { error: { code: '0x80060888', message: `Could not find a property named '${prop}'.` } } } });
const apiErr = (message, extra = {}) => Object.assign(new Error(message), { response: { data: { error: { message } }, ...extra } });

// ─────────────────────────── Provisioner: schema-drift repair ───────────────────────────
let origGetList, origGetHeaders, origPost;
beforeEach(() => { origGetList = d365.getList; origGetHeaders = d365.getHeaders; origPost = axios.post; d365.getHeaders = async () => ({}); });
afterEach(() => { d365.getList = origGetList; d365.getHeaders = origGetHeaders; axios.post = origPost; });

test('1 — existing table + missing columns → idempotent repair ADDS only the missing columns', async () => {
  d365.getList = async () => ({ data: [] });   // probe succeeds → table EXISTS
  const present = new Set(['hr_EmployeeId', 'hr_EmployeeName', 'hr_Month', 'hr_OutTime', 'hr_Reason', 'hr_Comments', 'hr_Status', 'hr_ApprovedBy', 'hr_ApprovedDate', 'hr_ApproverComment', 'hr_OldStatus', 'hr_NewStatus', 'hr_Ip']);
  const created = [];
  axios.post = async (url, body) => {
    if (url.endsWith('/EntityDefinitions')) throw apiErr('entity already exists');   // should NOT be called (table exists)
    const name = body.SchemaName;
    if (present.has(name)) throw apiErr(`attribute ${name} already exists`);        // existing → left untouched
    created.push(name); return { data: {} };                                        // missing → added
  };
  const r = await provision.ensureHistoricalAttendanceTable(console);
  assert.strictEqual(r.status, 'exists', 'table already existed');
  assert.deepStrictEqual(created.sort(), ['hr_AttachmentId', 'hr_Date', 'hr_InTime'].sort(), 'only the 3 genuinely-missing columns were added');
});

test('2 — existing table + all columns present → NOTHING recreated', async () => {
  d365.getList = async () => ({ data: [] });   // table exists
  let entityPosts = 0, added = 0;
  axios.post = async (url, body) => {
    if (url.endsWith('/EntityDefinitions')) { entityPosts++; return { data: {} }; }
    added++; throw apiErr(`attribute ${body.SchemaName} already exists`);   // every column already exists
  };
  const r = await provision.ensureHistoricalAttendanceTable(console);
  assert.strictEqual(r.status, 'exists');
  assert.strictEqual(entityPosts, 0, 'entity is never recreated when the table exists');
  assert.strictEqual(r.added.length, 0, 'no column created');
  assert.ok(r.existing.length > 0, 'all columns reported existing');
});

test('9 — a column add that FAILS (e.g. privilege) is surfaced as incomplete, never a false success', async () => {
  d365.getList = async () => ({ data: [] });   // table exists
  axios.post = async (url, body) => {
    if (url.endsWith('/EntityDefinitions')) return { data: {} };
    if (body.SchemaName === 'hr_Date') throw apiErr('Principal user is missing prvCreateAttribute privilege.');
    throw apiErr('already exists');
  };
  const r = await provision.ensureHistoricalAttendanceTable(console);
  assert.strictEqual(r.status, 'incomplete', 'does not claim success');
  assert.ok(r.failed.includes('hr_Date'));
  assert.match(r.reason, /privilege/i);
});

// ─────────────────────────── Service: resilient list / dup-guard / approval ───────────────────────────
let orig;
beforeEach(() => {
  orig = { gl: d365.getList, glr: d365.getListResilient, gbr: d365.getByIdResilient, cr: d365.create, up: d365.update, gio: d365.getByIdOptional, glo: d365.getListOptional, se: notif.sendEmail, nu: notif.notifyUser, bc: notif.broadcast };
  notif.sendEmail = async () => ({ success: true }); notif.notifyUser = () => {}; notif.broadcast = () => {};
});
afterEach(() => { Object.assign(d365, { getList: orig.gl, getListResilient: orig.glr, getByIdResilient: orig.gbr, create: orig.cr, update: orig.up, getByIdOptional: orig.gio, getListOptional: orig.glo }); Object.assign(notif, { sendEmail: orig.se, notifyUser: orig.nu, broadcast: orig.bc }); });

// A past date safely INSIDE the 6-month submission window (relative to the real clock).
const RECENT = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
const row = (o = {}) => ({ hr_histattendanceid: o.id || 'H1', hr_employeeid: o.emp || 'E1', hr_employeename: o.name || 'Amy', hr_date: o.date ?? '2026-04-10', hr_month: o.month ?? '2026-04', hr_status: o.status || 'pending', hr_intime: o.intime ?? '09:00', hr_outtime: o.outtime ?? '18:00', ...o.extra });

test('3 — list works when an optional column (hr_date) is missing (REAL getListResilient strips it)', async () => {
  // Drive the REAL getListResilient by stubbing the underlying getList: the full select 400s on
  // hr_date; the retry without hr_date succeeds.
  d365.getList = async (entity, { select }) => {
    if (String(select).includes('hr_date')) throw missingPropErr('hr_date');
    return { data: [row({ date: '' }), row({ id: 'H2', status: 'pending', date: '' })] };
  };
  const rows = await svc.list({});
  assert.strictEqual(rows.length, 2, 'rows still returned despite the missing column');
  assert.strictEqual(rows[0].status, 'pending');
  assert.strictEqual(rows[0].date, '', 'missing column degrades to blank, not a 400');
});

test('4 — successful list returns pending records and summary counts are correct', async () => {
  d365.getListResilient = async () => ({ data: [row({ id: 'H1', status: 'pending' }), row({ id: 'H2', status: 'pending' }), row({ id: 'H3', status: 'approved' })] });
  const s = await svc.summary({});
  assert.strictEqual(s.total, 3);
  assert.strictEqual(s.pending, 2);
  assert.strictEqual(s.approved, 1);
});

test('5 — a genuine list failure PROPAGATES (never silently returns an empty list)', async () => {
  d365.getList = async () => { throw apiErr('Service unavailable', { response: { status: 503, data: { error: { message: 'Service unavailable' } } } }); };
  await assert.rejects(() => svc.list({}), /Service unavailable/, 'list rejects so the UI can show an error, not an empty table');
});

test('6 — create then list returns the persisted request (schema complete)', async () => {
  const store = [];
  d365.getList = async (entity, { filter } = {}) => {   // dup-guard: no existing pending
    if (entity === HIST && /hr_status eq .pending./.test(String(filter))) return { data: [] };
    if (entity === EMP) return { data: [] };   // hrEmails
    return { data: [] };
  };
  d365.getByIdOptional = async () => ({ hr_email: 'amy@crmonce.com', hr_hremployee1: 'Amy' });
  d365.create = async (_e, payload) => { const id = `H${store.length + 1}`; store.push({ ...payload, hr_histattendanceid: id }); return { hr_histattendanceid: id }; };
  d365.getListResilient = async () => ({ data: store.slice() });

  const created = await svc.create({ employeeId: 'E1', employeeName: 'Amy', date: RECENT, inTime: '09:00', outTime: '18:00', reason: 'Was present, device missed' });
  assert.strictEqual(created.status, 'pending');
  const rows = await svc.list({});
  assert.strictEqual(rows.length, 1);
  assert.strictEqual(rows[0].date, RECENT);
  assert.strictEqual(rows[0].status, 'pending');
});

test('7 — duplicate pending detected when hr_date exists (409); when hr_date MISSING → explicit 503, never a silent skip', async () => {
  d365.getByIdOptional = async () => ({ hr_email: 'a@crmonce.com', hr_hremployee1: 'Amy' });
  // (a) hr_date present → an existing pending row is found → 409
  d365.getList = async (entity, { filter } = {}) => (entity === HIST && /hr_status eq .pending./.test(String(filter)) ? { data: [{ hr_histattendanceid: 'DUP' }] } : { data: [] });
  await assert.rejects(() => svc.create({ employeeId: 'E1', employeeName: 'Amy', date: RECENT, reason: 'x' }), (e) => e.status === 409);
  // (b) hr_date column missing → dup check can't run → explicit 503 (NOT a silent save)
  d365.getList = async (entity, { filter } = {}) => { if (entity === HIST && /hr_date eq/.test(String(filter))) throw missingPropErr('hr_date'); return { data: [] }; };
  let created = false; d365.create = async () => { created = true; return { hr_histattendanceid: 'X' }; };
  await assert.rejects(() => svc.create({ employeeId: 'E1', employeeName: 'Amy', date: RECENT, reason: 'x' }), (e) => e.status === 503);
  assert.strictEqual(created, false, 'no record created when duplicate protection cannot run');
});

test('8 — a request with no valid stored date CANNOT be approved (422); reject is still allowed', async () => {
  d365.getByIdResilient = async () => row({ id: 'H1', status: 'pending', date: '' });   // legacy dateless row
  d365.update = async () => ({});
  await assert.rejects(() => svc.decide('H1', 'approved', { name: 'HR' }, ''), (e) => e.status === 422, 'approval refused on a dateless record');
  // reject must still work so HR can resolve it (no attendance write, no date needed)
  const rj = await svc.decide('H1', 'rejected', { name: 'HR' }, 'no date on file');
  assert.strictEqual(rj.record.status, 'rejected');
});

test('10 — employee scoping is honored: a scoped list filters by employee; HR (no employeeId) does not', async () => {
  let captured;
  d365.getListResilient = async (_e, opts) => { captured = opts.filter || ''; return { data: [] }; };
  await svc.list({ employeeId: 'E1' });
  assert.match(captured, /hr_employeeid eq 'E1'/, 'scoped query filters to the employee');
  await svc.list({});
  assert.ok(!/hr_employeeid eq/.test(captured || ''), 'HR all-view adds no employee filter');
});

test('11 — create stores the employee NAME resolved from employeeId when omitted (HR-on-behalf), plus date/in/out/status', async () => {
  let payload;
  d365.getByIdOptional = async () => ({ hr_hremployee1: 'Bob', hr_email: 'bob@crmonce.com' });   // getEmployee(id)
  d365.getList = async () => ({ data: [] });                                                      // dup-guard none + hrEmails none
  d365.create = async (_e, p) => { payload = p; return { hr_histattendanceid: 'H9' }; };
  await svc.create({ employeeId: 'E9', date: RECENT, inTime: '09:15', outTime: '18:00', reason: 'HR raised on behalf' });
  assert.strictEqual(payload.hr_employeename, 'Bob', 'name resolved from id, never left blank');
  assert.strictEqual(payload.hr_employeeid, 'E9');
  assert.strictEqual(payload.hr_date, RECENT);
  assert.strictEqual(payload.hr_intime, '09:15');
  assert.strictEqual(payload.hr_outtime, '18:00');
  assert.strictEqual(payload.hr_status, 'pending');
});

test('12 — list resolves blank names from employeeId (display recovery); unrecoverable fields stay blank, never invented', async () => {
  d365.getListResilient = async () => ({ data: [
    { hr_histattendanceid: 'H1', hr_employeeid: 'E1', hr_employeename: '', hr_date: '', hr_outtime: '18:00', hr_status: 'pending', hr_month: '2026-04' },  // legacy: blank name+date+in
    { hr_histattendanceid: 'H2', hr_employeeid: 'E2', hr_employeename: 'Already', hr_status: 'approved' },                                                 // name already stored
    { hr_histattendanceid: 'H3', hr_employeeid: 'EX', hr_employeename: '', hr_status: 'rejected' },                                                        // id resolves to nothing
  ] });
  d365.getByIdOptional = async (_e, id) => (id === 'E1' ? { hr_hremployee1: 'Amy' } : { hr_hremployee1: '' });
  const byId = Object.fromEntries((await svc.list({})).map(r => [r.id, r]));
  assert.strictEqual(byId.H1.employeeName, 'Amy', 'blank name recovered from the stored id');
  assert.strictEqual(byId.H1.outTime, '18:00', 'other stored fields preserved');
  assert.strictEqual(byId.H1.date, '', 'date was never stored → stays blank (not invented)');
  assert.strictEqual(byId.H2.employeeName, 'Already', 'an already-stored name is untouched');
  assert.strictEqual(byId.H3.employeeName, '', 'an unresolvable id stays blank — never invented');
});

test('13 — list({status:"pending"}) filters server-side by hr_status eq pending and returns only pending (dashboard count contract)', async () => {
  let captured;
  d365.getListResilient = async (_e, opts) => { captured = opts.filter || ''; return { data: [row({ id: 'P1', status: 'pending' }), row({ id: 'P2', status: 'pending' })] }; };
  const rows = await svc.list({ status: 'pending' });
  assert.match(captured, /hr_status eq 'pending'/, "the 'pending' status filter is pushed to the query (Dataverse returns only pending)");
  assert.strictEqual(rows.length, 2, 'both pending rows surface');
  assert.ok(rows.every(r => r.status === 'pending'), 'only pending rows — more_info/approved/rejected are excluded by the filter');
  // Sanity: no status → no status filter is applied (the all-status list).
  await svc.list({});
  assert.ok(!/hr_status eq/.test(captured || ''), 'an unfiltered list adds no status clause');
});
