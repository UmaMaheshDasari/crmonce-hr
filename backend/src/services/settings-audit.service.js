/**
 * Settings Audit — append-only history of Company / Payroll / Attendance setting
 * changes. One row per changed field. Best-effort (never throws / blocks a save).
 * Storage: hr_settingsaudits (see provision-settings-audit.js).
 */
const d365 = require('./d365.service');
const { ensureSettingsAuditTable, ENTITY_SET } = require('./provision-settings-audit');

// Human labels for the settings we track (used in the history UI). Unknown keys fall
// back to the raw field name — so newly-added keys are still recorded, just unlabeled.
const FIELD_LABELS = {
  hr_attnruleeffectivedate: 'Attendance Rule Effective Date',
  hr_fulldayminhours: 'Full Day Minimum Hours',
  hr_halfdayminhours: 'Half Day Minimum Hours',
  hr_fulldayexpectedhours: 'Full Day Expected Hours',
  hr_halfdayexpectedhours: 'Half Day Expected Hours',
  hr_enablemonthlyhourbalance: 'Enable Monthly Hour Balance',
  hr_enablehourlyshortagededuction: 'Enable Hourly Shortage Deduction',
  hr_approvedleavededuction: 'Approved Leave Salary Deduction',
  hr_lateloginsalarydeduction: 'Late Login Salary Deduction',
  hr_overtimecarryforward: 'Overtime Carry Forward',
  hr_hourbalancecarryforward: 'Hour Balance Carry Forward',
  hr_negativebalancecarryforward: 'Negative Balance Carry Forward',
  hr_halfdaylopfromshortage: 'Half Day LOP From Hour Shortage',
  hr_fulldaylopfromshortage: 'Full Day LOP From Hour Shortage',
  hr_absentcreateslop: 'Absent Creates LOP',
  hr_hourlydeductionbasis: 'Hourly Shortage Deduction Basis',
  hr_ruleversion: 'Rule Version',
  hr_lopbasis: 'LOP Basis',
  hr_workinghoursperday: 'Working Hours Per Day',
  hr_otmultiplier: 'Overtime Multiplier',
  hr_gracetime: 'Late Login Grace (minutes)',
};

const labelOf = (field) => FIELD_LABELS[field] || field;

async function withTable(fn) {
  try { return await fn(); }
  catch (err) {
    if (/Resource not found for the segment|does not exist|Could not find/i.test(err.message)) {
      await ensureSettingsAuditTable(global.logger || console).catch(() => {});
      return await fn();
    }
    throw err;
  }
}

/**
 * Record ONE settings change (append-only). Best-effort.
 * @param {{scope?:string, field:string, oldValue:any, newValue:any, changedBy?:string,
 *          effectiveDate?:string, ruleVersion?:string, reason?:string}} p
 */
async function record({ scope = 'payroll', field, oldValue, newValue, changedBy, effectiveDate, ruleVersion, reason } = {}) {
  try {
    await d365.create(ENTITY_SET, {
      hr_name: `${labelOf(field)} · ${new Date().toISOString().slice(0, 10)}`.slice(0, 250),
      hr_scope: scope, hr_field: field, hr_fieldlabel: labelOf(field),
      hr_oldvalue: oldValue == null ? '' : String(oldValue),
      hr_newvalue: newValue == null ? '' : String(newValue),
      hr_changedby: changedBy || '', hr_changedon: new Date().toISOString(),
      hr_effectivedate: effectiveDate || '', hr_ruleversion: ruleVersion || '',
      hr_reason: reason || '',
    });
  } catch (e) { global.logger?.warn?.(`[settings-audit] write skipped (${field}): ${e.message}`); }
}

/**
 * Diff the tracked fields of `before` vs `after` (both raw string maps) and record a
 * row per change. Only fields present in `after` are considered. Best-effort.
 */
async function recordDiff({ before = {}, after = {}, fields, changedBy, effectiveDate, ruleVersion, reason, scope = 'payroll' } = {}) {
  const keys = fields || Object.keys(after);
  for (const f of keys) {
    if (!(f in after)) continue;
    const oldV = before[f];
    const newV = after[f];
    if (String(oldV ?? '') === String(newV ?? '')) continue;   // unchanged
    await record({ scope, field: f, oldValue: oldV, newValue: newV, changedBy, effectiveDate, ruleVersion, reason });
  }
}

/** Read history, newest first. Optional filters: field, changedBy, from, to. */
async function list({ field, changedBy, from, to, top = 500 } = {}) {
  try {
    const filters = [];
    if (field) filters.push(`hr_field eq '${field}'`);
    if (changedBy) filters.push(`contains(hr_changedby,'${changedBy}')`);
    if (from) filters.push(`hr_changedon ge '${from}'`);
    if (to) filters.push(`hr_changedon le '${to}'`);
    const { data } = await withTable(() => d365.getList(ENTITY_SET, {
      select: 'hr_settingsauditid,hr_scope,hr_field,hr_fieldlabel,hr_oldvalue,hr_newvalue,hr_changedby,hr_changedon,hr_effectivedate,hr_ruleversion,hr_reason,createdon',
      filter: filters.join(' and ') || undefined, orderby: 'createdon desc', top,
    }));
    return (data || []).map((r) => ({
      id: r.hr_settingsauditid, scope: r.hr_scope || '', field: r.hr_field || '', fieldLabel: r.hr_fieldlabel || r.hr_field || '',
      oldValue: r.hr_oldvalue || '', newValue: r.hr_newvalue || '', changedBy: r.hr_changedby || '',
      changedOn: r.hr_changedon || r.createdon, effectiveDate: r.hr_effectivedate || '', ruleVersion: r.hr_ruleversion || '', reason: r.hr_reason || '',
    }));
  } catch { return []; }
}

module.exports = { record, recordDiff, list, labelOf, FIELD_LABELS };
