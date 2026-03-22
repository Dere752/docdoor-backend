const express = require('express');
const bcrypt = require('bcryptjs');
const { v4: uuid } = require('uuid');
const { getDb } = require('../db/init');
const { adminAuthMiddleware, signAdminToken } = require('../middleware/adminAuth');
const router = express.Router();

// POST /api/admin/login
router.post('/login', async (req, res) => {
  try {
    const db = getDb();
    const { email, password } = req.body;
    if (!email || !password) return res.status(400).json({ error: 'Email and password required' });
    const admin = db.prepare('SELECT * FROM admin_users WHERE email = ? AND is_active = 1').get(email.toLowerCase());
    if (!admin || !bcrypt.compareSync(password, admin.password_hash)) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }
    db.prepare('UPDATE admin_users SET last_login = ? WHERE id = ?').run(Date.now(), admin.id);
    const token = signAdminToken(admin);
    // Audit log
    db.prepare('INSERT INTO audit_log (id,actor_id,actor_type,action,details,ip_address,created_at) VALUES (?,?,?,?,?,?,?)')
      .run('AL'+Date.now().toString(36), admin.id, 'admin', 'login', '{}', req.ip||'', Date.now());
    res.json({ token, admin: { id: admin.id, email: admin.email, name: admin.name, role: admin.role } });
  } catch(err) {
    console.error('Admin login error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// POST /api/admin/change-password
router.post('/change-password', adminAuthMiddleware, (req, res) => {
  const db = getDb();
  const { currentPassword, newPassword } = req.body;
  if (!currentPassword || !newPassword) return res.status(400).json({ error: 'Both passwords required' });
  if (newPassword.length < 8) return res.status(400).json({ error: 'Min 8 characters' });
  const admin = db.prepare('SELECT * FROM admin_users WHERE id = ?').get(req.admin.id);
  if (!bcrypt.compareSync(currentPassword, admin.password_hash)) return res.status(401).json({ error: 'Current password incorrect' });
  db.prepare('UPDATE admin_users SET password_hash = ? WHERE id = ?').run(bcrypt.hashSync(newPassword, 12), req.admin.id);
  logAction(db, req, 'change_password', 'admin', req.admin.id);
  res.json({ success: true });
});

// All routes below require admin auth
router.use(adminAuthMiddleware);

// GET /api/admin/dashboard — Real-time stats
router.get('/dashboard', (req, res) => {
  const db = getDb();
  const now = Date.now();
  const today = now - 86400000;
  const week = now - 7 * 86400000;
  const month = now - 30 * 86400000;

  const totalUsers = db.prepare("SELECT COUNT(*) as c FROM users WHERE role = 'patient'").get().c;
  const totalDocs = db.prepare("SELECT COUNT(*) as c FROM users WHERE role = 'doctor'").get().c;
  const totalVisits = db.prepare('SELECT COUNT(*) as c FROM visits').get().c;
  const activeVisits = db.prepare("SELECT COUNT(*) as c FROM visits WHERE status IN ('pending','upcoming','active')").get().c;
  const todayVisits = db.prepare('SELECT COUNT(*) as c FROM visits WHERE created_at > ?').get(today).c;
  const weekVisits = db.prepare('SELECT COUNT(*) as c FROM visits WHERE created_at > ?').get(week).c;
  const monthVisits = db.prepare('SELECT COUNT(*) as c FROM visits WHERE created_at > ?').get(month).c;

  const totalRevenue = db.prepare("SELECT COALESCE(SUM(amount),0) as t FROM payments WHERE status IN ('captured','provisioned')").get().t;
  const todayRevenue = db.prepare("SELECT COALESCE(SUM(amount),0) as t FROM payments WHERE status IN ('captured','provisioned') AND created_at > ?").get(today).t;
  const monthRevenue = db.prepare("SELECT COALESCE(SUM(amount),0) as t FROM payments WHERE status IN ('captured','provisioned') AND created_at > ?").get(month).t;
  const totalCommission = db.prepare("SELECT COALESCE(SUM(commission_amount),0) as t FROM payments WHERE status IN ('captured','provisioned')").get().t;
  const pendingRefunds = db.prepare("SELECT COUNT(*) as c FROM payments WHERE status = 'pending_refund'").get().c;

  const insuranceClaims = db.prepare('SELECT COUNT(*) as c FROM insurance_claims').get().c;
  const approvedClaims = db.prepare("SELECT COUNT(*) as c FROM insurance_claims WHERE status = 'approved'").get().c;
  const totalClaimAmount = db.prepare("SELECT COALESCE(SUM(approved_amount),0) as t FROM insurance_claims WHERE status = 'approved'").get().t;

  const openComplaints = db.prepare("SELECT COUNT(*) as c FROM complaints WHERE status = 'open'").get().c;
  const blockedUsers = db.prepare('SELECT COUNT(*) as c FROM users WHERE is_blocked = 1').get().c;

  // Recent visits
  const recentVisits = db.prepare(`SELECT v.*, u.first_name || ' ' || u.last_name as patient_name
    FROM visits v LEFT JOIN users u ON v.user_id = u.id ORDER BY v.created_at DESC LIMIT 10`).all();

  res.json({
    stats: {
      totalUsers, totalDocs, totalVisits, activeVisits, todayVisits, weekVisits, monthVisits,
      totalRevenue, todayRevenue, monthRevenue, totalCommission, pendingRefunds,
      insuranceClaims, approvedClaims, totalClaimAmount, openComplaints, blockedUsers,
    },
    recentVisits: recentVisits.map(v => ({
      id: v.id, patient: v.patient_name, doctor: v.doc_name, status: v.status,
      price: v.price, paymentStatus: v.payment_status, date: v.date, time: v.time,
      createdAt: v.created_at,
    })),
    // Demographics
    demographics: (() => {
      const countries = db.prepare("SELECT country, COUNT(*) as c FROM users WHERE country != '' GROUP BY country ORDER BY c DESC").all();
      const provinces = db.prepare("SELECT address as province, COUNT(*) as c FROM users WHERE address != '' GROUP BY address ORDER BY c DESC LIMIT 20").all();
      const ages = db.prepare("SELECT birth_date FROM users WHERE birth_date != ''").all().map(u => {
        const bd = new Date(u.birth_date);
        return Math.floor((Date.now() - bd.getTime()) / (365.25 * 86400000));
      }).filter(a => a > 0 && a < 120);
      const ageGroups = {'18-24':0,'25-34':0,'35-44':0,'45-54':0,'55-64':0,'65+':0};
      ages.forEach(a => {
        if(a<25) ageGroups['18-24']++;
        else if(a<35) ageGroups['25-34']++;
        else if(a<45) ageGroups['35-44']++;
        else if(a<55) ageGroups['45-54']++;
        else if(a<65) ageGroups['55-64']++;
        else ageGroups['65+']++;
      });
      const avgAge = ages.length > 0 ? Math.round(ages.reduce((s,a)=>s+a,0)/ages.length) : 0;
      return { countries, provinces, ageGroups, avgAge, totalWithAge: ages.length };
    })(),
  });
});

// GET /api/admin/users — List all users with pagination
router.get('/users', (req, res) => {
  const db = getDb();
  const { role, search, page = 1, limit = 50 } = req.query;
  const offset = (parseInt(page) - 1) * parseInt(limit);
  let sql = 'SELECT * FROM users WHERE 1=1';
  const params = [];
  if (role) { sql += ' AND role = ?'; params.push(role); }
  if (search) { sql += ' AND (id LIKE ? OR email LIKE ?)'; params.push(`%${search}%`,`%${search}%`); }
  const total = db.prepare(sql.replace('SELECT *', 'SELECT COUNT(*) as c')).get(...params).c;
  sql += ' ORDER BY created_at DESC LIMIT ? OFFSET ?';
  params.push(parseInt(limit), offset);
  const users = db.prepare(sql).all(...params);
  res.json({ users: users.map(u => { delete u.password_hash; return u; }), total, page: parseInt(page), pages: Math.ceil(total/parseInt(limit)) });
});

// PUT /api/admin/users/:id/block — Block/unblock user
router.put('/users/:id/block', (req, res) => {
  const db = getDb();
  const { blocked, reason } = req.body;
  db.prepare('UPDATE users SET is_blocked = ?, block_reason = ?, updated_at = ? WHERE id = ?')
    .run(blocked ? 1 : 0, reason || '', Date.now(), req.params.id);
  logAction(db, req, blocked ? 'block_user' : 'unblock_user', 'user', req.params.id, { reason });
  res.json({ success: true });
});

// DELETE /api/admin/users/:id — Delete user
router.delete('/users/:id', (req, res) => {
  const db = getDb();
  const user = db.prepare('SELECT id, email, role FROM users WHERE id = ?').get(req.params.id);
  if (!user) return res.status(404).json({ error: 'User not found' });
  db.prepare('DELETE FROM users WHERE id = ?').run(req.params.id);
  logAction(db, req, 'delete_user', 'user', req.params.id, { email: user.email });
  res.json({ success: true });
});

// GET /api/admin/payments — All payments
router.get('/payments', (req, res) => {
  const db = getDb();
  const { status, page = 1, limit = 50 } = req.query;
  const offset = (parseInt(page) - 1) * parseInt(limit);
  let sql = 'SELECT p.*, u.first_name || \' \' || u.last_name as patient_name FROM payments p LEFT JOIN users u ON p.user_id = u.id WHERE 1=1';
  const params = [];
  if (status) { sql += ' AND p.status = ?'; params.push(status); }
  const total = db.prepare(sql.replace(/SELECT p\.\*.*FROM/, 'SELECT COUNT(*) as c FROM').replace(/LEFT JOIN.*WHERE/, 'WHERE')).get(...params).c;
  sql += ' ORDER BY p.created_at DESC LIMIT ? OFFSET ?';
  params.push(parseInt(limit), offset);
  const payments = db.prepare(sql).all(...params);
  res.json({ payments, total });
});

// GET /api/admin/insurance-claims — All claims
router.get('/insurance-claims', (req, res) => {
  const db = getDb();
  const claims = db.prepare(`SELECT ic.*, u.first_name || ' ' || u.last_name as patient_name, ir.provider_name
    FROM insurance_claims ic LEFT JOIN users u ON ic.user_id = u.id
    LEFT JOIN insurance_records ir ON ic.insurance_record_id = ir.id
    ORDER BY ic.submitted_at DESC`).all();
  res.json({ claims });
});

// GET /api/admin/complaints — All complaints
router.get('/complaints', (req, res) => {
  const db = getDb();
  const { status } = req.query;
  let sql = 'SELECT c.*, u.first_name || \' \' || u.last_name as user_name FROM complaints c LEFT JOIN users u ON c.user_id = u.id';
  if (status) sql += " WHERE c.status = '" + status.replace(/'/g, '') + "'";
  sql += ' ORDER BY c.created_at DESC';
  res.json({ complaints: db.prepare(sql).all() });
});

// PUT /api/admin/complaints/:id — Update complaint
router.put('/complaints/:id', (req, res) => {
  const db = getDb();
  const { status, adminNotes } = req.body;
  const now = Date.now();
  if (status) db.prepare('UPDATE complaints SET status = ?, admin_notes = COALESCE(?, admin_notes), resolved_at = ? WHERE id = ?')
    .run(status, adminNotes, status === 'resolved' ? now : 0, req.params.id);
  logAction(db, req, 'update_complaint', 'complaint', req.params.id, { status });
  res.json({ success: true });
});

// GET /api/admin/settings — System settings
router.get('/settings', (req, res) => {
  const db = getDb();
  const rows = db.prepare('SELECT * FROM system_settings').all();
  const settings = {};
  rows.forEach(r => settings[r.key] = r.value);
  res.json({ settings });
});

// PUT /api/admin/settings — Update settings
router.put('/settings', (req, res) => {
  const db = getDb();
  const { settings } = req.body;
  const now = Date.now();
  for (const [key, value] of Object.entries(settings || {})) {
    db.prepare('INSERT OR REPLACE INTO system_settings (key, value, updated_at) VALUES (?, ?, ?)').run(key, String(value), now);
  }
  logAction(db, req, 'update_settings', 'system', '', { keys: Object.keys(settings || {}) });
  res.json({ success: true });
});

// GET /api/admin/audit — Audit log
router.get('/audit', (req, res) => {
  const db = getDb();
  const { limit = 100 } = req.query;
  const logs = db.prepare('SELECT * FROM audit_log ORDER BY created_at DESC LIMIT ?').all(parseInt(limit));
  res.json({ logs });
});

// POST /api/admin/doctor-payout — Create doctor payout
router.post('/doctor-payout', (req, res) => {
  const db = getDb();
  const { docId, amount, iban, bankName } = req.body;
  if (!docId || !amount) return res.status(400).json({ error: 'docId and amount required' });
  const id = 'PO' + Date.now().toString(36);
  db.prepare('INSERT INTO doctor_payouts (id,doc_id,amount,iban,bank_name,status,created_at) VALUES (?,?,?,?,?,?,?)')
    .run(id, docId, amount, iban||'', bankName||'', 'pending', Date.now());
  logAction(db, req, 'create_payout', 'doctor', docId, { amount });
  res.json({ success: true, payoutId: id });
});

// GET /api/admin/doctor-payouts — List payouts
router.get('/doctor-payouts', (req, res) => {
  const db = getDb();
  const payouts = db.prepare(`SELECT dp.*, u.first_name || ' ' || u.last_name as doc_name
    FROM doctor_payouts dp LEFT JOIN users u ON dp.doc_id = u.id ORDER BY dp.created_at DESC`).all();
  res.json({ payouts });
});

// PUT /api/admin/doctor-payouts/:id — Update payout status
router.put('/doctor-payouts/:id', (req, res) => {
  const db = getDb();
  const { status } = req.body;
  db.prepare('UPDATE doctor_payouts SET status = ?, processed_at = ? WHERE id = ?')
    .run(status, status === 'completed' ? Date.now() : 0, req.params.id);
  logAction(db, req, 'update_payout', 'payout', req.params.id, { status });
  res.json({ success: true });
});

function logAction(db, req, action, targetType, targetId, details = {}) {
  db.prepare('INSERT INTO audit_log (id,actor_id,actor_type,action,target_type,target_id,details,ip_address,created_at) VALUES (?,?,?,?,?,?,?,?,?)')
    .run('AL'+Date.now().toString(36)+Math.random().toString(36).slice(2,5), req.admin?.id||'system', 'admin', action, targetType, targetId||'', JSON.stringify(details), req.ip||'', Date.now());
}

module.exports = router;
