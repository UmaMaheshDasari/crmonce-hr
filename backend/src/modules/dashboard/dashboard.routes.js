const express = require('express');
const router = express.Router();
const d365 = require('../../services/d365.service');
const { toValue, toLabel } = require('../../services/picklist');
const { computeSession, punchesFromRecord } = require('../../services/attendance.util');
const attnCfg = require('../../services/attendance.config');
const { rangeCounts, effectiveWorking, approvedLeaveWorkingDays, absentDatesFor, gracePassedToday } = require('../../services/attendance-summary.util');
// Absent-before-grace: same rule as the attendance page — an employee is not Absent
// today until their own shift-start + grace passes. Resolve "now" (IST) + the grace.
const istNowMinutes = () => { const [h, m] = String(require('../../services/time.util').istHHMM() || '00:00').split(':').map(Number); return (h || 0) * 60 + (m || 0); };
const resolveAbsentGrace = async () => { try { return (await require('../../services/payroll-settings.service').getResolved()).lateLogin.graceMinutes; } catch { return 15; } };
const { leaveSummary, resolveDays } = require('../../services/leave-summary.util');
const { earliestAttendanceDate } = require('../../services/attendance-range.util');
const holidayService = require('../../services/holiday.service');
const attendanceExceptions = require('../../services/attendance-exception.service');
const time = require('../../services/time.util');
const activity = require('../../services/activity.service');
const webCheckin = require('../../services/web-checkin.service');

const ATT = d365.constructor.entities.attendance;
const EMP = d365.constructor.entities.employee;
const LEAVE = d365.constructor.entities.leave;

const PUNCH_SELECT = 'hr_hrattendanceid,hr_date,hr_intime,hr_outtime,hr_workedhours,hr_overtime,hr_status,hr_source,_hr_hremployee_value,hr_allpunches,hr_punchcount,hr_breakduration,hr_effectivehours';
const SHIFT_COLS = 'hr_shiftname,hr_shiftstarttime,hr_shiftendtime';
const pad2 = (n) => String(n).padStart(2, '0');
const round2 = (n) => Math.round(n * 100) / 100;

// Employee's first-ever attendance date (min hr_date) — clamps the Absent math to
// the first punch; a simple ordered top-1 read (no fragile aggregate).
async function firstAttendanceDate(empId) {
  try {
    const { data } = await d365.getList(ATT, {
      select: 'hr_date', filter: `_hr_hremployee_value eq '${empId}'`, orderby: 'hr_date asc', top: 1,
    });
    return (data && data[0]) ? String(data[0].hr_date).slice(0, 10) : null;
  } catch (_) { return null; }
}

// Most recent prior-day record still OPEN (odd punch count = forgot check-out).
async function openPriorRecord(empId, today) {
  try {
    const { data } = await d365.getList(ATT, {
      select: PUNCH_SELECT, filter: `_hr_hremployee_value eq '${empId}' and hr_date lt ${today}`,
      orderby: 'hr_date desc', top: 5,
    });
    for (const r of (data || [])) if (punchesFromRecord(r).length % 2 === 1) return r;
    return null;
  } catch (_) { return null; }
}

