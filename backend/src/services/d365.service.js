const axios = require('axios');
const { ConfidentialClientApplication } = require('@azure/msal-node');

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
    return { data: res.data.value, count: res.data['@odata.count'] };
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
