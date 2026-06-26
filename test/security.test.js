const { test } = require('node:test');
const assert = require('node:assert');
const { sanitizeInput, securityHeaders } = require('../middleware/security');

// Minimal Express-like req/res doubles
function mockRes() {
  const headers = {};
  return {
    headers,
    setHeader(k, v) { headers[k] = v; },
    removeHeader(k) { delete headers[k]; },
  };
}

test('sanitizeInput strips <script> tags from string fields', () => {
  const req = { body: { name: 'Ali<script>alert(1)</script>' } };
  sanitizeInput(req, mockRes(), () => {});
  assert.strictEqual(req.body.name, 'Ali');
});

test('sanitizeInput strips inline event handlers', () => {
  const req = { body: { bio: 'hi onerror="steal()" there' } };
  sanitizeInput(req, mockRes(), () => {});
  assert.ok(!/onerror=/.test(req.body.bio), 'event handler should be removed');
});

test('sanitizeInput recurses into nested objects', () => {
  const req = { body: { profile: { note: '<script>x</script>ok' } } };
  sanitizeInput(req, mockRes(), () => {});
  assert.strictEqual(req.body.profile.note, 'ok');
});

test('sanitizeInput calls next()', () => {
  let called = false;
  sanitizeInput({ body: {} }, mockRes(), () => { called = true; });
  assert.strictEqual(called, true);
});

test('securityHeaders sets hardening headers and removes X-Powered-By', () => {
  const res = mockRes();
  res.setHeader('X-Powered-By', 'Express');
  securityHeaders({}, res, () => {});
  assert.strictEqual(res.headers['X-Content-Type-Options'], 'nosniff');
  assert.strictEqual(res.headers['X-Frame-Options'], 'DENY');
  assert.strictEqual(res.headers['Referrer-Policy'], 'strict-origin-when-cross-origin');
  assert.strictEqual(res.headers['X-Powered-By'], undefined);
});
