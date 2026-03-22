const express = require('express');
const { getDb } = require('../db/init');
const { authMiddleware } = require('../middleware/auth');

const router = express.Router();

// GET /api/notifications
router.get('/', authMiddleware, (req, res) => {
  const db = getDb();
  const notifs = db.prepare('SELECT * FROM notifications WHERE user_id = ? ORDER BY created_at DESC LIMIT 50').all(req.user.id);
  res.json({
    notifications: notifs.map(n => ({
      id: n.id, msg: n.message, read: !!n.read,
      time: new Date(n.created_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
      createdAt: n.created_at,
    }))
  });
});

// POST /api/notifications — create notification
router.post('/', authMiddleware, (req, res) => {
  const db = getDb();
  const { message } = req.body;
  if (!message) return res.status(400).json({ error: 'Message required' });

  const id = 'n' + Date.now().toString(36);
  db.prepare('INSERT INTO notifications (id, user_id, message, read, created_at) VALUES (?, ?, ?, 0, ?)')
    .run(id, req.user.id, message, Date.now());

  res.status(201).json({ notification: { id, msg: message, read: false } });
});

// PUT /api/notifications/read-all
router.put('/read-all', authMiddleware, (req, res) => {
  const db = getDb();
  db.prepare('UPDATE notifications SET read = 1 WHERE user_id = ?').run(req.user.id);
  res.json({ success: true });
});

// DELETE /api/notifications/:id
router.delete('/:id', authMiddleware, (req, res) => {
  const db = getDb();
  db.prepare('DELETE FROM notifications WHERE id = ? AND user_id = ?').run(req.params.id, req.user.id);
  res.json({ success: true });
});

module.exports = router;
