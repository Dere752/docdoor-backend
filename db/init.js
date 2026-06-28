const initSqlJs = require('sql.js');
const fs = require('fs');
const path = require('path');
const bcrypt = require('bcryptjs');

const DB_PATH = path.join(__dirname, '..', 'docdoor.db');
let db = null;
let dbReady = null;

function save() {
  if (!db || !db._raw) return;
  try {
    const data = db._raw.export();
    fs.writeFileSync(DB_PATH, Buffer.from(data));
  } catch(e) { console.error('DB save error:', e); }
}

function createWrapper(raw) {
  const w = {
    _raw: raw,
    prepare(sql) {
      return {
        run(...params) { raw.run(sql, params); save(); },
        get(...params) {
          const stmt = raw.prepare(sql);
          if (params.length) stmt.bind(params);
          if (stmt.step()) {
            const cols = stmt.getColumnNames();
            const vals = stmt.get();
            stmt.free();
            const row = {};
            cols.forEach((c, i) => row[c] = vals[i]);
            return row;
          }
          stmt.free();
          return undefined;
        },
        all(...params) {
          const results = [];
          const stmt = raw.prepare(sql);
          if (params.length) stmt.bind(params);
          while (stmt.step()) {
            const cols = stmt.getColumnNames();
            const vals = stmt.get();
            const row = {};
            cols.forEach((c, i) => row[c] = vals[i]);
            results.push(row);
          }
          stmt.free();
          return results;
        }
      };
    },
    exec(sql) { raw.exec(sql); save(); },
    transaction(fn) {
      return () => {
        raw.run('BEGIN');
        try { fn(); raw.run('COMMIT'); save(); }
        catch(e) { raw.run('ROLLBACK'); throw e; }
      };
    }
  };
  return w;
}

async function initDb() {
  if (db) return db;
  const SQL = await initSqlJs();
  let raw;
  if (fs.existsSync(DB_PATH)) {
    raw = new SQL.Database(fs.readFileSync(DB_PATH));
  } else {
    raw = new SQL.Database();
  }
  db = createWrapper(raw);
  initTables();
  setInterval(save, 5000);
  return db;
}

function getDb() {
  if (!db) throw new Error('DB not ready');
  return db;
}
function waitForDb() {
  if (!dbReady) dbReady = initDb();
  return dbReady;
}

