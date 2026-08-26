/**
 * RBAC Security Audit Log — append-only record of security-sensitive / admin actions
 * covered by the RBAC guards. Best-effort: never throws, never blocks a request.
 * Storage: hr_auditlogs (see provision-audit-log.js).
 *
 * The RBAC guards (requireAnyPermission / requireRole) stash what they checked on
 * `req._audit`; the audit middleware calls shouldAudit()/buildEntry() at res 'finish'.
 * This keeps ALL business logic untouched (no route file changes) and scopes logging
 * precisely to RBAC-protected endpoints.
 */
const d365 = require('./d365.service');
const { ensureAuditLogTable, ENTITY_SET } = require('./provision-audit-log');

const MUTATION_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/** Strip the query string and collapse GUID/id path segments to ':id' for a stable action label. */
function pathTemplate(url) {
  const path = String(url || '').split('?')[0];
  return path
    .replace(/\/[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}(?=\/|$)/g, '/:id')
    .replace(/\/\d+(?=\/|$)/g, '/:id');
}

/**
 * Should this finished request be audited? Only RBAC-guarded routes (req._audit set),
 * and only when it is a MUTATION or was DENIED (403). Routine GET reads are skipped.
 */
function shouldAudit(req, res) {
  if (!req || !req._audit) return false;                 // no RBAC guard ran → not in scope
  const status = res?.statusCode || 0;
  const isMutation = MUTATION_METHODS.has(String(req.method || '').toUpperCase());
  const isDenied = status === 403;
  return isMutation || isDenied;
}

/** Map a finished request + its stashed guard info into an audit row (pure). */
function buildEntry(req, res) {
  const a = req._audit || {};
  const status = res?.statusCode || 0;
  const outcome = status === 403 ? 'denied' : (status >= 200 && status < 400 ? 'success' : 'error');
  const action = a.action || `${req.method} ${pathTemplate(req.originalUrl || req.url)}`;
  const category = a.action && a.action.includes('.') ? a.action.split('.')[0] : (a.category || 'general');
  const u = req.user || {};
  return {
    action,
    category,
    actor: u.name || u.email || '',
    actorId: u.id || '',
    actorRole: u.role || '',
    required: a.required || '',
    method: String(req.method || '').toUpperCase(),
    path: pathTemplate(req.originalUrl || req.url),
    targetId: (req.params && req.params.id) || '',
    outcome,
    statusCode: String(status || ''),
    ip: req.ip || req.headers?.['x-forwarded-for'] || '',
    occurredOn: new Date().toISOString(),
    details: a.details || '',
  };
}

async function withTable(fn) {
  try { return await fn(); }
  catch (err) {
    if (/Resource not found for the segment|does not exist|Could not find/i.test(err.message)) {
      await ensureAuditLogTable(global.logger || console).catch(() => {});
      return await fn();
    }
    throw err;
  }
}

/** Persist ONE audit row (append-only). Best-effort — swallows every error. */
async function record(entry) {
  try {
    const e = entry || {};
    await d365.create(ENTITY_SET, {
      hr_name: `${e.action || 'action'} · ${(e.occurredOn || new Date().toISOString()).slice(0, 10)}`.slice(0, 250),
      hr_action: e.action || '', hr_category: e.category || '',
      hr_actor: e.actor || '', hr_actorid: e.actorId || '', hr_actorrole: e.actorRole || '',
      hr_required: e.required || '', hr_method: e.method || '', hr_path: e.path || '',
      hr_targetid: e.targetId || '', hr_outcome: e.outcome || '', hr_statuscode: e.statusCode || '',
      hr_ip: e.ip || '', hr_occurredon: e.occurredOn || new Date().toISOString(), hr_details: e.details || '',
    });
  } catch (err) { global.logger?.warn?.(`[audit-log] write skipped (${entry?.action}): ${err.message}`); }
}

/** Read the audit log, newest first. Filters: action, actor, actorRole, outcome, category, targetId (employee), from, to. */
async function list({ action, actor, actorRole, outcome, category, targetId, from, to, top = 500 } = {}) {
  try {
    const q = (s) => String(s).replace(/'/g, "''");
    const filters = [];
    if (action) filters.push(`hr_action eq '${q(action)}'`);
    if (category) filters.push(`hr_category eq '${q(category)}'`);
    if (outcome) filters.push(`hr_outcome eq '${q(outcome)}'`);
    if (actorRole) filters.push(`hr_actorrole eq '${q(actorRole)}'`);
    if (actor) filters.push(`contains(hr_actor,'${q(actor)}')`);
    if (targetId) filters.push(`hr_targetid eq '${q(targetId)}'`);   // audit "Employee" filter (RBAC Phase E)
    if (from) filters.push(`hr_occurredon ge '${q(from)}'`);
    if (to) filters.push(`hr_occurredon le '${q(to)}'`);
    const { data } = await withTable(() => d365.getList(ENTITY_SET, {
      select: 'hr_auditlogid,hr_action,hr_category,hr_actor,hr_actorid,hr_actorrole,hr_required,hr_method,hr_path,hr_targetid,hr_outcome,hr_statuscode,hr_ip,hr_occurredon,hr_details,createdon',
      filter: filters.join(' and ') || undefined, orderby: 'createdon desc', top,
    }));
    return (data || []).map((r) => ({
      id: r.hr_auditlogid, action: r.hr_action || '', category: r.hr_category || '',
      actor: r.hr_actor || '', actorId: r.hr_actorid || '', actorRole: r.hr_actorrole || '',
      required: r.hr_required || '', method: r.hr_method || '', path: r.hr_path || '',
      targetId: r.hr_targetid || '', outcome: r.hr_outcome || '', statusCode: r.hr_statuscode || '',
      ip: r.hr_ip || '', occurredOn: r.hr_occurredon || r.createdon, details: r.hr_details || '',
    }));
  } catch { return []; }
}

module.exports = { shouldAudit, buildEntry, record, list, pathTemplate, ENTITY_SET };
