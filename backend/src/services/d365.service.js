const axios = require('axios');
const { ConfidentialClientApplication } = require('@azure/msal-node');
const { formatAxiosError, summarize } = require('../utils/axiosError');

// Diagnostics: log full detail for any failed D365 Web API request, then
// re-throw the original error unchanged (no behaviour change — callers still
// receive the same rejection and control flow).
axios.interceptors.response.use(
  (res) => res,
  (err) => {
    if (err?.config?.url?.includes('/api/data/')) {
      global.logger?.error(`D365 request failed → ${summarize(err)}`);
      global.logger?.error(`D365 error detail: ${JSON.stringify(formatAxiosError(err))}`);
    }
    return Promise.reject(err);
  }
);

class D365Service {
  constructor() {
    this.baseUrl = `${process.env.D365_BASE_URL}/api/data/v${process.env.D365_API_VERSION}`;
    this.tokenCache = null;
    this.tokenExpiry = null;
    // Maps a guessed entity-set name → the REAL EntitySetName from Dataverse
    // metadata. Populated lazily the first time a guess 404s (segment not found).
    this._setAlias = {};

    this.msalClient = new ConfidentialClientApplication({
      auth: {
        clientId: process.env.AZURE_CLIENT_ID,
        clientSecret: process.env.AZURE_CLIENT_SECRET,
        authority: `https://login.microsoftonline.com/${process.env.AZURE_TENANT_ID}`,
      },
    });
  }

  async getAccessToken() {
    if (this.tokenCache && this.tokenExpiry && Date.now() < this.tokenExpiry - 60000) {
      return this.tokenCache;
    }
    const result = await this.msalClient.acquireTokenByClientCredential({
      scopes: [`${process.env.D365_BASE_URL}/.default`],
    });
    this.tokenCache = result.accessToken;
    this.tokenExpiry = result.expiresOn?.getTime();
    return this.tokenCache;
  }

  async getHeaders(extras = {}) {
    const token = await this.getAccessToken();
    return {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      Accept: 'application/json',
      'OData-MaxVersion': '4.0',
      'OData-Version': '4.0',
      Prefer: 'odata.include-annotations="*"',
      ...extras,
    };
  }

  // ── Generic CRUD ──────────────────────────────────────────────

  async getList(entity, params = {}) {
    const { select, filter, expand, orderby, top, skip } = params;
    const query = new URLSearchParams();
    if (select) query.set('$select', select);
    if (filter) query.set('$filter', filter);
    if (expand) query.set('$expand', expand);
    if (orderby) query.set('$orderby', orderby);
    if (top) query.set('$top', top);
    if (skip) query.set('$skip', skip);
    query.set('$count', 'true');

    return this._withSet(entity, async (seg) => {
      const headers = await this.getHeaders();
      const url = `${this.baseUrl}/${seg}?${query.toString()}`;
      let res;
      try { res = await axios.get(url, { headers }); }
      catch (err) { throw this._enrich(err, `getList ${seg}`); }
      // Dataverse pages via @odata.nextLink (a skiptoken cursor) — it does NOT
      // support $skip. Expose nextLink so callers can page correctly.
      return { data: res.data.value, count: res.data['@odata.count'], nextLink: res.data['@odata.nextLink'] };
    });
  }

  // Follow @odata.nextLink cursors to retrieve ALL matching rows (up to cap).
  // Use this instead of $skip loops, which silently return page 1 forever.
  async getAll(entity, params = {}, cap = 10000) {
    const first = await this.getList(entity, params);
    const all = [...(first.data || [])];
    let nextLink = first.nextLink;
    let headers;   // fetched lazily — only when there is a cursor to follow
    while (nextLink && all.length < cap) {
      if (!headers) headers = await this.getHeaders();
      const res = await axios.get(nextLink, { headers });
      all.push(...(res.data.value || []));
      nextLink = res.data['@odata.nextLink'];
    }
    return { data: all.slice(0, cap), count: first.count };
  }

  async getById(entity, id, params = {}) {
    const { select, expand } = params;
    const query = new URLSearchParams();
    if (select) query.set('$select', select);
    if (expand) query.set('$expand', expand);
    return this._withSet(entity, async (seg) => {
      const headers = await this.getHeaders();
      const url = `${this.baseUrl}/${seg}(${id})?${query.toString()}`;
      try {
        const res = await axios.get(url, { headers });
        return res.data;
      } catch (err) { throw this._enrich(err, `getById ${seg}`); }
    });
  }

  // True when Dataverse rejected the query because a $select column doesn't exist
  // yet (optional/newly-added field). Lets callers degrade gracefully.
  _isMissingProperty(err) {
    const m = err?.response?.data?.error?.message || '';
    return err?.response?.status === 400 &&
      /Could not find a property named|does not exist|property named '/i.test(m);
  }

  // The exact column name Dataverse says is missing (from the 400 message), so a
  // writer can strip ONLY that field and retry — never dropping columns that exist.
  _missingPropertyName(err) {
    const m = err?.response?.data?.error?.message || '';
    const mm = m.match(/property named '([^']+)'/i) || m.match(/property '([^']+)'/i) ||
      m.match(/'([a-z0-9_]+)'\s+(?:does not exist|was not found)/i);
    return mm ? mm[1] : null;
  }

  // getList that RETRIES without the optional columns if Dataverse doesn't have
  // them yet — so a not-yet-created field never breaks the whole query.
  async getListOptional(entity, { select, optionalSelect, ...rest }) {
    const full = optionalSelect ? [select, optionalSelect].filter(Boolean).join(',') : select;
    try {
      return await this.getList(entity, { ...rest, select: full });
    } catch (err) {
      if (optionalSelect && this._isMissingProperty(err)) {
        return await this.getList(entity, { ...rest, select });
      }
      throw err;
    }
  }

