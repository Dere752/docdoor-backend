const express = require('express');
const { v4: uuid } = require('uuid');
const { getDb } = require('../db/init');
const { authMiddleware } = require('../middleware/auth');
const { validateTCKimlik } = require('../utils/validators');
const router = express.Router();

// ═══ YALNIZCA ÖZEL SİGORTA SORGULAMASI ═══
// HUKUK: SGK/Medula yalnızca sözleşmeli sağlık kuruluşlarına açıktır.
// Platform sağlık kuruluşu değildir. SGK sorgulaması yapılamaz.
const MOCK_MODE = !process.env.PRIVATE_INSURANCE_API_KEY;

const providers = {
  'acibadem': { name: 'Acıbadem Sigorta', rate: 0.80, max: 1000 },
  'axa':      { name: 'AXA Sigorta',      rate: 0.75, max: 800 },
  'allianz':  { name: 'Allianz Sigorta',   rate: 0.85, max: 1200 },
  'mapfre':   { name: 'Mapfre Sigorta',    rate: 0.70, max: 700 },
  'groupama': { name: 'Groupama Sigorta',  rate: 0.75, max: 900 },
  'sompo':    { name: 'Sompo Sigorta',     rate: 0.70, max: 750 },
  'zurich':   { name: 'Zurich Sigorta',    rate: 0.80, max: 950 },
};

async function mockVerify(tc) {
  await new Promise(r => setTimeout(r, 400 + Math.random() * 300));
  const h = tc.split('').reduce((a,c) => a + parseInt(c), 0);
  const keys = Object.keys(providers);
  const idx = h % (keys.length + 3);
  if (idx >= keys.length) return { found: false };
  const k = keys[idx], p = providers[k];
  return { found:true, type:'private', providerName:p.name, providerKey:k, policyNumber:k.toUpperCase().slice(0,3)+'-'+tc.slice(-6), coverageRate:p.rate, maxPerVisit:p.max, status:'active', expiresAt:Date.now()+365*86400000 };
}

router.post('/verify', authMiddleware, async (req, res) => {
  try {
    const db = getDb();
    const { tcKimlik } = req.body;
    if (!tcKimlik) return res.status(400).json({ error: 'TC Kimlik numarası gerekli' });
    if (!validateTCKimlik(tcKimlik)) return res.status(400).json({ error: 'Geçersiz TC Kimlik numarası' });
    db.prepare('UPDATE users SET tc_kimlik = ?, updated_at = ? WHERE id = ?').run(tcKimlik, Date.now(), req.user.id);
    const result = await mockVerify(tcKimlik);
    const records = [], now = Date.now();
    db.prepare('DELETE FROM insurance_records WHERE user_id = ?').run(req.user.id);
    if (result.found) {
      const id = 'INS_PVT_' + uuid().split('-')[0];
      db.prepare(`INSERT INTO insurance_records (id,user_id,tc_kimlik,insurance_type,provider_name,policy_number,coverage_status,coverage_details,verified_at,expires_at,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`)
        .run(id, req.user.id, tcKimlik, 'private', result.providerName, result.policyNumber, 'active', JSON.stringify(result), now, result.expiresAt, now, now);
      records.push({ id, type:'private', ...result });
    }
    res.json({ tcKimlik:tcKimlik.slice(0,3)+'*****'+tcKimlik.slice(-3), records, mock:MOCK_MODE,
      legalNote:'Bu sorgulama yalnızca özel sağlık sigortalarını kapsar. SGK sorgulaması yasal gereklilikler nedeniyle yapılamamaktadır.',
      message: records.length > 0 ? `${records.length} özel sigorta kaydı bulundu.` : 'Aktif özel sigorta bulunamadı. Ödeme tamamen hastaya aittir.' });
  } catch(err) { console.error('Insurance verify error:', err); res.status(500).json({ error: 'Sigorta sorgulama hatası' }); }
});

router.post('/claim', authMiddleware, async (req, res) => {
  try {
    const db = getDb();
    const { visitId, insuranceRecordId } = req.body;
    if (!visitId || !insuranceRecordId) return res.status(400).json({ error: 'visitId ve insuranceRecordId gerekli' });
    const visit = db.prepare('SELECT * FROM visits WHERE id = ? AND user_id = ?').get(visitId, req.user.id);
    if (!visit) return res.status(404).json({ error: 'Ziyaret bulunamadı' });
    const ins = db.prepare("SELECT * FROM insurance_records WHERE id = ? AND user_id = ? AND coverage_status = 'active'").get(insuranceRecordId, req.user.id);
    if (!ins) return res.status(404).json({ error: 'Aktif sigorta kaydı bulunamadı' });
    const cov = JSON.parse(ins.coverage_details || '{}');
    const covered = Math.min(Math.round(visit.price * (cov.coverageRate||0) * 100) / 100, cov.maxPerVisit||0);
    const copay = Math.round((visit.price - covered) * 100) / 100;
    const claimId = 'CLM_' + Date.now().toString(36).toUpperCase();
    const now = Date.now();
    db.prepare(`INSERT INTO insurance_claims (id,visit_id,user_id,insurance_record_id,claim_amount,approved_amount,patient_copay,status,submitted_at,processed_at,metadata) VALUES (?,?,?,?,?,?,?,?,?,?,?)`)
      .run(claimId, visitId, req.user.id, insuranceRecordId, visit.price, covered, copay, 'approved', now, now, JSON.stringify({provider:ins.provider_name,policy:ins.policy_number}));
    db.prepare('UPDATE visits SET insurance_claim_id = ?, updated_at = ? WHERE id = ?').run(claimId, now, visitId);
    res.json({ claimId, visitPrice:visit.price, coveredAmount:covered, patientCopay:copay, provider:ins.provider_name, status:'approved', mock:MOCK_MODE,
      message:`${ins.provider_name}: ₺${covered.toFixed(2)} karşılanacak. Hastanın ödemesi: ₺${copay.toFixed(2)}` });
  } catch(err) { console.error('Insurance claim error:', err); res.status(500).json({ error: 'Sigorta talep hatası' }); }
});

router.get('/records', authMiddleware, (req, res) => {
  const db = getDb();
  const records = db.prepare('SELECT * FROM insurance_records WHERE user_id = ? ORDER BY created_at DESC').all(req.user.id);
  res.json({ records: records.map(r => ({ id:r.id, type:r.insurance_type, provider:r.provider_name, policy:r.policy_number, status:r.coverage_status, coverage:JSON.parse(r.coverage_details||'{}'), verifiedAt:r.verified_at, expiresAt:r.expires_at }))});
});

module.exports = router;