function initTables() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY, email TEXT UNIQUE NOT NULL, password_hash TEXT NOT NULL,
      role TEXT DEFAULT 'patient', first_name TEXT NOT NULL, last_name TEXT DEFAULT '',
      phone TEXT DEFAULT '', address TEXT DEFAULT '', specialty TEXT DEFAULT '',
      license_number TEXT DEFAULT '', blood_type TEXT DEFAULT '', allergies TEXT DEFAULT '',
      medical_history TEXT DEFAULT '', insurance_provider TEXT DEFAULT '',
      insurance_policy TEXT DEFAULT '', tc_kimlik TEXT DEFAULT '',
      price REAL DEFAULT 150, bio TEXT DEFAULT '', education TEXT DEFAULT '',
      img TEXT DEFAULT '', langs TEXT DEFAULT '["English"]',
      rating REAL DEFAULT 5.0, review_count INTEGER DEFAULT 0, reviews TEXT DEFAULT '[]',
      eta INTEGER DEFAULT 20, next_available TEXT DEFAULT '',
      is_blocked INTEGER DEFAULT 0, block_reason TEXT DEFAULT '',
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS visits (
      id TEXT PRIMARY KEY, user_id TEXT NOT NULL, doc_id TEXT, doc_name TEXT,
      doc_img TEXT, doc_spec TEXT, status TEXT DEFAULT 'pending', sym TEXT DEFAULT '',
      date TEXT DEFAULT '', time TEXT DEFAULT '', address TEXT DEFAULT '',
      payment_method TEXT DEFAULT '', price REAL DEFAULT 0, rating INTEGER,
      review_text TEXT DEFAULT '', summary TEXT DEFAULT '',
      payment_status TEXT DEFAULT 'none', payment_id TEXT DEFAULT '',
      insurance_claim_id TEXT DEFAULT '',
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS medications (
      id TEXT PRIMARY KEY, user_id TEXT NOT NULL, name TEXT NOT NULL,
      dosage TEXT DEFAULT '', frequency TEXT DEFAULT 'Once daily',
      time TEXT DEFAULT '', days TEXT DEFAULT '[]',
      active INTEGER DEFAULT 1, created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS favorites (
      user_id TEXT NOT NULL, doc_id TEXT NOT NULL, created_at INTEGER NOT NULL,
      PRIMARY KEY (user_id, doc_id)
    );
    CREATE TABLE IF NOT EXISTS emergency_contacts (
      id TEXT PRIMARY KEY, user_id TEXT NOT NULL, name TEXT NOT NULL,
      phone TEXT NOT NULL, relation TEXT DEFAULT '', created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS notifications (
      id TEXT PRIMARY KEY, user_id TEXT NOT NULL, message TEXT NOT NULL,
      read INTEGER DEFAULT 0, created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS saved_cards (
      id TEXT PRIMARY KEY, user_id TEXT NOT NULL, last4 TEXT NOT NULL,
      holder TEXT DEFAULT '', brand TEXT DEFAULT 'Visa', exp TEXT DEFAULT '',
      is_default INTEGER DEFAULT 0, token TEXT DEFAULT '', created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS payments (
      id TEXT PRIMARY KEY, visit_id TEXT NOT NULL, user_id TEXT NOT NULL,
      doc_id TEXT DEFAULT '', amount REAL NOT NULL, currency TEXT DEFAULT 'TRY',
      status TEXT DEFAULT 'pending', type TEXT DEFAULT 'provision',
      payment_method TEXT DEFAULT 'card', card_last4 TEXT DEFAULT '', card_brand TEXT DEFAULT '',
      gateway TEXT DEFAULT 'iyzico', gateway_payment_id TEXT DEFAULT '',
      provision_token TEXT DEFAULT '', commission_rate REAL DEFAULT 0.20,
      commission_amount REAL DEFAULT 0, doctor_payout REAL DEFAULT 0,
      refund_amount REAL DEFAULT 0, refund_reason TEXT DEFAULT '',
      error_message TEXT DEFAULT '', ip_address TEXT DEFAULT '',
      metadata TEXT DEFAULT '{}',
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_pay_visit ON payments(visit_id);
    CREATE INDEX IF NOT EXISTS idx_pay_user ON payments(user_id);
    CREATE TABLE IF NOT EXISTS insurance_records (
      id TEXT PRIMARY KEY, user_id TEXT NOT NULL, tc_kimlik TEXT NOT NULL,
      insurance_type TEXT DEFAULT 'sgk', provider_name TEXT DEFAULT '',
      policy_number TEXT DEFAULT '', coverage_status TEXT DEFAULT 'unknown',
      coverage_details TEXT DEFAULT '{}', verified_at INTEGER DEFAULT 0,
      expires_at INTEGER DEFAULT 0,
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_ins_user ON insurance_records(user_id);
    CREATE TABLE IF NOT EXISTS insurance_claims (
      id TEXT PRIMARY KEY, visit_id TEXT NOT NULL, user_id TEXT NOT NULL,
      insurance_record_id TEXT NOT NULL, claim_amount REAL DEFAULT 0,
      approved_amount REAL DEFAULT 0, patient_copay REAL DEFAULT 0,
      status TEXT DEFAULT 'pending', rejection_reason TEXT DEFAULT '',
      submitted_at INTEGER NOT NULL, processed_at INTEGER DEFAULT 0,
      metadata TEXT DEFAULT '{}'
    );
    CREATE TABLE IF NOT EXISTS admin_users (
      id TEXT PRIMARY KEY, email TEXT UNIQUE NOT NULL, password_hash TEXT NOT NULL,
      name TEXT DEFAULT 'Admin', role TEXT DEFAULT 'super_admin',
      permissions TEXT DEFAULT '["all"]', last_login INTEGER DEFAULT 0,
      is_active INTEGER DEFAULT 1, created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS audit_log (
      id TEXT PRIMARY KEY, actor_id TEXT NOT NULL, actor_type TEXT DEFAULT 'admin',
      action TEXT NOT NULL, target_type TEXT DEFAULT '', target_id TEXT DEFAULT '',
      details TEXT DEFAULT '{}', ip_address TEXT DEFAULT '', created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_audit_time ON audit_log(created_at);
    CREATE TABLE IF NOT EXISTS system_settings (
      key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS doctor_payouts (
      id TEXT PRIMARY KEY, doc_id TEXT NOT NULL, amount REAL NOT NULL,
      currency TEXT DEFAULT 'TRY', status TEXT DEFAULT 'pending',
      payment_ids TEXT DEFAULT '[]', iban TEXT DEFAULT '', bank_name TEXT DEFAULT '',
      processed_at INTEGER DEFAULT 0, created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS complaints (
      id TEXT PRIMARY KEY, user_id TEXT NOT NULL, visit_id TEXT DEFAULT '',
      subject TEXT NOT NULL, message TEXT NOT NULL, status TEXT DEFAULT 'open',
      priority TEXT DEFAULT 'normal', admin_notes TEXT DEFAULT '',
      resolved_at INTEGER DEFAULT 0, created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS chat_messages (
      id TEXT PRIMARY KEY, visit_id TEXT NOT NULL, sender_id TEXT NOT NULL,
      sender_role TEXT DEFAULT 'patient', message TEXT NOT NULL,
      read INTEGER DEFAULT 0, created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_chat_visit ON chat_messages(visit_id);
  `);

  // Auto-migrate columns
  const uc = [
    ['price','REAL DEFAULT 150'],['bio','TEXT DEFAULT ""'],['education','TEXT DEFAULT ""'],
    ['experience','TEXT DEFAULT ""'],['currency','TEXT DEFAULT "USD"'],
    ['img','TEXT DEFAULT ""'],['langs','TEXT DEFAULT \'["English"]\''],
    ['rating','REAL DEFAULT 5.0'],['review_count','INTEGER DEFAULT 0'],['reviews','TEXT DEFAULT "[]"'],
    ['eta','INTEGER DEFAULT 20'],['next_available','TEXT DEFAULT ""'],
    ['tc_kimlik','TEXT DEFAULT ""'],['is_blocked','INTEGER DEFAULT 0'],['block_reason','TEXT DEFAULT ""'],
    // Legal compliance fields (doctor)
    ['work_status','TEXT DEFAULT ""'],['tabip_oda_no','TEXT DEFAULT ""'],['malpraktis_police','TEXT DEFAULT ""'],['firm_name','TEXT DEFAULT ""'],
    // KVKK consent tracking
    ['kvkk_consent','INTEGER DEFAULT 0'],['health_data_consent','INTEGER DEFAULT 0'],['kvkk_consent_date','INTEGER DEFAULT 0'],
    // Demographics
    ['country','TEXT DEFAULT ""'],['birth_date','TEXT DEFAULT ""'],
    // Doctor stats
    ['cancelled_count','INTEGER DEFAULT 0'],
  ];
  for (const [c,d] of uc) { try { db._raw.run(`ALTER TABLE users ADD COLUMN ${c} ${d}`); } catch(e){} }
  const vc = [['payment_status','TEXT DEFAULT "none"'],['payment_id','TEXT DEFAULT ""'],['insurance_claim_id','TEXT DEFAULT ""']];
  for (const [c,d] of vc) { try { db._raw.run(`ALTER TABLE visits ADD COLUMN ${c} ${d}`); } catch(e){} }
  const cc = [['token','TEXT DEFAULT ""']];
  for (const [c,d] of cc) { try { db._raw.run(`ALTER TABLE saved_cards ADD COLUMN ${c} ${d}`); } catch(e){} }

  try { db._raw.run('DROP TABLE IF EXISTS doctors'); } catch(e){}

  // Seed admin
  const adm = db.prepare('SELECT id FROM admin_users WHERE email = ?').get('admin@docdoor.com');
  if (!adm) {
    db.prepare(`INSERT INTO admin_users (id,email,password_hash,name,role,permissions,created_at) VALUES (?,?,?,?,?,?,?)`)
      .run('ADM001','admin@docdoor.com',bcrypt.hashSync('DocDoor2026!',12),'DocDoor Admin','super_admin','["all"]',Date.now());
    console.log('Default admin: admin@docdoor.com / DocDoor2026!');
  }

  // Seed settings
  const defs = {commission_rate:'0.20',cancellation_hours:'12',min_booking_minutes:'30',max_price:'5000',currency:'TRY',insurance_enabled:'1',payment_gateway:'iyzico',maintenance_mode:'0'};
  for (const [k,v] of Object.entries(defs)) {
    if (!db.prepare('SELECT key FROM system_settings WHERE key = ?').get(k))
      db.prepare('INSERT INTO system_settings (key,value,updated_at) VALUES (?,?,?)').run(k,v,Date.now());
  }

  save();
  console.log('All tables initialized');
}

module.exports = { getDb, waitForDb };
