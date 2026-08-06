/**
 * Professional Tax — the SINGLE source of truth for the PT slab. Every module
 * (Salary Structure, Payroll Engine, Payslip) imports this — the calculation is
 * never duplicated or entered manually.
 *
 * Slab (monthly, on Gross = Basic + HRA + Special + Medical + Conveyance + Other):
 *   Gross <= 15000            → ₹0
 *   Gross 15001 .. 20000      → ₹150
 *   Gross > 20000             → ₹200   (March stays ₹200 unless policy changes)
 */
function calculateProfessionalTax(grossSalary) {
  const g = Math.max(0, Math.round(Number(grossSalary) || 0));
  if (g <= 15000) return 0;
  if (g <= 20000) return 150;
  return 200;
}

// Documented slab (for UI display / templates). Kept beside the function so both
// stay in lockstep.
const PT_SLABS = [
  { upTo: 15000, amount: 0, label: 'Up to ₹15,000' },
  { upTo: 20000, amount: 150, label: '₹15,001 – ₹20,000' },
  { upTo: Infinity, amount: 200, label: 'Above ₹20,000' },
];

module.exports = { calculateProfessionalTax, PT_SLABS };
