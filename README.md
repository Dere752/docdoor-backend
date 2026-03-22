# 🩺 DocDoor — Eve Doktor Çağırma Platformu

## Kurulum

```bash
npm install
npm start
```

**Uygulama:** `http://localhost:3001`
**Admin Panel:** `http://localhost:3001/admin`

## Admin Giriş

```
Email: admin@docdoor.com
Şifre: DocDoor2026!
```

> İlk girişte şifrenizi değiştirin: Admin Panel → Ayarlar → Şifre Değiştir

## Ödeme Sistemi (iyzico)
- Randevu onayında ön provizyon → Seans bitince capture
- 12 saat öncesine kadar tam iade, sonrası yok
- `.env`'de IYZICO_API_KEY boşsa mock çalışır

## Sigorta (SGK + Özel)
- TC Kimlik No ile sorgulama
- Karşılama oranı ve copay otomatik hesap
- Mock mod: %80 SGK aktif, çeşitli özel sigortalar

## Admin Panel
- Dashboard, kullanıcı/doktor yönetimi, ödemeler
- Sigorta talepleri, doktor ödemeleri, şikayetler
- Sistem ayarları, denetim logu, şifre değiştirme

## Güvenlik
- Rate limiting, bcrypt, JWT, XSS koruması, audit log
