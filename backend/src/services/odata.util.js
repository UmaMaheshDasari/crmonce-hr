/**
 * OData $filter value sanitisers. Dataverse filters are built as interpolated
 * strings, so any value that originates from the client (req.query/body/params)
 * MUST be escaped/validated before interpolation to prevent filter-injection
 * (escaping the self-scope, reading other employees' rows, etc.).
 *
 *   odStr(v) — escape a string literal (double any single quotes) for `field eq '...'`
 *   odInt(v) — return the integer value, or null if not a safe integer (drop the clause)
 *   odGuid(v) — return v only if it is a GUID, else '' (drop the clause)
 */
const odStr = (v) => String(v ?? '').replace(/'/g, "''");
const odInt = (v) => { const s = String(v ?? '').trim(); if (s === '') return null; const n = Number(s); return Number.isInteger(n) ? n : null; };
const odGuid = (v) => (/^[0-9a-fA-F-]{36}$/.test(String(v || '')) ? String(v) : '');

module.exports = { odStr, odInt, odGuid };
