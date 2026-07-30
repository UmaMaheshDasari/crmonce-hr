const express = require('express');
const router = express.Router();
const d365 = require('../../services/d365.service');
const { toValue, toLabel } = require('../../services/picklist');
const { computeSession, punchesFromRecord } = require('../../services/attendance.util');
const attnCfg = require('../../services/attendance.config');
const { rangeCounts, effectiveWorking } = require('../../services/attendance-summary.util');
const { leaveSummary, resolveDays } = require('../../services/leave-summary.util');
const time = require('../../services/time.util');
const activity = require('../../services/activity.service');

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
    const empId = req.user.role === 'employee' ? req.user.id : (req.query.employeeId || req.user.id);
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
    const [emp, monthRecsRes, allLeavesRes, firstDate, openPrior, activityItems] = await Promise.all([
      d365.getByIdOptional(EMP, empId, {
        select: 'hr_hremployeeid,hr_hremployee1,hr_department,hr_designation',
        optionalSelect: `${SHIFT_COLS},hr_joiningdate,hr_salary`,
      }).catch(() => ({})),
      d365.getList(ATT, {
        select: PUNCH_SELECT,
        filter: `_hr_hremployee_value eq '${empId}' and hr_date ge ${monthFrom} and hr_date le ${monthEnd}`,
        orderby: 'hr_date asc',
      }).catch(() => ({ data: [] })),
      d365.getList(LEAVE, {
        select: 'hr_days,hr_fromdate,hr_todate,hr_status',
        filter: `_hr_hremployee_value eq '${empId}'`,
      }).catch(() => ({ data: [] })),
      firstAttendanceDate(empId),
      openPriorRecord(empId, today),
      activity.recent(6).catch(() => []),
    ]);

    const shift = attnCfg.resolveEmployeeShift(emp.hr_shiftname, emp.hr_shiftstarttime, emp.hr_shiftendtime);
    const monthRecs = monthRecsRes.data || [];
    const allLeaves = allLeavesRes.data || [];

    // ── Today's session (attendance widget) ───────────────────────────────────
    const todayRec = monthRecs.find(r => String(r.hr_date).slice(0, 10) === today) || null;
    const ct = computeSession(todayRec ? punchesFromRecord(todayRec) : [], shift);
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
      missingCheckout: openPrior
        ? { date: String(openPrior.hr_date).slice(0, 10) }
        : null,
    };

    // ── This month's attendance figures (live) ────────────────────────────────
    let present = 0, half = 0, incomplete = 0, attended = 0, lateDays = 0, workedEff = 0, overtime = 0;
    let earliestRec = null;
    for (const r of monthRecs) {
      const c = computeSession(punchesFromRecord(r), shift);
      const ds = String(r.hr_date).slice(0, 10);
      if (!earliestRec || ds < earliestRec) earliestRec = ds;
      if ((c.count || 0) > 0) { attended++; workedEff += c.effectiveHours || 0; overtime += c.overtimeHours || 0; }
      if (c.status === 'present') present++;
      else if (c.status === 'half_day') half++;
      else if (c.status === 'incomplete') incomplete++;
      if (c.lateArrivalMin > 0) lateDays++;
    }

    // Approved leave days in THIS month (up to today) — offsets Absent.
    const leaveDaysMonth = allLeaves
      .filter(l => l.hr_status === approvedVal)
      .filter(l => {
        const lf = String(l.hr_fromdate || '').slice(0, 10);
        return lf.slice(0, 7) === `${Y}-${mm}` && lf <= today;
      })
      .reduce((s, l) => s + resolveDays(l.hr_days, l.hr_fromdate, l.hr_todate), 0);

    // Absent = elapsed working days (from first punch) − attended − approved leave.
    // Resilient first-date: true first punch, else earliest in-range record.
    const clampDate = firstDate || earliestRec || null;
    const workingElapsed = effectiveWorking(monthFrom, capTo, clampDate);
    const absentDays = Math.max(0, workingElapsed - attended - leaveDaysMonth);
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
    const upcoming = (attnCfg.holidays || []).filter(d => d >= today).sort();
    const upcomingHoliday = upcoming.length ? { date: upcoming[0], label: time.fmtDate(upcoming[0]) } : null;

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
      activity: activityItems,
    });
  } catch (err) { next(err); }
});

module.exports = router;
