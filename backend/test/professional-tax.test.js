/**
 * Professional Tax — the single centralized slab function.
 */
const { test } = require('node:test');
const assert = require('node:assert');
const { calculateProfessionalTax } = require('../src/services/professional-tax');

test('slab boundaries', () => {
  assert.strictEqual(calculateProfessionalTax(0), 0);
  assert.strictEqual(calculateProfessionalTax(15000), 0);       // <= 15000 → 0
  assert.strictEqual(calculateProfessionalTax(15001), 150);     // first rupee over → 150
  assert.strictEqual(calculateProfessionalTax(18000), 150);
  assert.strictEqual(calculateProfessionalTax(20000), 150);     // inclusive upper edge → 150
  assert.strictEqual(calculateProfessionalTax(20001), 200);     // over 20000 → 200
  assert.strictEqual(calculateProfessionalTax(65000), 200);
});

test('robust to junk / negative / decimal input', () => {
  assert.strictEqual(calculateProfessionalTax(-500), 0);
  assert.strictEqual(calculateProfessionalTax('19999'), 150);
  assert.strictEqual(calculateProfessionalTax(20000.4), 150);   // rounds to 20000
  assert.strictEqual(calculateProfessionalTax(20000.6), 200);   // rounds to 20001
  assert.strictEqual(calculateProfessionalTax(null), 0);
  assert.strictEqual(calculateProfessionalTax(undefined), 0);
  assert.strictEqual(calculateProfessionalTax('abc'), 0);
});

test('salary-structure service derives PT from the same slab (no manual value)', () => {
  const svc = require('../src/services/salary-structure.service');
  // Client sends a bogus professionalTax; it must be ignored and replaced by the slab.
  const { value } = svc.validate({ employeeId: '11111111-1111-1111-1111-111111111111', effectiveFrom: '2026-04-01', basic: 18000, professionalTax: 9999 }, { requireEmployee: true });
  assert.strictEqual(value.professionalTax, 150);   // slab on 18000, NOT 9999
  const totals = svc.computeTotals({ basic: 30000 });
  assert.strictEqual(totals.professionalTax, 200);
});
