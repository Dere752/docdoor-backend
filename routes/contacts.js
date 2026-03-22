const express = require('express');
const { getDb } = require('../db/init');
const { authMiddleware } = require('../middleware/auth');

const router = express.Router();

// GET /api/contacts
router.get('/', authMiddleware, (req, res) => {
  const db = getDb();
  const contacts = db.prepare('SELECT * FROM emergency_contacts WHERE user_id = ? ORDER BY created_at DESC').all(req.user.id);
  res.json({ contacts: contacts.map(c => ({ id: c.id, name: c.name, phone: c.phone, relation: c.relation })) });
});

// POST /api/contacts
router.post('/', authMiddleware, (req, res) => {
  const db = getDb();
  const { name, phone, relation } = req.body;
  if (!name || !phone) return res.status(400).json({ error: 'Name and phone required' });

  const id = 'ec' + Date.now().toString(36);
  db.prepare('INSERT INTO emergency_contacts (id, user_id, name, phone, relation, created_at) VALUES (?, ?, ?, ?, ?, ?)')
    .run(id, req.user.id, name, phone, relation || '', Date.now());

  res.status(201).json({ contact: { id, name, phone, relation: relation || '' } });
});

// DELETE /api/contacts/:id
router.delete('/:id', authMiddleware, (req, res) => {
  const db = getDb();
  db.prepare('DELETE FROM emergency_contacts WHERE id = ? AND user_id = ?').run(req.params.id, req.user.id);
  res.json({ success: true });
});

module.exports = router;
