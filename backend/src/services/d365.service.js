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
    const headers = await this.getHeaders();
    const { select, filter, expand, orderby, top, skip } = params;
    const query = new URLSearchParams();
    if (select) query.set('$select', select);
    if (filter) query.set('$filter', filter);
    if (expand) query.set('$expand', expand);
    if (orderby) query.set('$orderby', orderby);
    if (top) query.set('$top', top);
    if (skip) query.set('$skip', skip);
    query.set('$count', 'true');

    const url = `${this.baseUrl}/${entity}?${query.toString()}`;
    const res = await axios.get(url, { headers });
    // Dataverse pages via @odata.nextLink (a skiptoken cursor) — it does NOT
    // support $skip. Expose nextLink so callers can page correctly.
    return { data: res.data.value, count: res.data['@odata.count'], nextLink: res.data['@odata.nextLink'] };
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
    const headers = await this.getHeaders();
    const { select, expand } = params;
    const query = new URLSearchParams();
    if (select) query.set('$select', select);
    if (expand) query.set('$expand', expand);
    const url = `${this.baseUrl}/${entity}(${id})?${query.toString()}`;
    const res = await axios.get(url, { headers });
    return res.data;
  }

  // True when Dataverse rejected the query because a $select column doesn't exist
  // yet (optional/newly-added field). Lets callers degrade gracefully.
  _isMissingProperty(err) {
    const m = err?.response?.data?.error?.message || '';
    return err?.response?.status === 400 &&
      /Could not find a property named|does not exist|property named '/i.test(m);
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

  async create(entity, data) {
    const headers = await this.getHeaders({ Prefer: 'return=representation' });
    const res = await axios.post(`${this.baseUrl}/${entity}`, data, { headers });
    return res.data;
  }

  async update(entity, id, data) {
    const headers = await this.getHeaders();
    await axios.patch(`${this.baseUrl}/${entity}(${id})`, data, { headers });
    return this.getById(entity, id);
  }

  async delete(entity, id) {
    const headers = await this.getHeaders();
    await axios.delete(`${this.baseUrl}/${entity}(${id})`, { headers });
    return { deleted: true };
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
  };
}

module.exports = new D365Service();
