/**
 * Verify `trust proxy` behind Nginx — client IP detection + per-IP rate limiting.
 * Spins a throwaway Express app that MIRRORS server.js's config (trust proxy = 1
 * + express-rate-limit), sends requests carrying X-Forwarded-For (as Nginx does),
 * and asserts:
 *   1. req.ip resolves to the forwarded CLIENT IP (not the proxy).
 *   2. express-rate-limit throws NO ERR_ERL_UNEXPECTED_X_FORWARDED_FOR warning.
 *   3. Rate limiting still triggers 429 per-IP (not disabled), and different IPs
 *      are counted separately.
 * No network egress, no secrets. Run: node scripts/verify-trust-proxy.js
 */
const http = require('http');
const express = require('express');
const rateLimit = require('express-rate-limit');

const HOPS = Number(process.env.TRUST_PROXY_HOPS || 1);
const MAX = 3;

let warned = false;
const app = express();
app.set('trust proxy', HOPS);                       // same as server.js
app.use(rateLimit({
  windowMs: 60 * 1000, max: MAX,
  message: { error: 'Too many requests' },
  // Surface any express-rate-limit validation warning as a hard failure.
  validate: { trustProxy: true, xForwardedForHeader: true },
}));
app.get('/api/ping', (req, res) => res.json({ ip: req.ip }));

// Capture the specific warning if the config were wrong.
const origWarn = console.warn;
console.warn = (...a) => { if (String(a[0]).includes('ERR_ERL')) warned = true; origWarn(...a); };

const server = app.listen(0, async () => {
  const port = server.address().port;
  const call = (xff) => new Promise((resolve) => {
    const req = http.request({ host: '127.0.0.1', port, path: '/api/ping', headers: { 'X-Forwarded-For': xff } }, (r) => {
      let body = ''; r.on('data', c => body += c); r.on('end', () => resolve({ status: r.statusCode, body: JSON.parse(body || '{}') }));
    });
    req.end();
  });

  let pass = true;
  const check = (cond, msg) => { console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${msg}`); if (!cond) pass = false; };

  console.log(`\n=== trust proxy = ${HOPS} (Nginx one hop) ===`);

  // 1. Client IP detection — a single upstream client IP behind the proxy.
  const first = await call('203.0.113.77');
  check(first.body.ip === '203.0.113.77', `req.ip = forwarded client IP (got ${first.body.ip})`);
  check(!warned, 'no ERR_ERL_UNEXPECTED_X_FORWARDED_FOR warning emitted');

  // 2. Rate limiting still enforced per-IP (client 203.0.113.77 already used 1).
  await call('203.0.113.77'); await call('203.0.113.77');      // now 3 total = MAX
  const limited = await call('203.0.113.77');
  check(limited.status === 429, `4th request from same IP → 429 (got ${limited.status})`);

  // 3. A DIFFERENT client IP is counted separately (not globally limited).
  const other = await call('198.51.100.9');
  check(other.status === 200, `different client IP not limited → 200 (got ${other.status})`);

  server.close();
  console.log(pass ? '\nALL CHECKS PASSED\n' : '\nCHECKS FAILED\n');
  process.exit(pass ? 0 : 1);
});
