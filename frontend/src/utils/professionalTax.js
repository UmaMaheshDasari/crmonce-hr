// Professional Tax slab — mirrors backend/src/services/professional-tax.js.
// Used ONLY for real-time display in the Salary Structure form; the backend
// re-computes authoritatively before saving/generating (never trusts the client).
export function calculateProfessionalTax(grossSalary) {
  const g = Math.max(0, Math.round(Number(grossSalary) || 0));
  if (g <= 15000) return 0;
  if (g <= 20000) return 150;
  return 200;
}

export const PT_SLABS = [
  { label: 'Up to ₹15,000', amount: 0 },
  { label: '₹15,001 – ₹20,000', amount: 150 },
  { label: 'Above ₹20,000', amount: 200 },
];
