/**
 * Module ON/OFF enforcement — Company Settings stores `hr_payrollenabled` and
 * `hr_salarystructureenabled` ('true'/'false'). When a module is off it must be
 * hidden in the UI AND its APIs must refuse to serve (403), so a bookmarked URL
 * or direct API call can never bypass the switch. Reads the cached company row
 * (5-min TTL, invalidated on save), so this costs nothing per request.
 */
const company = require('../services/company.service');

/** Company-setting value → enabled? Missing/blank defaults to ON (backward-compatible). */
function isOn(v) {
  if (v === undefined || v === null || v === '') return true;
  return v === true || /^(true|1|yes|on)$/i.test(String(v));
}

function requireModule(flag, label) {
  return async (req, res, next) => {
    try {
      const c = await company.getCompany();
      if (!isOn(c[flag])) {
        return res.status(403).json({ error: `${label} module is disabled by the administrator.` });
      }
      next();
    } catch {
      // A settings read failure must never take a module offline.
      next();
    }
  };
}

const requirePayrollEnabled = requireModule('hr_payrollenabled', 'Payroll');
const requireSalaryStructureEnabled = requireModule('hr_salarystructureenabled', 'Salary Structure');

module.exports = { isOn, requireModule, requirePayrollEnabled, requireSalaryStructureEnabled };
