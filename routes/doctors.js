const express = require('express');
const { getDb } = require('../db/init');
const { optionalAuth, authMiddleware } = require('../middleware/auth');

const router = express.Router();

// GET /api/doctors — list all REAL registered doctors
router.get('/', optionalAuth, (req, res) => {
  const db = getDb();
  const docs = db.prepare("SELECT * FROM users WHERE role = 'doctor' ORDER BY rating DESC, created_at DESC").all();
  res.json({
    doctors: docs.map(formatDoctor)
  });
});

// GET /api/doctors/:id
router.get('/:id', (req, res) => {
  const db = getDb();
  const d = db.prepare("SELECT * FROM users WHERE id = ? AND role = 'doctor'").get(req.params.id);
  if (!d) return res.status(404).json({ error: 'Doctor not found' });
  res.json({ doctor: formatDoctor(d) });
});

// PUT /api/doctors/profile — doctor updates their own doctor-specific fields
router.put('/profile', authMiddleware, (req, res) => {
  const db = getDb();
  if (req.user.role !== 'doctor') return res.status(403).json({ error: 'Not a doctor' });

  const { price, bio, education, img, langs, eta, nextAvailable, specialty } = req.body;
  const now = Date.now();

  db.prepare(`
    UPDATE users SET
      price = COALESCE(?, price),
      bio = COALESCE(?, bio),
      education = COALESCE(?, education),
      img = COALESCE(?, img),
      langs = COALESCE(?, langs),
      eta = COALESCE(?, eta),
      next_available = COALESCE(?, next_available),
      specialty = COALESCE(?, specialty),
      updated_at = ?
    WHERE id = ?
  `).run(price, bio, education, img, langs ? JSON.stringify(langs) : null, eta, nextAvailable, specialty, now, req.user.id);

  const d = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
  res.json({ doctor: formatDoctor(d) });
});

// POST /api/doctors/:id/review — add a review to a doctor
router.post('/:id/review', (req, res) => {
  const db = getDb();
  const { name, text, stars } = req.body;
  const d = db.prepare("SELECT * FROM users WHERE id = ? AND role = 'doctor'").get(req.params.id);
  if (!d) return res.status(404).json({ error: 'Doctor not found' });

  const reviews = JSON.parse(d.reviews || '[]');
  reviews.push({ name: name || 'Patient', text: text || '', stars: stars || 5 });

  const totalStars = reviews.reduce((sum, r) => sum + (r.stars || 5), 0);
  const newRating = Math.round((totalStars / reviews.length) * 10) / 10;

  db.prepare('UPDATE users SET reviews = ?, rating = ?, review_count = ?, updated_at = ? WHERE id = ?')
    .run(JSON.stringify(reviews), newRating, reviews.length, Date.now(), req.params.id);

  res.json({ rating: newRating, reviewCount: reviews.length });
});

function formatDoctor(d) {
  return {
    id: d.id,
    name: 'Dr. ' + (d.first_name || '') + (d.last_name ? ' ' + d.last_name : ''),
    email: d.email,
    specialty: d.specialty || 'General Practitioner',
    rating: d.rating || 0,
    reviewCount: d.review_count || 0,
    img: d.img || '',
    eta: d.eta || 20,
    price: d.price || 150,
    next: d.next_available || 'Available',
    langs: JSON.parse(d.langs || '["English"]'),
    bio: d.bio || '',
    education: d.education || '',
    experience: d.experience || '',
    currency: d.currency || 'USD',
    reviews: JSON.parse(d.reviews || '[]'),
    phone: d.phone || '',
    address: d.address || '',
  };
}

module.exports = router;
