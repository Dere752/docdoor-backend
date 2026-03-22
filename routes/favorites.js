const express = require('express');
const { getDb } = require('../db/init');
const { authMiddleware } = require('../middleware/auth');

const router = express.Router();

// GET /api/favorites
router.get('/', authMiddleware, (req, res) => {
  const db = getDb();
  const favs = db.prepare('SELECT doc_id FROM favorites WHERE user_id = ?').all(req.user.id);
  res.json({ favorites: favs.map(f => f.doc_id) });
});

// POST /api/favorites/:docId — toggle favorite
router.post('/:docId', authMiddleware, (req, res) => {
  const db = getDb();
  const existing = db.prepare('SELECT * FROM favorites WHERE user_id = ? AND doc_id = ?').get(req.user.id, req.params.docId);

  if (existing) {
    db.prepare('DELETE FROM favorites WHERE user_id = ? AND doc_id = ?').run(req.user.id, req.params.docId);
    res.json({ favorited: false });
  } else {
    db.prepare('INSERT INTO favorites (user_id, doc_id, created_at) VALUES (?, ?, ?)').run(req.user.id, req.params.docId, Date.now());
    res.json({ favorited: true });
  }
});

module.exports = router;
