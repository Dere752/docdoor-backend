const jwt = require('jsonwebtoken');

const ADMIN_SECRET = process.env.ADMIN_JWT_SECRET || process.env.JWT_SECRET + '_admin_2026';

function adminAuthMiddleware(req, res, next) {
  const header = req.headers.authorization;
  if (!header || !header.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Admin authentication required' });
  }
  try {
    const token = header.split(' ')[1];
    const decoded = jwt.verify(token, ADMIN_SECRET);
    if (decoded.type !== 'admin') {
      return res.status(403).json({ error: 'Invalid admin token' });
    }
    req.admin = decoded;
    next();
  } catch {
    return res.status(401).json({ error: 'Invalid or expired admin token' });
  }
}

function signAdminToken(admin) {
  return jwt.sign(
    { id: admin.id, email: admin.email, role: admin.role, type: 'admin' },
    ADMIN_SECRET,
    { expiresIn: '8h' }
  );
}

module.exports = { adminAuthMiddleware, signAdminToken, ADMIN_SECRET };
