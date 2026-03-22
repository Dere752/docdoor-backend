// ═══ RATE LIMITING + SECURITY ═══
const rateWindows = new Map(); // ip -> { count, resetTime }

function rateLimit(opts = {}) {
  const max = opts.max || 100;
  const windowMs = opts.windowMs || 60000;
  const message = opts.message || 'Too many requests. Please try again later.';
  return (req, res, next) => {
    const ip = req.ip || req.connection.remoteAddress || 'unknown';
    const key = (opts.prefix || 'rl') + ':' + ip;
    const now = Date.now();
    let entry = rateWindows.get(key);
    if (!entry || now > entry.resetTime) {
      entry = { count: 0, resetTime: now + windowMs };
      rateWindows.set(key, entry);
    }
    entry.count++;
    res.setHeader('X-RateLimit-Limit', max);
    res.setHeader('X-RateLimit-Remaining', Math.max(0, max - entry.count));
    if (entry.count > max) {
      return res.status(429).json({ error: message });
    }
    next();
  };
}

// Clean up old entries every 5 minutes
setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of rateWindows) {
    if (now > entry.resetTime) rateWindows.delete(key);
  }
}, 300000);

// Security headers (like helmet but lightweight)
function securityHeaders(req, res, next) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('X-XSS-Protection', '1; mode=block');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.removeHeader('X-Powered-By');
  next();
}

// Input sanitizer — strip dangerous characters
function sanitizeInput(req, res, next) {
  if (req.body && typeof req.body === 'object') {
    sanitizeObj(req.body);
  }
  next();
}
function sanitizeObj(obj) {
  for (const key of Object.keys(obj)) {
    if (typeof obj[key] === 'string') {
      obj[key] = obj[key].replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, '')
        .replace(/on\w+\s*=\s*["'][^"']*["']/gi, '');
    } else if (typeof obj[key] === 'object' && obj[key] !== null) {
      sanitizeObj(obj[key]);
    }
  }
}

module.exports = { rateLimit, securityHeaders, sanitizeInput };
