const express = require('express');
const { v4: uuid } = require('uuid');
const { getDb } = require('../db/init');
const { authMiddleware } = require('../middleware/auth');

const router = express.Router();

// GET /api/visits — list visits (patients see theirs, doctors see theirs)
router.get('/', authMiddleware, (req, res) => {
  const db = getDb();
  let visits;
  console.log(`📖 GET /visits — user: ${req.user.id}, role: ${req.user.role}`);
  if (req.user.role === 'doctor') {
    visits = db.prepare('SELECT * FROM visits WHERE doc_id = ? ORDER BY created_at DESC').all(req.user.id);
  } else {
    visits = db.prepare('SELECT * FROM visits WHERE user_id = ? ORDER BY created_at DESC').all(req.user.id);
  }
  console.log(`   Found ${visits.length} visits`);
  res.json({ visits: visits.map(formatVisit) });
});

// GET /api/visits/pending — doctors see pending requests needing their approval
router.get('/pending', authMiddleware, (req, res) => {
  const db = getDb();
  console.log(`\n🔍 GET /pending — user: ${req.user.id}, role: ${req.user.role}`);
  if (req.user.role !== 'doctor') return res.status(403).json({ error: 'Not a doctor' });
  
  // Debug: show all visits
  const allVisits = db.prepare('SELECT id, doc_id, status, sym FROM visits ORDER BY created_at DESC').all();
  console.log(`   All visits in DB: ${allVisits.length}`);
  allVisits.forEach(v => console.log(`     - ${v.id}: doc_id=${v.doc_id}, status=${v.status}`));
  
  const visits = db.prepare("SELECT * FROM visits WHERE doc_id = ? AND status = 'pending' ORDER BY created_at DESC").all(req.user.id);
  console.log(`   Pending for doctor ${req.user.id}: ${visits.length}\n`);
  
  const result = visits.map(v => {
    const patient = db.prepare('SELECT first_name, last_name, phone, email FROM users WHERE id = ?').get(v.user_id);
    return {
      ...formatVisit(v),
      patientName: patient ? (patient.first_name + ' ' + (patient.last_name || '')).trim() : 'Unknown',
      patientEmail: patient?.email || '',
      patientPhone: patient?.phone || '',
    };
  });
  res.json({ visits: result });
});

// DEBUG: show all visits and users (open /api/visits/debug in browser)
router.get('/debug', (req, res) => {
  const db = getDb();
  const visits = db.prepare('SELECT id, user_id, doc_id, status, sym, doc_name, created_at FROM visits ORDER BY created_at DESC').all();
  const users = db.prepare('SELECT id, email, role, first_name FROM users').all();
  res.json({ visits, users });
});

