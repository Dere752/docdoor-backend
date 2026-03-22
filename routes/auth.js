const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { v4: uuid } = require('uuid');
const { getDb } = require('../db/init');
const { authMiddleware } = require('../middleware/auth');

const router = express.Router();

// POST /api/auth/signup
router.post('/signup', async (req, res) => {
  try {
    const db = getDb();
    const { email, password, firstName, lastName, role, specialty, address, licenseNumber, price, bio, education, img, langs, country, birthDate } = req.body;

    if (!email || !password || !firstName) {
      return res.status(400).json({ error: 'Email, password, and first name required' });
    }
    if (password.length < 4) {
      return res.status(400).json({ error: 'Password must be at least 4 characters' });
    }

    const existing = db.prepare('SELECT id FROM users WHERE email = ?').get(email.toLowerCase());
    if (existing) {
      return res.status(409).json({ error: 'Account already exists. Please sign in.' });
    }

    const id = (role === 'doctor' ? 'D' : 'P') + uuid().split('-')[0].toUpperCase();
    const hash = bcrypt.hashSync(password, 10);
    const now = Date.now();

    db.prepare(`
      INSERT INTO users (id, email, password_hash, role, first_name, last_name, specialty, address, license_number, price, bio, education, img, langs, country, birth_date, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(id, email.toLowerCase(), hash, role || 'patient', firstName, lastName || '', specialty || '', address || '', licenseNumber || '', price || 150, bio || '', education || '', img || '', langs ? JSON.stringify(langs) : '["Türkçe"]', country || '', birthDate || '', now, now);

    const token = jwt.sign({ id, email: email.toLowerCase(), role: role || 'patient' }, process.env.JWT_SECRET, { expiresIn: '30d' });

    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(id);
    delete user.password_hash;

    res.status(201).json({ token, user: formatUser(user) });
  } catch (err) {
    console.error('Signup error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// POST /api/auth/login
router.post('/login', async (req, res) => {
  try {
    const db = getDb();
    const { email, password } = req.body;

    if (!email || !password) {
      return res.status(400).json({ error: 'Email and password required' });
    }

    const user = db.prepare('SELECT * FROM users WHERE email = ?').get(email.toLowerCase());
    if (!user) {
      return res.status(404).json({ error: 'Account not found. Please sign up.' });
    }

    if (!bcrypt.compareSync(password, user.password_hash)) {
      return res.status(401).json({ error: 'Incorrect password.' });
    }

    const token = jwt.sign({ id: user.id, email: user.email, role: user.role }, process.env.JWT_SECRET, { expiresIn: '30d' });

    delete user.password_hash;
    res.json({ token, user: formatUser(user) });
  } catch (err) {
    console.error('Login error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// GET /api/auth/me — get current user profile
router.get('/me', authMiddleware, (req, res) => {
  const db = getDb();
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
  if (!user) return res.status(404).json({ error: 'User not found' });
  delete user.password_hash;
  res.json({ user: formatUser(user) });
});

// PUT /api/auth/profile — update profile
router.put('/profile', authMiddleware, (req, res) => {
  const db = getDb();
  const b = req.body;
  const n = (v) => v === undefined ? null : v; // sql.js needs null, not undefined
  const price = b.price !== undefined ? parseFloat(b.price) : null;
  const now = Date.now();

  db.prepare(`
    UPDATE users SET
      first_name = COALESCE(?, first_name),
      last_name = COALESCE(?, last_name),
      phone = COALESCE(?, phone),
      address = COALESCE(?, address),
      blood_type = COALESCE(?, blood_type),
      allergies = COALESCE(?, allergies),
      medical_history = COALESCE(?, medical_history),
      insurance_provider = COALESCE(?, insurance_provider),
      insurance_policy = COALESCE(?, insurance_policy),
      specialty = COALESCE(?, specialty),
      price = COALESCE(?, price),
      bio = COALESCE(?, bio),
      education = COALESCE(?, education),
      experience = COALESCE(?, experience),
      currency = COALESCE(?, currency),
      img = COALESCE(?, img),
      langs = COALESCE(?, langs),
      eta = COALESCE(?, eta),
      next_available = COALESCE(?, next_available),
      country = COALESCE(?, country),
      birth_date = COALESCE(?, birth_date),
      updated_at = ?
    WHERE id = ?
  `).run(n(b.firstName), n(b.lastName), n(b.phone), n(b.address), n(b.bloodType), n(b.allergies), n(b.medicalHistory), n(b.insuranceProvider), n(b.insurancePolicy), n(b.specialty), price, n(b.bio), n(b.education), n(b.experience), n(b.currency), n(b.img), b.langs ? JSON.stringify(b.langs) : null, n(b.eta), n(b.nextAvailable), n(b.country), n(b.birthDate), now, req.user.id);

  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
  delete user.password_hash;
  res.json({ user: formatUser(user) });
});

function formatUser(u) {
  return {
    id: u.id, email: u.email, role: u.role,
    firstName: u.first_name, lastName: u.last_name,
    phone: u.phone, address: u.address,
    specialty: u.specialty, licenseNumber: u.license_number,
    bloodType: u.blood_type, allergies: u.allergies,
    medicalHistory: u.medical_history,
    insuranceProvider: u.insurance_provider,
    insurancePolicy: u.insurance_policy,
    price: u.price, bio: u.bio, education: u.education,
    experience: u.experience || '',
    currency: u.currency || 'TRY',
    country: u.country || '', birthDate: u.birth_date || '',
    cancelledCount: u.cancelled_count || 0,
    img: u.img, langs: JSON.parse(u.langs || '["Türkçe"]'),
    rating: u.rating, reviewCount: u.review_count,
    reviews: JSON.parse(u.reviews || '[]'),
    eta: u.eta, nextAvailable: u.next_available,
    createdAt: u.created_at,
  };
}

// ═══ KVKK: VERİ SİLME HAKKI (m.11/1-e) ═══
// Kullanıcının tüm kişisel verilerinin silinmesini talep etme hakkı
router.delete('/account', authMiddleware, (req, res) => {
  try {
    const db = getDb();
    const userId = req.user.id;
    // Aktif ziyaret kontrolü
    const activeVisit = db.prepare("SELECT id FROM visits WHERE user_id = ? AND status IN ('pending','upcoming','active')").get(userId);
    if (activeVisit) return res.status(400).json({ error: 'Aktif randevunuz var. Önce iptal edin.' });
    // Tüm kişisel verileri sil
    db.prepare('DELETE FROM insurance_records WHERE user_id = ?').run(userId);
    db.prepare('DELETE FROM insurance_claims WHERE user_id = ?').run(userId);
    db.prepare('DELETE FROM saved_cards WHERE user_id = ?').run(userId);
    db.prepare('DELETE FROM medications WHERE user_id = ?').run(userId);
    db.prepare('DELETE FROM favorites WHERE user_id = ?').run(userId);
    db.prepare('DELETE FROM emergency_contacts WHERE user_id = ?').run(userId);
    db.prepare('DELETE FROM notifications WHERE user_id = ?').run(userId);
    db.prepare('DELETE FROM complaints WHERE user_id = ?').run(userId);
    // Ziyaret verilerini anonimleştir (yasal saklama zorunluluğu)
    db.prepare("UPDATE visits SET user_id = 'DELETED', address = '', sym = '' WHERE user_id = ?").run(userId);
    db.prepare("UPDATE payments SET user_id = 'DELETED', card_last4 = '****', ip_address = '' WHERE user_id = ?").run(userId);
    // Kullanıcıyı sil
    db.prepare('DELETE FROM users WHERE id = ?').run(userId);
    res.json({ success: true, message: 'KVKK m.11 kapsamında tüm kişisel verileriniz silinmiştir.' });
  } catch(err) {
    console.error('Account deletion error:', err);
    res.status(500).json({ error: 'Hesap silme hatası' });
  }
});

// ═══ YASAL METİNLER ═══
router.get('/legal/kvkk', (req, res) => {
  res.json({ title: 'KVKK Aydınlatma Metni', text: `
KİŞİSEL VERİLERİN İŞLENMESİNE İLİŞKİN AYDINLATMA METNİ

Veri Sorumlusu: DocDoor Teknoloji Ltd. Şti.

6698 sayılı Kişisel Verilerin Korunması Kanunu ("KVKK") kapsamında, kişisel verileriniz aşağıda açıklanan amaçlarla ve hukuki sebeplerle işlenmektedir:

1. İŞLENEN VERİLER
- Kimlik bilgileri (ad, soyad, TC Kimlik No)
- İletişim bilgileri (e-posta, telefon, adres)
- Sağlık verileri (semptomlar, muayene notları, reçeteler) — ÖZEL NİTELİKLİ
- Ödeme bilgileri (kart son 4 hane, ödeme geçmişi)
- Konum verileri (GPS — yalnızca randevu için)

2. İŞLEME AMAÇLARI
- Doktor-hasta eşleştirmesi ve randevu yönetimi
- Ödeme işlemlerinin gerçekleştirilmesi
- Sigorta provizyon sorgulaması (yalnızca özel sigorta)
- Yasal yükümlülüklerin yerine getirilmesi

3. AKTARIM
Kişisel verileriniz: hizmet veren doktor (muayene için gerekli olanlar), ödeme kuruluşu (iyzico — ödeme işlemi), sigorta şirketi (provizyon) ve yasal zorunluluk halinde kamu kurumlarına aktarılabilir.

4. SAKLAMA SÜRESİ
- Sağlık verileri: 20 yıl (1219 s.K. gereği)
- Ödeme verileri: 10 yıl (VUK gereği)
- Diğer veriler: Hesap açık olduğu süre + 1 yıl

5. HAKLARINIZ (KVKK m.11)
- Verilerinizin işlenip işlenmediğini öğrenme
- İşlenmişse buna ilişkin bilgi talep etme
- Amacına uygun kullanılıp kullanılmadığını öğrenme
- Yurt içinde/dışında aktarıldığı üçüncü kişileri bilme
- Eksik/yanlış işlenmişse düzeltilmesini isteme
- İşlenmesini gerektiren sebeplerin ortadan kalkması halinde SİLİNMESİNİ isteme

Başvuru: kvkk@docdoor.com
` });
});

router.get('/legal/consent', (req, res) => {
  res.json({ title: 'Sağlık Verisi Açık Rızası', text: `
ÖZEL NİTELİKLİ KİŞİSEL VERİ İŞLEME AÇIK RIZASI

6698 sayılı KVKK'nın 6. maddesi kapsamında, sağlık verilerim "özel nitelikli kişisel veri" olup işlenmesi açık rızama bağlıdır.

Bu onay ile:
- Semptomlarım, muayene notlarım, teşhis ve tedavi bilgilerimin platform üzerinden işlenmesine,
- Hizmet veren doktora iletilmesine,
- Sigorta provizyon sorgulaması için sigorta şirketine aktarılmasına,
açık rızam bulunmaktadır.

Bu rızamı her zaman geri çekebileceğimi ve hesabımın silinmesini talep edebileceğimi biliyorum.
` });
});

router.get('/legal/distance-contract', (req, res) => {
  res.json({ title: 'Mesafeli Sözleşme Ön Bilgilendirme', text: `
MESAFELİ SÖZLEŞME ÖN BİLGİLENDİRME FORMU

6502 sayılı Tüketicinin Korunması Hakkında Kanun kapsamında:

SATICI: DocDoor Teknoloji Ltd. Şti. (Aracı Platform)
HİZMET: Evde doktor muayenesi aracılık hizmeti

ÖNEMLİ: DocDoor bir sağlık kuruluşu değil, teknoloji aracısıdır. Tıbbi muayene, doktor tarafından bağımsız yüklenici sıfatıyla verilmektedir. Platform tıbbi sorumluluk taşımaz.

ÖDEME: Randevu onayında ön provizyon alınır, seans tamamlanınca kesinleştirilir.
İPTAL: 12 saat öncesine kadar tam iade. 12 saatten az kaldıysa iade yapılmaz.
CAYMA HAKKI: Hizmet ifasına başlanmış ise cayma hakkı kullanılamaz (6502 s.K. m.15/3-a).

ACİL DURUM: Evde muayene sırasında acil durum oluşursa 112 aranmalıdır. Doktor ilk müdahaleyi yapar.
` });
});

module.exports = router;
