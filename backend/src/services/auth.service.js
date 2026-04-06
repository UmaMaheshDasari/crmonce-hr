const { ConfidentialClientApplication } = require('@azure/msal-node');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const d365 = require('./d365.service');
const { toLabel } = require('./picklist');

class AuthService {
  constructor() {
    this.msalClient = new ConfidentialClientApplication({
      auth: {
        clientId: process.env.AZURE_CLIENT_ID,
        clientSecret: process.env.AZURE_CLIENT_SECRET,
        authority: `https://login.microsoftonline.com/${process.env.AZURE_TENANT_ID}`,
      },
    });
  }

  generateTokens(user) {
    const payload = {
      id: user.hr_hremployeeid,
      email: user.hr_email,
      role: toLabel('hr_role', user.hr_role),
      name: user.hr_hremployee1,
    };
    const accessToken = jwt.sign(payload, process.env.JWT_SECRET, {
      expiresIn: process.env.JWT_ACCESS_EXPIRY || '15m',
    });
    const refreshToken = jwt.sign({ id: user.hr_hremployeeid }, process.env.JWT_SECRET, {
      expiresIn: process.env.JWT_REFRESH_EXPIRY || '7d',
    });
    return { accessToken, refreshToken };
  }

  async login(email, password) {
    const { data } = await d365.getList(d365.constructor.entities.employee, {
      filter: `hr_email eq '${email}' and hr_status eq 123140000`,
      select: 'hr_hremployeeid,hr_hremployee1,hr_email,hr_password,hr_role,hr_department',
    });

    if (!data || data.length === 0) throw new Error('Invalid credentials');
    const user = data[0];

    const valid = await bcrypt.compare(password, user.hr_password);
    if (!valid) throw new Error('Invalid credentials');

    const tokens = this.generateTokens(user);
    return {
      tokens,
      user: {
        id: user.hr_hremployeeid,
        name: user.hr_hremployee1,
        email: user.hr_email,
        role: toLabel('hr_role', user.hr_role),
      },
    };
  }

  async refreshToken(token) {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    const user = await d365.getById(d365.constructor.entities.employee, decoded.id, {
      select: 'hr_hremployeeid,hr_hremployee1,hr_email,hr_role',
    });
    return this.generateTokens(user);
  }

  verifyToken(token) {
    return jwt.verify(token, process.env.JWT_SECRET);
  }

  async hashPassword(password) {
    return bcrypt.hash(password, 12);
  }
}

module.exports = new AuthService();