// POST /api/visits — patient creates a booking request
router.post('/', authMiddleware, (req, res) => {
  try {
    const db = getDb();
    const { docId, docName, docImg, docSpec, sym, date, time, address, paymentMethod, price } = req.body;
    const id = 'V' + Date.now().toString(36) + uuid().split('-')[0];
    const now = Date.now();

    // Ensure paymentMethod is a string (frontend may send object)
    const payStr = typeof paymentMethod === 'object' ? JSON.stringify(paymentMethod) : (paymentMethod || '');

    console.log(`\n📋 ═══ NEW BOOKING ═══`);
    console.log(`   Patient ID: ${req.user.id}`);
    console.log(`   Doctor ID:  ${docId}`);
    console.log(`   DocName:    ${docName}`);
    console.log(`   Symptoms:   ${sym}`);
    console.log(`   Date:       ${date} ${time||''}`);
    console.log(`   Visit ID:   ${id}`);

    // Get patient info
    const patient = db.prepare('SELECT first_name, last_name FROM users WHERE id = ?').get(req.user.id);
    const patientName = patient ? (patient.first_name + ' ' + (patient.last_name || '')).trim() : 'Patient';

    db.prepare(`
      INSERT INTO visits (id, user_id, doc_id, doc_name, doc_img, doc_spec, status, sym, date, time, address, payment_method, price, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(id, req.user.id, docId || null, docName || '', docImg || '', docSpec || '', sym || '', date || '', time || '', address || '', payStr, price || 0, now, now);

    console.log(`   ✓ Visit saved to DB`);

    // Verify it was saved
    const visit = db.prepare('SELECT * FROM visits WHERE id = ?').get(id);
    console.log(`   ✓ Visit verified: doc_id=${visit?.doc_id}, status=${visit?.status}`);

    // Create notification for the doctor
    if (docId) {
      const notifId = 'n' + Date.now().toString(36);
      db.prepare('INSERT INTO notifications (id, user_id, message, read, created_at) VALUES (?, ?, ?, 0, ?)')
        .run(notifId, docId, `New booking request from ${patientName}: ${sym || 'General visit'}`, now);
      console.log(`   ✓ Notification created for doctor ${docId}`);
    }

    // Broadcast to doctor via WebSocket
    const broadcast = req.app.get('broadcastToUser');
    console.log(`   Broadcast function: ${broadcast ? 'YES' : 'NO'}`);
    if (broadcast && docId) {
      broadcast(docId, {
        type: 'booking_request',
        visit: { ...formatVisit(visit), patientName },
      });
    }
    console.log(`📋 ═══ BOOKING COMPLETE ═══\n`);

    res.status(201).json({ visit: formatVisit(visit) });
  } catch(err) {
    console.error('❌ BOOKING ERROR:', err);
    res.status(500).json({ error: 'Failed to create booking: ' + err.message });
  }
});

// PUT /api/visits/:id — update visit
router.put('/:id', authMiddleware, (req, res) => {
  const db = getDb();
  // Allow both patient (owner) and doctor (assigned) to update
  const visit = db.prepare('SELECT * FROM visits WHERE id = ? AND (user_id = ? OR doc_id = ?)').get(req.params.id, req.user.id, req.user.id);
  if (!visit) return res.status(404).json({ error: 'Visit not found' });

  const { status, rating, reviewText, summary } = req.body;
  const now = Date.now();

  if (status) db.prepare('UPDATE visits SET status = ?, updated_at = ? WHERE id = ?').run(status, now, req.params.id);
  if (rating !== undefined) {
    db.prepare('UPDATE visits SET rating = ?, review_text = ?, updated_at = ? WHERE id = ?').run(rating, reviewText || '', now, req.params.id);
    // Update doctor's average rating
    if (visit.doc_id) {
      const stats = db.prepare("SELECT AVG(rating) as avg, COUNT(*) as cnt FROM visits WHERE doc_id = ? AND rating > 0").get(visit.doc_id);
      if (stats && stats.cnt > 0) {
        db.prepare('UPDATE users SET rating = ?, review_count = ?, updated_at = ? WHERE id = ?')
          .run(Math.round(stats.avg * 10) / 10, stats.cnt, now, visit.doc_id);
      }
    }
  }
  if (summary) db.prepare('UPDATE visits SET summary = ?, updated_at = ? WHERE id = ?').run(JSON.stringify(summary), now, req.params.id);

  const updated = db.prepare('SELECT * FROM visits WHERE id = ?').get(req.params.id);
  res.json({ visit: formatVisit(updated) });
});

// POST /api/visits/:id/accept — doctor accepts booking
router.post('/:id/accept', authMiddleware, (req, res) => {
  const db = getDb();
  if (req.user.role !== 'doctor') return res.status(403).json({ error: 'Not a doctor' });

  const visit = db.prepare("SELECT * FROM visits WHERE id = ? AND doc_id = ? AND status = 'pending'").get(req.params.id, req.user.id);
  if (!visit) return res.status(404).json({ error: 'Visit not found or already handled' });

  const now = Date.now();
  db.prepare("UPDATE visits SET status = 'upcoming', updated_at = ? WHERE id = ?").run(now, req.params.id);
  console.log(`✅ Doctor ${req.user.id} ACCEPTED visit ${req.params.id} for patient ${visit.user_id}`);

  // Get doctor name
  const doc = db.prepare('SELECT first_name, last_name FROM users WHERE id = ?').get(req.user.id);
  const docName = doc ? 'Dr. ' + doc.first_name + ' ' + (doc.last_name || '') : visit.doc_name;

  // Notify patient
  const notifId = 'n' + Date.now().toString(36);
  db.prepare('INSERT INTO notifications (id, user_id, message, read, created_at) VALUES (?, ?, ?, 0, ?)')
    .run(notifId, visit.user_id, `${docName.trim()} accepted your booking!`, now);

  // Broadcast to patient via WebSocket
  const broadcast = req.app.get('broadcastToUser');
  if (broadcast) {
    broadcast(visit.user_id, {
      type: 'booking_accepted',
      visitId: req.params.id,
      docName: docName.trim(),
    });
  }

  const updated = db.prepare('SELECT * FROM visits WHERE id = ?').get(req.params.id);
  res.json({ visit: formatVisit(updated) });
});

// POST /api/visits/:id/decline — doctor declines booking
router.post('/:id/decline', authMiddleware, (req, res) => {
  const db = getDb();
  if (req.user.role !== 'doctor') return res.status(403).json({ error: 'Not a doctor' });

  const visit = db.prepare("SELECT * FROM visits WHERE id = ? AND doc_id = ? AND status = 'pending'").get(req.params.id, req.user.id);
  if (!visit) return res.status(404).json({ error: 'Visit not found or already handled' });

  const now = Date.now();
  const reason = req.body.reason || '';
  db.prepare("UPDATE visits SET status = 'cancelled', updated_at = ? WHERE id = ?").run(now, req.params.id);

  const doc = db.prepare('SELECT first_name, last_name FROM users WHERE id = ?').get(req.user.id);
  const docName = doc ? 'Dr. ' + doc.first_name + ' ' + (doc.last_name || '') : visit.doc_name;

  // Notify patient
  const notifId = 'n' + Date.now().toString(36);
  const msg = reason
    ? `${docName.trim()} declined your booking: "${reason}"`
    : `${docName.trim()} is unavailable. Please try another doctor.`;
  db.prepare('INSERT INTO notifications (id, user_id, message, read, created_at) VALUES (?, ?, ?, 0, ?)')
    .run(notifId, visit.user_id, msg, now);

  // Broadcast to patient
  const broadcast = req.app.get('broadcastToUser');
  if (broadcast) {
    broadcast(visit.user_id, {
      type: 'booking_declined',
      visitId: req.params.id,
      docName: docName.trim(),
      reason,
    });
  }

  const updated = db.prepare('SELECT * FROM visits WHERE id = ?').get(req.params.id);
  res.json({ visit: formatVisit(updated) });
});

// DELETE /api/visits/:id — cancel a visit with tiered policy
router.delete('/:id', authMiddleware, (req, res) => {
  const db = getDb();
  const visit = db.prepare('SELECT * FROM visits WHERE id = ? AND (user_id = ? OR doc_id = ?)').get(req.params.id, req.user.id, req.user.id);
  if (!visit) return res.status(404).json({ error: 'Visit not found' });

  const isDoctor = req.user.role === 'doctor' || req.user.id === visit.doc_id;
  const isPatient = req.user.id === visit.user_id;
  let refundType = 'full'; // full | commission | none
  let cancelMessage = '';

  // PENDING visits — always free cancel for both parties
  if (visit.status === 'pending') {
    refundType = 'full';
    cancelMessage = 'Bekleyen randevu ücretsiz iptal edildi.';
  }
  // UPCOMING (doctor accepted) — tiered policy
  else if (visit.status === 'upcoming' && visit.date && visit.time) {
    const dateStr = visit.date.includes(' ') ? visit.date.split(' ')[0] : visit.date;
    const timeStr = visit.time || '00:00';
    const apptTime = new Date(dateStr + 'T' + timeStr + ':00').getTime();
    const now = Date.now();
    const hoursLeft = (apptTime - now) / (1000 * 60 * 60);

    if (isDoctor) {
      // Doctors must cancel 24h+ before
      if (hoursLeft < 24 && hoursLeft > 0) {
        return res.status(400).json({
          error: `Doktorlar randevudan en az 24 saat önce iptal edebilir (${Math.round(hoursLeft)} saat kaldı).`,
          hoursLeft: Math.round(hoursLeft), policy: 'doctor_24h'
        });
      }
      refundType = 'full';
      cancelMessage = 'Doktor randevuyu iptal etti. Tam iade yapılacaktır.';
      // Increment doctor cancel count
      db.prepare('UPDATE users SET cancelled_count = COALESCE(cancelled_count,0) + 1 WHERE id = ?').run(visit.doc_id);
    } else if (isPatient) {
      // Patient tiered policy (Hukuki Analiz uyumlu)
      if (hoursLeft > 12) {
        refundType = 'full';
        cancelMessage = 'Randevu 12 saatten fazla kaldığı için tam iade yapılacaktır.';
      } else if (hoursLeft > 5) {
        refundType = 'commission';
        cancelMessage = `Randevuya 12 saatten az kaldığı için platform komisyonu (%20) kesilecek, kalan tutar iade edilecektir.`;
      } else if (hoursLeft > 0) {
        refundType = 'none';
        cancelMessage = 'Randevuya 5 saatten az kaldığı için iade yapılamaz. Tam ücret tahsil edilecektir.';
      } else {
        refundType = 'none';
        cancelMessage = 'Randevu saati geçtiği için iade yapılamaz.';
      }
    }
  }
  // Already active/completed
  else if (visit.status === 'active' || visit.status === 'completed') {
    return res.status(400).json({ error: 'Aktif veya tamamlanmış randevular iptal edilemez.' });
  }

  const now = Date.now();
  db.prepare("UPDATE visits SET status = 'cancelled', updated_at = ? WHERE id = ?").run(now, req.params.id);

  // Handle refund based on policy
  const payment = db.prepare("SELECT * FROM payments WHERE visit_id = ? AND status IN ('provisioned','captured')").get(req.params.id);
  let refundAmount = 0;
  if (payment) {
    const commRate = 0.20;
    if (refundType === 'full') {
      refundAmount = payment.amount;
    } else if (refundType === 'commission') {
      refundAmount = Math.round(payment.amount * (1 - commRate) * 100) / 100;
    }
    // else refundType === 'none' → no refund
    if (refundAmount > 0) {
      db.prepare("UPDATE payments SET status = 'refunded', refund_amount = ?, refund_reason = ?, updated_at = ? WHERE id = ?")
        .run(refundAmount, cancelMessage, now, payment.id);
      db.prepare("UPDATE visits SET payment_status = 'refunded', updated_at = ? WHERE id = ?").run(now, req.params.id);
    } else if (refundType === 'none') {
      // Payment stays captured — no refund
      db.prepare("UPDATE visits SET payment_status = 'no_refund', updated_at = ? WHERE id = ?").run(now, req.params.id);
    }
  }

  // Notify the other party
  const broadcast = req.app.get('broadcastToUser');
  const notifTarget = req.user.id === visit.user_id ? visit.doc_id : visit.user_id;
  const cancellerName = isDoctor ? 'Doktor' : 'Hasta';
  if (notifTarget) {
    const notifId = 'n' + Date.now().toString(36);
    db.prepare('INSERT INTO notifications (id, user_id, message, read, created_at) VALUES (?, ?, ?, 0, ?)')
      .run(notifId, notifTarget, `${cancellerName} ${visit.date} tarihli randevuyu iptal etti.`, now);
    if (broadcast) broadcast(notifTarget, { type: 'booking_declined', visitId: req.params.id });
  }

  res.json({ success: true, refundType, refundAmount, cancelMessage });
});

function formatVisit(v) {
  let summary = null;
  try { summary = v.summary ? JSON.parse(v.summary) : null; } catch { summary = v.summary; }
  return {
    id: v.id, userId: v.user_id, docId: v.doc_id,
    docName: v.doc_name, docImg: v.doc_img, docSpec: v.doc_spec,
    status: v.status, sym: v.sym, date: v.date, time: v.time,
    address: v.address, paymentMethod: v.payment_method,
    price: v.price, rating: v.rating, reviewText: v.review_text,
    summary, ts: v.created_at, createdAt: v.created_at, updatedAt: v.updated_at,
    patientName: v.patient_name || '',
  };
}

// ═══ CHAT MESSAGES ═══
// POST /api/visits/:id/chat — Send a chat message
router.post('/:id/chat', authMiddleware, (req, res) => {
  const db = getDb();
  const { message } = req.body;
  if (!message?.trim()) return res.status(400).json({ error: 'Message required' });
  const visit = db.prepare('SELECT * FROM visits WHERE id = ? AND (user_id = ? OR doc_id = ?)').get(req.params.id, req.user.id, req.user.id);
  if (!visit) return res.status(404).json({ error: 'Visit not found' });
  const id = 'MSG' + Date.now().toString(36) + Math.random().toString(36).slice(2,5);
  const now = Date.now();
  db.prepare('INSERT INTO chat_messages (id,visit_id,sender_id,sender_role,message,created_at) VALUES (?,?,?,?,?,?)')
    .run(id, req.params.id, req.user.id, req.user.role, message.trim(), now);
  // Real-time broadcast to other party
  const broadcast = req.app.get('broadcastToUser');
  const target = req.user.id === visit.user_id ? visit.doc_id : visit.user_id;
  if (broadcast && target) broadcast(target, { type:'chat_message', visitId:req.params.id, message:{id,senderId:req.user.id,senderRole:req.user.role,message:message.trim(),createdAt:now} });
  res.json({ success:true, messageId:id });
});

// GET /api/visits/:id/chat — Get chat messages
router.get('/:id/chat', authMiddleware, (req, res) => {
  const db = getDb();
  const visit = db.prepare('SELECT * FROM visits WHERE id = ? AND (user_id = ? OR doc_id = ?)').get(req.params.id, req.user.id, req.user.id);
  if (!visit) return res.status(404).json({ error: 'Visit not found' });
  const messages = db.prepare('SELECT * FROM chat_messages WHERE visit_id = ? ORDER BY created_at ASC').all(req.params.id);
  res.json({ messages: messages.map(m=>({id:m.id,senderId:m.sender_id,senderRole:m.sender_role,message:m.message,read:m.read,createdAt:m.created_at})) });
});

// POST /api/visits/:id/suggest-next — Doctor suggests next appointment
router.post('/:id/suggest-next', authMiddleware, (req, res) => {
  const db = getDb();
  if (req.user.role !== 'doctor') return res.status(403).json({ error: 'Only doctors can suggest' });
  const { suggestedDate, suggestedTime, reason } = req.body;
  const visit = db.prepare('SELECT * FROM visits WHERE id = ? AND doc_id = ?').get(req.params.id, req.user.id);
  if (!visit) return res.status(404).json({ error: 'Visit not found' });
  const now = Date.now();
  // Create a pending suggestion visit
  const newId = 'V' + Date.now().toString(36).toUpperCase() + Math.random().toString(36).slice(2,5);
  db.prepare(`INSERT INTO visits (id,user_id,doc_id,doc_name,doc_img,doc_spec,status,sym,date,time,price,created_at,updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(newId, visit.user_id, req.user.id, visit.doc_name, visit.doc_img, visit.doc_spec, 'suggested', reason||'Takip muayenesi', suggestedDate||'', suggestedTime||'', visit.price||0, now, now);
  // Notify patient
  const broadcast = req.app.get('broadcastToUser');
  const notifId = 'n' + Date.now().toString(36);
  db.prepare('INSERT INTO notifications (id,user_id,message,read,created_at) VALUES (?,?,?,0,?)')
    .run(notifId, visit.user_id, `Dr. ${visit.doc_name} size ${suggestedDate} tarihinde takip randevusu öneriyor.`, now);
  if (broadcast) broadcast(visit.user_id, { type:'next_visit_suggested', visitId:newId, suggestedDate, suggestedTime, reason });
  res.json({ success:true, suggestedVisitId:newId });
});

module.exports = router;
