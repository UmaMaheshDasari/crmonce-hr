const express = require('express');
const router = express.Router();
const { ConfidentialClientApplication } = require('@azure/msal-node');
const authService = require('../../services/auth.service');
const d365 = require('../../services/d365.service');
const { authenticateToken } = require('../../middleware/auth.middleware');
const { toLabel } = require('../../services/picklist');

// ── Azure AD MSAL Config for user login ──────────────────────
const msalConfig = {
  auth: {
    clientId: process.env.AZURE_CLIENT_ID,
    clientSecret: process.env.AZURE_CLIENT_SECRET,
    authority: `https://login.microsoftonline.com/${process.env.AZURE_TENANT_ID}`,
  },
};
const msalClient = new ConfidentialClientApplication(msalConfig);
const REDIRECT_URI = `${process.env.FRONTEND_URL || 'http://localhost:3000'}/auth/callback`;

// ── GET /api/auth/azure/login — Redirect to Azure AD ─────────
router.get('/azure/login', (req, res) => {
  const authUrl = `https://login.microsoftonline.com/${process.env.AZURE_TENANT_ID}/oauth2/v2.0/authorize?` +
    `client_id=${process.env.AZURE_CLIENT_ID}` +
    `&response_type=code` +
    `&redirect_uri=${encodeURIComponent(REDIRECT_URI)}` +
    `&response_mode=query` +
    `&scope=${encodeURIComponent('openid profile email User.Read')}` +
    `&state=hr_login`;

  res.json({ authUrl });
});

// ── POST /api/auth/azure/callback — Exchange code for token ──
router.post('/azure/callback', async (req, res) => {
  try {
    const { code } = req.body;
    if (!code) return res.status(400).json({ error: 'Authorization code required' });

    // Exchange code for Azure AD tokens
    const tokenResponse = await msalClient.acquireTokenByCode({
      code,
      scopes: ['openid', 'profile', 'email', 'User.Read'],
      redirectUri: REDIRECT_URI,
    });

    const azureUser = tokenResponse.account;
    const email = azureUser?.username || tokenResponse.idTokenClaims?.preferred_username || tokenResponse.idTokenClaims?.email;
    const name = azureUser?.name || tokenResponse.idTokenClaims?.name || email?.split('@')[0];

    if (!email) {
      return res.status(400).json({ error: 'Could not get email from Azure AD' });
    }

    // Find employee in D365 by email
    let { data: employees } = await d365.getList(d365.constructor.entities.employee, {
      filter: `hr_email eq '${email}' and hr_status eq 123140000`,
      select: 'hr_hremployeeid,hr_hremployee1,hr_email,hr_role,hr_department',
    });

    let user;

    if (employees.length > 0) {
      // Existing employee — use their record
      user = employees[0];
    } else {
      // Auto-create employee from Azure AD profile
      user = await d365.create(d365.constructor.entities.employee, {
        hr_hremployee1: name,
        hr_email: email,
        hr_role: 123140000, // employee
        hr_status: 123140000, // active
        hr_department: 'Unassigned',
        hr_designation: 'Employee',
        hr_joiningdate: new Date().toISOString(),
      });
      global.logger?.info(`Azure AD: Auto-created employee ${name} (${email})`);
    }

    // Generate JWT tokens (same as password login)
    const tokens = authService.generateTokens(user);

    res.json({
      tokens,
      user: {
        id: user.hr_hremployeeid,
        name: user.hr_hremployee1,
        email: user.hr_email,
        role: toLabel('hr_role', user.hr_role),
      },
    });
  } catch (err) {
    global.logger?.error(`Azure AD callback error: ${err.message}`);
    res.status(401).json({ error: 'Azure AD authentication failed: ' + err.message });
  }
});

// ── POST /api/auth/login — Email/password login (kept as fallback) ──
router.post('/login', async (req, res, next) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) return res.status(400).json({ error: 'Email and password required' });
    const result = await authService.login(email, password);
    res.json(result);
  } catch (err) {
    res.status(401).json({ error: err.message });
  }
});

// ── POST /api/auth/refresh ──
router.post('/refresh', async (req, res, next) => {
  try {
    const { refreshToken } = req.body;
    if (!refreshToken) return res.status(400).json({ error: 'Refresh token required' });
    const tokens = await authService.refreshToken(refreshToken);
    res.json({ tokens });
  } catch (err) {
    res.status(403).json({ error: 'Invalid refresh token' });
  }
});

// ── GET /api/auth/me ──
router.get('/me', authenticateToken, (req, res) => {
  res.json({ user: req.user });
});

// ── POST /api/auth/logout ──
router.post('/logout', authenticateToken, (req, res) => {
  res.json({ message: 'Logged out successfully' });
});

module.exports = router;