  async getByIdOptional(entity, id, { select, optionalSelect, ...rest }) {
    const full = optionalSelect ? [select, optionalSelect].filter(Boolean).join(',') : select;
    try {
      return await this.getById(entity, id, { ...rest, select: full });
    } catch (err) {
      if (optionalSelect && this._isMissingProperty(err)) {
        return await this.getById(entity, id, { ...rest, select });
      }
      throw err;
    }
  }

  // Surface the FULL Dataverse OData error instead of a bare "status code 400".
  // Keeps err.response intact (so _isMissingProperty etc. still work).
  _enrich(err, op) {
    const e = err?.response?.data?.error;
    if (e?.message) {
      err.message = `Dataverse ${err.response.status} on ${op}: ${e.code || ''} ${e.message}`.replace(/\s+/g, ' ').trim();
      global.logger?.error(`D365 ${op} FAILED — ${JSON.stringify(err.response.data.error)}`);
    }
    return err;
  }

  // True when Dataverse 404'd because the URL's entity-set segment doesn't exist
  // (wrong collection name) — e.g. 0x80060888 "Resource not found for the segment".
  _isBadSegment(err) {
    const code = err?.response?.data?.error?.code;
    const msg = err?.response?.data?.error?.message || '';
    return err?.response?.status === 404 &&
      (code === '0x80060888' || /Resource not found for the segment/i.test(msg));
  }

  // Ask Dataverse metadata for the authoritative EntitySetName. We only have a
  // (wrong) plural guess like 'hr_hrgoals', so derive candidate LOGICAL names and
  // look them up. Returns the real set name, or null if nothing matches.
  async _resolveEntitySet(entity) {
    const cands = new Set();
    const base = entity.replace(/s$/, '');          // hr_hrgoals → hr_hrgoal
    cands.add(base);
    cands.add(base.replace(/e$/, ''));              // ...ses → ...s
    cands.add(entity.replace(/ies$/, 'y'));         // categories → category
    cands.add(base.replace(/^hr_hr/, 'hr_'));       // hr_hrgoal → hr_goal
    const filter = [...cands].filter(Boolean)
      .map((n) => `LogicalName eq '${n}'`).join(' or ');
    try {
      const headers = await this.getHeaders();
      const url = `${this.baseUrl}/EntityDefinitions?$select=EntitySetName,LogicalName&$filter=${encodeURIComponent(filter)}`;
      const res = await axios.get(url, { headers });
      const rows = res.data.value || [];
      if (rows.length) return rows[0].EntitySetName;
    } catch (e) {
      global.logger?.error?.(`D365 metadata lookup for '${entity}' failed: ${e.message}`);
    }
    return null;
  }

  // Run a CRUD closure against the entity set. If the guessed set name 404s as a
  // bad segment, resolve the REAL name from metadata once, cache it, and retry.
  async _withSet(entity, run) {
    const seg = this._setAlias[entity] || entity;
    try {
      return await run(seg);
    } catch (err) {
      if (this._isBadSegment(err) && !this._setAlias[entity]) {
        const real = await this._resolveEntitySet(entity);
        if (real && real !== seg) {
          this._setAlias[entity] = real;
          global.logger?.warn?.(`D365 entity-set '${entity}' not found — resolved to '${real}' via metadata; retrying.`);
          return await run(real);
        }
      }
      throw err;
    }
  }

  async create(entity, data) {
    return this._withSet(entity, async (seg) => {
      const headers = await this.getHeaders({ Prefer: 'return=representation' });
      try {
        const res = await axios.post(`${this.baseUrl}/${seg}`, data, { headers });
        return res.data;
      } catch (err) { throw this._enrich(err, `create ${seg}`); }
    });
  }

  async update(entity, id, data) {
    await this._withSet(entity, async (seg) => {
      const headers = await this.getHeaders();
      try {
        await axios.patch(`${this.baseUrl}/${seg}(${id})`, data, { headers });
      } catch (err) { throw this._enrich(err, `update ${seg}`); }
    });
    return this.getById(entity, id);
  }

  async delete(entity, id) {
    return this._withSet(entity, async (seg) => {
      const headers = await this.getHeaders();
      await axios.delete(`${this.baseUrl}/${seg}(${id})`, { headers });
      return { deleted: true };
    });
  }

  async executeFetchXml(entity, fetchXml) {
    const headers = await this.getHeaders();
    const encoded = encodeURIComponent(fetchXml);
    const url = `${this.baseUrl}/${entity}?fetchXml=${encoded}`;
    const res = await axios.get(url, { headers });
    return res.data.value;
  }

  // ── D365 Entity Names (custom prefix: hr_) ────────────────────

  static entities = {
    employee:    'hr_hremployees',
    attendance:  'hr_hrattendances',
    leave:       'hr_hrleaves',
    payroll:     'hr_hrpayrolls',
    job:         'hr_hrjobs',
    application: 'hr_hrapplications',
    performance: 'hr_hrperformances',
    document:    'hr_hrdocuments',
    department:  'hr_hrdepartments',
    designation: 'hr_hrdesignations',
    goal:        'hr_hrgoals',
    salaryStructure: 'hr_salarystructures',       // Effective-dated salary revisions per employee
    leaveLedger: 'hr_leaveledgers',               // Comp-off grants + manual leave-balance adjustments
    attendanceRequest: 'hr_attendancerequests',   // Missing Punch / Attendance correction requests
    holiday:     'hr_holidays',                   // HR-managed holiday calendar
  };
}

module.exports = new D365Service();
