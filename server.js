require('dotenv').config();
const express = require('express');
const cors = require('cors');
const http = require('http');
const { WebSocketServer } = require('ws');
const path = require('path');
const fs = require('fs');
const jwt = require('jsonwebtoken');
const { getDb, waitForDb } = require('./db/init');
const { rateLimit, securityHeaders, sanitizeInput } = require('./middleware/security');

// ═══ COMPILE JSX ═══
function compileJSX() {
  const jsxPath = path.join(__dirname, 'public', 'app.jsx');
  const jsPath = path.join(__dirname, 'public', 'app.js');
  if (fs.existsSync(jsPath) && fs.existsSync(jsxPath)) {
    if (fs.statSync(jsPath).mtimeMs > fs.statSync(jsxPath).mtimeMs) { console.log('app.js up to date'); return; }
  }
  console.log('Compiling app.jsx → app.js ...');
  const babel = require('@babel/core');
  const jsx = fs.readFileSync(jsxPath, 'utf8');
  const result = babel.transformSync(jsx, { presets: [['@babel/preset-react', { runtime: 'classic' }]], filename: 'app.jsx' });
  fs.writeFileSync(jsPath, result.code, 'utf8');
  console.log('Compiled app.js (' + Math.round(result.code.length / 1024) + ' KB)');
}
compileJSX();

const app = express();
const server = http.createServer(app);
const PORT = process.env.PORT || 3001;

// ═══ SECURITY MIDDLEWARE ═══
app.use(securityHeaders);
app.use(cors({ origin: '*', allowedHeaders: ['Content-Type', 'Authorization', 'ngrok-skip-browser-warning'] }));
app.use(express.json({ limit: '10mb' }));
app.use(sanitizeInput);

// API rate limits
app.use('/api/auth/login', rateLimit({ max: 10, windowMs: 900000, prefix: 'login', message: 'Too many login attempts. Try in 15 minutes.' }));
app.use('/api/auth/signup', rateLimit({ max: 5, windowMs: 3600000, prefix: 'signup', message: 'Too many signups. Try in 1 hour.' }));
app.use('/api/admin/login', rateLimit({ max: 5, windowMs: 900000, prefix: 'adminlogin', message: 'Too many admin login attempts.' }));
app.use('/api/payment', rateLimit({ max: 20, windowMs: 60000, prefix: 'payment' }));
app.use('/api', rateLimit({ max: 200, windowMs: 60000, prefix: 'api' }));

app.use('/api', (req, res, next) => { res.setHeader('Content-Type', 'application/json'); next(); });

// Serve frontend
app.use(express.static(path.join(__dirname, 'public')));

// ═══ REST ROUTES ═══
app.use('/api/auth', require('./routes/auth'));
app.use('/api/doctors', require('./routes/doctors'));
app.use('/api/visits', require('./routes/visits'));
app.use('/api/meds', require('./routes/meds'));
app.use('/api/favorites', require('./routes/favorites'));
app.use('/api/contacts', require('./routes/contacts'));
app.use('/api/notifications', require('./routes/notifications'));
app.use('/api/ai', require('./routes/ai'));
app.use('/api/schedule', require('./routes/schedule'));
app.use('/api/payment', require('./routes/payment'));
app.use('/api/insurance', require('./routes/insurance'));
app.use('/api/admin', require('./routes/admin'));

// Health check
app.get('/api/health', (req, res) => {
  const db = getDb();
  const userCount = db.prepare('SELECT COUNT(*) as c FROM users').get().c;
  const visitCount = db.prepare('SELECT COUNT(*) as c FROM visits').get().c;
  const paymentCount = db.prepare('SELECT COUNT(*) as c FROM payments').get().c;
  res.json({ status: 'ok', uptime: process.uptime(), users: userCount, visits: visitCount, payments: paymentCount, wsClients: clients.size });
});

// Admin panel served at /admin
app.get('/admin', (req, res) => { res.sendFile(path.join(__dirname, 'public', 'admin.html')); });
app.get('/admin/*', (req, res) => { res.sendFile(path.join(__dirname, 'public', 'admin.html')); });

// SPA fallback
app.get('*', (req, res) => { res.sendFile(path.join(__dirname, 'public', 'index.html')); });

// ═══ WEBSOCKET ═══
const wss = new WebSocketServer({ server, path: '/ws' });
const clients = new Map();

wss.on('connection', (ws, req) => {
  let userId = null, deviceId = null;
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });
  ws.on('message', (raw) => {
    try {
      const msg = JSON.parse(raw.toString());
      if (msg.type === 'auth') {
        try {
          const decoded = jwt.verify(msg.token, process.env.JWT_SECRET);
          userId = decoded.id; deviceId = msg.deviceId || 'unknown';
          if (!clients.has(userId)) clients.set(userId, new Set());
          clients.get(userId).add(ws);
          broadcastToUser(userId, { type: 'presence', deviceCount: clients.get(userId).size });
          ws.send(JSON.stringify({ type: 'auth_ok', deviceCount: clients.get(userId).size }));
        } catch { ws.send(JSON.stringify({ type: 'auth_error', error: 'Invalid token' })); }
        return;
      }
      if (!userId) { ws.send(JSON.stringify({ type: 'error', error: 'Not authenticated' })); return; }
      if (msg.type === 'sync') {
        const uc = clients.get(userId);
        if (uc) {
          const payload = JSON.stringify({ type:'sync', table:msg.table, action:msg.action, data:msg.data, timestamp:Date.now(), from:deviceId });
          for (const c of uc) { if (c !== ws && c.readyState === 1) c.send(payload); }
        }
      }
      if (msg.type === 'ping') ws.send(JSON.stringify({ type: 'pong', timestamp: Date.now() }));
    } catch(err) { console.error('WS error:', err); }
  });
  ws.on('close', () => {
    if (userId && clients.has(userId)) {
      clients.get(userId).delete(ws);
      if (clients.get(userId).size === 0) clients.delete(userId);
      else broadcastToUser(userId, { type: 'presence', deviceCount: clients.get(userId).size });
    }
  });
  ws.on('error', () => {});
});

function broadcastToUser(userId, data) {
  const uc = clients.get(userId);
  if (!uc) return;
  const payload = JSON.stringify(data);
  for (const c of uc) { if (c.readyState === 1) c.send(payload); }
}

const heartbeat = setInterval(() => { wss.clients.forEach(ws => { if (!ws.isAlive) return ws.terminate(); ws.isAlive = false; ws.ping(); }); }, 30000);
wss.on('close', () => clearInterval(heartbeat));
app.set('broadcastToUser', broadcastToUser);

// ═══ START ═══
waitForDb().then(() => {
  server.listen(PORT, () => {
    console.log(`
╔═══════════════════════════════════════════════════╗
║  DocDoor Backend v2.0                          ║
║                                                   ║
║  App:      http://localhost:${PORT}                 ║
║  Admin:    http://localhost:${PORT}/admin            ║
║  API:      http://localhost:${PORT}/api              ║
║  WS:       ws://localhost:${PORT}/ws                 ║
║                                                   ║
║  Payment:  iyzico (${process.env.IYZICO_API_KEY ? 'LIVE' : 'MOCK'} mode)              ║
║  Insurance: SGK/Private (${process.env.MEDULA_API_KEY ? 'LIVE' : 'MOCK'} mode)          ║
║  Security: Rate limiting + Headers + Sanitization ║
╚═══════════════════════════════════════════════════╝`);
  });
}).catch(err => { console.error('Start failed:', err); process.exit(1); });
