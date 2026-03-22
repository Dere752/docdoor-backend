const express = require('express');
const router = express.Router();
const { getDb } = require('../db/init');
const { authMiddleware } = require('../middleware/auth');

function ensureTable() {
  const db = getDb();
  db.exec(`CREATE TABLE IF NOT EXISTS doctor_schedules (
    id TEXT PRIMARY KEY,
    doctor_id TEXT NOT NULL,
    day_of_week TEXT NOT NULL,
    enabled INTEGER DEFAULT 1,
    slots TEXT DEFAULT '[]',
    updated_at INTEGER NOT NULL,
    UNIQUE(doctor_id, day_of_week)
  )`);
}

router.get('/', authMiddleware, (req, res) => {
  ensureTable();
  const db = getDb();
  const rows = db.prepare('SELECT * FROM doctor_schedules WHERE doctor_id = ?').all(req.user.id);
  res.json({ schedule: rows });
});

router.get('/:doctorId', (req, res) => {
  ensureTable();
  const db = getDb();
  const rows = db.prepare('SELECT day_of_week, enabled, slots FROM doctor_schedules WHERE doctor_id = ?').all(req.params.doctorId);
  res.json({ schedule: rows });
});

router.put('/', authMiddleware, (req, res) => {
  ensureTable();
  const db = getDb();
  const { schedule } = req.body;
  if (!Array.isArray(schedule)) return res.status(400).json({ error: 'Schedule must be an array' });
  
  const now = Date.now();
  for (const day of schedule) {
    const id = `sched_${req.user.id}_${day.day_of_week}`;
    const slotsJson = typeof day.slots === 'string' ? day.slots : JSON.stringify(day.slots || []);
    try {
      db.prepare('INSERT INTO doctor_schedules (id, doctor_id, day_of_week, enabled, slots, updated_at) VALUES (?,?,?,?,?,?)').run(id, req.user.id, day.day_of_week, day.enabled ? 1 : 0, slotsJson, now);
    } catch(e) {
      db.prepare('UPDATE doctor_schedules SET enabled = ?, slots = ?, updated_at = ? WHERE doctor_id = ? AND day_of_week = ?').run(day.enabled ? 1 : 0, slotsJson, now, req.user.id, day.day_of_week);
    }
  }
  
  res.json({ ok: true });
});

module.exports = router;