// GET /api/dashboard/summary — ONE call powers the whole Employee Dashboard:
// hero, KPI cards, attendance widget, leave summary and recent activity. Every
// figure is computed live from Dataverse (no dummy values).
router.get('/summary', async (req, res, next) => {
  try {
    // Only HR/Super Admin may view another employee's dashboard; everyone else
    // (incl. recruiter) is locked to their own id (this route has no permission gate).
    const empId = ['super_admin', 'hr_manager'].includes(req.user.role) ? (req.query.employeeId || req.user.id) : req.user.id;
    const today = time.istDateStr();
    const [Y, M] = today.split('-').map(Number);
    const mm = pad2(M);
    const monthFrom = `${Y}-${mm}-01`;
    const monthEnd = `${Y}-${mm}-${pad2(new Date(Y, M, 0).getDate())}`;
    const capTo = today < monthEnd ? today : monthEnd;

    // Leave Summary period (dashboard filter) — defaults to This Year.
    const leaveFrom = req.query.from || `${Y}-01-01`;
    const leaveTo = req.query.to || `${Y}-12-31`;
    const approvedVal = toValue('hr_leave_status', 'approved');

    // ── Parallel Dataverse reads (one round trip each; the client makes ONE call) ──
    const [emp, monthRecsRes, allLeavesRes, firstDate, openPrior, activityItems, holidays, alerts] = await Promise.all([
      d365.getByIdOptional(EMP, empId, {
        select: 'hr_hremployeeid,hr_hremployee1,hr_department,hr_designation',
        optionalSelect: `${SHIFT_COLS},hr_joiningdate,hr_webcheckinenabled`,
      }).catch(() => ({})),
      d365.getList(ATT, {
        select: PUNCH_SELECT,
        filter: `_hr_hremployee_value eq '${empId}' and hr_date ge ${monthFrom} and hr_date le ${monthEnd}`,
        orderby: 'hr_date asc',
      }).catch(() => ({ data: [] })),
      d365.getList(LEAVE, {
        select: 'hr_days,hr_fromdate,hr_todate,hr_status',
        filter: `_hr_hremployee_value eq '${empId}'`,
      }).catch((e) => { console.error(`[dashboard/summary] leave read FAILED for ${empId}: ${e.message}`); return { data: [] }; }),
      firstAttendanceDate(empId),
      openPriorRecord(empId, today),
      activity.recent(6).catch(() => []),
      holidayService.listHolidays().catch(() => []),
      attendanceExceptions.openExceptionsForEmployee(empId).catch(() => []),
    ]);

    // Shift resolver for THIS employee (history-aware): today's session uses today's
    // shift; each past month-day uses the shift that was effective on that day.
    const shiftResolver = await require('../../services/shift-history.service').shiftResolverFor(empId, emp);
    const shift = shiftResolver.forDate(today);
    const monthRecs = monthRecsRes.data || [];
    const allLeaves = allLeavesRes.data || [];

    // ── Today's session (attendance widget) ───────────────────────────────────
    const todayRec = monthRecs.find(r => String(r.hr_date).slice(0, 10) === today) || null;
    const ct = computeSession(todayRec ? punchesFromRecord(todayRec) : [], shift, { graceMinutes: shift.grace });
    const todayView = {
      date: today,
      status: ct.status,                         // present | half_day | incomplete | absent
      state: ct.state,                           // none | in | out
      firstPunch: ct.firstPunch,
      lastPunch: ct.lastPunch,
      punchCount: ct.count,
      workedHours: ct.totalSpanHours,
      breakHours: ct.breakHours,
      effectiveHours: ct.effectiveHours,
      overtimeHours: ct.overtimeHours,
      lateByMin: ct.lateArrivalMin,
      earlyExitMin: ct.earlyDepartureMin,
      attendanceIssue: ct.attendanceIssue,       // Normal | Missing Check In/Out
      compensationStatus: ct.compensationStatus,
      canCheckIn: ct.state !== 'in',
      canCheckOut: ct.state === 'in',
      webCheckinEnabled: webCheckin.bool(emp.hr_webcheckinenabled),   // Admin-controlled; UI gate
      missingCheckout: openPrior
        ? { date: String(openPrior.hr_date).slice(0, 10) }
        : null,
    };

    // ── This month's attendance figures (live) ────────────────────────────────
    let present = 0, half = 0, incomplete = 0, attended = 0, lateDays = 0, workedEff = 0, overtime = 0;
    const earliestRec = earliestAttendanceDate(monthRecs);   // fallback Attendance Start Date
    for (const r of monthRecs) {
      const s = shiftResolver.forDate(String(r.hr_date).slice(0, 10));
      const c = computeSession(punchesFromRecord(r), s, { graceMinutes: s.grace });
      if ((c.count || 0) > 0) { attended++; workedEff += c.effectiveHours || 0; overtime += c.overtimeHours || 0; }
      if (c.status === 'present') present++;
      else if (c.status === 'half_day') half++;
      else if (c.status === 'incomplete') incomplete++;
      if (c.lateArrivalMin > 0) lateDays++;
    }

    // Approved leave days in THIS month (up to today) — offsets Absent. Counted in
    // WORKING days over [monthFrom, capTo] via the shared engine so this matches the
    // attendance page's /stats exactly (previously used calendar-day spans, which
    // over-subtracted weekend-spanning leaves and leaked future days).
    const approvedLeavesMonth = allLeaves.filter(l => l.hr_status === approvedVal);
    const leaveDaysMonth = approvedLeaveWorkingDays(approvedLeavesMonth, monthFrom, capTo);

    // Absent = ENUMERATED working dates with no record and no approved leave, from the
    // employee's first attendance date (identical to the attendance page /stats), and
    // TODAY is skipped until this employee's shift-start + grace has passed (spec §7).
    const clampDate = firstDate || earliestRec || null;
    const workingElapsed = effectiveWorking(monthFrom, capTo, clampDate);
    const recordDates = new Set(monthRecs.map(r => String(r.hr_date).slice(0, 10)));
    const leaveDates = new Set();
    approvedLeavesMonth.forEach(l => {
      const lf = String(l.hr_fromdate || '').slice(0, 10);
      const lt = String(l.hr_todate || '').slice(0, 10) || lf;
      if (!lf) return;
      const s = lf < monthFrom ? monthFrom : lf; const e = lt > capTo ? capTo : lt;
      if (e < s) return;
      for (let dt = new Date(`${s}T00:00:00Z`); dt <= new Date(`${e}T00:00:00Z`); dt.setUTCDate(dt.getUTCDate() + 1)) {
        const ds = `${dt.getUTCFullYear()}-${pad2(dt.getUTCMonth() + 1)}-${pad2(dt.getUTCDate())}`;
        if (!attnCfg.holidays.includes(ds) && !attnCfg.weekOffDays.includes(dt.getUTCDay())) leaveDates.add(ds);
      }
    });
    const todayPending = capTo >= today && !gracePassedToday(shift, await resolveAbsentGrace(), istNowMinutes());
    const absentDays = absentDatesFor(monthFrom, capTo, clampDate, ds => recordDates.has(ds), ds => leaveDates.has(ds), { today, todayPending }).length;
    const workingDays = rangeCounts(monthFrom, monthEnd).working;   // full month (display)

    const month = {
      year: Y, month: M, workingDays, workingElapsed,
      presentDays: present, halfDays: half, incompleteDays: incomplete, attendedDays: attended,
      absentDays, lateDays, leaveDays: leaveDaysMonth,
      workedHours: round2(workedEff), overtimeHours: round2(overtime),
    };

    // ── Leave Summary (period-filtered, all statuses) ─────────────────────────
    const leaveRows = allLeaves.map(l => ({
      days: resolveDays(l.hr_days, l.hr_fromdate, l.hr_todate),
      fromDate: String(l.hr_fromdate || '').slice(0, 10),
      status: toLabel('hr_leave_status', l.hr_status),
    }));
    const leave = leaveSummary(leaveRows, { from: leaveFrom, to: leaveTo });
    leave.hasActivity = leaveRows.some(r => r.fromDate && r.fromDate >= leaveFrom && r.fromDate <= leaveTo);

    // ── Next payday & upcoming holiday ────────────────────────────────────────
    const salaryDay = parseInt(process.env.SALARY_DAY, 10) || 1;
    const nextPayday = (() => {
      const todayD = new Date(`${today}T00:00:00Z`);
      let p = new Date(Date.UTC(Y, M - 1, salaryDay));
      if (p < todayD) p = new Date(Date.UTC(Y, M, salaryDay));   // rolled to next month
      return `${p.getUTCFullYear()}-${pad2(p.getUTCMonth() + 1)}-${pad2(p.getUTCDate())}`;
    })();
    // Next holiday (with its NAME) from the HR calendar, falling back to any env dates.
    const upcomingList = [
      ...holidays.filter(h => h.date >= today),
      ...(attnCfg.holidays || []).filter(d => d >= today && !holidays.some(h => h.date === d)).map(d => ({ date: d, name: 'Holiday' })),
    ].sort((a, b) => a.date.localeCompare(b.date));
    const upcomingHoliday = upcomingList.length
      ? { date: upcomingList[0].date, name: upcomingList[0].name, label: time.fmtDate(upcomingList[0].date) }
      : null;

    res.json({
      employee: {
        name: emp.hr_hremployee1 || req.user.name || 'Employee',
        department: emp.hr_department || '',
        designation: emp.hr_designation || '',
      },
      shift: { name: shift.name, start: shift.start, end: shift.end, durationHours: shift.durationHours },
      today: todayView,
      month,
      leave,
      nextPayday,
      upcomingHoliday,
      alerts: alerts || [],          // auto-detected attendance exceptions (Attendance Alerts card)
      activity: activityItems,
    });
  } catch (err) { next(err); }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/dashboard/admin-summary — ONE call powers the whole HR/Admin dashboard:
// hero, 4 KPI cards, attendance overview (Present/Absent/Late), action items,
// the admin's own attendance widget, leave summary and recent activity. HR/Admin
// only. Every figure is live from Dataverse.
// ─────────────────────────────────────────────────────────────────────────────
const { requireRole } = require('../../middleware/auth.middleware');
const JOB = d365.constructor.entities.job;
const PAYROLL = d365.constructor.entities.payroll;
const DOC = d365.constructor.entities.document;
const SHIFT_MAP = (emp) => attnCfg.resolveEmployeeShift(emp?.hr_shiftname, emp?.hr_shiftstarttime, emp?.hr_shiftendtime);
const addDays = (ds, n) => { const d = new Date(`${ds}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`; };

router.get('/admin-summary', requireRole('super_admin', 'hr_manager'), async (req, res, next) => {
  try {
    const today = time.istDateStr();
    const [Y, M] = today.split('-').map(Number);
    const mm = pad2(M);
    const monthFrom = `${Y}-${mm}-01`;
    const monthStartIso = `${monthFrom}T00:00:00Z`;

    // This week's working window (Mon → today) for the overview + corrections.
    const dow = new Date(`${today}T00:00:00Z`).getUTCDay();      // 0 Sun … 6 Sat
    const monday = addDays(today, dow === 0 ? -6 : 1 - dow);
    const weekDates = [0, 1, 2, 3, 4].map(i => addDays(monday, i));  // Mon–Fri
    const weekFrom = weekDates[0], weekTo = weekDates[4];

    // Leave Summary period (dashboard filter) — defaults to This Year.
    const leaveFrom = req.query.from || `${Y}-01-01`;
    const leaveTo = req.query.to || `${Y}-12-31`;

    const activeVal = toValue('hr_employee_status', 'active');
    const pendingLeaveVal = toValue('hr_leave_status', 'pending');
    const approvedLeaveVal = toValue('hr_leave_status', 'approved');
    const openJobVal = toValue('hr_job_status', 'open');
    const processedVal = toValue('hr_payroll_status', 'processed');

    const [empsRes, weekAttRes, jobsRes, payrollRes, leavesRes, docsRes, activityItems] = await Promise.all([
      d365.getListOptional(EMP, {
        select: 'hr_hremployeeid,hr_hremployee1,hr_department,createdon',
        optionalSelect: `${SHIFT_COLS},hr_designation,hr_webcheckinenabled`, filter: `hr_status eq ${activeVal}`, top: 5000,
      }).catch(() => ({ data: [] })),
      d365.getAll(ATT, {
        select: PUNCH_SELECT, filter: `hr_date ge ${weekFrom} and hr_date le ${weekTo}`, orderby: 'hr_date desc',
      }, 10000).catch(() => ({ data: [] })),
      d365.getList(JOB, { select: 'hr_hrjobid', filter: `hr_status eq ${openJobVal}`, top: 500 }).catch(() => ({ data: [] })),
      d365.getList(PAYROLL, { select: 'hr_netpay,hr_status', filter: `hr_month eq ${M} and hr_year eq ${Y}`, top: 2000 }).catch(() => ({ data: [] })),
      d365.getList(LEAVE, { select: 'hr_days,hr_fromdate,hr_todate,hr_status,_hr_hremployee_value', top: 5000 }).catch(() => ({ data: [] })),
      d365.getList(DOC, { select: 'hr_hrdocumentid,createdon', filter: `createdon ge ${monthStartIso}`, top: 2000 }).catch(() => ({ data: [] })),
      activity.recent(8).catch(() => []),
    ]);

    const emps = empsRes.data || [];
    const weekAtt = weekAttRes.data || [];
    const allLeaves = leavesRes.data || [];
    const shiftByEmp = new Map(emps.map(e => [e.hr_hremployeeid, SHIFT_MAP(e)]));
    // Date-aware shift resolution for the week (history-aware; a mid-week shift change
    // must not re-judge the earlier days — falls back to the current shift when no history).
    const shiftHist = require('../../services/shift-history.service');
    const empById = new Map(emps.map(e => [e.hr_hremployeeid, e]));
    const histMap = await shiftHist.loadHistoryMap();

    // ── KPI cards ─────────────────────────────────────────────────────────────
    const totalEmployees = emps.length;
    const presentTodaySet = new Set();
    weekAtt.forEach(r => {
      if (String(r.hr_date).slice(0, 10) === today && punchesFromRecord(r).length > 0) presentTodaySet.add(r._hr_hremployee_value);
    });
    const presentToday = presentTodaySet.size;
    const openPositions = (jobsRes.data || []).length;
    const payrollRows = payrollRes.data || [];
    const payrollProcessed = payrollRows.filter(p => p.hr_status === processedVal);
    const payroll = {
      status: payrollProcessed.length ? 'Processed' : 'Pending',
      count: payrollRows.length,
      netTotal: payrollProcessed.reduce((s, p) => s + (p.hr_netpay || 0), 0),
    };

    // ── Action items (replacing the old duplicate Quick Stats) ─────────────────
    const pendingLeaveApprovals = allLeaves.filter(l => l.hr_status === pendingLeaveVal).length;
    const correctionsPending = weekAtt.filter(r => punchesFromRecord(r).length % 2 === 1).length;  // odd punch = missing check-in/out
    const newEmployeesThisMonth = emps.filter(e => String(e.createdon || '') >= monthStartIso).length;
    const documentsPendingReview = (docsRes.data || []).length;

    // ── Attendance overview (Present / Absent / Late per weekday) ──────────────
    const onLeaveByDate = {}; weekDates.forEach(d => (onLeaveByDate[d] = new Set()));
    allLeaves.filter(l => l.hr_status === approvedLeaveVal).forEach(l => {
      const lf = String(l.hr_fromdate || '').slice(0, 10);
      const lt = String(l.hr_todate || '').slice(0, 10) || lf;
      weekDates.forEach(d => { if (d >= lf && d <= lt) onLeaveByDate[d].add(l._hr_hremployee_value); });
    });
    const byDate = {}; weekDates.forEach(d => (byDate[d] = { present: new Set(), late: new Set() }));
    weekAtt.forEach(r => {
      const ds = String(r.hr_date).slice(0, 10);
      if (!byDate[ds] || punchesFromRecord(r).length === 0) return;
      byDate[ds].present.add(r._hr_hremployee_value);
      const s = shiftHist.shiftForDateFromMap(histMap, r._hr_hremployee_value, ds, empById.get(r._hr_hremployee_value));
      const c = computeSession(punchesFromRecord(r), s, { graceMinutes: s.grace });
      if (c.lateArrivalMin > 0) byDate[ds].late.add(r._hr_hremployee_value);
    });
    const dayName = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
    const nowMin = istNowMinutes();
    const graceMin = await resolveAbsentGrace();
    const overview = weekDates.map(d => {
      const isWorking = !attnCfg.weekOffDays.includes(new Date(`${d}T00:00:00Z`).getUTCDay()) && !attnCfg.holidays.includes(d);
      const present = byDate[d].present.size;
      const late = byDate[d].late.size;
      let absent = 0;
      if (isWorking && d < today) {
        absent = Math.max(0, totalEmployees - present - onLeaveByDate[d].size);
      } else if (isWorking && d === today) {
        // TODAY: count an employee Absent only once their OWN shift-start + grace has
        // passed (spec §7/§8) — pre-grace employees are "Pending", not Absent.
        for (const e of emps) {
          const id = e.hr_hremployeeid;
          if (byDate[d].present.has(id) || onLeaveByDate[d].has(id)) continue;
          if (gracePassedToday(shiftByEmp.get(id), graceMin, nowMin)) absent++;
        }
      }
      return { day: dayName[new Date(`${d}T00:00:00Z`).getUTCDay()], date: d, present, absent, late };
    });

    // ── Admin's own attendance widget (today) ──────────────────────────────────
    const myRec = weekAtt.find(r => r._hr_hremployee_value === req.user.id && String(r.hr_date).slice(0, 10) === today) || null;
    const myShift = shiftByEmp.get(req.user.id) || attnCfg.resolveShift();
    const ct = computeSession(myRec ? punchesFromRecord(myRec) : [], myShift);
    const todayView = {
      date: today, status: ct.status, state: ct.state,
      firstPunch: ct.firstPunch, lastPunch: ct.lastPunch, punchCount: ct.count,
      workedHours: ct.totalSpanHours, breakHours: ct.breakHours, effectiveHours: ct.effectiveHours,
      overtimeHours: ct.overtimeHours, lateByMin: ct.lateArrivalMin, earlyExitMin: ct.earlyDepartureMin,
      canCheckIn: ct.state !== 'in', canCheckOut: ct.state === 'in',
      webCheckinEnabled: webCheckin.bool(empById.get(req.user.id)?.hr_webcheckinenabled),   // Admin-controlled; UI gate
    };

    // ── Leave Summary (org-wide, period-filtered) ──────────────────────────────
    const leaveRows = allLeaves.map(l => ({
      days: resolveDays(l.hr_days, l.hr_fromdate, l.hr_todate),
      fromDate: String(l.hr_fromdate || '').slice(0, 10),
      status: toLabel('hr_leave_status', l.hr_status),
    }));
    const leave = leaveSummary(leaveRows, { from: leaveFrom, to: leaveTo });
    leave.hasActivity = leaveRows.some(r => r.fromDate && r.fromDate >= leaveFrom && r.fromDate <= leaveTo);

    res.json({
      employee: { name: req.user.name || 'Admin' },
      shift: { name: myShift.name, start: myShift.start, end: myShift.end, durationHours: myShift.durationHours },
      systemStatus: 'operational',
      kpis: { totalEmployees, presentToday, openPositions, payroll },
      actions: { pendingLeaveApprovals, correctionsPending, newEmployeesThisMonth, documentsPendingReview },
      overview,
      today: todayView,
      leave,
      activity: activityItems,
    });
  } catch (err) { next(err); }
});

module.exports = router;
