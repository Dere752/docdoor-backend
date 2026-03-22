const express = require('express');
const { v4: uuid } = require('uuid');
const { getDb } = require('../db/init');
const { authMiddleware } = require('../middleware/auth');

const router = express.Router();

// Auto-migrate: add time, days, dayTimes columns if missing
try {
  const db = getDb();
  try { db._raw.run('ALTER TABLE medications ADD COLUMN time TEXT DEFAULT ""'); } catch {}
  try { db._raw.run('ALTER TABLE medications ADD COLUMN days TEXT DEFAULT "[]"'); } catch {}
  try { db._raw.run('ALTER TABLE medications ADD COLUMN day_times TEXT DEFAULT ""'); } catch {}
} catch {}

// GET /api/meds
router.get('/', authMiddleware, (req, res) => {
  const db = getDb();
  const meds = db.prepare('SELECT * FROM medications WHERE user_id = ? ORDER BY created_at DESC').all(req.user.id);
  res.json({ meds: meds.map(m => ({ id: m.id, name: m.name, dosage: m.dosage, frequency: m.frequency, time: m.time || '', days: m.days || '[]', dayTimes: m.day_times || '', active: !!m.active })) });
});

// POST /api/meds
router.post('/', authMiddleware, (req, res) => {
  const db = getDb();
  const { name, dosage, frequency, time, days, dayTimes, userId } = req.body;
  if (!name) return res.status(400).json({ error: 'Medication name required' });

  // Doctor can add meds for a patient
  const targetUserId = (req.user.role === 'doctor' && userId) ? userId : req.user.id;
  const id = 'm' + Date.now().toString(36);
  const timeStr = time || '';
  const daysStr = typeof days === 'string' ? days : JSON.stringify(days || []);
  const dayTimesStr = typeof dayTimes === 'string' ? dayTimes : JSON.stringify(dayTimes || {});
  
  db.prepare('INSERT INTO medications (id, user_id, name, dosage, frequency, time, days, day_times, active, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?)')
    .run(id, targetUserId, name, dosage || '', frequency || timeStr, timeStr, daysStr, dayTimesStr, Date.now());

  res.status(201).json({ med: { id, name, dosage: dosage || '', frequency: frequency || timeStr, time: timeStr, days: daysStr, dayTimes: dayTimesStr, active: true } });
});

// PUT /api/meds/:id — toggle active, update
router.put('/:id', authMiddleware, (req, res) => {
  const db = getDb();
  const { active, name, dosage, frequency, time, days } = req.body;

  if (active !== undefined) {
    db.prepare('UPDATE medications SET active = ? WHERE id = ? AND user_id = ?').run(active ? 1 : 0, req.params.id, req.user.id);
  }
  if (name) db.prepare('UPDATE medications SET name = ? WHERE id = ? AND user_id = ?').run(name, req.params.id, req.user.id);
  if (dosage !== undefined) db.prepare('UPDATE medications SET dosage = ? WHERE id = ? AND user_id = ?').run(dosage, req.params.id, req.user.id);
  if (frequency) db.prepare('UPDATE medications SET frequency = ? WHERE id = ? AND user_id = ?').run(frequency, req.params.id, req.user.id);
  if (time !== undefined) db.prepare('UPDATE medications SET time = ? WHERE id = ? AND user_id = ?').run(time, req.params.id, req.user.id);
  if (days !== undefined) {
    const daysStr = typeof days === 'string' ? days : JSON.stringify(days);
    db.prepare('UPDATE medications SET days = ? WHERE id = ? AND user_id = ?').run(daysStr, req.params.id, req.user.id);
  }

  const med = db.prepare('SELECT * FROM medications WHERE id = ? AND user_id = ?').get(req.params.id, req.user.id);
  if (!med) return res.status(404).json({ error: 'Not found' });
  res.json({ med: { id: med.id, name: med.name, dosage: med.dosage, frequency: med.frequency, time: med.time || '', days: med.days || '[]', active: !!med.active } });
});

// DELETE /api/meds/:id
router.delete('/:id', authMiddleware, (req, res) => {
  const db = getDb();
  db.prepare('DELETE FROM medications WHERE id = ? AND user_id = ?').run(req.params.id, req.user.id);
  res.json({ success: true });
});

module.exports = router;
