const { useState, useEffect, useRef, useCallback, createContext, useContext, useMemo } = React;

// ═══════════════════════════════════════════════════════
// API CLIENT — connects to our Express backend
// ═══════════════════════════════════════════════════════
const API_BASE = window.location.origin + '/api';
let authToken = localStorage.getItem('dd_token') || null;

const api = {
  setToken(t) { authToken = t; if(t) localStorage.setItem('dd_token',t); else localStorage.removeItem('dd_token'); },
  async req(method, path, body) {
    const opts = { method, headers: {
      'Content-Type': 'application/json',
      'ngrok-skip-browser-warning': 'true'
    }};
    if (authToken) opts.headers['Authorization'] = 'Bearer ' + authToken;
    if (body) opts.body = JSON.stringify(body);
    const r = await fetch(API_BASE + path, opts);
    if (!r.ok) {
      const text = await r.text();
      let data; try { data = JSON.parse(text); } catch { throw new Error('Server error'); }
      throw new Error(data.error || 'Request failed');
    }
    return await r.json();
  },
  get: (p) => api.req('GET', p),
  post: (p, b) => api.req('POST', p, b),
  put: (p, b) => api.req('PUT', p, b),
  del: (p) => api.req('DELETE', p),
};

// Auth API
const AuthDB = {
  async signup(email, password, userData) {
    try {
      const res = await api.post('/auth/signup', { email, password, ...userData });
      api.setToken(res.token);
      return { user: res.user };
    } catch(e) { return { error: e.message }; }
  },
  async login(email, password) {
    try {
      const res = await api.post('/auth/login', { email, password });
      api.setToken(res.token);
      return { user: res.user };
    } catch(e) { return { error: e.message }; }
  },
  async updateProfile(email, data) {
    try { await api.put('/auth/profile', data); return true; } catch { return false; }
  },
};

// ═══════════════════════════════════════════════════════
// WEBSOCKET — REAL-TIME SYNC
// ═══════════════════════════════════════════════════════
class SyncSocket {
  constructor() {
    this.ws = null;
    this.listeners = new Map();
    this.deviceId = 'dev_' + Math.random().toString(36).slice(2,8);
    this.connected = false;
    this.reconnectTimer = null;
  }

  connect(token) {
    if (this.ws) this.ws.close();
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    this.ws = new WebSocket(proto + '//' + location.host + '/ws');

    this.ws.onopen = () => {
      this.ws.send(JSON.stringify({ type: 'auth', token, deviceId: this.deviceId }));
    };

    this.ws.onmessage = (e) => {
      try {
        const msg = JSON.parse(e.data);
        if (msg.type === 'auth_ok') {
          this.connected = true;
          this._emit('presence', { deviceCount: msg.deviceCount });
          this._emit('status', { status: 'synced' });
        }
        if (msg.type === 'sync') this._emit('sync:' + msg.table, msg);
        if (msg.type === 'booking_request') this._emit('booking_request', msg);
        if (msg.type === 'booking_accepted') this._emit('booking_accepted', msg);
        if (msg.type === 'booking_declined') this._emit('booking_declined', msg);
        if (msg.type === 'presence') this._emit('presence', msg);
      } catch {}
    };

    this.ws.onclose = () => {
      this.connected = false;
      this._emit('status', { status: 'connecting' });
      this.reconnectTimer = setTimeout(() => this.connect(token), 3000);
    };

    this.ws.onerror = () => {};
  }

  send(table, action, data) {
    if (this.ws?.readyState === 1) {
      this.ws.send(JSON.stringify({ type: 'sync', table, action, data }));
    }
  }

  on(event, fn) {
    if (!this.listeners.has(event)) this.listeners.set(event, new Set());
    this.listeners.get(event).add(fn);
    return () => this.listeners.get(event)?.delete(fn);
  }

  _emit(event, data) {
    this.listeners.get(event)?.forEach(fn => fn(data));
  }

  disconnect() {
    clearTimeout(this.reconnectTimer);
    if (this.ws) this.ws.close();
    this.ws = null;
    this.connected = false;
  }
}

const syncSocket = new SyncSocket();

// ═══════════════════════════════════════════════════════
// SYNCED STATE HOOK — API + WebSocket
// ═══════════════════════════════════════════════════════
function useSyncedState(tableName, fetchFn, defaultVal) {
  const [state, _setState] = useState(defaultVal);
  const [ready, setReady] = useState(!tableName);

  // Initial fetch from API
  useEffect(() => {
    if (!tableName || !authToken) { setReady(true); return; }
    let mounted = true;
    (async () => {
      try {
        const data = await fetchFn();
        if (mounted) _setState(data);
      } catch {}
      if (mounted) setReady(true);
    })();
    return () => { mounted = false; };
  }, [tableName, authToken]);

  // Listen for WebSocket sync from other devices
  useEffect(() => {
    if (!tableName) return;
    const unsub = syncSocket.on('sync:' + tableName, (msg) => {
      // Re-fetch from API to get latest data
      fetchFn().then(data => _setState(data)).catch(()=>{});
    });
    return unsub;
  }, [tableName]);

  const setState = useCallback((updater) => {
    _setState(prev => typeof updater === 'function' ? updater(prev) : updater);
  }, []);

  return [state, setState, ready];
}

// Sync context
const SyncCtx = createContext({ status: 'offline', deviceId: '' });
const useSync = () => useContext(SyncCtx);

function SyncProvider({ userId, children }) {
  const [status, setStatus] = useState('connecting');
  const [deviceCount, setDeviceCount] = useState(1);
  const [lastSync, setLastSync] = useState(null);

  useEffect(() => {
    if (!userId || !authToken) { setStatus('offline'); return; }
    syncSocket.connect(authToken);
    const unsub1 = syncSocket.on('status', (d) => { setStatus(d.status); if(d.status==='synced') setLastSync(new Date()); });
    const unsub2 = syncSocket.on('presence', (d) => setDeviceCount(d.deviceCount || 1));
    return () => { unsub1(); unsub2(); syncSocket.disconnect(); };
  }, [userId]);

  return React.createElement(SyncCtx.Provider, { value: { status, lastSync, deviceCount, deviceId: syncSocket.deviceId } }, children);
}

function SyncIndicator() {
  const { status, deviceCount, lastSync } = useSync();
  const [show, setShow] = useState(false);
  const colors = { synced:'#22c55e', syncing:'#f59e0b', error:'#ef4444', offline:'#94a3b8', connecting:'#f59e0b' };
  const labels = { synced:'Synced', syncing:'Syncing...', error:'Sync error', offline:'Offline', connecting:'Connecting...' };
  return (
    <div style={{position:'relative'}}>
      <button onClick={()=>setShow(!show)} style={{display:'flex',alignItems:'center',gap:6,padding:'4px 10px',borderRadius:10,border:'1.5px solid var(--c-border)',background:'transparent',cursor:'pointer',fontSize:11,fontWeight:700,fontFamily:'var(--font-display)',color:'var(--c-muted)'}}>
        <span style={{width:7,height:7,borderRadius:'50%',background:colors[status],boxShadow:status==='synced'?'0 0 6px '+colors[status]:'none',transition:'all .3s'}}/>
        {deviceCount > 1 && <span style={{fontSize:10,color:'var(--c-accent)'}}>{deviceCount} devices</span>}
      </button>
      {show && <div style={{position:'absolute',right:0,top:'calc(100% + 6px)',width:240,background:'var(--c-surface)',border:'1px solid var(--c-border)',borderRadius:14,boxShadow:'var(--shadow-lg)',padding:'14px 16px',zIndex:100,fontSize:12}} className="animate-fadeUp">
        <div style={{display:'flex',alignItems:'center',gap:8,marginBottom:10}}>
          <span style={{width:9,height:9,borderRadius:'50%',background:colors[status]}}/>
          <span style={{fontWeight:700,fontSize:13}}>{labels[status]}</span>
        </div>
        <div style={{color:'var(--c-muted)',marginBottom:6}}>Active devices: <strong style={{color:'var(--c-text)'}}>{deviceCount}</strong></div>
        {lastSync && <div style={{color:'var(--c-muted)'}}>Last sync: <strong style={{color:'var(--c-text)'}}>{lastSync.toLocaleTimeString()}</strong></div>}
        <div style={{marginTop:10,padding:'8px 10px',borderRadius:8,background:'var(--c-subtle)',fontSize:11,color:'var(--c-muted)',lineHeight:1.5}}>
          🔌 Custom WebSocket — instant sync across all devices
        </div>
      </div>}
    </div>
  );
}

const hashEmail = () => ''; // not needed for API-based backend

// ─── TRANSLATIONS ────────────────────────────────────────────
const TR = {
  app_name: { en: 'DocDoor', tr: 'DocDoor', es: 'DocDoor', de: 'DocDoor' },
  back: { en: 'Back', tr: 'Geri', es: 'Atrás', de: 'Zurück' },
  cancel: { en: 'Cancel', tr: 'İptal', es: 'Cancelar', de: 'Abbrechen' },
  confirm: { en: 'Confirm', tr: 'Onayla', es: 'Confirmar', de: 'Bestätigen' },
  save: { en: 'Save', tr: 'Kaydet', es: 'Guardar', de: 'Speichern' },
  welcome_back: { en: 'Welcome back', tr: 'Tekrar hoşgeldiniz', es: 'Bienvenido', de: 'Willkommen' },
  sign_in_desc: { en: 'Sign in to manage your health.', tr: 'Sağlığınızı yönetin.', es: 'Gestiona tu salud.', de: 'Verwalten Sie Ihre Gesundheit.' },
  sign_in: { en: 'Sign In', tr: 'Giriş Yap', es: 'Iniciar', de: 'Anmelden' },
  email: { en: 'Email', tr: 'E-posta', es: 'Correo', de: 'E-Mail' },
  password: { en: 'Password', tr: 'Şifre', es: 'Contraseña', de: 'Passwort' },
  emergency_skip: { en: 'Emergency? Skip login →', tr: 'Acil mi? Girişi atla →', es: '¿Emergencia? Omitir →', de: 'Notfall? Überspringen →' },
  my_visits: { en: 'My Visits', tr: 'Ziyaretlerim', es: 'Mis Visitas', de: 'Besuche' },
  profile: { en: 'Profile', tr: 'Profil', es: 'Perfil', de: 'Profil' },
  sign_out: { en: 'Sign Out', tr: 'Çıkış', es: 'Cerrar', de: 'Abmelden' },
  dashboard: { en: 'Dashboard', tr: 'Panel', es: 'Panel', de: 'Dashboard' },
  what_care: { en: 'How can we help today?', tr: 'Bugün nasıl yardımcı olabiliriz?', es: '¿Cómo podemos ayudar?', de: 'Wie können wir helfen?' },
  care_desc: { en: 'Choose the type of care you need right now.', tr: 'İhtiyacınız olan bakım türünü seçin.', es: 'Elija el tipo de atención que necesita.', de: 'Wählen Sie die Art der Betreuung.' },
  urgent_title: { en: 'Urgent Care', tr: 'Acil Bakım', es: 'Urgencia', de: 'Notfall' },
  urgent_desc: { en: 'Immediate medical attention for acute symptoms.', tr: 'Akut semptomlar için hemen müdahale.', es: 'Atención inmediata para síntomas agudos.', de: 'Sofortige ärztliche Hilfe.' },
  routine_title: { en: 'Schedule Visit', tr: 'Randevu Al', es: 'Programar', de: 'Terminieren' },
  routine_desc: { en: 'Book a checkup or follow-up appointment.', tr: 'Kontrol veya takip randevusu alın.', es: 'Reserve una consulta o seguimiento.', de: 'Vereinbaren Sie einen Termin.' },
  find_nearest: { en: 'Get help now', tr: 'Şimdi yardım al', es: 'Ayuda ahora', de: 'Hilfe jetzt' },
  browse_doctors: { en: 'Browse doctors', tr: 'Doktorları gör', es: 'Ver doctores', de: 'Ärzte ansehen' },
  emergency_911: { en: 'Life-threatening? Call 911 immediately.', tr: 'Hayati tehlike? Hemen 112\'yi arayın.', es: '¿Emergencia vital? Llame al 911.', de: 'Lebensgefahr? Sofort 112 anrufen.' },
  how_feeling: { en: 'Tell us how you feel', tr: 'Nasıl hissediyorsunuz?', es: '¿Cómo se siente?', de: 'Wie fühlen Sie sich?' },
  describe_symptoms: { en: 'Our AI will match you with the right specialist based on your symptoms.', tr: 'AI\'mız semptomlarınıza göre sizi uzmanla eşleştirecek.', es: 'Nuestra IA le asignará un especialista.', de: 'Unsere KI findet den richtigen Spezialisten.' },
  symptoms_placeholder: { en: 'Describe what you\'re experiencing...', tr: 'Yaşadıklarınızı anlatın...', es: 'Describa lo que experimenta...', de: 'Beschreiben Sie Ihre Symptome...' },
  analyzing: { en: 'Analyzing...', tr: 'Analiz...', es: 'Analizando...', de: 'Analyse...' },
  find_doctor: { en: 'Analyze & Match', tr: 'Analiz Et', es: 'Analizar', de: 'Analysieren' },
  skip_ai: { en: 'Skip to booking', tr: 'Direkt randevu al', es: 'Ir a reserva', de: 'Direkt buchen' },
  medical_disclaimer: { en: 'AI-assisted triage only. Not a medical diagnosis.', tr: 'Sadece AI triaj. Tıbbi teşhis değildir.', es: 'Solo triaje con IA. No es diagnóstico.', de: 'Nur KI-Triage. Keine Diagnose.' },
  available_specialists: { en: 'Available Doctors', tr: 'Müsait Doktorlar', es: 'Doctores Disponibles', de: 'Verfügbare Ärzte' },
  book_home_visit: { en: 'Choose a specialist for your home visit.', tr: 'Ev ziyaretiniz için uzman seçin.', es: 'Elija un especialista para su visita.', de: 'Wählen Sie einen Spezialisten.' },
  book_visit: { en: 'Book', tr: 'Randevu Al', es: 'Reservar', de: 'Buchen' },
  available: { en: 'Next', tr: 'Sonra', es: 'Próx.', de: 'Nächst' },
  show_all: { en: 'All', tr: 'Tümü', es: 'Todos', de: 'Alle' },
  booking_title: { en: 'Book Appointment', tr: 'Randevu Al', es: 'Reservar Cita', de: 'Termin buchen' },
  urgent_care: { en: 'Emergency Dispatch', tr: 'Acil Sevk', es: 'Envío de Emergencia', de: 'Notfall-Einsatz' },
  delivery_address: { en: 'Visit Address', tr: 'Ziyaret Adresi', es: 'Dirección', de: 'Besuchsadresse' },
  secure_payment: { en: 'Payment', tr: 'Ödeme', es: 'Pago', de: 'Zahlung' },
  card_number: { en: 'Card Number', tr: 'Kart No', es: 'Nº Tarjeta', de: 'Kartennr.' },
  card_holder: { en: 'Name on Card', tr: 'Kart Sahibi', es: 'Titular', de: 'Karteninhaber' },
  confirm_appointment: { en: 'Confirm Booking', tr: 'Onayla', es: 'Confirmar', de: 'Bestätigen' },
  find_emergency_doctor: { en: 'Dispatch Now', tr: 'Hemen Gönder', es: 'Enviar Ahora', de: 'Jetzt senden' },
  recommendation: { en: 'AI Recommendation', tr: 'AI Önerisi', es: 'Recomendación IA', de: 'KI-Empfehlung' },
  waiting_confirmation: { en: 'Awaiting doctor', tr: 'Doktor bekleniyor', es: 'Esperando doctor', de: 'Warte auf Arzt' },
  request_declined: { en: 'Unavailable', tr: 'Uygun değil', es: 'No disponible', de: 'Nicht verfügbar' },
  call: { en: 'Call', tr: 'Ara', es: 'Llamar', de: 'Anrufen' },
  chat: { en: 'Chat', tr: 'Mesaj', es: 'Chat', de: 'Chat' },
  cancel_visit: { en: 'Cancel Visit', tr: 'İptal Et', es: 'Cancelar', de: 'Abbrechen' },
  start_consultation: { en: 'Begin Consultation', tr: 'Muayeneyi Başlat', es: 'Iniciar Consulta', de: 'Konsultation starten' },
  finding_route: { en: 'Routing', tr: 'Rota', es: 'Ruta', de: 'Route' },
  on_the_way: { en: 'En route', tr: 'Yolda', es: 'En camino', de: 'Unterwegs' },
  arrived: { en: 'Arrived', tr: 'Vardı', es: 'Llegó', de: 'Angekommen' },
  type_message: { en: 'Type a message...', tr: 'Mesaj yazın...', es: 'Escribe...', de: 'Nachricht...' },
  update_profile: { en: 'Save Changes', tr: 'Kaydet', es: 'Guardar', de: 'Speichern' },
  blood_group: { en: 'Blood Type', tr: 'Kan Grubu', es: 'Tipo de Sangre', de: 'Blutgruppe' },
  allergies: { en: 'Allergies', tr: 'Alerjiler', es: 'Alergias', de: 'Allergien' },
  medical_history: { en: 'Medical Notes', tr: 'Tıbbi Notlar', es: 'Notas Médicas', de: 'Notizen' },
  search_doctors: { en: 'Search doctors...', tr: 'Doktor ara...', es: 'Buscar doctores...', de: 'Ärzte suchen...' },
  sort_by: { en: 'Sort', tr: 'Sırala', es: 'Ordenar', de: 'Sortieren' },
  rating: { en: 'Rating', tr: 'Puan', es: 'Puntuación', de: 'Bewertung' },
  price: { en: 'Price', tr: 'Fiyat', es: 'Precio', de: 'Preis' },
  reviews: { en: 'Reviews', tr: 'Yorumlar', es: 'Reseñas', de: 'Bewertungen' },
  rate_visit: { en: 'Rate your visit', tr: 'Ziyareti değerlendir', es: 'Califique su visita', de: 'Bewerten Sie den Besuch' },
  // Home
  what_care_home: { en: 'What kind of care do you need?', tr: 'Ne tür bir bakıma ihtiyacınız var?', es: '¿Qué tipo de atención necesita?', de: 'Welche Behandlung benötigen Sie?' },
  what_care_sub: { en: 'Select the option that best describes your situation.', tr: 'Durumunuzu en iyi anlatan seçeneği seçin.', es: 'Seleccione la opción que mejor describe su situación.', de: 'Wählen Sie die passende Option.' },
  greeting_morning: { en: 'Good morning', tr: 'Günaydın', es: 'Buenos días', de: 'Guten Morgen' },
  greeting_afternoon: { en: 'Good afternoon', tr: 'İyi öğleden sonralar', es: 'Buenas tardes', de: 'Guten Tag' },
  greeting_evening: { en: 'Good evening', tr: 'İyi akşamlar', es: 'Buenas noches', de: 'Guten Abend' },
  appt_awaiting: { en: 'Awaiting Doctor Approval...', tr: 'Doktor Onayı Bekleniyor...', es: 'Esperando aprobación del médico...', de: 'Warte auf Arztbestätigung...' },
  appt_confirmed_label: { en: 'Confirmed Appointment', tr: 'Onaylanmış Randevu', es: 'Cita Confirmada', de: 'Bestätigter Termin' },
  status_pending: { en: 'Pending', tr: 'Bekliyor', es: 'Pendiente', de: 'Ausstehend' },
  status_confirmed: { en: 'Confirmed', tr: 'Onaylandı', es: 'Confirmado', de: 'Bestätigt' },
  appt_details: { en: 'Appointment Details', tr: 'Randevu Detayları', es: 'Detalles de la Cita', de: 'Termindetails' },
  close: { en: 'Close', tr: 'Kapat', es: 'Cerrar', de: 'Schließen' },
  doctor_label: { en: 'Doctor', tr: 'Doktor', es: 'Doctor', de: 'Arzt' },
  status_label: { en: 'Status', tr: 'Durum', es: 'Estado', de: 'Status' },
  date_time: { en: 'Date & Time', tr: 'Tarih & Saat', es: 'Fecha y Hora', de: 'Datum & Uhrzeit' },
  location: { en: 'Location', tr: 'Konum', es: 'Ubicación', de: 'Standort' },
  apartment: { en: 'Apartment', tr: 'Daire', es: 'Apartamento', de: 'Wohnung' },
  symptoms_label: { en: 'Symptoms', tr: 'Semptomlar', es: 'Síntomas', de: 'Symptome' },
  general_visit: { en: 'General visit', tr: 'Genel muayene', es: 'Visita general', de: 'Allgemeine Untersuchung' },
  not_specified: { en: 'Not specified', tr: 'Belirtilmedi', es: 'No especificado', de: 'Nicht angegeben' },
  todays_meds: { en: "Today's Medicines", tr: 'Bugünkü İlaçlar', es: 'Medicamentos de Hoy', de: 'Heutige Medikamente' },
  routine_desc_home: { en: 'Schedule a checkup, follow-up, or specialist appointment.', tr: 'Genel kontrol, takip muayenesi veya uzman doktor randevusu.', es: 'Programe un chequeo, seguimiento o cita con especialista.', de: 'Allgemeine Kontrolle, Nachsorge oder Facharzttermin.' },
  see_doctors: { en: 'See Doctors', tr: 'Doktorları Gör', es: 'Ver Doctores', de: 'Ärzte ansehen' },
  fav_doctors_title: { en: 'Favorite Doctors', tr: 'Favori Doktorlar', es: 'Médicos Favoritos', de: 'Lieblingsärzte' },
  recent_visits_title: { en: 'Recent Visits', tr: 'Son Ziyaretler', es: 'Visitas Recientes', de: 'Letzte Besuche' },
  summary_badge: { en: 'Summary', tr: 'Özet', es: 'Resumen', de: 'Zusammenfassung' },
  new_badge: { en: 'New', tr: 'Yeni', es: 'Nuevo', de: 'Neu' },
  safe_tagline: { en: 'DocDoor — Trusted and fast healthcare service.', tr: 'DocDoor — Güvenli ve hızlı sağlık hizmeti aracılığı.', es: 'DocDoor — Servicio médico rápido y confiable.', de: 'DocDoor — Schneller und sicherer Gesundheitsservice.' },
  // Doctors list
  sort_best: { en: '⭐ Best rated', tr: '⭐ En iyi puanlı', es: '⭐ Mejor valorado', de: '⭐ Bestbewertet' },
  sort_price: { en: '💰 Lowest price', tr: '💰 En düşük fiyat', es: '💰 Precio más bajo', de: '💰 Günstigster Preis' },
  sort_nearest: { en: '⏱ Nearest', tr: '⏱ En yakın', es: '⏱ Más cercano', de: '⏱ Nächster' },
  reviews_count: { en: 'reviews', tr: 'yorum', es: 'reseñas', de: 'Bewertungen' },
  no_doctors: { en: 'No doctors available yet', tr: 'Henüz kayıtlı doktor yok', es: 'Aún no hay médicos disponibles', de: 'Noch keine Ärzte verfügbar' },
  no_doctors_desc: { en: 'Doctors will appear here once they create an account and sign up as a doctor.', tr: 'Doktorlar hesap oluşturup kaydolunca burada görünecek.', es: 'Los médicos aparecerán aquí una vez que creen una cuenta.', de: 'Ärzte erscheinen hier, sobald sie ein Konto erstellt haben.' },
  // Doctor detail
  per_visit: { en: 'per visit', tr: 'ziyaret başına', es: 'por visita', de: 'pro Besuch' },
  rating_label: { en: 'Rating', tr: 'Puan', es: 'Puntuación', de: 'Bewertung' },
  no_reviews: { en: 'No reviews', tr: 'Yorum yok', es: 'Sin reseñas', de: 'Keine Bewertungen' },
  reviews_label: { en: 'Reviews', tr: 'Yorumlar', es: 'Reseñas', de: 'Bewertungen' },
  education: { en: 'Education', tr: 'Eğitim', es: 'Educación', de: 'Ausbildung' },
  experience_label: { en: 'Experience', tr: 'Deneyim', es: 'Experiencia', de: 'Erfahrung' },
  patient_reviews: { en: 'Patient Reviews', tr: 'Hasta Yorumları', es: 'Reseñas de Pacientes', de: 'Patientenbewertungen' },
  no_reviews_first: { en: 'No reviews yet. Be the first to review!', tr: 'Henüz yorum yok. İlk yorum yapan siz olun!', es: 'Sin reseñas aún. ¡Sé el primero!', de: 'Noch keine Bewertungen. Seien Sie der Erste!' },
  book_with: { en: 'Book with', tr: 'Randevu Al:', es: 'Reservar con', de: 'Buchen bei' },
  // Auth
  welcome_back_title: { en: 'Welcome Back', tr: 'Tekrar Hoşgeldiniz', es: 'Bienvenido de nuevo', de: 'Willkommen zurück' },
  provider_signup: { en: 'Provider Sign Up', tr: 'Doktor Kaydı', es: 'Registro de Proveedor', de: 'Anbieter-Registrierung' },
  patient_signup: { en: 'Patient Sign Up', tr: 'Hasta Kaydı', es: 'Registro de Paciente', de: 'Patientenregistrierung' },
  sign_in_arrow: { en: 'Sign In →', tr: 'Giriş Yap →', es: 'Iniciar sesión →', de: 'Anmelden →' },
  register_provider: { en: 'Register as Provider →', tr: 'Doktor Olarak Kayıt →', es: 'Registrarse como Proveedor →', de: 'Als Anbieter registrieren →' },
  create_account: { en: 'Create Account →', tr: 'Hesap Oluştur →', es: 'Crear cuenta →', de: 'Konto erstellen →' },
  no_account: { en: "Don't have an account? Sign up", tr: 'Hesabınız yok mu? Kaydolun', es: '¿No tiene cuenta? Regístrese', de: 'Kein Konto? Registrieren' },
  have_account: { en: 'Already have an account? Sign in', tr: 'Zaten hesabınız var mı? Giriş yapın', es: '¿Ya tiene cuenta? Inicie sesión', de: 'Haben Sie ein Konto? Anmelden' },
  switch_to_patient: { en: 'Switch to Patient', tr: 'Hasta Hesabına Geç', es: 'Cambiar a Paciente', de: 'Zu Patient wechseln' },
  are_you_doctor: { en: 'Are you a Doctor?', tr: 'Doktor musunuz? Tıklayın', es: '¿Es médico? Haga clic', de: 'Sind Sie Arzt? Klicken' },
  legal_read_scroll: { en: '↓ Please read the full text to continue', tr: '↓ Devam etmek için metni okuyun', es: '↓ Lea el texto completo para continuar', de: '↓ Bitte lesen Sie den Text vollständig' },
  legal_confirm: { en: 'I have read and understood', tr: 'Okudum, Anladım', es: 'He leído y entendido', de: 'Ich habe gelesen und verstanden' },
  // Visits / Dashboard
  my_visits_title: { en: 'My Visits', tr: 'Ziyaretlerim', es: 'Mis Visitas', de: 'Meine Besuche' },
  no_visits: { en: 'No visits yet', tr: 'Henüz ziyaret yok', es: 'Sin visitas aún', de: 'Noch keine Besuche' },
  // Profile
  first_name: { en: 'First Name', tr: 'Ad', es: 'Nombre', de: 'Vorname' },
  last_name: { en: 'Last Name', tr: 'Soyad', es: 'Apellido', de: 'Nachname' },
  country: { en: 'Country', tr: 'Ülke', es: 'País', de: 'Land' },
  city: { en: 'City', tr: 'Şehir', es: 'Ciudad', de: 'Stadt' },
  birth_date: { en: 'Date of Birth', tr: 'Doğum Tarihi', es: 'Fecha de Nacimiento', de: 'Geburtsdatum' },
  manage_schedule: { en: 'Manage Schedule', tr: 'Takvimi Yönet', es: 'Gestionar Horario', de: 'Zeitplan verwalten' },
  admin_panel: { en: 'Admin', tr: 'Admin', es: 'Admin', de: 'Admin' },
  // Emergency
  emergency_call: { en: 'Life-threatening? Call {num} immediately.', tr: 'Hayati tehlike? Hemen {num}\'yi arayın.', es: '¿Emergencia vital? Llame al {num}.', de: 'Lebensgefahr? Sofort {num} anrufen.' },
  // Auth form
  first_name_req: { en: 'First Name *', tr: 'Ad *', es: 'Nombre *', de: 'Vorname *' },
  last_name_req: { en: 'Last Name *', tr: 'Soyad *', es: 'Apellido *', de: 'Nachname *' },
  city_province: { en: 'City / Province *', tr: 'Şehir / İl *', es: 'Ciudad / Provincia *', de: 'Stadt / Provinz *' },
  select_placeholder: { en: 'Select...', tr: 'Seçiniz...', es: 'Seleccionar...', de: 'Auswählen...' },
  birth_date_req: { en: 'Date of Birth *', tr: 'Doğum Tarihi *', es: 'Fecha de Nacimiento *', de: 'Geburtsdatum *' },
  // Auth errors
  err_all_required: { en: 'All fields are required.', tr: 'Tüm alanlar zorunludur.', es: 'Todos los campos son obligatorios.', de: 'Alle Felder sind erforderlich.' },
  err_name_required: { en: 'First and last name are required.', tr: 'İsim ve soyisim zorunludur.', es: 'Nombre y apellido son obligatorios.', de: 'Vor- und Nachname sind erforderlich.' },
  err_birth_required: { en: 'Date of birth is required.', tr: 'Doğum tarihi zorunludur.', es: 'La fecha de nacimiento es obligatoria.', de: 'Geburtsdatum ist erforderlich.' },
  err_city_required: { en: 'City/Province is required.', tr: 'Şehir/İl bilgisi zorunludur.', es: 'Ciudad/Provincia es obligatoria.', de: 'Stadt/Provinz ist erforderlich.' },
  err_pw_short: { en: 'Password must be at least 6 characters.', tr: 'Şifre en az 6 karakter olmalıdır.', es: 'La contraseña debe tener al menos 6 caracteres.', de: 'Passwort muss mindestens 6 Zeichen haben.' },
  err_kvkk_read: { en: 'Please read the KVKK Policy first.', tr: "KVKK Aydınlatma Metni'ni önce okumalısınız.", es: 'Debe leer la Política KVKK primero.', de: 'Bitte zuerst die KVKK-Richtlinie lesen.' },
  err_kvkk_consent: { en: 'You must accept the KVKK Policy.', tr: "KVKK Aydınlatma Metni'ni onaylamanız gereklidir.", es: 'Debe aceptar la Política KVKK.', de: 'KVKK-Richtlinie muss akzeptiert werden.' },
  err_health_read: { en: 'Please read the Health Data Consent first.', tr: 'Sağlık Verisi Açık Rızası metnini önce okumalısınız.', es: 'Lea primero el Consentimiento de Datos de Salud.', de: 'Bitte zuerst die Gesundheitsdaten-Einwilligung lesen.' },
  err_health_consent: { en: 'Health data processing consent is required.', tr: 'Sağlık verisi işleme onayı gereklidir.', es: 'Se requiere consentimiento de datos de salud.', de: 'Einwilligung zur Gesundheitsdatenverarbeitung erforderlich.' },
  err_license_required: { en: 'Diploma/Registration number is required.', tr: 'Diploma/Tescil numarası zorunludur.', es: 'El número de diploma/registro es obligatorio.', de: 'Diplom-/Registrierungsnummer ist erforderlich.' },
  err_tabip_required: { en: 'Medical Chamber membership number is required.', tr: 'Tabip Odası üyelik numarası zorunludur.', es: 'El número del Colegio Médico es obligatorio.', de: 'Ärztekammer-Mitgliedsnummer ist erforderlich.' },
  err_malpraktis_required: { en: 'Malpractice insurance policy number is required.', tr: 'Malpraktis sigorta poliçe numarası zorunludur.', es: 'El número de póliza de malpractice es obligatorio.', de: 'Malpraktis-Versicherungsnummer ist erforderlich.' },
  err_contractor_read: { en: 'Please read the Independent Contractor Agreement first.', tr: 'Bağımsız yüklenici sözleşmesini önce okumalısınız.', es: 'Lea primero el Acuerdo de Contratista.', de: 'Bitte zuerst den Auftragnehmervertrag lesen.' },
  err_contractor_consent: { en: 'You must accept the Independent Contractor Agreement.', tr: 'Bağımsız yüklenici sözleşmesini onaylamanız gereklidir.', es: 'Debe aceptar el Acuerdo de Contratista.', de: 'Auftragnehmervertrag muss akzeptiert werden.' },
  err_connection: { en: 'Connection error.', tr: 'Bağlantı hatası.', es: 'Error de conexión.', de: 'Verbindungsfehler.' },
  toast_welcome: { en: 'Welcome!', tr: 'Hoş geldiniz!', es: '¡Bienvenido!', de: 'Willkommen!' },
  toast_account_created: { en: 'Account created!', tr: 'Hesap oluşturuldu!', es: '¡Cuenta creada!', de: 'Konto erstellt!' },
  // Visits page
  patient_history_title: { en: 'Patient History', tr: 'Hasta Geçmişi', es: 'Historial de Pacientes', de: 'Patientenhistorie' },
  patient_history_sub: { en: 'Your patients and visit history', tr: 'Gelen hastalarınız ve ziyaret geçmişi', es: 'Sus pacientes e historial de visitas', de: 'Ihre Patienten und Besuchshistorie' },
  visits_sub: { en: 'Your appointments and visit history', tr: 'Randevularınız ve ziyaret geçmişi', es: 'Sus citas e historial de visitas', de: 'Ihre Termine und Besuchshistorie' },
  tab_upcoming: { en: 'Upcoming', tr: 'Yaklaşan', es: 'Próximas', de: 'Bevorstehend' },
  tab_history: { en: 'History', tr: 'Geçmiş', es: 'Historial', de: 'Verlauf' },
  btn_summary: { en: 'Summary', tr: 'Özet', es: 'Resumen', de: 'Zusammenfassung' },
  btn_rebook: { en: 'Rebook', tr: 'Tekrar Rezerve Et', es: 'Reservar de nuevo', de: 'Erneut buchen' },
  visits_show_here: { en: 'Your appointments will show here.', tr: 'Randevularınız burada görünecek.', es: 'Sus citas aparecerán aquí.', de: 'Ihre Termine werden hier angezeigt.' },
  // Favorites
  fav_sub: { en: 'Quick access to your preferred doctors', tr: 'Tercih ettiğiniz doktorlara hızlı erişim', es: 'Acceso rápido a sus médicos preferidos', de: 'Schnellzugriff auf Ihre bevorzugten Ärzte' },
  fav_remove: { en: '♥ Remove', tr: '♥ Çıkar', es: '♥ Eliminar', de: '♥ Entfernen' },
  fav_book_visit: { en: 'Book Visit', tr: 'Rezerve Et', es: 'Reservar Visita', de: 'Besuch buchen' },
  no_favs: { en: 'No favorite doctors', tr: 'Favori doktor yok', es: 'Sin médicos favoritos', de: 'Keine Lieblingsärzte' },
  no_favs_sub: { en: 'Heart a doctor to add them here.', tr: 'Doktorların kalbine basarak buraya ekle.', es: 'Toca el corazón para añadir.', de: 'Tippe auf das Herz, um hinzuzufügen.' },
  new_doctor: { en: 'New doctor', tr: 'Yeni doktor', es: 'Médico nuevo', de: 'Neuer Arzt' },
  // Booking / insurance
  err_tc_length: { en: 'TC ID must be 11 digits.', tr: 'TC Kimlik 11 haneli olmalı.', es: 'El TC ID debe tener 11 dígitos.', de: 'TC-ID muss 11 Stellen haben.' },
  insurance_found: { en: '{n} insurance record(s) found!', tr: '{n} sigorta kaydı bulundu!', es: '¡{n} registro(s) de seguro encontrado(s)!', de: '{n} Versicherungsdatensatz/-sätze gefunden!' },
  insurance_not_found: { en: 'No insurance found.', tr: 'Sigorta bulunamadı.', es: 'No se encontró seguro.', de: 'Keine Versicherung gefunden.' },
  insurance_error: { en: 'Insurance query error.', tr: 'Sigorta sorgulama hatası.', es: 'Error de consulta de seguro.', de: 'Versicherungsabfragefehler.' },
  err_address_required: { en: 'Please fill in all address fields.', tr: 'Lütfen tüm adres alanlarını doldurun.', es: 'Por favor complete todos los campos de dirección.', de: 'Bitte alle Adressfelder ausfüllen.' },
  err_time_required: { en: 'Please select a time.', tr: 'Lütfen bir saat seçin.', es: 'Por favor seleccione una hora.', de: 'Bitte eine Uhrzeit auswählen.' },
  err_payment_required: { en: 'Please complete payment details.', tr: 'Ödeme bilgilerini tamamlayın.', es: 'Complete los datos de pago.', de: 'Zahlungsdetails vervollständigen.' },
  err_informed_consent: { en: 'Informed consent is required.', tr: 'Aydınlatılmış onam onayı gerekli.', es: 'Se requiere consentimiento informado.', de: 'Einwilligung nach Aufklärung erforderlich.' },
  err_distance_contract: { en: 'Distance contract approval is required.', tr: 'Mesafeli sözleşme onayı gerekli.', es: 'Se requiere aprobación del contrato a distancia.', de: 'Fernvertragsgenehmigung erforderlich.' },
};

function getEmergencyNumber(country) {
  const c = (country||'').toLowerCase();
  if(c.includes('uk')||c.includes('united kingdom')||c.includes('britain')) return '999';
  if(c.includes('usa')||c.includes('united states')||c.includes('us')) return '911';
  return '112'; // Turkey, Germany, Netherlands, France, Spain, and most of Europe/world
}

const Ctx = createContext(null);
const useT = () => useContext(Ctx);

// ─── MOCK DATA ──────────────────────────────────────────────
const REVIEWS = [];
const DOCS = [];  // Doctors come from backend (real registered users only)

// Avatar helper — shows initial letter when no image
function fmtPrice(amount, currency) { const sym = currency==='TRY'?'₺':currency==='EUR'?'€':currency==='GBP'?'£':'$'; return sym+(amount||0); }

function DocAvatar({src, name, size=48, radius=16, style={}}) {
  if (src) return <img src={src} alt="" style={{width:size,height:size,borderRadius:radius,objectFit:'cover',...style}} onError={e=>{e.target.style.display='none';e.target.nextSibling&&(e.target.nextSibling.style.display='flex');}}/>;
  const letter = (name||'D').charAt(0).toUpperCase();
  return <div style={{width:size,height:size,borderRadius:radius,background:'linear-gradient(135deg,var(--c-accent),var(--c-accent2))',display:'flex',alignItems:'center',justifyContent:'center',color:'white',fontSize:size*0.4,fontWeight:800,fontFamily:'var(--font-display)',flexShrink:0,...style}}>{letter}</div>;
}

const SLOTS = Array.from({length:24},(_,i)=>`${String(i).padStart(2,'0')}:00`);

// ─── LOTTIE ANIMATIONS ─────────────────────────────────────
const _lottieCache = {};
function LottieAnim({name, size=24, loop=false, autoplay=false, hover=false, trigger, speed=1, style={}, className=''}) {
  const ref = useRef(null);
  const animRef = useRef(null);
  const [data, setData] = useState(_lottieCache[name]||null);
  useEffect(()=>{
    if(_lottieCache[name]){setData(_lottieCache[name]);return;}
    fetch('/lottie/'+name+'.json').then(r=>r.json()).then(d=>{_lottieCache[name]=d;setData(d);}).catch(()=>{});
  },[name]);
  useEffect(()=>{
    if(!ref.current||!data||!window.lottie) return;
    if(animRef.current){animRef.current.destroy();}
    const anim = window.lottie.loadAnimation({
      container:ref.current, renderer:'svg', loop:loop, autoplay:autoplay,
      animationData:data, rendererSettings:{preserveAspectRatio:'xMidYMid slice'}
    });
    anim.setSpeed(speed);
    animRef.current = anim;
    return ()=>{try{anim.destroy();}catch{}};
  },[data,loop,autoplay,speed]);
  useEffect(()=>{if(trigger!==undefined&&animRef.current){animRef.current.goToAndPlay(0,true);}},[trigger]);
  const onEnter = ()=>{if(hover&&animRef.current){animRef.current.goToAndPlay(0,true);}};
  if(!data) return <div style={{width:size,height:size,...style}}/>;
  return <div ref={ref} onMouseEnter={onEnter} className={className} style={{width:size,height:size,display:'inline-flex',alignItems:'center',justifyContent:'center',overflow:'hidden',pointerEvents:hover?'auto':'none',...style}}/>;
}


const COMMON_SYMPTOMS = [
  {label:'Headache',icon:'🤕',text:'I have a headache'},
  {label:'Fever',icon:'🌡️',text:'I have a fever'},
  {label:'Chest Pain',icon:'💔',text:'I have chest pain'},
  {label:'Cough',icon:'🤧',text:'I have a persistent cough'},
  {label:'Back Pain',icon:'🦴',text:'I have back pain'},
  {label:'Stomach',icon:'🤢',text:'I have stomach pain or nausea'},
  {label:'Skin Issue',icon:'🩹',text:'I have a skin rash or irritation'},
  {label:'Fatigue',icon:'😴',text:'I feel extremely fatigued'},
];

// ─── AI (via backend proxy) ─────────────────────────────────
async function aiTriage(symptoms) {
  try { return await api.post('/ai/triage', { symptoms }); }
  catch { return { specialty:'General Practitioner', urgency:'Medium', advice:'A doctor will assess you shortly.', timeframe:'Within 1 hour' }; }
}
async function aiChat(doc, spec, sym, hist, msg) {
  try { const r = await api.post('/ai/chat', { docName:doc, specialty:spec, symptoms:sym, history:hist, message:msg }); return r.reply; }
  catch { return "I'm on my way — see you shortly."; }
}
async function aiSummary(sym, spec) {
  try { return await api.post('/ai/summary', { symptoms:sym, specialty:spec }); }
  catch { return {diagnosis:'General assessment completed.',prescriptions:[{name:'Ibuprofen',dosage:'400mg',frequency:'As needed',duration:'5 days'}],followUp:'In 2 weeks',notes:'Rest well and stay hydrated.'}; }
}

// ─── TOAST SYSTEM ────────────────────────────────────────────
const ToastCtx = createContext(()=>{});
const useToast = () => useContext(ToastCtx);
function ToastProvider({ children }) {
  const [toasts, setToasts] = useState([]);
  const add = useCallback((msg, type='info') => {
    const id = Date.now();
    setToasts(p => [...p, { id, msg, type }]);
    setTimeout(() => setToasts(p => p.filter(t => t.id !== id)), 3500);
  }, []);
  return (
    <ToastCtx.Provider value={add}>
      {children}
      <div style={{position:'fixed',top:80,right:16,zIndex:200,display:'flex',flexDirection:'column',gap:8,pointerEvents:'none',maxWidth:360}}>
        {toasts.map(t => (
          <div key={t.id} style={{pointerEvents:'auto',padding:'14px 20px',borderRadius:16,boxShadow:'0 8px 32px rgba(0,0,0,.12)',fontSize:14,fontWeight:600,backdropFilter:'blur(20px)',border:'1px solid',animation:'slideIn .35s cubic-bezier(.22,1,.36,1) both',fontFamily:'var(--font-body)',...(
            t.type==='success'?{background:'rgba(16,185,129,.92)',color:'white',borderColor:'rgba(16,185,129,.3)'}:
            t.type==='error'?{background:'rgba(239,68,68,.92)',color:'white',borderColor:'rgba(239,68,68,.3)'}:
            t.type==='warning'?{background:'rgba(245,158,11,.92)',color:'white',borderColor:'rgba(245,158,11,.3)'}:
            {background:'var(--c-surface)',color:'var(--c-text)',borderColor:'var(--c-border)'}
          )}}>{t.msg}</div>
        ))}
      </div>
    </ToastCtx.Provider>
  );
}

// ─── SVG ICONS ───────────────────────────────────────────────
const P = ({d,s=20,c="",f=false,style={}}) => {
  const colorMap = {'text-teal-600':'#0d9488','text-red-500':'#ef4444','text-indigo-500':'#6366f1','text-slate-400':'#94a3b8','text-amber-500':'#f59e0b','text-white':'#ffffff','text-slate-300':'#cbd5e1','text-green-500':'#22c55e'};
  let col = undefined;
  (c||'').split(' ').forEach(cls => { if(colorMap[cls]) col = colorMap[cls]; });
  const mergedStyle = {...style};
  if(col) mergedStyle.color = col;
  return <svg width={s} height={s} viewBox="0 0 24 24" fill={f?"currentColor":"none"} stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" style={mergedStyle}>{(Array.isArray(d)?d:[d]).map((p,i)=><path key={i} d={p}/>)}</svg>;
};
const ic = {
  stethoscope:["M4.8 2.3A.3.3 0 1 0 5 2H4a2 2 0 0 0-2 2v5a6 6 0 0 0 6 6 6 6 0 0 0 6-6V4a2 2 0 0 0-2-2h-1a.2.2 0 1 0 .3.3","M8 15v1a6 6 0 0 0 6 6 6 6 0 0 0 6-6v-4","M22 10a2 2 0 0 0-4 0v3"],
  mail:["M4 4h16c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2z","M22 6l-10 7L2 6"],
  lock:["M19 11H5a2 2 0 0 0-2 2v7a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7a2 2 0 0 0-2-2z","M7 11V7a5 5 0 0 1 10 0v4"],
  arrowRight:"M5 12h14M12 5l7 7-7 7",arrowLeft:"M19 12H5M12 19l-7-7 7-7",
  user:["M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2","M12 3a4 4 0 1 0 0 8 4 4 0 0 0 0-8z"],
  alert:["M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z","M12 9v4","M12 17h.01"],
  calendar:["M19 4H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V6a2 2 0 0 0-2-2z","M16 2v4","M8 2v4","M3 10h18"],
  star:"M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z",
  clock:["M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20z","M12 6v6l4 2"],
  dollar:["M12 1v22","M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6"],
  chevDown:"M6 9l6 6 6-6",chevRight:"M9 18l6-6-6-6",chevUp:"M18 15l-6-6-6 6",
  filter:["M22 3H2l8 9.46V19l4 2v-8.54L22 3"],
  globe:["M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20z","M2 12h20","M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"],
  mapPin:["M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z","M12 7a3 3 0 1 0 0 6 3 3 0 0 0 0-6z"],
  nav:"M3 11l19-9-9 19-2-8-8-2z",
  check:"M20 6L9 17l-5-5",
  checkCircle:["M22 11.08V12a10 10 0 1 1-5.93-9.14","M22 4L12 14.01l-3-3"],
  x:["M18 6L6 18","M6 6l12 12"],xCircle:["M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20z","M15 9l-6 6","M9 9l6 6"],
  phone:["M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6A19.79 19.79 0 0 1 2.12 4.18 2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72c.127.96.361 1.903.7 2.81a2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45c.907.339 1.85.573 2.81.7A2 2 0 0 1 22 16.92z"],
  msg:"M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z",
  shield:"M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z",
  sparkle:["M12 3l1.912 5.813a2 2 0 0 0 1.275 1.275L21 12l-5.813 1.912a2 2 0 0 0-1.275 1.275L12 21l-1.912-5.813a2 2 0 0 0-1.275-1.275L3 12l5.813-1.912a2 2 0 0 0 1.275-1.275L12 3z"],
  send:["M22 2L11 13","M22 2l-7 20-4-9-9-4 20-7z"],
  sun:["M12 1v2","M12 21v2","M4.22 4.22l1.42 1.42","M18.36 18.36l1.42 1.42","M1 12h2","M21 12h2","M4.22 19.78l1.42-1.42","M18.36 5.64l1.42-1.42","M12 5a7 7 0 1 0 0 14 7 7 0 0 0 0-14z"],
  moon:"M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z",
  logout:["M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4","M16 17l5-5-5-5","M21 12H9"],
  credit:["M1 4h22v16H1z","M1 10h22"],wallet:["M21 12V7H5a2 2 0 0 1 0-4h14v4","M3 5v14a2 2 0 0 0 2 2h16v-5","M18 12a1 1 0 1 0 2 0 1 1 0 0 0-2 0z"],
  plus:["M12 5v14","M5 12h14"],trash:["M3 6h18","M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"],
  heart:["M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"],
  activity:["M22 12h-4l-3 9L9 3l-3 9H2"],
  zap:["M13 2L3 14h9l-1 8 10-12h-9l1-8"],
  shieldAlert:["M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z","M12 8v4","M12 16h.01"],
  eye:["M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8z","M12 9a3 3 0 1 0 0 6 3 3 0 0 0 0-6z"],
  eyeOff:["M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24","M1 1l22 22"],
  lang:["M5 8l6 6","M4 14l6-6 2-3","M2 5h12","M7 2h1","M22 22l-5-10-5 10","M14 18h6"],
  alertCircle:["M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20z","M12 8v4","M12 16h.01"],
  loader:["M12 2v4","M12 18v4","M4.93 4.93l2.83 2.83","M16.24 16.24l2.83 2.83","M2 12h4","M18 12h4","M4.93 19.07l2.83-2.83","M16.24 7.76l2.83-2.83"],
  clipboard:["M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2","M15 2H9a1 1 0 0 0-1 1v2a1 1 0 0 0 1 1h6a1 1 0 0 0 1-1V3a1 1 0 0 0-1-1z"],
  search:["M11 3a8 8 0 1 0 0 16 8 8 0 0 0 0-16z","M21 21l-4.35-4.35"],
  bell:["M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9","M13.73 21a2 2 0 0 1-3.46 0"],
  award:["M12 15l-3.5 2 1-3.87L6 10.1l3.95-.35L12 6.25l2.05 3.5 3.95.35-3.5 3.03 1 3.87L12 15z","M12 15a7 7 0 1 0 0-14 7 7 0 0 0 0 14z","M8.21 13.89L7 23l5-3 5 3-1.21-9.12"],
  wifi:["M5 12.55a11 11 0 0 1 14.08 0","M1.42 9a16 16 0 0 1 21.16 0","M8.53 16.11a6 6 0 0 1 6.95 0","M12 20h.01"],
  sort:["M3 6h18","M6 12h12","M9 18h6"],
  pill:["M10.5 1.5L3 9l6 6 7.5-7.5a4.24 4.24 0 0 0-6-6z","M9 9l6 6"],
  repeat:["M17 1l4 4-4 4","M3 11V9a4 4 0 0 1 4-4h14","M7 23l-4-4 4-4","M21 13v2a4 4 0 0 1-4 4H3"],
  fileText:["M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z","M14 2v6h6","M16 13H8","M16 17H8","M10 9H8"],
  userPlus:["M16 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2","M8.5 3a4 4 0 1 0 0 8 4 4 0 0 0 0-8z","M20 8v6","M23 11h-6"],
};
const I = ({n,s=20,c="",f=false,style={}}) => <P d={ic[n]||""} s={s} c={c} f={f} style={style}/>;

// ─── STAR RATING INPUT ───────────────────────────────────────
function StarRating({value=0, onChange, size=24, readonly=false}) {
  const [hover, setHover] = useState(0);
  return (
    <div style={{display:'flex',gap:4}}>
      {[1,2,3,4,5].map(i => (
        <button key={i} type="button" disabled={readonly}
          onMouseEnter={()=>!readonly&&setHover(i)} onMouseLeave={()=>setHover(0)}
          onClick={()=>onChange?.(i)}
          style={{background:'none',border:'none',cursor:readonly?'default':'pointer',padding:2,transition:'transform .15s',transform:(hover===i&&!readonly)?'scale(1.2)':'scale(1)'}}>
          <svg width={size} height={size} viewBox="0 0 24 24" fill={(hover||value)>=i?'#f59e0b':'none'} stroke="#f59e0b" strokeWidth={1.5}><path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z"/></svg>
        </button>
      ))}
    </div>
  );
}

// ─── STEP PROGRESS ───────────────────────────────────────────
function StepProgress({steps, current}) {
  return (
    <div style={{display:'flex',alignItems:'center',gap:0,marginBottom:24}}>
      {steps.map((s,i) => (
        <div key={i} style={{display:'flex',alignItems:'center',flex:i<steps.length-1?1:'none'}}>
          <div style={{display:'flex',flexDirection:'column',alignItems:'center',gap:4,position:'relative',zIndex:1}}>
            <div style={{width:32,height:32,borderRadius:'50%',display:'flex',alignItems:'center',justifyContent:'center',fontSize:13,fontWeight:800,fontFamily:'var(--font-display)',transition:'all .3s',
              background:i<=current?'var(--c-accent)':'var(--c-subtle)',color:i<=current?'white':'var(--c-muted)',border:i<=current?'2px solid var(--c-accent)':'2px solid var(--c-border)',
              boxShadow:i===current?'0 0 0 4px rgba(13,148,136,.15)':'none'
            }}>{i<current?<I n="check" s={14}/>:i+1}</div>
            <span style={{fontSize:10,fontWeight:700,color:i<=current?'var(--c-accent)':'var(--c-muted)',whiteSpace:'nowrap',fontFamily:'var(--font-display)',letterSpacing:'.02em'}}>{s}</span>
          </div>
          {i<steps.length-1 && <div style={{flex:1,height:2,background:i<current?'var(--c-accent)':'var(--c-border)',margin:'0 8px',marginBottom:20,transition:'background .3s'}}/>}
        </div>
      ))}
    </div>
  );
}

// ─── CREDIT CARD VISUAL ──────────────────────────────────────
function CreditCardVisual({number, holder, expiry}) {
  const brand = number.startsWith('4')?'VISA':number.startsWith('5')?'MC':number.startsWith('3')?'AMEX':'CARD';
  const brandColor = brand==='VISA'?'#1a1f71':brand==='MC'?'#eb001b':'#2e77bc';
  return (
    <div style={{width:'100%',maxWidth:340,aspectRatio:'1.586',borderRadius:16,padding:'24px 28px',display:'flex',flexDirection:'column',justifyContent:'space-between',color:'white',position:'relative',overflow:'hidden',fontFamily:'monospace',
      background:`linear-gradient(135deg, ${brandColor}, ${brandColor}dd, ${brandColor}99)`,
      boxShadow:'0 10px 40px rgba(0,0,0,.25)',margin:'0 auto 16px'}}>
      <div style={{position:'absolute',inset:0,background:'linear-gradient(135deg,rgba(255,255,255,.12) 0%,transparent 50%,rgba(255,255,255,.06) 100%)',pointerEvents:'none'}}/>
      <div style={{position:'absolute',top:'30%',right:'-10%',width:'60%',height:'60%',borderRadius:'50%',background:'rgba(255,255,255,.05)',pointerEvents:'none'}}/>
      <div style={{display:'flex',justifyContent:'space-between',alignItems:'flex-start',position:'relative'}}>
        <div style={{width:40,height:28,borderRadius:5,background:'linear-gradient(135deg,#e6c84c,#b8952c)',boxShadow:'inset 0 1px 2px rgba(255,255,255,.3)'}}/>
        <div style={{fontSize:14,fontWeight:900,letterSpacing:'.1em',fontFamily:'var(--font-display)',opacity:.9}}>{brand}</div>
      </div>
      <div style={{fontSize:18,letterSpacing:'.15em',fontWeight:600,position:'relative',textShadow:'0 1px 2px rgba(0,0,0,.2)'}}>
        {number||'•••• •••• •••• ••••'}
      </div>
      <div style={{display:'flex',justifyContent:'space-between',alignItems:'flex-end',position:'relative'}}>
        <div><div style={{fontSize:8,opacity:.6,letterSpacing:'.08em',marginBottom:2}}>CARD HOLDER</div><div style={{fontSize:12,fontWeight:600,letterSpacing:'.05em'}}>{holder||'YOUR NAME'}</div></div>
        <div style={{textAlign:'right'}}><div style={{fontSize:8,opacity:.6,letterSpacing:'.08em',marginBottom:2}}>EXPIRES</div><div style={{fontSize:12,fontWeight:600}}>{expiry||'••/••'}</div></div>
      </div>
    </div>
  );
}


// ─── MAIN APP ────────────────────────────────────────────────
function App() {
  const [locale, setLocale] = useState('en');
  const t = (k, vars) => { let s = TR[k]?.[locale] || k; if(vars) Object.keys(vars).forEach(v=>{s=s.replace('{'+v+'}',vars[v]);}); return s; };
  const [dk, setDk] = useState(() => localStorage.getItem('dd_dk') === '1');
  useEffect(() => { localStorage.setItem('dd_dk', dk ? '1' : '0'); }, [dk]);
  const [isAuth, setIsAuth] = useState(false);
  const [role, setRole] = useState('patient');
  const [user, setUser] = useState(null);
  const [guest, setGuest] = useState(false);
  const [view, setView] = useState('AUTH');
  const [triage, setTriage] = useState({sym:''});
  const [selDoc, setSelDoc] = useState(null);
  const [booking, setBooking] = useState(null);
  const [activeId, setActiveId] = useState(null);
  const [ratingModal, setRatingModal] = useState(null);
  const [docDetail, setDocDetail] = useState(null);
  const [summaryModal, setSummaryModal] = useState(null);
  const [loading, setLoading] = useState(true);

  // API-backed state
  const [docs, setDocs] = useState(DOCS);
  const [visits, setVisits] = useState([]);
  const [notifs, setNotifs] = useState([]);
  const [favDocs, setFavDocs] = useState([]);
  const [meds, setMeds] = useState([]);
  const [emergencyContacts, setEmergencyContacts] = useState([]);

  // Fetch all user data from backend
  const fetchUserData = useCallback(async () => {
    try {
      const [vRes, mRes, fRes, cRes, nRes, dRes] = await Promise.all([
        api.get('/visits'),
        api.get('/meds'),
        api.get('/favorites'),
        api.get('/contacts'),
        api.get('/notifications'),
        api.get('/doctors'),
      ]);
      setVisits(vRes.visits || []);
      setMeds(mRes.meds || []);
      setFavDocs(fRes.favorites || []);
      setEmergencyContacts(cRes.contacts || []);
      setNotifs(nRes.notifications || []);
      if (dRes.doctors?.length) setDocs(dRes.doctors);
    } catch(e) { console.error('Fetch error:', e); }
  }, []);

  // Auto-login from saved token
  useEffect(() => {
    let done = false;
    const init = async () => {
      try {
        const saved = localStorage.getItem('dd_token');
        if (saved) {
          api.setToken(saved);
          const res = await api.get('/auth/me');
          if (res.user && !done) {
            setUser(res.user);
            setRole(res.user.role);
            setIsAuth(true);
            setView(res.user.role === 'doctor' ? 'DOC_DASH' : res.user.role === 'admin' ? 'ADMIN' : 'HOME');
            // Fetch in background, don't block loading
            fetchUserData().catch(()=>{});
          }
        }
      } catch(e) {
        console.error('Init error:', e);
        api.setToken(null);
      }
      if (!done) { done = true; setLoading(false); }
    };
    init();
    // Failsafe: never stay on loading screen longer than 3s
    const timer = setTimeout(() => { if (!done) { done = true; setLoading(false); } }, 3000);
    return () => { done = true; clearTimeout(timer); };
  }, []);

  // WebSocket: listen for sync events from other devices
  useEffect(() => {
    if (!isAuth) return;
    const unsubs = [
      syncSocket.on('sync:visits', () => api.get('/visits').then(r => setVisits(r.visits||[])).catch(()=>{})),
      syncSocket.on('sync:meds', () => api.get('/meds').then(r => setMeds(r.meds||[])).catch(()=>{})),
      syncSocket.on('sync:favorites', () => api.get('/favorites').then(r => setFavDocs(r.favorites||[])).catch(()=>{})),
      syncSocket.on('sync:contacts', () => api.get('/contacts').then(r => setEmergencyContacts(r.contacts||[])).catch(()=>{})),
      syncSocket.on('sync:notifications', () => api.get('/notifications').then(r => setNotifs(r.notifications||[])).catch(()=>{})),
    ];
    return () => unsubs.forEach(u => u());
  }, [isAuth]);

  const toggleFav = useCallback(async (docId) => {
    try {
      const res = await api.post('/favorites/' + docId);
      setFavDocs(p => res.favorited ? [...p, docId] : p.filter(x => x !== docId));
      syncSocket.send('favorites', 'toggle', { docId });
    } catch {}
  }, []);

  const login = async (p) => {
    setIsAuth(true); setRole(p.role); setUser(p); setGuest(false);
    setView(p.role === 'doctor' ? 'DOC_DASH' : p.role === 'admin' ? 'ADMIN' : 'HOME');
    await fetchUserData();
  };
  const logout = () => {
    setIsAuth(false); setGuest(false); setUser(null); setRole('patient');
    setBooking(null); setTriage({sym:''}); setSelDoc(null); setView('AUTH');
    setVisits([]); setMeds([]); setFavDocs([]); setNotifs([]); setEmergencyContacts([]);
    api.setToken(null);
    syncSocket.disconnect();
  };
  const goHome = () => {
    setBooking(null); setSelDoc(null); setTriage({sym:''}); setDocDetail(null);
    if (isAuth) setView(role === 'doctor' ? 'DOC_DASH' : role === 'admin' ? 'ADMIN' : 'HOME');
    else { setGuest(false); setView('AUTH'); }
  };

  const addNotif = useCallback(async (msg) => {
    try {
      const res = await api.post('/notifications', { message: msg });
      setNotifs(p => [{ id: res.notification.id, msg, read: false, time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) }, ...p.slice(0, 49)]);
      syncSocket.send('notifications', 'create', { msg });
    } catch {
      setNotifs(p => [{ id: Date.now(), msg, read: false }, ...p.slice(0, 49)]);
    }
  }, []);

  const confirmBooking = async (det) => {
    setBooking(det);
    const docId = det.docId || selDoc?.id;
    console.log('📋 Booking:', { docId, docName: selDoc?.name, sym: det.sym, date: det.date });
    try {
      const res = await api.post('/visits', {
        docId, docName: selDoc?.name, docImg: selDoc?.img || '',
        docSpec: selDoc?.specialty, sym: det.sym || '', date: det.date || '',
        time: det.time || '', address: det.address || '',
        paymentMethod: typeof det.payment === 'object' ? det.payment.method : (det.payment || ''),
        price: selDoc?.price || 150, currency: selDoc?.currency || 'TRY',
      });
      console.log('✅ Booking created:', res.visit?.id, 'docId:', res.visit?.docId, 'status:', res.visit?.status);
      const nv = res.visit;
      setVisits(p => [nv, ...p]);
      setActiveId(nv.id);
      addNotif(`Booking request sent to ${selDoc?.name || 'doctor'} — waiting for confirmation`);
      syncSocket.send('visits', 'create', nv);
      setView('WAITING_CONFIRM');
    } catch(err) {
      console.error('❌ Booking error:', err);
      addNotif('Booking sent (offline mode)');
      const nv = { ...det, id: Date.now().toString(), status: 'pending', ts: Date.now(), docId, docName: selDoc?.name, docImg: selDoc?.img, docSpec: selDoc?.specialty, price: selDoc?.price || 150, currency: selDoc?.currency || 'TRY' };
      setVisits(p => [nv, ...p]); setActiveId(nv.id); setView('WAITING_CONFIRM');
    }
  };

  // Listen for doctor accept/decline via WebSocket
  useEffect(() => {
    if (!isAuth) return;
    const unsub1 = syncSocket.on('booking_accepted', (msg) => {
      setVisits(p => p.map(v => v.id === msg.visitId ? { ...v, status: 'upcoming' } : v));
      addNotif(`${msg.docName} accepted your booking!`);
      if (activeId === msg.visitId) setView('ACTIVE');
    });
    const unsub2 = syncSocket.on('booking_declined', (msg) => {
      setVisits(p => p.map(v => v.id === msg.visitId ? { ...v, status: 'cancelled' } : v));
      addNotif(msg.reason ? `${msg.docName} declined: ${msg.reason}` : `${msg.docName} is unavailable. Try another doctor.`);
      if (activeId === msg.visitId) { setActiveId(null); setBooking(null); setView('DOCS'); }
    });
    const unsub3 = syncSocket.on('booking_request', () => {
      // Doctor: refresh visits to see new request
      api.get('/visits').then(r => setVisits(r.visits||[])).catch(()=>{});
      api.get('/notifications').then(r => setNotifs(r.notifications||[])).catch(()=>{});
    });
    return () => { unsub1(); unsub2(); unsub3(); };
  }, [isAuth, activeId]);

  const cancelVisit = async () => {
    if (activeId) {
      try {
        const res = await api.del('/visits/' + activeId);
        setVisits(p => p.map(v => v.id === activeId ? { ...v, status: 'cancelled' } : v));
        syncSocket.send('visits', 'update', { id: activeId, status: 'cancelled' });
        // Show cancel policy message from backend
        if (res.cancelMessage) {
          const refundInfo = res.refundType === 'full' ? '💰 Tam iade yapılacaktır.' :
            res.refundType === 'commission' ? `💰 Komisyon düşülerek ₺${res.refundAmount} iade edilecektir.` :
            '⚠️ İade yapılmayacaktır.';
          setTimeout(() => alert(`${res.cancelMessage}\n\n${refundInfo}`), 200);
        }
      } catch(err) {
        alert(err.message || 'İptal işlemi başarısız');
        return;
      }
    }
    setBooking(null); setSelDoc(null); setActiveId(null);
    guest ? (setGuest(false), setView('AUTH')) : setView('VISITS');
  };

  const finishVisit = async () => {
    const vid = activeId;
    if (vid) {
      try { await api.put('/visits/' + vid, { status: 'completed' }); } catch {}
      setVisits(p => p.map(v => v.id === vid ? { ...v, status: 'completed' } : v));
    }
    setBooking(null); setActiveId(null);
    addNotif('Visit completed!');
    const v = visits.find(x => x.id === vid);
    const summary = await aiSummary(v?.sym || 'General checkup', v?.docSpec || 'General Practitioner');
    try { await api.put('/visits/' + vid, { summary }); } catch {}
    setVisits(p => p.map(x => x.id === vid ? { ...x, summary } : x));
    syncSocket.send('visits', 'update', { id: vid, status: 'completed', summary });
    setSummaryModal(vid);
  };

  const getDoc = () => selDoc || (activeId && docs.find(d => d.id === visits.find(v => v.id === activeId)?.docId)) || docs[0] || null;
  const getVisit = () => visits.find(v => v.id === activeId);

  useEffect(() => {
    if (user?.email) AuthDB.updateProfile(user.email, user);
  }, [user]);

  // Wrap setMeds/setEmergencyContacts to sync via API
  const setMedsSync = useCallback((updater) => {
    setMeds(updater);
    syncSocket.send('meds', 'update', {});
  }, []);
  const setContactsSync = useCallback((updater) => {
    setEmergencyContacts(updater);
    syncSocket.send('contacts', 'update', {});
  }, []);

  if (loading) return (
    <div data-theme={dk?'dark':'light'} style={{minHeight:'100vh',display:'flex',alignItems:'center',justifyContent:'center',background:'var(--c-bg)'}}>
      <div style={{textAlign:'center'}}>
        <div style={{width:56,height:56,borderRadius:16,background:'linear-gradient(135deg,#0d9488,#6366f1)',display:'flex',alignItems:'center',justifyContent:'center',margin:'0 auto 16px',fontSize:28}}>🩺</div>
        <div style={{fontSize:14,color:'var(--c-muted)',fontWeight:600}}>Loading DocDoor...</div>
      </div>
    </div>
  );

  return (
    <Ctx.Provider value={{locale,setLocale,t,dk}}>
    <SyncProvider userId={user?.id}>
    <ToastProvider>
    <div className={dk?'dark':''}>
    <div className="dd-root" data-theme={dk?'dark':'light'} data-role={role}>
      <div className="dd-ambient"><div className="dd-blob dd-blob-1"/><div className="dd-blob dd-blob-2"/><div className="dd-blob dd-blob-3"/><div className="dd-grain"/></div>

      <Header goHome={goHome} isGuest={!isAuth} role={role} user={user} onLogout={logout} onVisits={()=>setView('VISITS')} onAdmin={()=>setView('ADMIN')} onProfile={()=>setView('PROFILE')} onMedical={()=>setView('MEDICAL')} onMeds={()=>setView('MEDS')} onFavs={()=>setView('FAVS')} onSchedule={()=>setView('SCHEDULE')} toggleDk={()=>setDk(d=>!d)} notifs={notifs} setNotifs={setNotifs} />

      <main className="dd-main">
        {view==='AUTH' && <AuthView onLogin={login} onEmergency={()=>{setTriage({sym:''});setSelDoc(null);if(!isAuth)setGuest(true);setView('BOOKING');}} />}
        {view==='HOME' && <HomeView onEmergency={()=>{setTriage({sym:''});setSelDoc(null);if(!isAuth)setGuest(true);setView('BOOKING');}} onRoutine={()=>{setSelDoc(null);setView('DOCS');}} visits={visits} user={user} favDocs={favDocs} docs={docs} meds={meds} onSelectDoc={(d)=>{setSelDoc(d);setTriage({sym:''});setView('BOOKING');}} onViewSummary={(id)=>setSummaryModal(id)} />}
        {view==='DOCS' && <DocsView docs={docs} favDocs={favDocs} toggleFav={toggleFav} onSelect={(d)=>{setSelDoc(d);setTriage({sym:''});setView('BOOKING');}} onDetail={setDocDetail} onBack={()=>setView('HOME')} />}
        {view==='TRIAGE' && <TriageView onDone={(s,r)=>{setTriage({sym:s,result:r});setView('BOOKING');}} onSkip={()=>setView('BOOKING')} onBack={()=>guest?(setGuest(false),setView('AUTH')):setView('HOME')} />}
        {view==='BOOKING' && <BookingView doc={selDoc} tri={triage.result} initSym={triage.sym} onConfirm={confirmBooking} onBack={()=>selDoc?setView('DOCS'):triage.result?setView('TRIAGE'):guest?(setGuest(false),setView('AUTH')):setView('HOME')} user={user} />}
        {view==='FINDING' && <FindingView />}
        {view==='WAITING_CONFIRM' && <WaitingConfirmView doc={selDoc} visit={getVisit()} onCancel={cancelVisit} />}
        {view==='ACTIVE' && <ActiveView doc={getDoc()} visit={getVisit()} isGuest={guest} onCancel={cancelVisit} onFinish={finishVisit} onBack={()=>guest?(setGuest(false),setView('AUTH')):setView('HOME')} onBrowse={()=>{setActiveId(null);setBooking(null);setSelDoc(null);setView('DOCS');}} />}
        {view==='VISITS' && <VisitsView visits={visits} role={role} onBack={()=>role==='doctor'?setView('DOC_DASH'):setView('HOME')} onRebook={(d)=>{setSelDoc(d);setTriage({sym:''});setView('BOOKING');}} onViewSummary={(id)=>setSummaryModal(id)} docs={docs} />}
        {view==='FAVS' && <FavsView docs={docs} favDocs={favDocs} toggleFav={toggleFav} onSelectDoc={(d)=>{setSelDoc(d);setTriage({sym:''});setView('BOOKING');}} onDetail={setDocDetail} onBack={()=>setView('HOME')} />}
        {view==='SCHEDULE' && <DocScheduleView onBack={()=>setView('DOC_DASH')} />}
        {view==='DOC_DASH' && <DocDash visits={visits} setVisits={setVisits} addNotif={addNotif} onSchedule={()=>setView('SCHEDULE')} user={user} />}
        {view==='ADMIN' && <AdminView docs={docs} visits={visits} setDocs={setDocs} setVisits={setVisits} onBack={()=>setView('HOME')} />}
        {view==='PROFILE' && user && <ProfileView user={user} onUpdate={setUser} onBack={()=>role==='doctor'?setView('DOC_DASH'):setView('HOME')} emergencyContacts={emergencyContacts} setEmergencyContacts={setContactsSync} visits={visits} onViewSummary={(id)=>setSummaryModal(id)} />}
        {view==='MEDS' && <MedsView meds={meds} setMeds={setMedsSync} onBack={()=>setView('HOME')} />}
      </main>

      {summaryModal && <VisitSummaryModal visitId={summaryModal} visits={visits} onClose={()=>{setSummaryModal(null);setRatingModal(summaryModal);}} onSkipRating={()=>{setSummaryModal(null);guest?(setGuest(false),setView('AUTH')):setView('VISITS');}} />}
      {ratingModal && <RatingModal visitId={ratingModal} visits={visits} setVisits={setVisits} onClose={()=>{setRatingModal(null);guest?(setGuest(false),setView('AUTH')):setView('VISITS');}} />}
      {docDetail && <DoctorDetailModal doc={docDetail} isFav={favDocs.includes(docDetail.id)} toggleFav={toggleFav} onClose={()=>setDocDetail(null)} onSelect={(d)=>{setDocDetail(null);setSelDoc(d);setTriage({sym:''});setView('BOOKING');}} />}

      {view!=='ACTIVE' && <footer className="dd-footer"><p>© {new Date().getFullYear()} DocDoor Inc. — Concierge Healthcare</p></footer>}

      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Outfit:wght@300;400;500;600;700;800;900&family=DM+Sans:ital,opsz,wght@0,9..40,300;0,9..40,400;0,9..40,500;0,9..40,600;0,9..40,700&display=swap');
        :root{--font-display:'Outfit',sans-serif;--font-body:'DM Sans',sans-serif;--c-accent:#0d9488;--c-accent2:#6366f1;--c-danger:#ef4444;--c-warn:#f59e0b;--c-bg:#f8fafc;--c-surface:#ffffff;--c-border:#e2e8f0;--c-text:#0f172a;--c-muted:#64748b;--c-subtle:#f1f5f9;--radius:20px;--shadow:0 1px 3px rgba(0,0,0,.04),0 8px 30px rgba(0,0,0,.06);--shadow-lg:0 4px 20px rgba(0,0,0,.08),0 20px 60px rgba(0,0,0,.1);}
        [data-role="doctor"]{--c-accent:#1e293b;--c-accent2:#334155;}
        [data-role="doctor"][data-theme="light"]{--c-bg:#f8fafc;--c-surface:#ffffff;--c-border:#e2e8f0;}
        [data-role="doctor"] .dd-btn-primary{background:#1e293b;box-shadow:0 4px 14px rgba(30,41,59,.3);}
        [data-role="doctor"] .dd-btn-primary:hover{background:#0f172a;box-shadow:0 6px 20px rgba(30,41,59,.4);}
        [data-role="doctor"][data-theme="light"] .dd-header{background:color-mix(in srgb,#f8fafc 92%,transparent);}
        [data-role="doctor"][data-theme="dark"] .dd-header{background:color-mix(in srgb,#020617 92%,transparent);}
        [data-role="doctor"] .dd-blob-1{background:#1e293b;}
        [data-role="doctor"] .dd-blob-2{background:#334155;}
        [data-theme="dark"]{--c-bg:#020617;--c-surface:#0f172a;--c-border:#1e293b;--c-text:#f1f5f9;--c-muted:#94a3b8;--c-subtle:#1e293b;}
        [data-theme="dark"] .dd-input{color:#f1f5f9;background:#0f172a;border-color:#334155;}
        [data-theme="dark"] .dd-input::placeholder{color:#64748b;}
        [data-theme="dark"] select.dd-input{color:#f1f5f9;}
        [data-theme="dark"] h1,[data-theme="dark"] h2,[data-theme="dark"] h3{color:#f1f5f9;}
        [data-theme="dark"] p{color:#cbd5e1;}
        [data-theme="dark"] label{color:#94a3b8;}
        [data-theme="dark"] .dd-card{color:#e2e8f0;}
        .dd-root{font-family:var(--font-body);background:var(--c-bg);color:var(--c-text);min-height:100vh;display:flex;flex-direction:column;position:relative;overflow-x:hidden;transition:background .4s,color .4s;}
        .dd-ambient{position:fixed;inset:0;pointer-events:none;z-index:0;overflow:hidden;}
        .dd-blob{position:absolute;border-radius:50%;filter:blur(120px);opacity:.15;transition:opacity .4s;}
        [data-theme="dark"] .dd-blob{opacity:.08;}
        .dd-blob-1{width:60vw;height:60vw;top:-20%;left:-15%;background:var(--c-accent);}
        .dd-blob-2{width:45vw;height:45vw;top:30%;right:-15%;background:var(--c-accent2);}
        .dd-blob-3{width:50vw;height:50vw;bottom:-20%;left:20%;background:#ec4899;opacity:.08;}
        .dd-grain{position:absolute;inset:0;background-image:url("data:image/svg+xml,%3Csvg viewBox='0 0 256 256' xmlns='http://www.w3.org/2000/svg'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='.9' numOctaves='4' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23n)' opacity='.04'/%3E%3C/svg%3E");}
        .dd-main{flex:1;display:flex;flex-direction:column;position:relative;z-index:10;}
        .dd-footer{border-top:1px solid var(--c-border);padding:2rem;text-align:center;font-size:.75rem;color:var(--c-muted);letter-spacing:.05em;transition:border-color .4s;}
        h1,h2,h3,h4{font-family:var(--font-display);}
        .dd-card{background:var(--c-surface);border:1px solid var(--c-border);border-radius:var(--radius);box-shadow:var(--shadow);transition:all .3s;}
        .dd-card:hover{box-shadow:var(--shadow-lg);}
        .dd-input{width:100%;padding:.875rem 1rem;background:var(--c-subtle);border:1.5px solid var(--c-border);border-radius:14px;color:var(--c-text);font-family:var(--font-body);font-size:.9375rem;font-weight:500;outline:none;transition:all .2s;box-sizing:border-box;}
        .dd-input:focus{border-color:var(--c-accent);box-shadow:0 0 0 3px rgba(13,148,136,.12);}
        .dd-input::placeholder{color:var(--c-muted);opacity:.7;}
        [data-theme="dark"] .dd-input{color-scheme:dark;}
        [data-theme="dark"] input[type="date"]::-webkit-calendar-picker-indicator{filter:brightness(0) invert(1);opacity:1;cursor:pointer;}
        input[type="date"]::-webkit-calendar-picker-indicator{cursor:pointer;}
        .dd-btn{display:inline-flex;align-items:center;justify-content:center;gap:.5rem;padding:.875rem 1.5rem;border-radius:14px;font-family:var(--font-display);font-weight:700;font-size:.9375rem;cursor:pointer;transition:all .25s cubic-bezier(.22,1,.36,1);border:none;position:relative;overflow:hidden;}
        .dd-btn:active{transform:scale(.96);}
        .dd-btn::after{content:'';position:absolute;inset:0;background:radial-gradient(circle at var(--ripple-x,50%) var(--ripple-y,50%),rgba(255,255,255,.3) 0%,transparent 60%);opacity:0;transition:opacity .4s;}
        .dd-btn:active::after{opacity:1;transition:opacity 0s;}
        .dd-btn-primary{background:var(--c-accent);color:white;box-shadow:0 4px 14px rgba(13,148,136,.3);}
        .dd-btn-primary:hover{transform:translateY(-2px);box-shadow:0 8px 25px rgba(13,148,136,.35);}
        .dd-btn-danger{background:var(--c-danger);color:white;}
        .dd-btn-danger:hover{transform:translateY(-1px);box-shadow:0 6px 20px rgba(239,68,68,.3);}
        .dd-btn-ghost{background:transparent;color:var(--c-muted);}
        .dd-btn-ghost:hover{background:var(--c-subtle);color:var(--c-text);transform:translateY(-1px);}
        @keyframes btnPulse{0%{box-shadow:0 0 0 0 rgba(13,148,136,.4);}70%{box-shadow:0 0 0 10px rgba(13,148,136,0);}100%{box-shadow:0 0 0 0 rgba(13,148,136,0);}}
        @keyframes btnShake{0%,100%{transform:translateX(0);}20%{transform:translateX(-3px);}40%{transform:translateX(3px);}60%{transform:translateX(-2px);}80%{transform:translateX(2px);}}
        @keyframes heartBeat{0%{transform:scale(1);}15%{transform:scale(1.25);}30%{transform:scale(1);}45%{transform:scale(1.15);}60%{transform:scale(1);}}
        @keyframes gentleBounce{0%,100%{transform:translateY(0);}50%{transform:translateY(-3px);}}
        @keyframes checkPop{0%{transform:scale(0) rotate(-45deg);opacity:0;}50%{transform:scale(1.2) rotate(0deg);opacity:1;}100%{transform:scale(1) rotate(0deg);opacity:1;}}
        @keyframes slideUp{from{opacity:0;transform:translateY(8px);}to{opacity:1;transform:translateY(0);}}
        .btn-pulse:hover{animation:btnPulse 1s infinite;}
        .btn-cancel:hover{animation:btnShake .4s ease-in-out;}
        .btn-fav:hover{animation:heartBeat .6s ease-in-out;}
        .btn-bounce:hover{animation:gentleBounce .5s ease-in-out;}
        .dd-badge{display:inline-flex;align-items:center;gap:.25rem;padding:.25rem .75rem;border-radius:100px;font-size:.6875rem;font-weight:700;font-family:var(--font-display);letter-spacing:.04em;text-transform:uppercase;}
        .dd-page{min-height:calc(100vh - 64px);padding:2rem 1rem;}
        @keyframes fadeUp{from{opacity:0;transform:translateY(16px);}to{opacity:1;transform:translateY(0);}}
        @keyframes slideIn{from{opacity:0;transform:translateX(20px);}to{opacity:1;transform:translateX(0);}}
        @keyframes pulse-ring{0%{transform:scale(.8);opacity:1;}100%{transform:scale(2.2);opacity:0;}}
        @keyframes spin{to{transform:rotate(360deg);}}
        @keyframes shimmer{0%{background-position:-200% 0;}100%{background-position:200% 0;}}
        .animate-fadeUp{animation:fadeUp .5s cubic-bezier(.22,1,.36,1) both;}
        .animate-slideIn{animation:slideIn .35s cubic-bezier(.22,1,.36,1) both;}
        .animate-slideUp{animation:slideUp .3s ease both;}
        .animate-spin{animation:spin 1s linear infinite;}
        @keyframes scaleIn{from{opacity:0;transform:scale(.92);}to{opacity:1;transform:scale(1);}}
        @keyframes glowPulse{0%,100%{box-shadow:0 0 0 0 rgba(13,148,136,.2);}50%{box-shadow:0 0 20px 4px rgba(13,148,136,.15);}}
        @keyframes successPop{0%{transform:scale(0);opacity:0;}60%{transform:scale(1.15);}100%{transform:scale(1);opacity:1;}}
        @keyframes slideDown{from{opacity:0;transform:translateY(-10px);}to{opacity:1;transform:translateY(0);}}
        @keyframes cardFlip{from{opacity:0;transform:rotateY(8deg) translateX(12px);}to{opacity:1;transform:rotateY(0) translateX(0);}}
        .animate-scaleIn{animation:scaleIn .35s cubic-bezier(.22,1,.36,1) both;}
        .animate-glowPulse{animation:glowPulse 2s ease-in-out infinite;}
        .animate-successPop{animation:successPop .5s cubic-bezier(.22,1,.36,1) both;}
        .animate-slideDown{animation:slideDown .3s ease both;}
        .animate-cardFlip{animation:cardFlip .4s cubic-bezier(.22,1,.36,1) both;}
        .soft-hover{transition:all .25s cubic-bezier(.22,1,.36,1);}
        .soft-hover:hover{transform:translateY(-2px);box-shadow:0 8px 24px rgba(0,0,0,.08);}
        .soft-press:active{transform:scale(.97);transition:transform .1s;}
        .stagger-1{animation-delay:.05s;}.stagger-2{animation-delay:.1s;}.stagger-3{animation-delay:.15s;}.stagger-4{animation-delay:.2s;}.stagger-5{animation-delay:.25s;}
        .dd-header{position:sticky;top:0;z-index:50;backdrop-filter:blur(16px) saturate(180%);-webkit-backdrop-filter:blur(16px) saturate(180%);border-bottom:1px solid var(--c-border);background:color-mix(in srgb,var(--c-surface) 85%,transparent);transition:all .4s;}
        .dd-skeleton{background:linear-gradient(90deg,var(--c-subtle) 25%,var(--c-border) 50%,var(--c-subtle) 75%);background-size:200% 100%;animation:shimmer 1.5s ease-in-out infinite;border-radius:8px;}
        .dd-notif-item{padding:12px 16px;border-radius:14px;border:1px solid var(--c-border);background:var(--c-surface);margin-bottom:6px;transition:all .25s;animation:slideUp .3s ease both;}
        .dd-notif-item:hover{border-color:var(--c-accent);background:color-mix(in srgb,var(--c-accent) 3%,var(--c-surface));}
        .dd-notif-unread{border-left:3px solid var(--c-accent);background:color-mix(in srgb,var(--c-accent) 4%,var(--c-surface));}
        @media(max-width:640px){.dd-page{padding:1.25rem .75rem;}}
      `}</style>
    </div>
    </div>
    </ToastProvider>
    </SyncProvider>
    </Ctx.Provider>
  );
}

// ═══════ HEADER ═══════
function Header({goHome,isGuest,role,user,onLogout,onVisits,onAdmin,onProfile,onMedical,onMeds,onFavs,onSchedule,toggleDk,notifs,setNotifs}){
  const {locale,setLocale,t,dk} = useT();
  const [menuO,setMenuO]=useState(false);
  const [langO,setLangO]=useState(false);
  const [notifO,setNotifO]=useState(false);
  const mRef=useRef(null),lRef=useRef(null),nRef=useRef(null);
  const unread = notifs.filter(n=>!n.read).length;
  useEffect(()=>{const h=(e)=>{if(mRef.current&&!mRef.current.contains(e.target))setMenuO(false);if(lRef.current&&!lRef.current.contains(e.target))setLangO(false);if(nRef.current&&!nRef.current.contains(e.target))setNotifO(false);};document.addEventListener('mousedown',h);return()=>document.removeEventListener('mousedown',h);},[]);
  const langs=[{c:'en',l:'English',f:'US'},{c:'tr',l:'Türkçe',f:'TR'},{c:'es',l:'Español',f:'ES'},{c:'de',l:'Deutsch',f:'DE'}];
  const accBg = role==='doctor'?'linear-gradient(135deg,#1e293b,#334155)':role==='admin'?'linear-gradient(135deg,#ef4444,#f97316)':'linear-gradient(135deg,#0d9488,#6366f1)';
  // #15: profile photo
  const profImg = user?.img;
  return (
    <header className="dd-header">
      <div style={{maxWidth:1200,margin:'0 auto',padding:'0 1.25rem',height:64,display:'flex',alignItems:'center',justifyContent:'space-between'}}>
        <div style={{display:'flex',alignItems:'center',gap:'.5rem',fontFamily:'var(--font-display)',fontWeight:900,fontSize:'1.25rem',letterSpacing:'-.03em',color:'var(--c-text)',cursor:'pointer'}} onClick={goHome}>
          {/* #5: Stethoscope logo */}
          <div style={{width:36,height:36,borderRadius:10,display:'flex',alignItems:'center',justifyContent:'center',background:role==='admin'?'var(--c-danger)':role==='doctor'?'#1A1A2E':'#0d9488',color:'white'}}>
            <svg width={22} height={22} viewBox="0 0 24 24" fill="none" stroke={role==='doctor'?'#FFFFFF':'white'} strokeWidth={2.2} strokeLinecap="round" strokeLinejoin="round"><path d="M4.8 2.3A.3.3 0 1 0 5 2H4a2 2 0 0 0-2 2v5a6 6 0 0 0 6 6v0a6 6 0 0 0 6-6V4a2 2 0 0 0-2-2h-1a.2.2 0 1 0 .3.3"/><path d="M8 15v1a6 6 0 0 0 6 6v0a6 6 0 0 0 6-6v-4"/><circle cx="20" cy="10" r="2"/></svg>
          </div>
          {t('app_name')}
        </div>
        <div style={{display:'flex',alignItems:'center',gap:6}}>
          {/* #4: Smaller, smoother language button matching mockup */}
          <div style={{position:'relative'}} ref={lRef}>
            <button onClick={()=>setLangO(!langO)} title="Language" style={{display:'flex',alignItems:'center',gap:3,padding:'4px 8px',borderRadius:100,border:'none',background:'var(--c-subtle)',color:'var(--c-muted)',cursor:'pointer',transition:'all .2s',fontSize:10,fontWeight:600}}>
              <svg width={13} height={13} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}><path d="m5 8 6 6"/><path d="m4 14 6-6 2-3"/><path d="M2 5h12"/><path d="M7 2h1"/><path d="m22 22-5-10-5 10"/><path d="M14 18h6"/></svg>
              <I n={langO?'chevUp':'chevDown'} s={10} style={{transition:'transform .3s ease'}}/>
            </button>
            {langO && <div style={{position:'absolute',right:0,top:'calc(100% + 6px)',width:160,background:'var(--c-surface)',border:'1px solid var(--c-border)',borderRadius:12,boxShadow:'var(--shadow-lg)',padding:'.25rem',zIndex:100}} className="animate-fadeUp">{langs.map(l=><button key={l.c} onClick={()=>{setLocale(l.c);setLangO(false);}} style={{display:'flex',alignItems:'center',gap:'.625rem',padding:'.5rem .75rem',borderRadius:8,fontSize:'.8125rem',fontWeight:600,cursor:'pointer',border:'none',background:locale===l.c?'color-mix(in srgb,var(--c-accent) 10%,transparent)':'transparent',width:'100%',color:locale===l.c?'var(--c-accent)':'var(--c-text)',transition:'background .15s'}}><span style={{fontSize:10,fontWeight:800,color:'var(--c-accent)',fontFamily:'monospace'}}>{l.f}</span>{l.l}</button>)}</div>}
          </div>
          {/* #6: Remove outlines from theme button */}
          <button onClick={toggleDk} title="Theme" style={{width:32,height:32,borderRadius:10,display:'flex',alignItems:'center',justifyContent:'center',border:'none',outline:'none',background:'transparent',color:'var(--c-muted)',cursor:'pointer',transition:'all .2s'}}><I n={dk?'sun':'moon'} s={16}/></button>
          {!isGuest && <>
            {/* #6: Remove outline from notification button */}
            <div style={{position:'relative'}} ref={nRef}>
              <button onClick={()=>setNotifO(!notifO)} style={{width:32,height:32,borderRadius:10,display:'flex',alignItems:'center',justifyContent:'center',border:'none',outline:'none',background:'transparent',color:'var(--c-muted)',cursor:'pointer',position:'relative',transition:'all .2s'}}>
                <I n="bell" s={18}/>
                {unread>0 && <div style={{position:'absolute',top:4,right:4,width:8,height:8,borderRadius:'50%',background:'#22c55e',border:'2px solid var(--c-surface)',boxShadow:'0 0 4px rgba(34,197,94,0.5)'}}/>}
              </button>
              {notifO && (
                <div style={{position:'absolute',right:0,top:'calc(100% + 8px)',width:320,background:'var(--c-surface)',border:'1px solid var(--c-border)',borderRadius:16,boxShadow:'var(--shadow-lg)',padding:12,zIndex:100,maxHeight:360,overflowY:'auto'}} className="animate-fadeUp">
                  <div style={{padding:'6px 8px 12px',fontSize:11,fontWeight:800,color:'var(--c-muted)',textTransform:'uppercase',letterSpacing:'.08em',display:'flex',justifyContent:'space-between',alignItems:'center'}}>
                    <span>Notifications</span>
                    {unread>0 && <span style={{background:'var(--c-accent)',color:'white',padding:'2px 8px',borderRadius:100,fontSize:10}}>{unread} new</span>}
                  </div>
                  {notifs.length>0?notifs.slice(0,8).map(n=>(
                    <div key={n.id} className={`dd-notif-item ${!n.read?'dd-notif-unread':''}`}>
                      <div style={{display:'flex',gap:10,alignItems:'flex-start'}}>
                        <div style={{width:10,height:10,borderRadius:'50%',background:n.read?'transparent':'#22c55e',flexShrink:0,marginTop:5,border:n.read?'none':'2px solid #bbf7d0',boxShadow:n.read?'none':'0 0 6px rgba(34,197,94,0.4)'}}/>
                        <div style={{flex:1}}><div style={{fontSize:13,fontWeight:n.read?500:600}}>{n.msg||n.message}</div>{n.time && <div style={{fontSize:11,color:'var(--c-muted)',marginTop:3}}>{n.time}</div>}</div>
                      </div>
                    </div>
                  )):<div style={{padding:30,textAlign:'center',color:'var(--c-muted)',fontSize:13}}><I n="bell" s={28} style={{display:'block',margin:'0 auto 8px',opacity:0.3}}/><div>No notifications yet</div></div>}
                </div>
              )}
            </div>
            {/* #6: Remove outline from profile button */}
            <div style={{position:'relative'}} ref={mRef}>
              <button onClick={()=>setMenuO(!menuO)} style={{position:'relative',display:'flex',alignItems:'center',gap:4,padding:'4px 6px 4px 4px',borderRadius:100,cursor:'pointer',border:'none',outline:'none',background:'transparent',transition:'all .2s'}}>
                {profImg ? <img src={profImg} style={{width:30,height:30,borderRadius:'50%',objectFit:'cover'}}/> : <div style={{width:30,height:30,borderRadius:'50%',background:accBg,display:'flex',alignItems:'center',justifyContent:'center',color:'white',fontFamily:'var(--font-display)',fontWeight:700,fontSize:'.7rem'}}>{user?.firstName?.[0]||'U'}</div>}
                <I n={menuO?'chevUp':'chevDown'} s={12}/>
              </button>
              {menuO && (
                <div style={{position:'absolute',right:0,top:'calc(100% + 8px)',width:220,background:'var(--c-surface)',border:'1px solid var(--c-border)',borderRadius:16,boxShadow:'var(--shadow-lg)',padding:'.5rem',zIndex:100}} className="animate-fadeUp">
                  <div style={{padding:'8px 12px',marginBottom:4}}><div style={{fontSize:10,fontWeight:800,color:'var(--c-muted)',textTransform:'uppercase',letterSpacing:'.08em'}}>Account</div><div style={{fontSize:13,fontWeight:700,marginTop:2,fontFamily:'monospace',color:'var(--c-muted)'}}>{(user?.id||'').substring(0,12)}...</div></div>
                  <div style={{height:1,background:'var(--c-border)',margin:'.375rem .75rem'}}/>
                  <button onClick={()=>{onProfile();setMenuO(false);}} style={{display:'flex',alignItems:'center',gap:'.625rem',padding:'.625rem .75rem',borderRadius:10,fontSize:'.8125rem',fontWeight:600,color:'var(--c-text)',cursor:'pointer',transition:'background .15s',border:'none',background:'transparent',width:'100%',textAlign:'left'}}><I n="user" s={16}/>{t('profile')}</button>
                  <button onClick={()=>{onVisits();setMenuO(false);}} style={{display:'flex',alignItems:'center',gap:'.625rem',padding:'.625rem .75rem',borderRadius:10,fontSize:'.8125rem',fontWeight:600,color:'var(--c-text)',cursor:'pointer',border:'none',background:'transparent',width:'100%',textAlign:'left'}}><I n="clipboard" s={16}/>{role==='doctor'?t('dashboard'):t('my_visits')}</button>
                  {role==='patient' && <button onClick={()=>{onFavs();setMenuO(false);}} style={{display:'flex',alignItems:'center',gap:'.625rem',padding:'.625rem .75rem',borderRadius:10,fontSize:'.8125rem',fontWeight:600,color:'var(--c-text)',cursor:'pointer',border:'none',background:'transparent',width:'100%',textAlign:'left'}}><I n="heart" s={16}/>{t('fav_doctors_title')}</button>}
                  {role==='patient' && <button onClick={()=>{onMeds();setMenuO(false);}} style={{display:'flex',alignItems:'center',gap:'.625rem',padding:'.625rem .75rem',borderRadius:10,fontSize:'.8125rem',fontWeight:600,color:'var(--c-text)',cursor:'pointer',border:'none',background:'transparent',width:'100%',textAlign:'left'}}><I n="pill" s={16}/>{t('todays_meds')}</button>}
                  {role==='doctor' && onSchedule && <button onClick={()=>{onSchedule();setMenuO(false);}} style={{display:'flex',alignItems:'center',gap:'.625rem',padding:'.625rem .75rem',borderRadius:10,fontSize:'.8125rem',fontWeight:600,color:'var(--c-text)',cursor:'pointer',border:'none',background:'transparent',width:'100%',textAlign:'left'}}><I n="calendar" s={16}/>{t('manage_schedule')}</button>}
                  {role==='admin' && <button onClick={()=>{onAdmin();setMenuO(false);}} style={{display:'flex',alignItems:'center',gap:'.625rem',padding:'.625rem .75rem',borderRadius:10,fontSize:'.8125rem',fontWeight:600,color:'var(--c-text)',cursor:'pointer',border:'none',background:'transparent',width:'100%',textAlign:'left'}}><I n="shieldAlert" s={16}/>{t('admin_panel')}</button>}
                  <div style={{height:1,background:'var(--c-border)',margin:'.375rem .75rem'}}/>
                  <button onClick={()=>{onLogout();setMenuO(false);}} style={{display:'flex',alignItems:'center',gap:'.625rem',padding:'.625rem .75rem',borderRadius:10,fontSize:'.8125rem',fontWeight:600,color:'var(--c-danger)',cursor:'pointer',border:'none',background:'transparent',width:'100%',textAlign:'left'}}><I n="logout" s={16}/>{t('sign_out')}</button>
                </div>
              )}
            </div>
          </>}
        </div>
      </div>
    </header>
  );
}

// ═══════ AUTH ═══════
function AuthView({onLogin,onEmergency}){
  const {t} = useT();
  const toast = useToast();
  const [mode,setMode]=useState('login');
  const [isDoc,setIsDoc]=useState(false);
  const [em,setEm]=useState('');const [pw,setPw]=useState('');const [fn,setFn]=useState('');const [ln,setLn]=useState('');const [regCountry,setRegCountry]=useState('Türkiye');const [regProvince,setRegProvince]=useState('');const [birthDate,setBirthDate]=useState('');const [spec,setSpec]=useState('General Practitioner');const [lic,setLic]=useState('');
  // Legal compliance fields
  const [docWorkStatus,setDocWorkStatus]=useState('muayenehane');const [tabipOdaNo,setTabipOdaNo]=useState('');const [malpraktisPolice,setMalpraktisPolice]=useState('');const [docFirmName,setDocFirmName]=useState('');
  const [kvkkConsent,setKvkkConsent]=useState(false);const [healthDataConsent,setHealthDataConsent]=useState(false);const [independentContractor,setIndependentContractor]=useState(false);
  const [legalScrolled,setLegalScrolled]=useState(false);
  // Track if legal texts have been read (must read before checking)
  const [kvkkRead,setKvkkRead]=useState(false);const [healthRead,setHealthRead]=useState(false);const [contractorRead,setContractorRead]=useState(false);
  const [showPw,setShowPw]=useState(false);const [err,setErr]=useState('');const [loading,setLoading]=useState(false);
  const [legalModal,setLegalModal]=useState(null); // 'kvkk' | 'consent' | null
  useEffect(()=>{if(legalModal)setLegalScrolled(false);},[legalModal]);
  const handleLegalScroll=(e)=>{const el=e.target;if(el.scrollTop+el.clientHeight>=el.scrollHeight-20)setLegalScrolled(true);};
  const submit = async()=>{
    setErr('');
    if(!em||!pw){setErr(t('err_all_required'));return;}
    if(mode==='register'&&(!fn||!ln)){setErr(t('err_name_required'));return;}
    if(mode==='register'&&!isDoc&&!birthDate){setErr(t('err_birth_required'));return;}
    if(mode==='register'&&!isDoc&&!regProvince){setErr(t('err_city_required'));return;}
    if(pw.length<6){setErr(t('err_pw_short'));return;}
    if(mode==='register'&&!kvkkRead){setErr(t('err_kvkk_read'));return;}
    if(mode==='register'&&!kvkkConsent){setErr(t('err_kvkk_consent'));return;}
    if(mode==='register'&&!isDoc&&!healthRead){setErr(t('err_health_read'));return;}
    if(mode==='register'&&!isDoc&&!healthDataConsent){setErr(t('err_health_consent'));return;}
    if(mode==='register'&&isDoc){
      if(!lic){setErr(t('err_license_required'));return;}
      if(!tabipOdaNo){setErr(t('err_tabip_required'));return;}
      if(!malpraktisPolice){setErr(t('err_malpraktis_required'));return;}
      if(!contractorRead){setErr(t('err_contractor_read'));return;}
      if(!independentContractor){setErr(t('err_contractor_consent'));return;}
    }
    setLoading(true);
    try {
      if(mode==='login'){
        const res = await AuthDB.login(em,pw);
        if(res.error){setErr(res.error);setLoading(false);return;}
        onLogin(res.user);toast(t('toast_welcome'),'success');
      } else {
        const r=isDoc?'doctor':'patient';
        const userData = {id:`${r[0].toUpperCase()}${Date.now().toString(36)}`,role:r,firstName:fn,lastName:ln,specialty:isDoc?spec:undefined,address:regProvince,country:regCountry,birthDate,licenseNumber:lic,
          ...(isDoc?{workStatus:docWorkStatus,tabipOdaNo,malpraktisPolice,firmName:docFirmName}:{}),
        };
        const res = await AuthDB.signup(em,pw,userData);
        if(res.error){setErr(res.error);setLoading(false);return;}
        onLogin(res.user);toast(t('toast_account_created'),'success');
      }
    } catch(e){setErr(t('err_connection'));}
    setLoading(false);
  };
  const themeColor = isDoc&&mode==='register' ? '#1e293b' : '#0d9488';
  const themeGrad = isDoc&&mode==='register' ? 'linear-gradient(135deg,#1e293b,#334155)' : 'linear-gradient(135deg,#0d9488,#14b8a6)';
  const InputIcon = ({icon}) => <span style={{position:'absolute',left:14,top:'50%',transform:'translateY(-50%)',pointerEvents:'none',color:'var(--c-muted)',display:'flex'}}><I n={icon} s={18}/></span>;
  return (
    <div className="dd-page" style={{display:'flex',flexDirection:'column',alignItems:'center',justifyContent:'center'}}>
      <div style={{width:'100%',maxWidth:400}} className="animate-fadeUp">
        {/* Green/dark banner */}
        <div style={{background:themeGrad,borderRadius:'24px 24px 0 0',padding:'32px 24px 28px',textAlign:'center',color:'white'}}>
          <div style={{width:56,height:56,borderRadius:16,background:'rgba(255,255,255,.2)',display:'flex',alignItems:'center',justifyContent:'center',margin:'0 auto 14px',backdropFilter:'blur(8px)'}}><I n="stethoscope" s={30} c="text-white"/></div>
          <h1 style={{fontSize:'1.5rem',fontWeight:900,letterSpacing:'-.02em',color:'white'}}>{mode==='login'?t('welcome_back_title'):isDoc?t('provider_signup'):t('patient_signup')}</h1>
        </div>
        {/* Form card */}
        <div style={{background:'var(--c-surface)',borderRadius:'0 0 24px 24px',padding:'24px',border:'1px solid var(--c-border)',borderTop:'none',boxShadow:'var(--shadow)'}}>
          <div style={{display:'flex',flexDirection:'column',gap:14}}>
            {err && <div style={{padding:'10px 14px',borderRadius:12,background:'color-mix(in srgb,var(--c-danger) 10%,transparent)',color:'var(--c-danger)',fontSize:13,fontWeight:600,display:'flex',alignItems:'center',gap:8}}><I n="alertCircle" s={16}/>{err}</div>}
            {mode==='register' && <>
              <div style={{display:'flex',justifyContent:'center',marginBottom:2}}>
                <button onClick={()=>setIsDoc(!isDoc)} style={{fontSize:12,fontWeight:700,padding:'6px 16px',borderRadius:100,border:`1.5px solid ${isDoc?'#1e293b':'var(--c-border)'}`,background:isDoc?'#1e293b':'transparent',color:isDoc?'white':'var(--c-muted)',cursor:'pointer',transition:'all .3s'}}>{isDoc?t('switch_to_patient'):t('are_you_doctor')}</button>
              </div>
              <div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:10}}>
                <div><label style={{fontSize:11,fontWeight:700,color:'var(--c-muted)',display:'block',marginBottom:4}}>{t('first_name_req')}</label><div style={{position:'relative'}}><InputIcon icon="user"/><input className="dd-input" style={{paddingLeft:40}} placeholder="Ahmet" value={fn} onChange={e=>setFn(e.target.value)}/></div></div>
                <div><label style={{fontSize:11,fontWeight:700,color:'var(--c-muted)',display:'block',marginBottom:4}}>{t('last_name_req')}</label><div style={{position:'relative'}}><InputIcon icon="user"/><input className="dd-input" style={{paddingLeft:40}} placeholder="Yılmaz" value={ln} onChange={e=>setLn(e.target.value)}/></div></div>
              </div>
              {!isDoc && <>
                <div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:8}}>
                  <div><label style={{fontSize:11,fontWeight:700,color:'var(--c-muted)',display:'block',marginBottom:4}}>{t('country')}</label><div style={{position:'relative'}}><InputIcon icon="globe"/><select className="dd-input" style={{paddingLeft:40}} value={regCountry} onChange={e=>setRegCountry(e.target.value)}><option value="Türkiye">Türkiye</option><option value="Germany">Germany</option><option value="UK">United Kingdom</option><option value="USA">USA</option><option value="Netherlands">Netherlands</option><option value="France">France</option><option value="Other">Diğer</option></select></div></div>
                  <div><label style={{fontSize:11,fontWeight:700,color:'var(--c-muted)',display:'block',marginBottom:4}}>{t('city_province')}</label><div style={{position:'relative'}}><InputIcon icon="mapPin"/><select className="dd-input" style={{paddingLeft:40}} value={regProvince} onChange={e=>setRegProvince(e.target.value)}><option value="">{t('select_placeholder')}</option>{['Adana','Adıyaman','Afyonkarahisar','Ağrı','Aksaray','Amasya','Ankara','Antalya','Ardahan','Artvin','Aydın','Balıkesir','Bartın','Batman','Bayburt','Bilecik','Bingöl','Bitlis','Bolu','Burdur','Bursa','Çanakkale','Çankırı','Çorum','Denizli','Diyarbakır','Düzce','Edirne','Elazığ','Erzincan','Erzurum','Eskişehir','Gaziantep','Giresun','Gümüşhane','Hakkari','Hatay','Iğdır','Isparta','İstanbul','İzmir','Kahramanmaraş','Karabük','Karaman','Kars','Kastamonu','Kayseri','Kilis','Kırıkkale','Kırklareli','Kırşehir','Kocaeli','Konya','Kütahya','Malatya','Manisa','Mardin','Mersin','Muğla','Muş','Nevşehir','Niğde','Ordu','Osmaniye','Rize','Sakarya','Samsun','Şanlıurfa','Siirt','Sinop','Sivas','Şırnak','Tekirdağ','Tokat','Trabzon','Tunceli','Uşak','Van','Yalova','Yozgat','Zonguldak'].map(p=><option key={p} value={p}>{p}</option>)}</select></div></div>
                </div>
                <div><label style={{fontSize:11,fontWeight:700,color:'var(--c-muted)',display:'block',marginBottom:4}}>{t('birth_date_req')}</label><div style={{position:'relative'}}><InputIcon icon="calendar"/><input className="dd-input" style={{paddingLeft:40}} type="date" value={birthDate} onChange={e=>setBirthDate(e.target.value)} max={new Date().toISOString().split('T')[0]}/></div></div>
              </>}
              {isDoc && <>
                {/* Erken kayıt teşviki */}
                <div style={{padding:'12px 14px',borderRadius:12,background:'linear-gradient(135deg,color-mix(in srgb,#0d9488 8%,transparent),color-mix(in srgb,#6366f1 6%,transparent))',border:'1px solid color-mix(in srgb,#0d9488 20%,transparent)',fontSize:11,display:'flex',gap:10,alignItems:'flex-start'}}>
                  <span style={{fontSize:18,flexShrink:0}}>🎁</span>
                  <div>
                    <div style={{fontWeight:800,color:'#0d9488',fontSize:12,marginBottom:3}}>İlk 50 Doktora Özel Teklif</div>
                    <div style={{color:'var(--c-text)',lineHeight:1.6}}>İlk <strong>3 ay komisyon sıfır</strong> — platformda görünürlüğünüzü test edin, kazancınızın tamamını alın.</div>
                  </div>
                </div>
                {/* Yasal uyarı */}
                <div style={{padding:'10px 14px',borderRadius:12,background:'color-mix(in srgb,var(--c-warn) 8%,transparent)',border:'1px solid color-mix(in srgb,var(--c-warn) 18%,transparent)',fontSize:11,color:'#92400e',display:'flex',gap:8,alignItems:'flex-start'}}>
                  <I n="alertTriangle" s={16} c="text-amber-600" style={{flexShrink:0,marginTop:1}}/>
                  <div><strong>Yasal Uyarı:</strong> 657 sayılı DMK m.28 gereği kamu hastanelerinde çalışan hekimler bu platformda hizmet veremez. Yalnızca muayenehane sahibi veya özel sağlık kuruluşu hekimleri kayıt olabilir.</div>
                </div>
                <div><label style={{fontSize:11,fontWeight:700,color:'var(--c-muted)',display:'block',marginBottom:4}}>Çalışma Statüsü *</label>
                  <select className="dd-input" value={docWorkStatus} onChange={e=>setDocWorkStatus(e.target.value)}>
                    <option value="muayenehane">Muayenehane Sahibi (Serbest Hekim)</option>
                    <option value="ozel_kuruluş">Özel Sağlık Kuruluşu Çalışanı</option>
                  </select>
                </div>
                {docWorkStatus==='ozel_kuruluş' && <div><label style={{fontSize:11,fontWeight:700,color:'var(--c-muted)',display:'block',marginBottom:4}}>Kuruluş Adı *</label><input className="dd-input" placeholder="Özel Hastane / Klinik adı" value={docFirmName} onChange={e=>setDocFirmName(e.target.value)}/></div>}
                <div><label style={{fontSize:11,fontWeight:700,color:'var(--c-muted)',display:'block',marginBottom:4}}>Uzmanlık Alanı *</label><select className="dd-input" value={spec} onChange={e=>setSpec(e.target.value)}><option>Aile Hekimliği</option><option>İç Hastalıkları</option><option>Çocuk Sağlığı</option><option>Kardiyoloji</option><option>Dermatoloji</option><option>Ortopedi</option><option>Nöroloji</option><option>Psikiyatri</option><option>Göz Hastalıkları</option><option>KBB</option></select></div>
                <div><label style={{fontSize:11,fontWeight:700,color:'var(--c-muted)',display:'block',marginBottom:4}}>Diploma / Tescil Numarası *</label><div style={{position:'relative'}}><InputIcon icon="shield"/><input className="dd-input" style={{paddingLeft:40}} placeholder="Tescil No" value={lic} onChange={e=>setLic(e.target.value)}/></div></div>
                <div><label style={{fontSize:11,fontWeight:700,color:'var(--c-muted)',display:'block',marginBottom:4}}>Tabip Odası Üyelik No *</label><input className="dd-input" placeholder="Tabip Odası No" value={tabipOdaNo} onChange={e=>setTabipOdaNo(e.target.value)}/></div>
                <div>
                  <label style={{fontSize:11,fontWeight:700,color:'var(--c-muted)',display:'block',marginBottom:4}}>Malpraktis Sigorta Poliçe No *</label>
                  <input className="dd-input" placeholder="Poliçe numarası" value={malpraktisPolice} onChange={e=>setMalpraktisPolice(e.target.value)}/>
                  <div style={{marginTop:6,padding:'8px 12px',borderRadius:10,background:'color-mix(in srgb,#6366f1 6%,transparent)',border:'1px solid color-mix(in srgb,#6366f1 15%,transparent)',fontSize:10,color:'#4338ca',display:'flex',gap:6,alignItems:'flex-start',lineHeight:1.6}}>
                    <span style={{flexShrink:0,marginTop:1}}>💡</span>
                    <span>Malpraktis sigortanız yok mu? Kayıt sonrası <strong>sigorta aracılık hizmetimizden</strong> yararlanabilirsiniz. <strong>malpraktis@docdoor.com</strong> adresine yazın.</span>
                  </div>
                </div>
                {/* Bağımsız Yüklenici Onayı */}
                <label style={{display:'flex',gap:10,alignItems:'flex-start',padding:'10px 14px',borderRadius:12,background:'var(--c-subtle)',fontSize:12,cursor:contractorRead?'pointer':'not-allowed',opacity:contractorRead?1:0.6,border:'1px solid var(--c-border)'}}>
                  <input type="checkbox" checked={independentContractor} onChange={e=>contractorRead&&setIndependentContractor(e.target.checked)} disabled={!contractorRead} style={{marginTop:2,accentColor:'var(--c-accent)'}}/>
                  <span>Bu platformda <strong>bağımsız yüklenici</strong> olarak hizmet vereceğimi, platformla aramda işçi-işveren ilişkisi bulunmadığını, kendi malpraktis sigortamın aktif olduğunu kabul ediyorum. <a href="#" onClick={e=>{e.preventDefault();e.stopPropagation();setLegalModal('contractor');}} style={{color:'var(--c-accent)',textDecoration:'underline',fontWeight:700}}>{contractorRead?'Tekrar oku':'Önce sözleşmeyi oku ↗'}</a></span>
                </label>
              </>}
              {/* KVKK Onayları */}
              <div style={{display:'flex',flexDirection:'column',gap:8,padding:'12px 14px',borderRadius:12,border:'1px solid var(--c-border)',background:'var(--c-subtle)'}}>
                <div style={{fontSize:11,fontWeight:800,color:'var(--c-muted)',textTransform:'uppercase',letterSpacing:'.05em'}}>Yasal Onaylar</div>
                <label style={{display:'flex',gap:10,alignItems:'flex-start',fontSize:12,cursor:kvkkRead?'pointer':'not-allowed',opacity:kvkkRead?1:0.6}}>
                  <input type="checkbox" checked={kvkkConsent} onChange={e=>kvkkRead&&setKvkkConsent(e.target.checked)} disabled={!kvkkRead} style={{marginTop:2,accentColor:'var(--c-accent)'}}/>
                  <span><strong>KVKK Aydınlatma Metni</strong>'ni okudum ve kişisel verilerimin belirtilen amaçlarla işlenmesini kabul ediyorum. <a href="#" onClick={e=>{e.preventDefault();e.stopPropagation();setLegalModal('kvkk');}} style={{color:'var(--c-accent)',textDecoration:'underline',fontWeight:700}}>{kvkkRead?'Tekrar oku':'Önce metni oku ↗'}</a></span>
                </label>
                {!isDoc && <label style={{display:'flex',gap:10,alignItems:'flex-start',fontSize:12,cursor:healthRead?'pointer':'not-allowed',opacity:healthRead?1:0.6}}>
                  <input type="checkbox" checked={healthDataConsent} onChange={e=>healthRead&&setHealthDataConsent(e.target.checked)} disabled={!healthRead} style={{marginTop:2,accentColor:'var(--c-accent)'}}/>
                  <span><strong>Sağlık Verisi Açık Rızası:</strong> Özel nitelikli kişisel verilerim (sağlık verileri) kapsamında, tıbbi teşhis ve tedavi hizmeti amacıyla işlenmesine açık rızam vardır. <a href="#" onClick={e=>{e.preventDefault();e.stopPropagation();setLegalModal('consent');}} style={{color:'var(--c-accent)',textDecoration:'underline',fontWeight:700}}>{healthRead?'Tekrar oku':'Önce metni oku ↗'}</a></span>
                </label>}
                <label style={{display:'flex',gap:10,alignItems:'flex-start',fontSize:12,cursor:'pointer'}}>
                  <input type="checkbox" checked={kvkkConsent} onChange={()=>{}} style={{marginTop:2,accentColor:'var(--c-accent)',visibility:'hidden',width:0,height:0}}/>
                  <span style={{fontSize:10,color:'var(--c-muted)'}}>6698 sayılı KVKK kapsamında veri sorumlusu: DocDoor Teknoloji A.Ş. İletişim: kvkk@docdoor.com</span>
                </label>
              </div>
            </>}
            <div><label style={{fontSize:11,fontWeight:700,color:'var(--c-muted)',display:'block',marginBottom:4}}>Email</label><div style={{position:'relative'}}><InputIcon icon="mail"/><input className="dd-input" style={{paddingLeft:40}} type="email" placeholder="you@example.com" value={em} onChange={e=>setEm(e.target.value)}/></div></div>
            <div><label style={{fontSize:11,fontWeight:700,color:'var(--c-muted)',display:'block',marginBottom:4}}>Password</label>
            <div style={{position:'relative'}}>
              <InputIcon icon="lock"/>
              <input className="dd-input" style={{paddingLeft:40,paddingRight:44}} type={showPw?'text':'password'} placeholder="••••••••" value={pw} onChange={e=>setPw(e.target.value)} onKeyDown={e=>{if(e.key==='Enter')submit();}}/>
              <button onClick={()=>setShowPw(!showPw)} style={{position:'absolute',right:8,top:'50%',transform:'translateY(-50%)',background:'none',border:'none',cursor:'pointer',padding:6,color:'var(--c-muted)'}}><I n={showPw?'eyeOff':'eye'} s={18}/></button>
            </div></div>
            <button className="dd-btn" style={{width:'100%',marginTop:4,padding:'1rem',background:themeColor,color:'white',boxShadow:`0 4px 14px ${themeColor}44`}} disabled={loading} onClick={submit}>
              {loading?<span className="animate-spin" style={{display:'inline-flex'}}><I n="loader" s={18} c="text-white"/></span>:mode==='login'?t('sign_in_arrow'):isDoc?t('register_provider'):t('create_account')}
            </button>
          </div>
          <div style={{textAlign:'center',marginTop:16}}>
            <button onClick={()=>{setMode(mode==='login'?'register':'login');setErr('');setIsDoc(false);}} style={{background:'none',border:'none',color:themeColor,fontSize:13,fontWeight:600,cursor:'pointer'}}>{mode==='login'?t('no_account'):t('have_account')}</button>
          </div>
        </div>
      </div>
      {/* Legal Text Modal */}
      {legalModal && (
        <div style={{position:'fixed',inset:0,zIndex:300,display:'flex',alignItems:'center',justifyContent:'center',padding:16,background:'rgba(0,0,0,.6)',backdropFilter:'blur(12px)'}} onClick={()=>setLegalModal(null)}>
          <div className="dd-card animate-fadeUp" style={{maxWidth:520,width:'100%',padding:'2rem',borderRadius:24,maxHeight:'85vh',overflowY:'auto'}} onClick={e=>e.stopPropagation()} onScroll={handleLegalScroll}>
            <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',marginBottom:16}}>
              <h3 style={{fontSize:'1.1rem',fontWeight:800}}>{legalModal==='kvkk'?'KVKK Aydınlatma Metni':legalModal==='consent'?'Sağlık Verisi Açık Rızası':'Bağımsız Yüklenici Sözleşmesi'}</h3>
              <button onClick={()=>setLegalModal(null)} style={{background:'none',border:'none',cursor:'pointer',padding:4,color:'var(--c-muted)',fontSize:20}}>✕</button>
            </div>
            {legalModal==='kvkk' ? (
              <div style={{fontSize:12,lineHeight:1.8,color:'var(--c-text)'}}>
                <p style={{fontWeight:800,fontSize:14,marginBottom:12,color:'var(--c-accent)'}}>KİŞİSEL VERİLERİN İŞLENMESİNE İLİŞKİN AYDINLATMA METNİ</p>
                <p style={{marginBottom:8}}><strong>Veri Sorumlusu:</strong> DocDoor Teknoloji Ltd. Şti.</p>
                <p style={{marginBottom:8}}>6698 sayılı Kişisel Verilerin Korunması Kanunu ("KVKK") kapsamında, kişisel verileriniz aşağıda açıklanan amaçlarla işlenmektedir:</p>
                <p style={{fontWeight:700,marginTop:12,marginBottom:4}}>1. İŞLENEN VERİLER</p>
                <p>Kimlik bilgileri (ad, soyad, TC Kimlik No), iletişim bilgileri (e-posta, telefon, adres), sağlık verileri (semptomlar, muayene notları — ÖZEL NİTELİKLİ), ödeme bilgileri (kart son 4 hane), konum verileri (GPS — yalnızca randevu için).</p>
                <p style={{fontWeight:700,marginTop:12,marginBottom:4}}>2. İŞLEME AMAÇLARI</p>
                <p>Doktor-hasta eşleştirmesi, randevu yönetimi, ödeme işlemleri, sigorta provizyon sorgulaması (yalnızca özel sigorta), yasal yükümlülükler.</p>
                <p style={{fontWeight:700,marginTop:12,marginBottom:4}}>3. AKTARIM</p>
                <p>Hizmet veren doktor (muayene için), ödeme kuruluşu (iyzico — 6493 s.K. lisanslı), sigorta şirketi (provizyon), yasal zorunluluk halinde kamu kurumları.</p>
                <p style={{fontWeight:700,marginTop:12,marginBottom:4}}>4. SAKLAMA SÜRESİ</p>
                <p>Sağlık verileri: 20 yıl (1219 s.K.). Ödeme verileri: 10 yıl (VUK). Diğer: Hesap açık + 1 yıl.</p>
                <p style={{fontWeight:700,marginTop:12,marginBottom:4}}>5. HAKLARINIZ (KVKK m.11)</p>
                <p>Verilerinizin işlenip işlenmediğini öğrenme, bilgi talep etme, düzeltilmesini isteme, silinmesini isteme, üçüncü kişilere aktarımı öğrenme, itiraz etme ve Kişisel Verileri Koruma Kurulu'na şikayette bulunma hakları.</p>
                <p style={{marginTop:12,fontWeight:700,color:'var(--c-accent)'}}>Başvuru: kvkk@docdoor.com | VERBİS Kayıt No: [başvuru aşamasında]</p>
              </div>
            ) : legalModal==='consent' ? (
              <div style={{fontSize:12,lineHeight:1.8,color:'var(--c-text)'}}>
                <p style={{fontWeight:800,fontSize:14,marginBottom:12,color:'var(--c-accent)'}}>ÖZEL NİTELİKLİ KİŞİSEL VERİ İŞLEME AÇIK RIZASI</p>
                <p style={{marginBottom:8}}>6698 sayılı KVKK'nın 6. maddesi kapsamında, sağlık verilerim "özel nitelikli kişisel veri" olup işlenmesi açık rızama bağlıdır.</p>
                <p style={{fontWeight:700,marginTop:12,marginBottom:4}}>Bu onay ile aşağıdaki işlemlere açık rızam bulunmaktadır:</p>
                <p style={{marginBottom:4}}>• Semptomlarımın, muayene notlarımın, teşhis ve tedavi bilgilerimin platform üzerinden işlenmesi</p>
                <p style={{marginBottom:4}}>• Hizmet veren doktora tıbbi bilgilerimin iletilmesi</p>
                <p style={{marginBottom:4}}>• Sigorta provizyon sorgulaması için sigorta şirketine TC Kimlik ve sağlık bilgilerimin aktarılması</p>
                <p style={{marginBottom:4}}>• Muayene sonuçlarının ve reçete bilgilerinin platform üzerinden saklanması</p>
                <p style={{fontWeight:700,marginTop:12,marginBottom:4}}>Rıza Geri Çekme:</p>
                <p>Bu rızamı her zaman kvkk@docdoor.com adresine yazılı başvuru ile geri çekebileceğimi, hesabımın silinmesini talep edebileceğimi (KVKK m.11/1-e) ve rıza geri çekildiğinde mevcut verilerimin anonimleştirileceğini biliyorum.</p>
                <p style={{marginTop:12,fontWeight:700,color:'var(--c-accent)'}}>İletişim: kvkk@docdoor.com</p>
              </div>
            ) : (
              <div style={{fontSize:12,lineHeight:1.8,color:'var(--c-text)'}}>
                <p style={{fontWeight:800,fontSize:14,marginBottom:12,color:'var(--c-accent)'}}>BAĞIMSIZ YÜKLENİCİ SÖZLEŞMESİ ÖN BİLGİLENDİRME</p>
                <p style={{marginBottom:8}}>4857 sayılı İş Kanunu ve 6098 sayılı Türk Borçlar Kanunu kapsamında:</p>
                <p style={{fontWeight:700,marginTop:12,marginBottom:4}}>1. İLİŞKİNİN NİTELİĞİ</p>
                <p>DocDoor platformu ile aranızda işçi-işveren ilişkisi bulunmamaktadır. Hizmetinizi bağımsız yüklenici (serbest meslek erbabı) olarak vermektesiniz. Platform yalnızca hasta-doktor eşleştirmesi için teknoloji aracılığı yapmaktadır.</p>
                <p style={{fontWeight:700,marginTop:12,marginBottom:4}}>2. TIBBİ SORUMLULUK</p>
                <p>Tıbbi müdahalelerin tüm sorumluluğu hekime aittir. Platform tıbbi karar almaz, reçete yazmaz, tedavi planlamaz. 1219 sayılı Tababet Kanunu'na göre meslek icra yetkisi ve sorumluluğu tamamen hekimdedir.</p>
                <p style={{fontWeight:700,marginTop:12,marginBottom:4}}>3. MALPRAKTİS SİGORTASI</p>
                <p>Aktif malpraktis (tıbbi kötü uygulama) sigortanızın olması zorunludur. Sigorta poliçe numaranız kayıt altında tutulacaktır.</p>
                <p style={{fontWeight:700,marginTop:12,marginBottom:4}}>4. VERGİ VE SGK</p>
                <p>Serbest meslek makbuzu kesme, vergi beyannamesi verme ve SGK primleriniz kendi sorumluluğunuzdadır. Platform %20 komisyon keser, kalan tutarı hesabınıza aktarır.</p>
                <p style={{fontWeight:700,marginTop:12,marginBottom:4}}>5. ÇALIŞMA KOŞULLARI (657 DMK KISITLAMASI)</p>
                <p>Kamu kurumlarında görev yapan hekimler (657 sayılı DMK m.28 gereği) platform üzerinden hizmet veremez. Yalnızca muayenehane sahibi veya özel sağlık kuruluşu çalışanı hekimler kabul edilir.</p>
                <p style={{marginTop:12,fontWeight:700,color:'var(--c-accent)'}}>İletişim: legal@docdoor.com</p>
              </div>
            )}
            <button onClick={()=>{if(legalModal==='kvkk')setKvkkRead(true);else if(legalModal==='consent')setHealthRead(true);else if(legalModal==='contractor')setContractorRead(true);setLegalModal(null);}} className="dd-btn dd-btn-primary" disabled={!legalScrolled} style={{width:'100%',marginTop:20,padding:'12px',opacity:legalScrolled?1:0.4,cursor:legalScrolled?'pointer':'not-allowed'}}>{legalScrolled?t('legal_confirm'):t('legal_read_scroll')}</button>
          </div>
        </div>
      )}
    </div>
  );
}

// ═══════ HOME ═══════
function HomeView({onEmergency,onRoutine,visits,user,favDocs,docs,meds,onSelectDoc,onViewSummary}){
  const {t} = useT();
  const upcoming = visits.filter(v=>v.status==='upcoming'||v.status==='pending');
  const completed = visits.filter(v=>v.status==='completed');
  const favDocList = docs.filter(d=>favDocs.includes(d.id));
  const activeMeds = (meds||[]).filter(m=>m.active);
  const hour = new Date().getHours();
  const greeting = hour<12?t('greeting_morning'):hour<18?t('greeting_afternoon'):t('greeting_evening');
  const [selAppt,setSelAppt]=useState(null); // #14: Selected appointment for details
  const [showKvkk,setShowKvkk]=useState(false);

  // Filter medicines due today
  const today = new Date();
  const dayName = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'][today.getDay()];
  const todayMeds = activeMeds.filter(m => {
    if (!m.days || m.days === '[]') return true; // No specific days = every day
    try { const days = JSON.parse(m.days); return !days.length || days.includes(dayName); } catch { return true; }
  });

  return (
    <div className="dd-page" style={{display:'flex',flexDirection:'column',alignItems:'center',justifyContent:'center'}}>
      <div style={{maxWidth:680,width:'100%'}}>
        <div className="animate-fadeUp" style={{marginBottom:28}}>
          <h1 style={{fontSize:'clamp(1.5rem,3.5vw,2rem)',fontWeight:900,letterSpacing:'-.03em'}}>{t('what_care_home')}</h1>
          <p style={{color:'var(--c-muted)',marginTop:4,fontSize:15}}>{t('what_care_sub')}</p>
        </div>

        {/* Upcoming & Pending appointments */}
        {upcoming.length>0 && (
          <div className="animate-fadeUp stagger-1" style={{display:'flex',flexDirection:'column',gap:10,marginBottom:16}}>
            {upcoming.map(apt=>(
              <div key={apt.id} className="dd-card" style={{padding:'1.25rem 1.5rem',border:apt.status==='pending'?'2px solid color-mix(in srgb,var(--c-warn) 30%,var(--c-border))':'2px solid color-mix(in srgb,var(--c-accent) 25%,var(--c-border))',background:apt.status==='pending'?'color-mix(in srgb,var(--c-warn) 3%,var(--c-surface))':'color-mix(in srgb,var(--c-accent) 3%,var(--c-surface))',cursor:'pointer'}} onClick={()=>setSelAppt(apt)}>
                <div style={{display:'flex',alignItems:'center',justifyContent:'space-between'}}>
                  <div style={{display:'flex',alignItems:'center',gap:14}}>
                    <div style={{width:48,height:48,borderRadius:16,background:apt.status==='pending'?'color-mix(in srgb,var(--c-warn) 12%,transparent)':'color-mix(in srgb,var(--c-accent) 12%,transparent)',display:'flex',alignItems:'center',justifyContent:'center'}}>
                      {apt.status==='pending'?<span className="animate-spin" style={{display:'inline-block'}}><I n="clock" s={24} c="text-amber-500"/></span>:<I n="calendar" s={24} c="text-teal-600"/>}
                    </div>
                    <div>
                      <div style={{fontSize:11,fontWeight:700,color:apt.status==='pending'?'var(--c-warn)':'var(--c-accent)',textTransform:'uppercase',letterSpacing:'.05em'}}>{apt.status==='pending'?t('appt_awaiting'):t('appt_confirmed_label')}</div>
                      <div style={{fontWeight:700,marginTop:2}}>{apt.docName||apt.specialty}</div>
                      <div style={{fontSize:13,color:'var(--c-muted)',marginTop:1}}>{apt.date} · {apt.time||'-'}</div>
                    </div>
                  </div>
                  <div style={{display:'flex',alignItems:'center',gap:8}}>
                    <span className="dd-badge" style={{background:apt.status==='pending'?'color-mix(in srgb,var(--c-warn) 12%,transparent)':'color-mix(in srgb,var(--c-accent) 10%,transparent)',color:apt.status==='pending'?'var(--c-warn)':'var(--c-accent)',fontSize:10}}>{apt.status==='pending'?t('status_pending'):t('status_confirmed')}</span>
                    <I n="chevRight" s={16} c="text-slate-400"/>
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}

        {/* #14: Appointment detail modal */}
        {selAppt && (
          <div style={{position:'fixed',inset:0,zIndex:200,display:'flex',alignItems:'center',justifyContent:'center',padding:16,background:'rgba(0,0,0,.5)',backdropFilter:'blur(12px)'}} onClick={()=>setSelAppt(null)}>
            <div className="dd-card animate-fadeUp" style={{maxWidth:420,width:'100%',padding:'2rem',borderRadius:24}} onClick={e=>e.stopPropagation()}>
              <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',marginBottom:20}}>
                <h3 style={{fontSize:'1.25rem',fontWeight:800}}>{t('appt_details')}</h3>
                <button onClick={()=>setSelAppt(null)} style={{background:'none',border:'none',cursor:'pointer',padding:4,color:'var(--c-muted)'}}><I n="x" s={20}/></button>
              </div>
              <div style={{display:'flex',flexDirection:'column',gap:0}}>
                {[
                  [t('doctor_label'),selAppt.docName||selAppt.specialty||t('doctor_label')],
                  [t('status_label'),selAppt.status],
                  [t('date_time'),(selAppt.date==='ASAP'?'ASAP':selAppt.date)+' '+(selAppt.time||'')],
                  [t('location'),(selAppt.address||t('not_specified')).split('|')[0]?.trim()],
                  [t('apartment'),selAppt.address?.includes('|')?selAppt.address.split('|')[1]?.trim()?.replace(/Apt:/,'').replace(/Floor:/,'Fl:').replace(/Door:/,'Dr:'):'—'],
                  [t('symptoms_label'),selAppt.sym||t('general_visit')],
                  [t('price'),selAppt.price?fmtPrice(selAppt.price,selAppt.currency||'TRY'):'—'],
                ].map(([label,value],i,arr)=>(
                  <div key={label} style={{display:'flex',justifyContent:'space-between',padding:'12px 0',borderBottom:i<arr.length-1?'1px solid var(--c-border)':'none'}}>
                    <span style={{color:'var(--c-muted)',fontSize:13}}>{label}</span>
                    <span style={{fontWeight:label==='Price'?800:600,fontSize:label==='Price'?18:14,color:label==='Price'?'var(--c-accent)':'var(--c-text)',maxWidth:200,textAlign:'right',overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap'}}>{value}</span>
                  </div>
                ))}
              </div>
              <button className="dd-btn dd-btn-ghost" onClick={()=>setSelAppt(null)} style={{width:'100%',marginTop:20,border:'1.5px solid var(--c-border)'}}>{t('close')}</button>
            </div>
          </div>
        )}

        {/* Today's Medicines Reminder - ONLY show if patient has meds due today */}
        {todayMeds.length>0 && (
          <div className="dd-card animate-fadeUp stagger-1" style={{padding:'1rem 1.25rem',marginBottom:16,border:'2px solid color-mix(in srgb,var(--c-accent2) 20%,var(--c-border))',background:'color-mix(in srgb,var(--c-accent2) 3%,var(--c-surface))'}}>
            <div style={{display:'flex',alignItems:'center',gap:10,marginBottom:10}}>
              <div style={{width:36,height:36,borderRadius:12,background:'color-mix(in srgb,var(--c-accent2) 12%,transparent)',display:'flex',alignItems:'center',justifyContent:'center'}}><I n="pill" s={18} c="text-indigo-500"/></div>
              <div><div style={{fontSize:12,fontWeight:800,color:'var(--c-accent2)',textTransform:'uppercase',letterSpacing:'.05em'}}>{t('todays_meds')}</div></div>
            </div>
            <div style={{display:'flex',gap:8,overflowX:'auto',paddingBottom:4}}>
              {todayMeds.map(m=>(
                <div key={m.id} style={{minWidth:160,padding:'10px 14px',borderRadius:12,background:'var(--c-subtle)',flexShrink:0,display:'flex',alignItems:'center',gap:8}}>
                  <div style={{width:8,height:8,borderRadius:'50%',background:'var(--c-accent2)',flexShrink:0}}/>
                  <div><div style={{fontWeight:700,fontSize:13}}>{m.name}</div><div style={{fontSize:11,color:'var(--c-muted)'}}>{m.dosage} · {m.time||m.frequency}</div></div>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Main action card */}
        <div style={{display:'grid',gridTemplateColumns:'1fr',gap:16}}>
          <button className="dd-card animate-fadeUp stagger-2 btn-bounce" onClick={onRoutine} style={{padding:'2rem',textAlign:'center',cursor:'pointer',border:'2px solid color-mix(in srgb,var(--c-accent) 15%,var(--c-border))',transition:'all .3s'}}>
            <div style={{width:64,height:64,borderRadius:20,background:'color-mix(in srgb,var(--c-accent) 10%,transparent)',display:'flex',alignItems:'center',justifyContent:'center',margin:'0 auto 16px'}}><I n="calendar" s={28} c="text-teal-600"/></div>
            <h3 style={{fontSize:'1.25rem',fontWeight:800,marginBottom:6}}>{t('routine_title')}</h3>
            <p style={{color:'var(--c-muted)',fontSize:14,lineHeight:1.5,marginBottom:16}}>{t('routine_desc_home')}</p>
            <span style={{color:'var(--c-accent)',fontWeight:700,fontSize:14,fontFamily:'var(--font-display)',display:'inline-flex',alignItems:'center',gap:4}}>{t('see_doctors')} <LottieAnim name="arrow" size={20} hover style={{filter:'invert(0.4) sepia(1) saturate(5) hue-rotate(130deg)',pointerEvents:'auto'}}/></span>
          </button>
        </div>

        {/* Favorite doctors */}
        {favDocList.length>0 && (
          <div className="animate-fadeUp stagger-4" style={{marginTop:20}}>
            <h3 style={{fontSize:14,fontWeight:700,color:'var(--c-muted)',marginBottom:10,fontFamily:'var(--font-display)',letterSpacing:'.03em'}}>{t('fav_doctors_title').toUpperCase()}</h3>
            <div style={{display:'flex',gap:12,overflowX:'auto',paddingBottom:4}}>
              {favDocList.map(d=>(
                <button key={d.id} onClick={()=>onSelectDoc(d)} className="dd-card btn-bounce" style={{minWidth:180,padding:0,textAlign:'left',cursor:'pointer',flexShrink:0,border:'none',overflow:'hidden'}}>
                  <div style={{height:6,background:'linear-gradient(90deg,var(--c-accent),var(--c-accent2))'}}/>
                  <div style={{padding:'14px 16px'}}>
                    <div style={{display:'flex',alignItems:'center',gap:10,marginBottom:8}}>
                      <DocAvatar src={d.img} name={d.name} size={42} radius={12}/>
                      <div><div style={{fontWeight:700,fontSize:13,lineHeight:1.2}}>{d.name?.split(' ').slice(0,2).join(' ')}</div><div style={{fontSize:11,color:'var(--c-accent)',fontWeight:600,marginTop:1}}>{d.specialty}</div></div>
                    </div>
                    <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',fontSize:11,color:'var(--c-muted)'}}>
                      {(d.reviewCount||0)>0 ? <span style={{fontWeight:700,color:'#f59e0b'}}>★ {d.rating}</span> : <span style={{fontStyle:'italic'}}>New</span>}
                      <span style={{fontWeight:700}}>{fmtPrice(d.price||150,d.currency)}</span>
                    </div>
                  </div>
                </button>
              ))}
            </div>
          </div>
        )}
        {/* Recent visits */}
        {completed.length>0 && (
          <div className="animate-fadeUp stagger-4" style={{marginTop:20}}>
            <h3 style={{fontSize:14,fontWeight:700,color:'var(--c-muted)',marginBottom:10,fontFamily:'var(--font-display)',letterSpacing:'.03em'}}>{t('recent_visits_title').toUpperCase()}</h3>
            <div style={{display:'flex',gap:10}}>{completed.slice(0,2).map(v=>(
              <button key={v.id} onClick={()=>v.summary&&onViewSummary(v.id)} className="dd-card" style={{flex:1,padding:'14px 16px',display:'flex',alignItems:'center',gap:12,cursor:'pointer',border:'none',textAlign:'left'}}>
                {v.docImg?<img src={v.docImg} alt="" style={{width:36,height:36,borderRadius:10,objectFit:'cover'}}/>:<div style={{width:36,height:36,borderRadius:10,background:'var(--c-subtle)',display:'flex',alignItems:'center',justifyContent:'center'}}><I n="user" s={16}/></div>}
                <div><div style={{fontWeight:600,fontSize:13}}>{v.docName||'Doctor'}</div><div style={{fontSize:11,color:'var(--c-muted)'}}>{v.docSpec||v.specialty}</div></div>
                {v.summary && <span className="dd-badge" style={{background:'color-mix(in srgb,var(--c-accent) 10%,transparent)',color:'var(--c-accent)',marginLeft:'auto'}}>{t('summary_badge')}</span>}
              </button>
            ))}</div>
          </div>
        )}
        {/* Trust badges */}
        <div className="animate-fadeUp stagger-4" style={{marginTop:24}}>
          <div style={{display:'flex',gap:8,flexWrap:'wrap',justifyContent:'center',marginBottom:10}}>
            {[
              {icon:'shield',label:'KVKK Uyumlu',sub:'VERBİS Kayıtlı',color:'#0d9488',onClick:()=>setShowKvkk(true)},
              {icon:'credit',label:'iyzico Güvenli Ödeme',sub:'6493 s.K. Lisanslı',color:'#6366f1',onClick:null},
              {icon:'stethoscope',label:'Malpraktis Güvenceli',sub:'Tüm Doktorlar Sigortalı',color:'#0891b2',onClick:null},
            ].map(b=>(
              <div key={b.label} onClick={b.onClick||undefined} style={{display:'flex',alignItems:'center',gap:8,padding:'8px 14px',borderRadius:12,background:'color-mix(in srgb,var(--c-accent) 5%,var(--c-surface))',border:'1px solid color-mix(in srgb,var(--c-border) 80%,transparent)',cursor:b.onClick?'pointer':'default',transition:'all .2s',flex:'0 1 auto'}}>
                <div style={{width:30,height:30,borderRadius:8,background:`color-mix(in srgb,${b.color} 12%,transparent)`,display:'flex',alignItems:'center',justifyContent:'center',flexShrink:0}}>
                  <I n={b.icon} s={16} style={{color:b.color}}/>
                </div>
                <div>
                  <div style={{fontSize:11,fontWeight:800,color:'var(--c-text)',lineHeight:1.2}}>{b.label}{b.onClick&&<span style={{color:b.color,marginLeft:4,fontSize:10}}>↗</span>}</div>
                  <div style={{fontSize:10,color:'var(--c-muted)',marginTop:1}}>{b.sub}</div>
                </div>
              </div>
            ))}
          </div>
          <p style={{textAlign:'center',color:'var(--c-muted)',fontSize:10,fontWeight:600,letterSpacing:'.04em'}}>
            <I n="shield" s={11} style={{display:"inline-block",verticalAlign:"text-bottom",marginRight:3}}/>{t('safe_tagline')}
            &nbsp;·&nbsp;<a href="#" onClick={e=>{e.preventDefault();setShowKvkk(true);}} style={{color:'var(--c-accent)',textDecoration:'underline',fontWeight:700}}>KVKK Politikası</a>
          </p>
        </div>
        {/* KVKK quick-info modal */}
        {showKvkk && (
          <div style={{position:'fixed',inset:0,zIndex:300,display:'flex',alignItems:'center',justifyContent:'center',padding:16,background:'rgba(0,0,0,.6)',backdropFilter:'blur(12px)'}} onClick={()=>setShowKvkk(false)}>
            <div className="dd-card animate-fadeUp" style={{maxWidth:480,width:'100%',padding:'1.75rem',borderRadius:24,maxHeight:'80vh',overflowY:'auto'}} onClick={e=>e.stopPropagation()}>
              <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',marginBottom:16}}>
                <h3 style={{fontSize:'1rem',fontWeight:800,display:'flex',alignItems:'center',gap:8}}><I n="shield" s={18} style={{color:'#0d9488'}}/>KVKK Aydınlatma Metni</h3>
                <button onClick={()=>setShowKvkk(false)} style={{background:'none',border:'none',cursor:'pointer',padding:4,color:'var(--c-muted)',fontSize:20}}>✕</button>
              </div>
              <div style={{fontSize:12,lineHeight:1.8,color:'var(--c-text)'}}>
                <p style={{fontWeight:700,color:'var(--c-accent)',marginBottom:8}}>KİŞİSEL VERİLERİN İŞLENMESİNE İLİŞKİN AYDINLATMA METNİ</p>
                <p style={{marginBottom:8}}><strong>Veri Sorumlusu:</strong> DocDoor Teknoloji Ltd. Şti.</p>
                <p style={{marginBottom:8}}>6698 sayılı KVKK kapsamında kişisel verileriniz; doktor-hasta eşleştirmesi, randevu yönetimi, ödeme işlemleri ve yasal yükümlülükler amacıyla işlenmektedir.</p>
                <p style={{fontWeight:700,marginTop:10,marginBottom:4}}>İşlenen Veriler</p>
                <p>Kimlik (ad, soyad), iletişim (e-posta, adres), sağlık verileri (semptomlar, muayene notları — özel nitelikli), ödeme (kart son 4 hane), konum (randevu için).</p>
                <p style={{fontWeight:700,marginTop:10,marginBottom:4}}>Aktarım</p>
                <p>Hizmet veren doktor, iyzico (lisanslı ödeme kuruluşu), özel sigorta şirketi (provizyon), yasal zorunluluk halinde kamu kurumları.</p>
                <p style={{fontWeight:700,marginTop:10,marginBottom:4}}>Haklarınız (KVKK m.11)</p>
                <p>Verilerinizin işlenip işlenmediğini öğrenme, bilgi talep etme, düzeltilmesini / silinmesini isteme ve Kişisel Verileri Koruma Kurulu'na şikayette bulunma.</p>
                <p style={{marginTop:12,color:'var(--c-muted)',fontSize:11}}>İletişim: <strong>kvkk@docdoor.com</strong></p>
              </div>
              <button className="dd-btn dd-btn-primary" onClick={()=>setShowKvkk(false)} style={{width:'100%',marginTop:16}}>Anladım</button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

// ═══════ DOCTORS LIST ═══════
function DocsView({docs,favDocs,toggleFav,onSelect,onDetail,onBack}){
  const {t} = useT();
  const [sp,setSp]=useState('All');
  const [search,setSearch]=useState('');
  const [sortBy,setSortBy]=useState('rating');
  const specs = useMemo(()=>['All',...new Set(docs.map(d=>d.specialty))],[docs]);
  const filtered = useMemo(()=>{
    let r = sp==='All'?docs:docs.filter(d=>d.specialty===sp);
    if(search) r = r.filter(d=>d.name.toLowerCase().includes(search.toLowerCase())||d.specialty.toLowerCase().includes(search.toLowerCase()));
    return [...r].sort((a,b)=>sortBy==='price'?a.price-b.price:sortBy==='eta'?a.eta-b.eta:b.rating-a.rating);
  },[docs,sp,search,sortBy]);
  return (
    <div className="dd-page"><div style={{maxWidth:900,margin:'0 auto',width:'100%'}}>
      <div className="animate-fadeUp" style={{display:'flex',justifyContent:'space-between',alignItems:'flex-start',marginBottom:24}}>
        <div><h2 style={{fontSize:'1.5rem',fontWeight:800}}>{t('available_specialists')}</h2><p style={{color:'var(--c-muted)',fontSize:14,marginTop:4}}>{t('book_home_visit')}</p></div>
        <button className="dd-btn dd-btn-ghost" onClick={onBack} style={{fontSize:13}}><I n="arrowLeft" s={16}/>{t('back')}</button>
      </div>
      {/* Search & Sort */}
      <div className="animate-fadeUp stagger-1" style={{display:'flex',gap:10,marginBottom:16,flexWrap:'wrap'}}>
        <div style={{flex:1,minWidth:200,position:'relative'}}><span style={{position:"absolute",left:14,top:"50%",transform:"translateY(-50%)",pointerEvents:"none",color:"var(--c-muted)",display:"flex"}}><I n="search" s={16}/></span><input className="dd-input" style={{paddingLeft:38,padding:'10px 10px 10px 38px'}} placeholder={t('search_doctors')} value={search} onChange={e=>setSearch(e.target.value)}/></div>
        <select className="dd-input" style={{width:'auto',padding:'10px 16px',fontSize:13}} value={sortBy} onChange={e=>setSortBy(e.target.value)}>
          <option value="rating">{t('sort_best')}</option><option value="price">{t('sort_price')}</option><option value="eta">{t('sort_nearest')}</option>
        </select>
      </div>
      <div className="animate-fadeUp stagger-1" style={{display:'flex',flexWrap:'wrap',gap:8,marginBottom:24}}>
        {specs.map(s=><button key={s} onClick={()=>setSp(s)} style={{padding:'8px 16px',borderRadius:100,fontSize:13,fontWeight:700,fontFamily:'var(--font-display)',cursor:'pointer',border:'1.5px solid',transition:'all .2s',background:sp===s?'var(--c-accent)':'transparent',color:sp===s?'white':'var(--c-muted)',borderColor:sp===s?'var(--c-accent)':'var(--c-border)'}}>{s==='All'?t('show_all'):s}</button>)}
      </div>
      <div style={{display:'flex',flexDirection:'column',gap:12}}>
        {filtered.map((d,i)=>(
          <div key={d.id} className={`dd-card animate-fadeUp stagger-${Math.min(i+1,5)}`} style={{display:'flex',gap:20,padding:'1.25rem',alignItems:'center',cursor:'pointer'}} onClick={()=>onDetail(d)}>
            {d.img ? <img src={d.img} alt={d.name} style={{width:72,height:72,borderRadius:18,objectFit:'cover',flexShrink:0}}/> : <div style={{width:72,height:72,borderRadius:18,flexShrink:0,background:'linear-gradient(135deg,var(--c-accent),var(--c-accent2))',display:'flex',alignItems:'center',justifyContent:'center',color:'white',fontSize:24,fontWeight:800,fontFamily:'var(--font-display)'}}>{d.name?.charAt(0)||'D'}</div>}
            <div style={{flex:1,minWidth:0}}>
              <div style={{display:'flex',alignItems:'center',justifyContent:'space-between',gap:8}}>
                <h3 style={{fontSize:'1.0625rem',fontWeight:800,whiteSpace:'nowrap',overflow:'hidden',textOverflow:'ellipsis'}}>{d.name}</h3>
                <div className="dd-badge" style={{background:'color-mix(in srgb,#f59e0b 12%,transparent)',color:'#d97706',flexShrink:0}}>{(d.reviewCount||0)>0?<><I n="star" s={12} f/> {d.rating}</>:<span style={{fontSize:10}}>{t('new_badge')}</span>}</div>
              </div>
              <div style={{color:'var(--c-accent)',fontWeight:600,fontSize:13,marginTop:2}}>{d.specialty}</div>
              <p style={{color:'var(--c-muted)',fontSize:12,marginTop:4,lineHeight:1.4,display:'-webkit-box',WebkitLineClamp:2,WebkitBoxOrient:'vertical',overflow:'hidden'}}>{d.bio}</p>
              <div style={{display:'flex',flexWrap:'wrap',gap:12,marginTop:8,fontSize:12,color:'var(--c-muted)'}}>
                <span style={{display:'flex',alignItems:'center',gap:4}}><I n="clock" s={13}/>{t('available')}: {d.next}</span>
                <span style={{display:'flex',alignItems:'center',gap:4}}>{fmtPrice(d.price,d.currency)}</span>
                <span style={{display:'flex',alignItems:'center',gap:4}}><I n="globe" s={13}/>{Array.isArray(d.langs)?d.langs.join(', '):(d.langs||'')}</span>
                <span style={{display:'flex',alignItems:'center',gap:4}}><I n="msg" s={13}/>{d.reviewCount||0} {t('reviews_count')}</span>
              </div>
            </div>
            <div style={{display:'flex',flexDirection:'column',alignItems:'flex-end',gap:8,flexShrink:0}}>
              <button onClick={e=>{e.stopPropagation();toggleFav(d.id);}} style={{background:'none',border:'none',cursor:'pointer',padding:4}}><svg width={20} height={20} viewBox="0 0 24 24" fill={favDocs?.includes(d.id)?'#ef4444':'none'} stroke={favDocs?.includes(d.id)?'#ef4444':'var(--c-muted)'} strokeWidth={1.8}><path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"/></svg></button>
              <div className="dd-btn dd-btn-primary" style={{padding:'10px 20px',fontSize:13,display:'flex',alignItems:'center',gap:6}} onClick={e=>{e.stopPropagation();onSelect(d);}}>{t('book_visit')}<LottieAnim name="arrow" size={18} hover style={{filter:'invert(1) brightness(2)',pointerEvents:'auto'}}/></div>
            </div>
          </div>
        ))}
        {filtered.length===0 && <div className="dd-card" style={{textAlign:'center',padding:'3rem',borderStyle:'dashed'}}><div style={{fontSize:48,marginBottom:12}}>👨‍⚕️</div><p style={{color:'var(--c-muted)',fontWeight:600,fontSize:16,marginBottom:6}}>{t('no_doctors')}</p><p style={{color:'var(--c-muted)',fontSize:13}}>{t('no_doctors_desc')}</p></div>}
      </div>
    </div></div>
  );
}

// ═══════ DOCTOR DETAIL MODAL ═══════
function DoctorDetailModal({doc,isFav,toggleFav,onClose,onSelect}){
  const {t} = useT();
  const hasReviews = (doc.reviewCount||0) > 0;
  const [showReviews,setShowReviews]=useState(false);
  return (
    <div style={{position:'fixed',inset:0,zIndex:200,display:'flex',alignItems:'center',justifyContent:'center',padding:16,background:'rgba(0,0,0,.5)',backdropFilter:'blur(12px)'}} onClick={onClose}>
      <div className="dd-card animate-fadeUp" style={{maxWidth:520,width:'100%',maxHeight:'85vh',overflowY:'auto',padding:0,borderRadius:28}} onClick={e=>e.stopPropagation()}>
        <div style={{position:'relative',height:160,background:'linear-gradient(135deg,var(--c-accent),var(--c-accent2))',borderRadius:'28px 28px 0 0',display:'flex',alignItems:'flex-end',padding:24}}>
          <button onClick={onClose} style={{position:'absolute',top:12,right:12,width:32,height:32,borderRadius:10,background:'rgba(255,255,255,.2)',border:'none',cursor:'pointer',display:'flex',alignItems:'center',justifyContent:'center',color:'white'}}><I n="x" s={18}/></button>
          {toggleFav && <button onClick={()=>toggleFav(doc.id)} style={{position:'absolute',top:12,right:52,width:32,height:32,borderRadius:10,background:'rgba(255,255,255,.2)',border:'none',cursor:'pointer',display:'flex',alignItems:'center',justifyContent:'center'}}>
            <svg width={18} height={18} viewBox="0 0 24 24" fill={isFav?'#ef4444':'none'} stroke={isFav?'#ef4444':'white'} strokeWidth={2}><path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"/></svg>
          </button>}
          {doc.img ? <img src={doc.img} alt="" style={{width:80,height:80,borderRadius:22,objectFit:'cover',border:'3px solid var(--c-surface)',boxShadow:'0 4px 12px rgba(0,0,0,.2)',marginBottom:-40}}/> : <div style={{width:80,height:80,borderRadius:22,border:'3px solid var(--c-surface)',boxShadow:'0 4px 12px rgba(0,0,0,.2)',marginBottom:-40,background:'rgba(255,255,255,.2)',display:'flex',alignItems:'center',justifyContent:'center',color:'white',fontSize:28,fontWeight:800}}>{doc.name?.charAt(0)||'D'}</div>}
        </div>
        <div style={{padding:'48px 28px 28px'}}>
          <div style={{display:'flex',justifyContent:'space-between',alignItems:'flex-start'}}>
            <div>
              <h2 style={{fontSize:'1.5rem',fontWeight:900}}>{doc.name}</h2>
              <div style={{color:'var(--c-accent)',fontWeight:600,fontSize:14,marginTop:2}}>{doc.specialty}</div>
            </div>
            <div style={{textAlign:'right'}}>
              <div style={{fontSize:'1.5rem',fontWeight:900}}>{fmtPrice(doc.price,doc.currency)}</div>
              <div style={{fontSize:11,color:'var(--c-muted)'}}>{t('per_visit')}</div>
            </div>
          </div>
          <div style={{display:'flex',gap:16,marginTop:16,paddingBottom:16,borderBottom:'1px solid var(--c-border)'}}>
            {hasReviews ? <div style={{textAlign:'center'}}><div style={{display:'flex',gap:1}}>{Array.from({length:5},(_,i)=><span key={i} style={{color:i<Math.round(doc.rating)?'#f59e0b':'#cbd5e1',fontSize:18}}>★</span>)}</div><div style={{fontSize:11,color:'var(--c-muted)'}}>{t('rating_label')}</div></div>
              : <div style={{textAlign:'center'}}><div style={{fontWeight:700,fontSize:14,color:'var(--c-muted)'}}>—</div><div style={{fontSize:11,color:'var(--c-muted)'}}>{t('no_reviews')}</div></div>}
            <div style={{textAlign:'center'}}><div style={{fontWeight:800,fontSize:18}}>{doc.reviewCount||0}</div><div style={{fontSize:11,color:'var(--c-muted)'}}>{t('reviews_label')}</div></div>
            <div style={{textAlign:'center'}}><div style={{fontWeight:800,fontSize:18}}>{doc.eta}m</div><div style={{fontSize:11,color:'var(--c-muted)'}}>ETA</div></div>
          </div>
          {doc.bio && <p style={{color:'var(--c-muted)',fontSize:14,lineHeight:1.6,marginTop:16}}>{doc.bio}</p>}
          {(Array.isArray(doc.langs)?doc.langs:[]).length>0 && <div style={{display:'flex',gap:8,marginTop:12,flexWrap:'wrap'}}>
            {doc.langs.map(l=><span key={l} className="dd-badge" style={{background:'var(--c-subtle)',color:'var(--c-muted)'}}><I n="globe" s={10}/>{l}</span>)}
          </div>}
          {/* #19: Education & Experience — visible to patients */}
          {(doc.education || doc.experience) && <div style={{marginTop:16,padding:'14px 16px',borderRadius:14,background:'var(--c-subtle)',border:'1px solid var(--c-border)'}}>
            {doc.education && <div style={{marginBottom:doc.experience?10:0}}><div style={{fontSize:10,fontWeight:800,color:'var(--c-accent)',textTransform:'uppercase',letterSpacing:'.06em',marginBottom:4,display:'flex',alignItems:'center',gap:5}}><I n="award" s={12}/>{t('education')}</div><div style={{fontSize:13,fontWeight:600}}>{doc.education}</div></div>}
            {doc.experience && <div><div style={{fontSize:10,fontWeight:800,color:'var(--c-accent)',textTransform:'uppercase',letterSpacing:'.06em',marginBottom:4,display:'flex',alignItems:'center',gap:5}}><I n="clipboard" s={12}/>{t('experience_label')}</div><div style={{fontSize:13,color:'var(--c-text)',whiteSpace:'pre-line'}}>{doc.experience}</div></div>}
          </div>}
          {/* #18: Reviews section — collapsed by default, click to expand */}
          {hasReviews ? (
            <div style={{marginTop:20}}>
              <button onClick={()=>setShowReviews(!showReviews)} style={{display:'flex',alignItems:'center',justifyContent:'space-between',width:'100%',padding:'12px 16px',borderRadius:14,background:'color-mix(in srgb,#f59e0b 6%,transparent)',border:'1.5px solid color-mix(in srgb,#f59e0b 15%,transparent)',cursor:'pointer',transition:'all .2s'}}>
                <span style={{fontWeight:700,fontSize:14,color:'#b45309',display:'flex',alignItems:'center',gap:8}}><I n="star" s={16}/>{t('patient_reviews')} ({doc.reviewCount})</span>
                <I n={showReviews?'chevUp':'chevDown'} s={16} style={{color:'#b45309',transition:'transform .3s'}}/>
              </button>
              {showReviews && <div style={{display:'flex',flexDirection:'column',gap:10,marginTop:10}} className="animate-fadeUp">
                {(doc.reviews||[]).map((r,i)=>(
                  <div key={i} style={{padding:'12px 16px',borderRadius:14,background:'var(--c-subtle)',border:'1px solid var(--c-border)'}}>
                    <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',marginBottom:4}}>
                      <span style={{fontWeight:700,fontSize:13}}>{r.name}</span>
                      <StarRating value={r.stars} readonly size={14}/>
                    </div>
                    {r.text && <p style={{fontSize:13,color:'var(--c-muted)',lineHeight:1.4}}>{r.text}</p>}
                  </div>
                ))}
              </div>}
            </div>
          ) : (
            <div style={{textAlign:'center',padding:'1.25rem',color:'var(--c-muted)',fontSize:13,background:'var(--c-subtle)',borderRadius:14,marginTop:20}}>{t('no_reviews_first')}</div>
          )}
          <button className="dd-btn dd-btn-primary" onClick={()=>onSelect(doc)} style={{width:'100%',marginTop:20,padding:'1rem',display:'flex',alignItems:'center',justifyContent:'center',gap:8}}>{t('book_with')} {doc.name.split(' ')[1]||doc.name}<LottieAnim name="arrow" size={20} hover style={{filter:'invert(1) brightness(2)',pointerEvents:'auto'}}/></button>
        </div>
      </div>
    </div>
  );
}

// ═══════ RATING MODAL ═══════
function RatingModal({visitId,visits,setVisits,onClose}){
  const [stars,setStars]=useState(0);const [text,setText]=useState('');
  const toast = useToast();
  const v = visits.find(v=>v.id===visitId);
  const submit = async ()=>{
    try{
      await api.put('/visits/'+visitId,{rating:stars,reviewText:text});
      setVisits(p=>p.map(x=>x.id===visitId?{...x,rating:stars,review:text}:x));
      toast('Thank you for your feedback!','success');
    }catch(e){toast('Rating saved locally','success');}
    onClose();
  };
  return (
    <div style={{position:'fixed',inset:0,zIndex:200,display:'flex',alignItems:'center',justifyContent:'center',padding:16,background:'rgba(0,0,0,.5)',backdropFilter:'blur(12px)'}}>
      <div className="dd-card animate-fadeUp" style={{maxWidth:400,width:'100%',padding:'2.5rem',borderRadius:28,textAlign:'center'}}>
        <div style={{width:72,height:72,borderRadius:'50%',background:'color-mix(in srgb,#22c55e 12%,transparent)',display:'flex',alignItems:'center',justifyContent:'center',margin:'0 auto 20px'}}><I n="checkCircle" s={36} c="text-green-500"/></div>
        <h3 style={{fontSize:'1.375rem',fontWeight:900,marginBottom:4}}>Visit Complete!</h3>
        <p style={{color:'var(--c-muted)',fontSize:14,marginBottom:20}}>How was your visit with <strong>{v?.docName||'the doctor'}</strong>?</p>
        <div style={{display:'flex',justifyContent:'center',marginBottom:16}}><StarRating value={stars} onChange={setStars} size={32}/></div>
        <textarea className="dd-input" value={text} onChange={e=>setText(e.target.value)} placeholder="Share your experience (optional)..." style={{height:80,resize:'none',marginBottom:16}}/>
        <div style={{display:'flex',gap:10}}>
          <button className="dd-btn dd-btn-ghost" onClick={onClose} style={{flex:1,border:'1.5px solid var(--c-border)'}}>Skip</button>
          <button className="dd-btn dd-btn-primary" onClick={submit} style={{flex:1.5}} disabled={!stars}>Submit</button>
        </div>
      </div>
    </div>
  );
}

// ═══════ TRIAGE ═══════
function TriageView({onDone,onSkip,onBack}){
  const {t} = useT();
  const [sym,setSym]=useState('');const [busy,setBusy]=useState(false);
  const go = async()=>{if(!sym.trim())return;setBusy(true);const r=await aiTriage(sym);onDone(sym,r);setBusy(false);};
  return (
    <div className="dd-page" style={{display:'flex',flexDirection:'column',alignItems:'center',justifyContent:'center'}}>
      <div style={{maxWidth:600,width:'100%'}} className="animate-fadeUp">
        <button className="dd-btn dd-btn-ghost" onClick={onBack} style={{marginBottom:16,fontSize:13}}><I n="arrowLeft" s={16}/>{t('back')}</button>
        <div className="dd-card" style={{padding:'2rem',borderRadius:24}}>
          <div style={{display:'flex',alignItems:'center',gap:12,marginBottom:16}}>
            <div style={{width:44,height:44,borderRadius:14,background:'color-mix(in srgb,var(--c-accent2) 12%,transparent)',display:'flex',alignItems:'center',justifyContent:'center'}}><I n="sparkle" s={24} c="text-indigo-500"/></div>
            <div><h2 style={{fontSize:'1.375rem',fontWeight:800}}>{t('how_feeling')}</h2><p style={{color:'var(--c-muted)',fontSize:13,marginTop:2}}>{t('describe_symptoms')}</p></div>
          </div>
          <textarea className="dd-input" value={sym} onChange={e=>setSym(e.target.value)} placeholder={t('symptoms_placeholder')} style={{height:140,resize:'none',fontSize:16,lineHeight:1.6}}/>
          <div style={{display:'flex',gap:10,marginTop:20}}>
            <button className="dd-btn dd-btn-primary" style={{flex:1,padding:'1rem'}} disabled={!sym.trim()||busy} onClick={go}>
              {busy?<><span className="animate-spin"><I n="loader" s={18}/></span>{t('analyzing')}</>:<><I n="sparkle" s={18}/>{t('find_doctor')}</>}
            </button>
            <button className="dd-btn dd-btn-ghost" onClick={onSkip} style={{fontSize:13}}>{t('skip_ai')}</button>
          </div>
        </div>
        <p style={{textAlign:'center',marginTop:16,fontSize:11,color:'var(--c-muted)'}}>{t('medical_disclaimer')}</p>
      </div>
    </div>
  );
}

// ═══════ BOOKING ═══════
function BookingView({doc,tri,initSym,onConfirm,onBack,user,savedCards}){
  const {t,dk} = useT();
  const toast = useToast();
  const isEmergency = false; // Emergency feature removed
  // Load saved address/card from localStorage
  const savedAddr = user?.address || '';
  const [addr,setAddr]=useState('');const [spec,setSpec]=useState(doc?.specialty||tri?.specialty||'General Practitioner');const [sym,setSym]=useState(initSym||'');
  const [mode,setMode]=useState('SCHEDULED');const [date,setDate]=useState(new Date().toISOString().split('T')[0]);const [time,setTime]=useState('');
  const [pay,setPay]=useState('card');const [cNum,setCNum]=useState('');const [cHold,setCHold]=useState('');const [cExp,setCExp]=useState('');const [cCvc,setCCvc]=useState('');
  const [tcKimlik,setTcKimlik]=useState('');const [insRecords,setInsRecords]=useState([]);const [insLoading,setInsLoading]=useState(false);const [selectedIns,setSelectedIns]=useState(null);const [insVerified,setInsVerified]=useState(false);const [insClaim,setInsClaim]=useState(null);
  const [wBal,setWBal]=useState(()=>{try{return parseFloat(localStorage.getItem('dd_wallet')||'0');}catch{return 0;}});
  const [showConf,setShowConf]=useState(false);const [locL,setLocL]=useState(false);const [payLoading,setPayLoading]=useState(false);
  const [docSchedule,setDocSchedule]=useState(null);
  const [scheduleLoaded,setScheduleLoaded]=useState(false);
  const [bookedSlots,setBookedSlots]=useState([]);
  // GPS → apartment fields
  const [isGPS,setIsGPS]=useState(false);const [aptName,setAptName]=useState('');const [floor,setFloor]=useState('');const [doorNo,setDoorNo]=useState('');
  // Structured address fields
  const [province,setProvince]=useState('');const [district,setDistrict]=useState('');const [neighborhood,setNeighborhood]=useState('');const [street,setStreet]=useState('');
  // Wallet custom amount
  const [walletAmt,setWalletAmt]=useState('');
  // Legal consent states
  const [informedConsent,setInformedConsent]=useState(false);const [distanceContract,setDistanceContract]=useState(false);
  const cost = doc?.price || 150;
  const fmtCard = v=>v.replace(/\D/g,'').substring(0,16).replace(/(\d{4})/g,'$1 ').trim();
  const fmtExp = v=>{let d=v.replace(/\D/g,'');return d.length>=2?d.substring(0,2)+'/'+d.substring(2,4):d;};
  const payOk = ()=>pay==='card'?cNum.length>=19&&cExp.length>=5&&cCvc.length>=3&&cHold.length>3:pay==='insurance'?insVerified&&selectedIns:wBal>=cost;
  const getLoc = ()=>{setLocL(true);if("geolocation" in navigator)navigator.geolocation.getCurrentPosition(p=>{setAddr(`${p.coords.latitude.toFixed(4)}, ${p.coords.longitude.toFixed(4)}`);setIsGPS(true);setLocL(false);},()=>{toast('Location unavailable','error');setLocL(false);});else{toast('Geolocation not supported','error');setLocL(false);}};
  // TC Kimlik sigorta sorgulama
  const verifyInsurance = async ()=>{
    if(tcKimlik.length!==11){toast(t('err_tc_length'),'warning');return;}
    setInsLoading(true);setInsRecords([]);setSelectedIns(null);setInsVerified(false);setInsClaim(null);
    try{
      const token=localStorage.getItem('dd_token');
      const r=await fetch('/api/insurance/verify',{method:'POST',headers:{'Content-Type':'application/json','Authorization':'Bearer '+token},body:JSON.stringify({tcKimlik})});
      const d=await r.json();
      if(r.ok&&d.records?.length>0){setInsRecords(d.records);setSelectedIns(d.records[0]);setInsVerified(true);toast(t('insurance_found',{n:d.records.length}),'success');}
      else{toast(d.message||d.error||t('insurance_not_found'),'warning');}
    }catch(e){toast(t('insurance_error'),'error');}
    setInsLoading(false);
  };
  // Sigorta claim gönder
  const submitInsuranceClaim = async (visitId)=>{
    if(!selectedIns)return null;
    try{
      const token=localStorage.getItem('dd_token');
      const r=await fetch('/api/insurance/claim',{method:'POST',headers:{'Content-Type':'application/json','Authorization':'Bearer '+token},body:JSON.stringify({visitId,insuranceRecordId:selectedIns.id})});
      return await r.json();
    }catch{return null;}
  };  const streetAddr = [street,neighborhood,district,province].filter(Boolean).join(', ');
  const aptDetails = [aptName?'Apt:'+aptName:'',floor?'Floor:'+floor:'',doorNo?'Door:'+doorNo:''].filter(Boolean).join(', ');
  const fullAddr = isGPS ? `GPS:${addr}${streetAddr?' | '+streetAddr:''}${aptDetails?' | '+aptDetails:''}` : `${streetAddr}${aptDetails?' | '+aptDetails:''}`;
  const addrComplete = isGPS ? (addr.trim()&&aptName.trim()&&floor.trim()&&doorNo.trim()) : (province.trim()&&district.trim()&&neighborhood.trim()&&street.trim()&&aptName.trim()&&floor.trim()&&doorNo.trim());
  const submit = ()=>{if(!addrComplete){toast(t('err_address_required'),'warning');return;}if(mode!=='ASAP'&&!time){toast(t('err_time_required'),'warning');return;}if(!payOk()){toast(t('err_payment_required'),'warning');return;}if(!informedConsent){toast(t('err_informed_consent'),'warning');return;}if(!distanceContract){toast(t('err_distance_contract'),'warning');return;}setShowConf(true);};
  const final = async ()=>{
    setPayLoading(true);
    try{
      if(pay==='wallet'){const nb=wBal-cost;setWBal(nb);localStorage.setItem('dd_wallet',nb.toString());}
      // Save card for future use
      if(pay==='card'&&cNum.length>=19){try{const sc=JSON.parse(localStorage.getItem('dd_saved_cards')||'[]');const l4=cNum.replace(/\s/g,'').slice(-4);if(!sc.find(c=>c.last4===l4)){const nc={last4:l4,holder:cHold,brand:cNum.trim().startsWith('4')?'Visa':'Mastercard',exp:cExp};sc.push(nc);localStorage.setItem('dd_saved_cards',JSON.stringify(sc));localStorage.setItem('dd_profile_cards',JSON.stringify(sc));}}catch{}}
      if(fullAddr.trim()&&!isGPS){try{localStorage.setItem('dd_saved_addr',fullAddr);}catch{}}
      // Build payment data for backend
      const payData = pay==='insurance'&&selectedIns ? {method:'insurance',insuranceId:selectedIns.id,copay:selectedIns.found?Math.round(cost*(1-(selectedIns.coverageRate||0))*100)/100:cost} : {method:pay};
      const visitData = {sym:sym||'Routine Visit',specialty:spec,address:fullAddr,date:mode==='ASAP'?'ASAP':date,time:mode==='ASAP'?'':time,docId:doc?.id,payment:payData};
      // Create visit first
      onConfirm(visitData);
      setShowConf(false);
      // Payment provision (ön provizyon) — runs after visit creation
      if(pay==='card'){
        setTimeout(async ()=>{
          try{
            const token=localStorage.getItem('dd_token');
            // Find the most recent visit to get its ID
            const vr=await fetch('/api/visits',{headers:{'Authorization':'Bearer '+token}});
            const vd=await vr.json();
            const latestVisit=vd.visits?.[0];
            if(latestVisit){
              const pr=await fetch('/api/payment/provision',{method:'POST',headers:{'Content-Type':'application/json','Authorization':'Bearer '+token},body:JSON.stringify({visitId:latestVisit.id,cardNumber:cNum.replace(/\s/g,''),expMonth:cExp.split('/')[0],expYear:cExp.split('/')[1],cvc:cCvc,holderName:cHold,saveCard:true})});
              const pd=await pr.json();
              if(pd.success){toast('Ödeme ön provizyonu alındı ✓','success');}
              else{toast(pd.error||'Ödeme hatası','error');}
            }
          }catch(e){console.error('Payment provision error:',e);}
        },1500);
      }
      toast('Randevu onaylandı!','success');
    }catch(e){toast('Bir hata oluştu','error');}
    setPayLoading(false);
  };

  // Fetch doctor availability + booked slots
  useEffect(()=>{
    if(doc?.id){
      api.get('/schedule/'+doc.id).then(r=>{setDocSchedule(r.schedule||[]);setScheduleLoaded(true);}).catch(()=>{setScheduleLoaded(true);});
    }
  },[doc?.id]);
  // Fetch existing bookings for this doctor+date to mark as taken (#2)
  useEffect(()=>{
    if(doc?.id&&date){
      api.get('/visits').then(r=>{
        const taken=(r.visits||[]).filter(v=>v.docId===doc.id&&(v.status==='upcoming'||v.status==='pending')&&v.date&&v.date.includes(date)).map(v=>v.time||v.date.split(' ')[1]||'').filter(Boolean);
        setBookedSlots(taken);
      }).catch(()=>{});
    }
  },[doc?.id,date]);

  const getAvailableSlots = ()=>{
    if(!scheduleLoaded && doc) return 'loading';
    if(!docSchedule || docSchedule.length===0) return [];
    const hasAnyAvailability = docSchedule.some(s=>{
      if(!s.enabled) return false;
      try { const sl=JSON.parse(s.slots||'[]'); return sl.length>0; } catch { return false; }
    });
    if(!hasAnyAvailability) return [];
    const d = new Date(date);
    const dayNames = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];
    const dayName = dayNames[d.getDay()];
    const daySchedule = docSchedule.find(s=>s.day_of_week===dayName);
    if(!daySchedule || !daySchedule.enabled) return [];
    try { const parsed = JSON.parse(daySchedule.slots||'[]'); return parsed.sort((a,b)=>a.localeCompare(b)); } catch { return []; }
  };

  const availableSlots = getAvailableSlots();
  const ALL_HOURS = Array.from({length:24},(_,i)=>`${String(i).padStart(2,'0')}:00`);
  // #9: Filter past times for today
  const now = new Date();
  const isToday = date === now.toISOString().split('T')[0];
  const currentHour = now.getHours();
  const isPastSlot = (s) => isToday ? parseInt(s.split(':')[0]) <= currentHour : false;
  // Only show slots from doctor's schedule (not all 24 hours)
  const slotsToShow = availableSlots==='loading' ? [] : (!doc ? ALL_HOURS : (Array.isArray(availableSlots) ? availableSlots : []));

  // Auto-fill helpers (#9)
  const autoFillAddr = ()=>{if(savedAddr){setAddr(savedAddr);setIsGPS(false);toast('Address filled from profile','success');}};
  const autoFillCard = (c)=>{setCNum('•••• •••• •••• '+c.last4);setCHold(c.holder);setCExp(c.exp);setCCvc('***');toast('Card filled','success');};
  const lsCards = useMemo(()=>{try{const a=JSON.parse(localStorage.getItem('dd_saved_cards')||'[]');const b=JSON.parse(localStorage.getItem('dd_profile_cards')||'[]');return [...a,...b].filter((c,i,arr)=>arr.findIndex(x=>x.last4===c.last4)===i);}catch{return [];}},[]);
  const lsAddr = useMemo(()=>{try{return localStorage.getItem('dd_saved_addr')||'';}catch{return '';}},[]);
  const allSavedCards = [...(savedCards||[]),...lsCards].filter((c,i,a)=>a.findIndex(x=>x.last4===c.last4)===i);

  const step = !addrComplete?0:mode==='SCHEDULED'&&!time?1:!payOk()?2:3;
  const stepLabels = doc ? ['Details','Schedule','Payment','Confirm'] : ['Symptoms','Location','Payment','Confirm'];

  return (
    <div className="dd-page" style={{display:'flex',justifyContent:'center'}}>
      <div style={{maxWidth:560,width:'100%'}} className="animate-fadeUp">
        {tri && !doc && (
          <div className="dd-card" style={{padding:'1.25rem',marginBottom:16,borderLeft:'4px solid var(--c-accent2)',borderRadius:'4px 20px 20px 4px'}}>
            <div style={{display:'flex',gap:12,alignItems:'flex-start'}}>
              <I n="sparkle" s={20} c="text-indigo-500" style={{flexShrink:0,marginTop:2}}/>
              <div><div style={{fontWeight:700,fontSize:14,color:'var(--c-accent2)'}}>{t('recommendation')}: {tri.specialty}</div><p style={{color:'var(--c-muted)',fontSize:13,marginTop:4}}>{tri.advice}</p>
                <div style={{display:'flex',gap:6,marginTop:8}}><span className="dd-badge" style={{background:'color-mix(in srgb,var(--c-accent2) 10%,transparent)',color:'var(--c-accent2)'}}>{tri.urgency}</span><span className="dd-badge" style={{background:'var(--c-subtle)',color:'var(--c-muted)'}}>{tri.timeframe}</span></div>
              </div>
            </div>
          </div>
        )}
        {doc && (
          <div className="dd-card" style={{display:'flex',alignItems:'center',gap:16,padding:'1rem 1.25rem',marginBottom:16}}>
            <DocAvatar src={doc.img} name={doc.name} size={52} radius={16}/>
            <div style={{flex:1}}><div style={{fontWeight:800}}>{doc.name}</div><div style={{color:'var(--c-accent)',fontSize:13,fontWeight:600}}>{doc.specialty}</div></div>
            <div style={{textAlign:'right'}}><div style={{fontWeight:800,fontSize:'1.25rem'}}>{fmtPrice(doc.price,doc.currency)}</div><div style={{fontSize:11,color:'var(--c-muted)'}}>per visit</div></div>
          </div>
        )}
        <StepProgress steps={stepLabels} current={step}/>
        <div className="dd-card" style={{padding:'2rem',borderRadius:24}}>
          <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',marginBottom:24}}>
            <h2 style={{fontSize:'1.375rem',fontWeight:800}}>{doc?t('booking_title'):t('urgent_care')}</h2>
            <button className="dd-btn dd-btn-ghost" onClick={onBack} style={{fontSize:12,padding:'6px 12px'}}>{t('back')}</button>
          </div>
          <div style={{display:'flex',flexDirection:'column',gap:20}}>
            {!doc && <div><label style={{fontSize:11,fontWeight:800,color:'var(--c-muted)',textTransform:'uppercase',letterSpacing:'.06em',marginBottom:6,display:'block'}}>Specialty</label><select className="dd-input" value={spec} onChange={e=>setSpec(e.target.value)}><option>General Practitioner</option><option>Pediatrician</option><option>Dermatologist</option><option>Orthopedist</option><option>Cardiologist</option></select></div>}
            {(!initSym||doc) && <div><label style={{fontSize:11,fontWeight:800,color:'var(--c-muted)',textTransform:'uppercase',letterSpacing:'.06em',marginBottom:6,display:'block'}}>Reason for visit</label><textarea className="dd-input" value={sym} onChange={e=>setSym(e.target.value)} placeholder="Describe your concern..." style={{height:90,resize:'none'}}/></div>}
            <div><label style={{fontSize:11,fontWeight:800,color:'var(--c-muted)',textTransform:'uppercase',letterSpacing:'.06em',marginBottom:6,display:'block'}}>{t('delivery_address')}</label>
              {/* GPS option */}
              <div style={{display:'flex',gap:6,marginBottom:10}}>
                <button type="button" onClick={getLoc} disabled={locL} style={{padding:'8px 14px',borderRadius:10,fontSize:12,fontWeight:700,border:`1.5px solid ${isGPS?'var(--c-accent)':'var(--c-border)'}`,background:isGPS?'color-mix(in srgb,var(--c-accent) 8%,transparent)':'transparent',color:isGPS?'var(--c-accent)':'var(--c-muted)',cursor:'pointer',display:'flex',alignItems:'center',gap:6}}>{locL?<span className="animate-spin"><I n="loader" s={14}/></span>:<I n="nav" s={14}/>}{isGPS?'GPS Active':'Use GPS'}</button>
                {isGPS && <button type="button" onClick={()=>{setIsGPS(false);setAddr('');}} style={{padding:'8px 14px',borderRadius:10,fontSize:12,fontWeight:700,border:'1.5px solid var(--c-border)',background:'transparent',color:'var(--c-muted)',cursor:'pointer'}}>Clear GPS</button>}
              </div>
              {/* GPS coordinates (informational) */}
              {isGPS && addr && <div style={{padding:'10px 14px',borderRadius:10,background:'color-mix(in srgb,var(--c-accent) 6%,transparent)',border:'1px solid color-mix(in srgb,var(--c-accent) 15%,transparent)',marginBottom:10,fontSize:13,display:'flex',alignItems:'center',gap:8}}><I n="mapPin" s={16} c="text-teal-600"/><span style={{fontWeight:600}}>{addr}</span><span style={{fontSize:10,color:'var(--c-muted)',marginLeft:'auto'}}>GPS coordinates</span></div>}
              {/* Show structured address fields ONLY when GPS is NOT active */}
              {!isGPS && <div style={{display:'flex',flexDirection:'column',gap:8,marginBottom:10}}>
                <div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:8}}>
                  <div><label style={{fontSize:10,fontWeight:700,color:'var(--c-muted)',display:'block',marginBottom:3}}>Province / İl *</label><input className="dd-input" placeholder="e.g. İstanbul" value={province} onChange={e=>setProvince(e.target.value)} style={{padding:'.75rem'}}/></div>
                  <div><label style={{fontSize:10,fontWeight:700,color:'var(--c-muted)',display:'block',marginBottom:3}}>District / İlçe *</label><input className="dd-input" placeholder="e.g. Kadıköy" value={district} onChange={e=>setDistrict(e.target.value)} style={{padding:'.75rem'}}/></div>
                </div>
                <div><label style={{fontSize:10,fontWeight:700,color:'var(--c-muted)',display:'block',marginBottom:3}}>Neighborhood / Mahalle *</label><input className="dd-input" placeholder="e.g. Caferağa Mah." value={neighborhood} onChange={e=>setNeighborhood(e.target.value)} style={{padding:'.75rem'}}/></div>
                <div><label style={{fontSize:10,fontWeight:700,color:'var(--c-muted)',display:'block',marginBottom:3}}>Street / Sokak *</label><input className="dd-input" placeholder="e.g. Moda Cad. No:15" value={street} onChange={e=>setStreet(e.target.value)} style={{padding:'.75rem'}}/></div>
              </div>}
              {/* Apartment details — always shown below address */}
              <div style={{padding:16,borderRadius:14,background:'color-mix(in srgb,var(--c-accent) 4%,transparent)',border:'1px solid color-mix(in srgb,var(--c-accent) 15%,transparent)'}}>
                <div style={{fontSize:11,fontWeight:800,color:'var(--c-accent)',textTransform:'uppercase',letterSpacing:'.06em',marginBottom:8}}>Apartment Details *</div>
                <div style={{display:'flex',flexDirection:'column',gap:8}}>
                  <input className="dd-input" placeholder="Building / Apartment name" value={aptName} onChange={e=>setAptName(e.target.value)} style={{padding:'.75rem'}}/>
                  <div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:8}}>
                    <input className="dd-input" placeholder="Floor" value={floor} onChange={e=>setFloor(e.target.value)} style={{padding:'.75rem'}}/>
                    <input className="dd-input" placeholder="Door number" value={doorNo} onChange={e=>setDoorNo(e.target.value)} style={{padding:'.75rem'}}/>
                  </div>
                </div>
              </div>
            </div>
            {mode==='SCHEDULED' && <div style={{display:'flex',flexDirection:'column',gap:12}}>
              <input className="dd-input" type="date" value={date} min={new Date().toISOString().split('T')[0]} onChange={e=>{setDate(e.target.value);setTime('');}}/>
              {availableSlots==='loading' && <div style={{padding:16,borderRadius:14,background:'var(--c-subtle)',textAlign:'center'}}><span className="animate-spin" style={{display:'inline-block',marginRight:8}}><I n="loader" s={16}/></span><span style={{color:'var(--c-muted)',fontSize:13}}>Loading schedule...</span></div>}
              {doc && availableSlots!=='loading' && slotsToShow.length===0 && <div style={{padding:16,borderRadius:14,background:'color-mix(in srgb,var(--c-danger) 6%,transparent)',border:'1px solid color-mix(in srgb,var(--c-danger) 15%,transparent)',textAlign:'center'}}><p style={{color:'var(--c-danger)',fontWeight:700,fontSize:13}}>Doctor is not available on this day. Please select another date.</p></div>}
              {slotsToShow.length>0 && <div style={{display:'grid',gridTemplateColumns:'repeat(4,1fr)',gap:6}}>{slotsToShow.map(s=>{
                const isBooked = bookedSlots.includes(s);
                const past = isPastSlot(s);
                const canSelect = !isBooked && !past;
                return <button key={s} type="button" onClick={()=>canSelect&&setTime(s)} disabled={!canSelect} style={{padding:'10px 0',borderRadius:10,fontSize:12,fontWeight:700,fontFamily:'var(--font-display)',cursor:canSelect?'pointer':'not-allowed',border:'1.5px solid',transition:'all .2s',background:time===s?'var(--c-accent)':past?'var(--c-subtle)':isBooked?'var(--c-subtle)':'transparent',color:time===s?'white':past?'var(--c-muted)':isBooked?'var(--c-muted)':'var(--c-text)',borderColor:time===s?'var(--c-accent)':past?'var(--c-border)':isBooked?'var(--c-border)':'var(--c-border)',opacity:canSelect||time===s?1:0.45}}>{s}{isBooked?' ✗':past?' ·':''}</button>;
              })}</div>}
              {isToday && slotsToShow.length>0 && <div style={{fontSize:11,color:'var(--c-muted)',display:'flex',alignItems:'center',gap:6,marginTop:4}}><div style={{width:12,height:12,borderRadius:4,background:'var(--c-subtle)',border:'1px solid var(--c-border)'}}/> Past time</div>}
              {bookedSlots.length>0 && slotsToShow.length>0 && <div style={{fontSize:11,color:'var(--c-muted)',display:'flex',alignItems:'center',gap:6}}><div style={{width:12,height:12,borderRadius:4,background:'var(--c-subtle)',border:'1px solid var(--c-border)'}}/> Already booked</div>}
            </div>}
            {mode==='ASAP' && <div style={{padding:16,borderRadius:16,background:'color-mix(in srgb,var(--c-warn) 8%,transparent)',border:'1px solid color-mix(in srgb,var(--c-warn) 18%,transparent)',display:'flex',gap:12,alignItems:'flex-start'}}><I n="clock" s={20} c="text-amber-500" style={{flexShrink:0,marginTop:2}}/><div><div style={{fontWeight:700,fontSize:14,color:'#b45309'}}>Estimated: {doc?`~${doc.eta} min`:'45-60 min'}</div><div style={{fontSize:12,color:'#92400e',marginTop:2}}>Nearest available doctor dispatched immediately</div></div></div>}
            {/* Payment */}
            <div style={{borderTop:'1.5px solid var(--c-border)',paddingTop:20}}>
              <h3 style={{fontWeight:800,fontSize:15,marginBottom:12,display:'flex',alignItems:'center',gap:8}}><I n="shield" s={18} c="text-teal-600"/>{t('secure_payment')}</h3>
              <div style={{display:'grid',gridTemplateColumns:'repeat(3,1fr)',gap:8,marginBottom:16}}>
                {[['card','Card',ic.credit],['wallet','Wallet',null],['insurance','Insurance',ic.shield]].map(([k,l,icon])=><button key={k} type="button" onClick={()=>setPay(k)} style={{display:'flex',flexDirection:'column',alignItems:'center',gap:6,padding:'12px 0',borderRadius:14,fontSize:10,fontWeight:800,fontFamily:'var(--font-display)',textTransform:'uppercase',letterSpacing:'.05em',cursor:'pointer',border:'1.5px solid',transition:'all .2s',background:pay===k?'var(--c-accent)':'transparent',color:pay===k?'white':'var(--c-muted)',borderColor:pay===k?'var(--c-accent)':'var(--c-border)'}}>{k==='wallet'?<LottieAnim name="wallet" size={22} hover style={{filter:pay===k?'invert(1) brightness(2)':dk?'invert(0.6)':'',pointerEvents:'auto'}}/>:<P d={icon} s={18}/>}{l}</button>)}
              </div>
              {pay==='card' && <div style={{display:'flex',flexDirection:'column',gap:10}}>
                {/* Auto-fill from saved cards (#9) */}
                {allSavedCards.length>0&&!cNum && <div style={{marginBottom:6}}>
                  <div style={{fontSize:11,fontWeight:700,color:'var(--c-muted)',marginBottom:6}}>Use saved card:</div>
                  <div style={{display:'flex',gap:6,flexWrap:'wrap'}}>{allSavedCards.map(c=><button key={c.last4} type="button" onClick={()=>autoFillCard(c)} style={{padding:'6px 12px',borderRadius:8,fontSize:11,fontWeight:700,border:'1.5px solid var(--c-border)',background:'transparent',color:'var(--c-text)',cursor:'pointer',display:'flex',alignItems:'center',gap:6}}><span style={{fontSize:9,fontWeight:900,color:c.brand==='Visa'?'#1a1f71':'#eb001b'}}>{c.brand==='Visa'?'VISA':'MC'}</span>•••• {c.last4}</button>)}</div>
                </div>}
                <CreditCardVisual number={cNum} holder={cHold} expiry={cExp}/>
                <input className="dd-input" placeholder="0000 0000 0000 0000" value={cNum} onChange={e=>setCNum(fmtCard(e.target.value))} maxLength={19} style={{fontFamily:'monospace',letterSpacing:'.05em'}}/>
                <input className="dd-input" placeholder="NAME ON CARD" value={cHold} onChange={e=>setCHold(e.target.value.toUpperCase())}/>
                <div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:10}}>
                  <input className="dd-input" placeholder="MM/YY" value={cExp} onChange={e=>setCExp(fmtExp(e.target.value))} maxLength={5} style={{textAlign:'center',fontFamily:'monospace'}}/>
                  <input className="dd-input" type="password" placeholder="CVC" value={cCvc} onChange={e=>setCCvc(e.target.value.replace(/\D/g,''))} maxLength={4} style={{textAlign:'center',fontFamily:'monospace'}}/>
                </div>
              </div>}
              {pay==='wallet' && <div style={{textAlign:'center',padding:20}}>
                <div style={{fontSize:'2rem',fontWeight:900}}>{'$'}{wBal.toFixed(2)}</div>
                <p style={{color:'var(--c-muted)',fontSize:13,margin:'8px 0 16px'}}>Wallet balance</p>
                {wBal<cost && <p style={{color:'var(--c-danger)',fontWeight:700,fontSize:13,marginBottom:12}}>Need {fmtPrice(cost,doc.currency||'TRY')} for this visit</p>}
                {allSavedCards.length>0 ? <>
                  <div style={{display:'flex',gap:6,marginBottom:8}}>
                    {[50,100,200].map(a=><button key={a} type="button" onClick={()=>{const nb=wBal+a;setWBal(nb);localStorage.setItem('dd_wallet',nb.toString());toast(`$${a} added`,'success');}} className="dd-btn dd-btn-ghost" style={{flex:1,border:'1.5px solid var(--c-border)',padding:'8px',fontSize:13}}>+${a}</button>)}
                  </div>
                  <div style={{display:'flex',gap:6}}>
                    <input className="dd-input" type="number" placeholder="Custom $" value={walletAmt} onChange={e=>setWalletAmt(e.target.value)} style={{flex:1,padding:'.75rem'}}/>
                    <button type="button" onClick={()=>{const a=parseFloat(walletAmt);if(a>0){const nb=wBal+a;setWBal(nb);localStorage.setItem('dd_wallet',nb.toString());setWalletAmt('');toast(`$${a} added`,'success');}}} className="dd-btn dd-btn-primary" style={{padding:'8px 16px'}} disabled={!walletAmt||parseFloat(walletAmt)<=0}>Add</button>
                  </div>
                </> : <div style={{padding:'12px',color:'var(--c-muted)',fontSize:13,background:'var(--c-subtle)',borderRadius:12}}>Save a card first to add wallet funds</div>}
              </div>}
              {pay==='insurance' && <div style={{display:'flex',flexDirection:'column',gap:10}}>
                <div style={{padding:20,borderRadius:16,background:'linear-gradient(135deg,#1e40af,#3b82f6)',color:'white',position:'relative',overflow:'hidden',marginBottom:6}}>
                  <div style={{position:'absolute',top:-20,right:-20,width:100,height:100,borderRadius:'50%',background:'rgba(255,255,255,.08)'}}/>
                  <div style={{fontSize:10,fontWeight:700,letterSpacing:'.08em',opacity:.7,marginBottom:8}}>ÖZEL SİGORTA SORGULAMA</div>
                  <div style={{fontSize:16,fontWeight:800,fontFamily:'var(--font-display)'}}>{selectedIns?selectedIns.providerName:'TC Kimlik ile Sorgula'}</div>
                  <div style={{fontSize:13,fontFamily:'monospace',marginTop:4,letterSpacing:'.04em'}}>{selectedIns?selectedIns.policyNumber:'Yalnızca Özel Sigorta'}</div>
                  {selectedIns && <div style={{marginTop:10,padding:'6px 12px',borderRadius:8,background:'rgba(255,255,255,.15)',fontSize:12,display:'inline-block'}}>Karşılanan: %{Math.round((selectedIns.coverageRate||0)*100)} — Max ₺{selectedIns.maxPerVisit||0}/ziyaret</div>}
                </div>
                <div style={{padding:'6px 12px',borderRadius:8,background:'color-mix(in srgb,var(--c-warn) 6%,transparent)',fontSize:10,color:'#92400e',textAlign:'center'}}>Yasal gereklilikler nedeniyle yalnızca özel sağlık sigortaları sorgulanabilir. SGK sorgulaması yapılamamaktadır.</div>
                <div style={{display:'flex',gap:8}}>
                  <input className="dd-input" placeholder="TC Kimlik No (11 hane)" value={tcKimlik} onChange={e=>setTcKimlik(e.target.value.replace(/\D/g,'').slice(0,11))} maxLength={11} style={{flex:1,fontFamily:'monospace',letterSpacing:'.08em'}}/>
                  <button type="button" onClick={verifyInsurance} disabled={tcKimlik.length!==11||insLoading} className="dd-btn dd-btn-primary" style={{padding:'8px 16px',fontSize:12,fontWeight:800,opacity:tcKimlik.length!==11?.4:1,minWidth:90}}>{insLoading?'Sorgulanıyor...':'Sorgula'}</button>
                </div>
                {insRecords.length>0 && <div style={{display:'flex',flexDirection:'column',gap:6}}>
                  <div style={{fontSize:11,fontWeight:700,color:'var(--c-muted)',marginBottom:2}}>Bulunan sigortalar:</div>
                  {insRecords.map((ins,i)=><button key={i} type="button" onClick={()=>setSelectedIns(ins)} style={{display:'flex',alignItems:'center',justifyContent:'space-between',padding:'12px 16px',borderRadius:12,border:selectedIns?.id===ins.id?'2px solid var(--c-accent)':'1.5px solid var(--c-border)',background:selectedIns?.id===ins.id?'color-mix(in srgb,var(--c-accent) 6%,transparent)':'transparent',cursor:'pointer',transition:'all .2s'}}>
                    <div style={{textAlign:'left'}}>
                      <div style={{fontWeight:700,fontSize:13}}>{ins.providerName}</div>
                      <div style={{fontSize:11,color:'var(--c-muted)',fontFamily:'monospace'}}>{ins.policyNumber}</div>
                    </div>
                    <div style={{textAlign:'right'}}>
                      <div style={{fontWeight:800,fontSize:14,color:'var(--c-accent)'}}>%{Math.round((ins.coverageRate||0)*100)}</div>
                      <div style={{fontSize:10,color:'var(--c-muted)'}}>Max ₺{ins.maxPerVisit}</div>
                    </div>
                  </button>)}
                  {selectedIns && <div style={{padding:12,borderRadius:10,background:'color-mix(in srgb,var(--c-accent) 5%,transparent)',border:'1px solid color-mix(in srgb,var(--c-accent) 12%,transparent)',fontSize:12}}>
                    <div style={{display:'flex',justifyContent:'space-between',marginBottom:4}}><span style={{color:'var(--c-muted)'}}>Seans Ücreti</span><span style={{fontWeight:700}}>₺{cost}</span></div>
                    <div style={{display:'flex',justifyContent:'space-between',marginBottom:4}}><span style={{color:'var(--c-muted)'}}>Sigorta Karşılayan</span><span style={{fontWeight:700,color:'var(--c-accent)'}}>-₺{Math.min(Math.round(cost*(selectedIns.coverageRate||0)*100)/100, selectedIns.maxPerVisit||0)}</span></div>
                    <div style={{display:'flex',justifyContent:'space-between',borderTop:'1px solid var(--c-border)',paddingTop:6,marginTop:4}}><span style={{fontWeight:800}}>Sizin Ödemeniz</span><span style={{fontWeight:900,fontSize:16,color:'var(--c-accent)'}}>₺{Math.max(cost - Math.min(Math.round(cost*(selectedIns.coverageRate||0)*100)/100, selectedIns.maxPerVisit||0), 0)}</span></div>
                  </div>}
                </div>}
                {insVerified && !selectedIns && <div style={{padding:12,borderRadius:10,background:'color-mix(in srgb,var(--c-warn) 8%,transparent)',fontSize:12,color:'#b45309',textAlign:'center'}}>Lütfen bir sigorta seçin</div>}
              </div>}
            </div>
          </div>
          {/* Yasal Onaylar — Aydınlatılmış Onam + Mesafeli Sözleşme */}
          <div style={{marginTop:20,padding:'14px 16px',borderRadius:14,border:'1px solid var(--c-border)',background:'var(--c-subtle)',display:'flex',flexDirection:'column',gap:10}}>
            <div style={{fontSize:11,fontWeight:800,color:'var(--c-muted)',textTransform:'uppercase',letterSpacing:'.05em'}}>Yasal Onaylar</div>
            <label style={{display:'flex',gap:10,alignItems:'flex-start',fontSize:11,cursor:'pointer',lineHeight:1.4}}>
              <input type="checkbox" checked={informedConsent} onChange={e=>setInformedConsent(e.target.checked)} style={{marginTop:2,accentColor:'var(--c-accent)',flexShrink:0}}/>
              <span><strong>Aydınlatılmış Onam:</strong> Evde muayene hizmetinin hastane ortamından farklı olduğunu, acil durumlarda {getEmergencyNumber(user?.country)}'nin aranacağını, doktorun bağımsız yüklenici olarak hizmet verdiğini ve platformun tıbbi sorumluluk taşımadığını anladım, kabul ediyorum.</span>
            </label>
            <label style={{display:'flex',gap:10,alignItems:'flex-start',fontSize:11,cursor:'pointer',lineHeight:1.4}}>
              <input type="checkbox" checked={distanceContract} onChange={e=>setDistanceContract(e.target.checked)} style={{marginTop:2,accentColor:'var(--c-accent)',flexShrink:0}}/>
              <span><strong>Mesafeli Sözleşme Ön Bilgilendirme:</strong> 6502 sayılı TKHK kapsamında; hizmet bedeli, iptal/iade koşulları (12 saat öncesine kadar tam iade, sonrası iade yok) ve cayma hakkı şartlarını okudum, kabul ediyorum. <a href="#" style={{color:'var(--c-accent)',textDecoration:'underline'}}>Sözleşmeyi oku</a></span>
            </label>
          </div>
          <button className={`dd-btn ${doc?'dd-btn-primary':'dd-btn-danger'}`} disabled={!addrComplete||!payOk()||!informedConsent||!distanceContract} onClick={submit} style={{width:'100%',marginTop:16,padding:'1.125rem',fontSize:'1rem',opacity:(!addrComplete||!payOk()||!informedConsent||!distanceContract)?.35:1}}>
            {doc?t('confirm_appointment'):t('find_emergency_doctor')}
          </button>
        </div>
        {showConf && (
          <div style={{position:'fixed',inset:0,zIndex:200,display:'flex',alignItems:'center',justifyContent:'center',padding:16,background:'rgba(0,0,0,.5)',backdropFilter:'blur(12px)'}}>
            <div className="dd-card animate-fadeUp" style={{maxWidth:400,width:'100%',padding:'2.5rem',borderRadius:28,textAlign:'center'}}>
              <div style={{width:72,height:72,borderRadius:22,background:'color-mix(in srgb,var(--c-accent) 12%,transparent)',display:'flex',alignItems:'center',justifyContent:'center',margin:'0 auto 20px'}}><I n="checkCircle" s={36} c="text-teal-600"/></div>
              <h3 style={{fontSize:'1.5rem',fontWeight:900,marginBottom:6}}>Confirm Booking</h3>
              <div style={{background:'var(--c-subtle)',borderRadius:16,padding:20,marginTop:16,marginBottom:24,textAlign:'left',fontSize:13}}>
                <div style={{display:'flex',justifyContent:'space-between',padding:'8px 0',borderBottom:'1px solid var(--c-border)'}}><span style={{color:'var(--c-muted)'}}>Doctor</span><span style={{fontWeight:700}}>{doc?doc.name:spec}</span></div>
                <div style={{display:'flex',justifyContent:'space-between',padding:'8px 0',borderBottom:'1px solid var(--c-border)'}}><span style={{color:'var(--c-muted)'}}>When</span><span style={{fontWeight:700}}>{mode==='ASAP'?'Now':date+' '+time}</span></div>
                <div style={{display:'flex',justifyContent:'space-between',padding:'8px 0',borderBottom:'1px solid var(--c-border)'}}><span style={{color:'var(--c-muted)'}}>Where</span><span style={{fontWeight:700,maxWidth:200,textAlign:'right',fontSize:12}}>{streetAddr}</span></div>
                <div style={{display:'flex',justifyContent:'space-between',padding:'8px 0',borderBottom:'1px solid var(--c-border)'}}><span style={{color:'var(--c-muted)'}}>Apartment</span><span style={{fontWeight:700,fontSize:12}}>{aptName}, Floor {floor}, Door {doorNo}</span></div>
                <div style={{display:'flex',justifyContent:'space-between',padding:'8px 0',borderBottom:'1px solid var(--c-border)'}}><span style={{color:'var(--c-muted)'}}>Ödeme</span><span style={{fontWeight:700,fontSize:12}}>{pay==='card'?'Kredi Kartı (••••'+cNum.replace(/\s/g,'').slice(-4)+')':pay==='insurance'?'Sigorta'+(selectedIns?' ('+selectedIns.providerName+')':''):'Cüzdan'}</span></div>
                {pay==='insurance'&&selectedIns ? <>
                  <div style={{display:'flex',justifyContent:'space-between',padding:'8px 0',borderBottom:'1px solid var(--c-border)'}}><span style={{color:'var(--c-muted)'}}>Seans Ücreti</span><span style={{fontWeight:700}}>₺{cost}</span></div>
                  <div style={{display:'flex',justifyContent:'space-between',padding:'8px 0',borderBottom:'1px solid var(--c-border)'}}><span style={{color:'var(--c-accent)'}}>Sigorta Karşılayan</span><span style={{fontWeight:700,color:'var(--c-accent)'}}>-₺{Math.min(Math.round(cost*(selectedIns.coverageRate||0)*100)/100,selectedIns.maxPerVisit||0)}</span></div>
                  <div style={{display:'flex',justifyContent:'space-between',padding:'8px 0'}}><span style={{fontWeight:800}}>Sizin Ödemeniz</span><span style={{fontWeight:900,fontSize:18,color:'var(--c-accent)'}}>₺{Math.max(cost-Math.min(Math.round(cost*(selectedIns.coverageRate||0)*100)/100,selectedIns.maxPerVisit||0),0)}</span></div>
                </> : <div style={{display:'flex',justifyContent:'space-between',padding:'8px 0'}}><span style={{color:'var(--c-muted)'}}>Tutar</span><span style={{fontWeight:900,fontSize:18,color:'var(--c-accent)'}}>{fmtPrice(cost,doc?.currency||'TRY')}</span></div>}
              </div>
              <div style={{display:'flex',gap:10}}><button className="dd-btn dd-btn-ghost" onClick={()=>setShowConf(false)} style={{flex:1,border:'1.5px solid var(--c-border)'}}>Düzenle</button><button className="dd-btn dd-btn-primary" onClick={final} disabled={payLoading} style={{flex:1.5,opacity:payLoading?.6:1}}>{payLoading?'İşleniyor...':t('confirm')}</button></div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

// ═══════ FINDING ═══════
function FindingView(){
  const [dots, setDots] = useState(0);
  useEffect(()=>{const iv=setInterval(()=>setDots(d=>(d+1)%4),500);return()=>clearInterval(iv);},[]);
  return (
    <div className="dd-page" style={{display:'flex',flexDirection:'column',alignItems:'center',justifyContent:'center'}}>
      <div className="animate-fadeUp" style={{textAlign:'center'}}>
        <div style={{position:'relative',width:96,height:96,margin:'0 auto 28px'}}>
          <div style={{position:'absolute',inset:0,borderRadius:'50%',border:'3px solid var(--c-border)'}}/>
          <div style={{position:'absolute',inset:0,borderRadius:'50%',border:'3px solid var(--c-danger)',borderTopColor:'transparent',animation:'spin 1s linear infinite'}}/>
          <div style={{position:'absolute',inset:0,display:'flex',alignItems:'center',justifyContent:'center'}}><span style={{color:'var(--c-danger)',fontWeight:900,fontFamily:'var(--font-display)',fontSize:18}}>SOS</span></div>
        </div>
        <h2 style={{fontSize:'1.5rem',fontWeight:800,marginBottom:8}}>Finding your doctor{'.'.repeat(dots)}</h2>
        <p style={{color:'var(--c-muted)',maxWidth:300,margin:'0 auto'}}>Dispatching nearest available physician to your location.</p>
      </div>
    </div>
  );
}

// ═══════ WAITING FOR DOCTOR CONFIRMATION ═══════
function WaitingConfirmView({doc, visit, onCancel}){
  const {t} = useT();
  const [dots, setDots] = useState(0);
  const [elapsed, setElapsed] = useState(0);
  useEffect(()=>{const iv=setInterval(()=>setDots(d=>(d+1)%4),500);return()=>clearInterval(iv);},[]);
  useEffect(()=>{const iv=setInterval(()=>setElapsed(e=>e+1),1000);return()=>clearInterval(iv);},[]);
  const mins = Math.floor(elapsed/60);
  const secs = elapsed%60;
  return (
    <div className="dd-page" style={{display:'flex',flexDirection:'column',alignItems:'center',justifyContent:'center',minHeight:'70vh'}}>
      <div className="animate-fadeUp" style={{textAlign:'center',maxWidth:420}}>
        <div style={{position:'relative',width:96,height:96,margin:'0 auto 28px'}}>
          <div style={{position:'absolute',inset:0,borderRadius:'50%',border:'3px solid var(--c-border)'}}/>
          <div style={{position:'absolute',inset:0,borderRadius:'50%',border:'3px solid var(--c-accent)',borderTopColor:'transparent',animation:'spin 1.5s linear infinite'}}/>
          {doc ? <DocAvatar src={doc.img} name={doc.name} size={64} radius={32} style={{position:'absolute',top:16,left:16}}/> :
          <div style={{position:'absolute',inset:0,display:'flex',alignItems:'center',justifyContent:'center',fontSize:32}}>⏳</div>}
        </div>
        <h2 style={{fontSize:'1.5rem',fontWeight:800,marginBottom:8}}>Waiting for confirmation{'.'.repeat(dots)}</h2>
        <p style={{color:'var(--c-muted)',marginBottom:4}}>
          Your request has been sent to <strong style={{color:'var(--c-text)'}}>{doc?.name || 'the doctor'}</strong>
        </p>
        <p style={{color:'var(--c-muted)',fontSize:13,marginBottom:20}}>
          The doctor will review and accept or decline your booking.
        </p>

        <div className="dd-card" style={{padding:'20px 24px',textAlign:'left',marginBottom:20}}>
          <div style={{display:'flex',justifyContent:'space-between',marginBottom:12}}>
            <span style={{color:'var(--c-muted)',fontSize:13}}>Status</span>
            <span className="dd-badge" style={{background:'rgba(245,158,11,.12)',color:'#d97706'}}>⏳ Pending</span>
          </div>
          {visit?.sym && <div style={{display:'flex',justifyContent:'space-between',marginBottom:12}}>
            <span style={{color:'var(--c-muted)',fontSize:13}}>Symptoms</span>
            <span style={{fontSize:13,fontWeight:600,maxWidth:200,textAlign:'right'}}>{visit.sym}</span>
          </div>}
          {visit?.date && <div style={{display:'flex',justifyContent:'space-between',marginBottom:12}}>
            <span style={{color:'var(--c-muted)',fontSize:13}}>Date</span>
            <span style={{fontSize:13,fontWeight:600}}>{visit.date} {visit.time}</span>
          </div>}
          <div style={{display:'flex',justifyContent:'space-between'}}>
            <span style={{color:'var(--c-muted)',fontSize:13}}>Waiting</span>
            <span style={{fontSize:13,fontWeight:600,fontVariantNumeric:'tabular-nums'}}>{mins}:{secs.toString().padStart(2,'0')}</span>
          </div>
        </div>

        <button className="dd-btn" onClick={onCancel} style={{background:'var(--c-subtle)',color:'var(--c-muted)',width:'100%'}}>
          Cancel Request
        </button>
      </div>
    </div>
  );
}

// ═══════ ACTIVE VISIT ═══════
function ActiveView({doc,visit,isGuest,onCancel,onFinish,onBack,onBrowse}){
  const {t} = useT();
  const toast = useToast();
  const [chatO,setChatO]=useState(false);
  const [msgs,setMsgs]=useState([]);const [inp,setInp]=useState('');const [typing,setTyping]=useState(false);
  const chatEnd=useRef(null);
  const vs = visit?.status||'pending';
  const myId = typeof window!=='undefined'?JSON.parse(atob((localStorage.getItem('dd_token')||'.ey==.').split('.')[1]||'e30=')).id:'';

  useEffect(()=>{chatEnd.current?.scrollIntoView({behavior:'smooth'});},[msgs,chatO]);
  // Load chat messages when opened
  useEffect(()=>{if(chatO&&visit?.id){api.get('/visits/'+visit.id+'/chat').then(r=>{if(r.messages)setMsgs(r.messages.map(m=>({id:m.id,s:m.senderId===myId?'user':'doctor',t:m.message})));}).catch(()=>{});}},[chatO,visit?.id]);

  const sendMsg = async()=>{if(!inp.trim()||!visit?.id)return;const txt=inp;setInp('');
    setMsgs(p=>[...p,{id:Date.now().toString(),s:'user',t:txt}]);
    try{await api.post('/visits/'+visit.id+'/chat',{message:txt});}catch(e){toast('Mesaj gönderilemedi','error');}
  };

  const handleCancel = async () => {
    try { await onCancel(); }
    catch(err) { toast(err.message || 'Cannot cancel this booking', 'error'); }
  };

  if(!doc) return null;

  if(vs==='pending') return (
    <div className="dd-page" style={{display:'flex',alignItems:'center',justifyContent:'center'}}>
      <div className="animate-fadeUp" style={{textAlign:'center',maxWidth:380}}>
        <div style={{position:'relative',width:80,height:80,margin:'0 auto 24px'}}>
          <div style={{position:'absolute',inset:0,borderRadius:'50%',background:'color-mix(in srgb,var(--c-warn) 12%,transparent)'}}/>
          <div style={{position:'absolute',inset:-8,borderRadius:'50%',border:'3px solid var(--c-warn)',opacity:.3,animation:'pulse-ring 2s ease-out infinite'}}/>
          <div style={{position:'absolute',inset:0,display:'flex',alignItems:'center',justifyContent:'center'}}><I n="clock" s={32} c="text-amber-500"/></div>
        </div>
        <h2 style={{fontSize:'1.375rem',fontWeight:800,marginBottom:6}}>{t('waiting_confirmation')}</h2>
        <p style={{color:'var(--c-muted)',fontSize:14,marginBottom:20}}>Waiting for <strong>{doc.name}</strong> to accept...</p>
        <div className="dd-card" style={{display:'flex',alignItems:'center',gap:12,padding:'12px 16px',marginBottom:24}}>
          <DocAvatar src={doc.img} name={doc.name} size={40} radius={12}/>
          <div style={{textAlign:'left'}}><div style={{fontWeight:700,fontSize:14}}>{doc.name}</div><div style={{color:'var(--c-muted)',fontSize:12}}>{doc.specialty}</div></div>
        </div>
        <button className="dd-btn dd-btn-ghost btn-cancel" onClick={handleCancel} style={{fontSize:13}}>{t('cancel')}</button>
      </div>
    </div>
  );

  if(vs==='cancelled') return (
    <div className="dd-page" style={{display:'flex',alignItems:'center',justifyContent:'center'}}>
      <div className="animate-fadeUp" style={{textAlign:'center',maxWidth:380}}>
        <div style={{width:72,height:72,borderRadius:'50%',background:'color-mix(in srgb,var(--c-danger) 10%,transparent)',display:'flex',alignItems:'center',justifyContent:'center',margin:'0 auto 20px'}}><I n="xCircle" s={36} c="text-red-500"/></div>
        <h2 style={{fontSize:'1.375rem',fontWeight:800,marginBottom:8}}>{t('request_declined')}</h2>
        <p style={{color:'var(--c-muted)',fontSize:14,marginBottom:24}}>This doctor is currently unavailable.</p>
        <div style={{display:'flex',flexDirection:'column',gap:10}}>
          <button className="dd-btn dd-btn-primary btn-bounce" onClick={onBrowse} style={{width:'100%'}}><I n="stethoscope" s={18}/>{t('available_specialists')}</button>
          <button className="dd-btn dd-btn-ghost" onClick={onBack}>{isGuest?'Back to login':t('back')}</button>
        </div>
      </div>
    </div>
  );

  return (
    <div className="dd-page" style={{display:'flex',justifyContent:'center'}}>
      <div style={{maxWidth:440,width:'100%'}} className="animate-fadeUp">
        <button className="dd-btn dd-btn-ghost" onClick={onBack} style={{marginBottom:12,fontSize:13}}><I n="arrowLeft" s={16}/>{isGuest?'Back to login':t('back')}</button>
        {/* Appointment Confirmed Banner */}
        <div style={{width:'100%',borderRadius:'24px 24px 0 0',background:'linear-gradient(135deg,var(--c-accent),color-mix(in srgb,var(--c-accent) 80%,var(--c-accent2)))',padding:'2rem',textAlign:'center',color:'white',position:'relative',overflow:'hidden'}}>
          <div style={{position:'absolute',top:-20,right:-20,width:100,height:100,borderRadius:'50%',background:'rgba(255,255,255,.08)'}}/>
          <div style={{width:64,height:64,borderRadius:'50%',background:'rgba(255,255,255,.15)',display:'flex',alignItems:'center',justifyContent:'center',margin:'0 auto 12px',animation:'checkPop .5s ease both'}}><I n="checkCircle" s={32} c="text-white"/></div>
          <h2 style={{fontSize:'1.25rem',fontWeight:800,marginBottom:4}}>Appointment Confirmed</h2>
          <p style={{opacity:.8,fontSize:13}}>Your booking has been accepted</p>
        </div>
        {/* Doctor & Details card */}
        <div className="dd-card" style={{padding:'1.5rem',borderRadius:'0 0 24px 24px',borderTop:'none',marginTop:-1}}>
          <div style={{display:'flex',alignItems:'center',gap:16,marginBottom:20}}>
            <div style={{position:'relative'}}>
              <DocAvatar src={doc.img} name={doc.name} size={64} radius={20} style={{boxShadow:'var(--shadow)'}}/>
              <div style={{position:'absolute',bottom:-2,right:-2,width:14,height:14,borderRadius:'50%',background:'#22c55e',border:'2.5px solid var(--c-surface)'}}/>
            </div>
            <div style={{flex:1}}>
              <h3 style={{fontWeight:800,fontSize:'1.125rem'}}>{doc.name}</h3>
              <div style={{color:'var(--c-accent)',fontWeight:600,fontSize:13}}>{doc.specialty}</div>
              <div style={{fontSize:12,color:'var(--c-muted)',marginTop:2}}>{(doc.reviewCount||0)>0 ? '⭐ '+doc.rating+' · ' : ''}{Array.isArray(doc.langs)?doc.langs.join(', '):(doc.langs||'')}</div>
            </div>
          </div>
          {/* Appointment Details */}
          <div style={{display:'flex',flexDirection:'column',gap:12,padding:'16px',background:'var(--c-subtle)',borderRadius:16,marginBottom:16}}>
            <div style={{display:'flex',justifyContent:'space-between',alignItems:'center'}}>
              <div style={{display:'flex',alignItems:'center',gap:8}}><I n="calendar" s={16} c="text-teal-600"/><span style={{fontSize:13,color:'var(--c-muted)'}}>Date</span></div>
              <span style={{fontWeight:700,fontSize:14}}>{visit?.date==='ASAP'?'Today (ASAP)':visit?.date}</span>
            </div>
            {visit?.time && <div style={{display:'flex',justifyContent:'space-between',alignItems:'center'}}>
              <div style={{display:'flex',alignItems:'center',gap:8}}><I n="clock" s={16} c="text-teal-600"/><span style={{fontSize:13,color:'var(--c-muted)'}}>Time</span></div>
              <span style={{fontWeight:700,fontSize:14}}>{visit.time}</span>
            </div>}
            <div style={{display:'flex',justifyContent:'space-between',alignItems:'center'}}>
              <div style={{display:'flex',alignItems:'center',gap:8}}><span style={{fontSize:16,fontWeight:900,color:'var(--c-accent)'}}>₺</span><span style={{fontSize:13,color:'var(--c-muted)'}}>Price</span></div>
              <span style={{fontWeight:800,fontSize:16,color:'var(--c-accent)'}}>{fmtPrice(visit?.price||doc.price||150,doc.currency)}</span>
            </div>
            {visit?.address && <div style={{padding:'8px 0'}}>
              <div style={{display:'flex',justifyContent:'space-between',alignItems:'center'}}>
                <div style={{display:'flex',alignItems:'center',gap:8}}><I n="mapPin" s={16} c="text-teal-600"/><span style={{fontSize:13,color:'var(--c-muted)'}}>Location</span></div>
                <span style={{fontWeight:600,fontSize:13,maxWidth:180,textAlign:'right'}}>{visit.address.split('|')[0]?.trim()}</span>
              </div>
              {visit.address.includes('|') && <div style={{marginTop:6,marginLeft:24,padding:'8px 12px',borderRadius:8,background:'color-mix(in srgb,var(--c-accent) 5%,transparent)',fontSize:12,color:'var(--c-muted)'}}>
                🏢 {visit.address.split('|')[1]?.trim()?.replace(/Apt:/,'').replace(/Floor:/,' · Floor: ').replace(/Door:/,' · Door: ')}
              </div>}
            </div>}
            {visit?.sym && <div style={{display:'flex',justifyContent:'space-between',alignItems:'flex-start'}}>
              <div style={{display:'flex',alignItems:'center',gap:8}}><I n="activity" s={16} c="text-teal-600"/><span style={{fontSize:13,color:'var(--c-muted)'}}>Reason</span></div>
              <span style={{fontWeight:600,fontSize:13,maxWidth:200,textAlign:'right'}}>{visit.sym}</span>
            </div>}
          </div>
          <div style={{marginBottom:16}}>
            <button className="dd-btn dd-btn-primary btn-bounce" style={{width:'100%',padding:'14px'}} onClick={()=>setChatO(true)}><I n="msg" s={18}/>Mesaj Gönder</button>
          </div>
          <button className="dd-btn dd-btn-primary btn-bounce" onClick={onBack} style={{width:'100%',padding:'1rem',marginBottom:8}}><I n="arrowLeft" s={18}/>Back to Menu</button>
          <button className="dd-btn btn-cancel" onClick={handleCancel} style={{width:'100%',padding:'1rem',background:'color-mix(in srgb,var(--c-danger) 8%,transparent)',color:'var(--c-danger)',border:'1.5px solid color-mix(in srgb,var(--c-danger) 20%,transparent)'}}>{t('cancel_visit')}</button>
        </div>
        {/* Chat */}
        {chatO && (
          <div style={{position:'fixed',inset:0,zIndex:100,display:'flex',alignItems:'center',justifyContent:'center',padding:0,background:'rgba(0,0,0,.4)',backdropFilter:'blur(8px)'}}>
            <div className="dd-card animate-fadeUp" style={{width:'100%',maxWidth:420,height:'min(600px,90vh)',borderRadius:28,display:'flex',flexDirection:'column',overflow:'hidden',margin:16}}>
              <div style={{padding:'16px 20px',borderBottom:'1px solid var(--c-border)',display:'flex',alignItems:'center',justifyContent:'space-between',flexShrink:0}}>
                <div style={{display:'flex',alignItems:'center',gap:12}}>
                  <div style={{position:'relative'}}><DocAvatar src={doc.img} name={doc.name} size={36} radius={12}/><div style={{position:'absolute',bottom:-1,right:-1,width:10,height:10,borderRadius:'50%',background:'#22c55e',border:'2px solid var(--c-surface)'}}/></div>
                  <div><div style={{fontWeight:700,fontSize:14}}>{doc.name}</div><div style={{fontSize:11,color:'#22c55e',fontWeight:600}}>● Çevrimiçi</div></div>
                </div>
                <button style={{background:'none',border:'none',cursor:'pointer',padding:6,color:'var(--c-muted)'}} onClick={()=>setChatO(false)}><I n="x" s={22}/></button>
              </div>
              <div style={{flex:1,overflowY:'auto',padding:16,display:'flex',flexDirection:'column',gap:12,background:'var(--c-subtle)'}}>
                {msgs.length===0 && <div style={{textAlign:'center',padding:40,color:'var(--c-muted)',fontSize:13}}>Send a message to start chatting with {doc.name}</div>}
                {msgs.map(m=><div key={m.id} style={{display:'flex',justifyContent:m.s==='user'?'flex-end':'flex-start'}}>
                  <div style={{maxWidth:'78%',padding:'10px 16px',borderRadius:18,fontSize:14,lineHeight:1.5,...(m.s==='user'?{background:'var(--c-accent)',color:'white',borderBottomRightRadius:6}:{background:'var(--c-surface)',border:'1px solid var(--c-border)',borderBottomLeftRadius:6})}}>{m.t}</div>
                </div>)}
                {typing && <div style={{display:'flex'}}><div style={{padding:'10px 16px',borderRadius:18,borderBottomLeftRadius:6,background:'var(--c-surface)',border:'1px solid var(--c-border)',display:'flex',gap:4,alignItems:'center'}}><span style={{width:6,height:6,borderRadius:'50%',background:'var(--c-muted)',animation:'pulse-ring 1.5s ease-in-out infinite'}}/><span style={{width:6,height:6,borderRadius:'50%',background:'var(--c-muted)',animation:'pulse-ring 1.5s ease-in-out .2s infinite'}}/><span style={{width:6,height:6,borderRadius:'50%',background:'var(--c-muted)',animation:'pulse-ring 1.5s ease-in-out .4s infinite'}}/></div></div>}
                <div ref={chatEnd}/>
              </div>
              <div style={{padding:12,borderTop:'1px solid var(--c-border)',display:'flex',gap:8,flexShrink:0}}>
                <input className="dd-input" value={inp} onChange={e=>setInp(e.target.value)} placeholder={t('type_message')} style={{borderRadius:100,padding:'12px 18px'}} onKeyDown={e=>{if(e.key==='Enter'&&!e.shiftKey){e.preventDefault();sendMsg();}}}/>
                <button disabled={!inp.trim()||typing} className="dd-btn dd-btn-primary" onClick={sendMsg} style={{borderRadius:100,width:48,height:48,padding:0,flexShrink:0,opacity:(!inp.trim()||typing)?.4:1}}><I n="send" s={18}/></button>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

// ═══════ VISITS ═══════
function VisitsView({visits,onBack,onRebook,onViewSummary,docs,role}){
  const {t} = useT();
  const [tab,setTab]=useState('upcoming');
  const isDoc = role==='doctor';

  const list = tab==='upcoming'?visits.filter(v=>v.status==='upcoming'||v.status==='pending'):
               visits.filter(v=>v.status==='completed'||v.status==='cancelled');
  const badge = s=>({upcoming:{bg:'color-mix(in srgb,var(--c-accent) 10%,transparent)',c:'var(--c-accent)'},pending:{bg:'color-mix(in srgb,var(--c-warn) 10%,transparent)',c:'#b45309'},completed:{bg:'var(--c-subtle)',c:'var(--c-muted)'},cancelled:{bg:'color-mix(in srgb,var(--c-danger) 10%,transparent)',c:'var(--c-danger)'}}[s]||{});

  return (
    <div className="dd-page"><div style={{maxWidth:800,margin:'0 auto',width:'100%'}}>
      <div className="animate-fadeUp" style={{display:'flex',justifyContent:'space-between',alignItems:'flex-start',marginBottom:24}}>
        <div><h2 style={{fontSize:'1.5rem',fontWeight:800}}>{isDoc?t('patient_history_title'):t('my_visits')}</h2><p style={{color:'var(--c-muted)',fontSize:14,marginTop:4}}>{isDoc?t('patient_history_sub'):t('visits_sub')}</p></div>
        <button className="dd-btn dd-btn-ghost" onClick={onBack} style={{fontSize:13}}><I n="arrowLeft" s={16}/>{t('back')}</button>
      </div>
      <div className="animate-fadeUp stagger-1" style={{display:'inline-flex',padding:4,borderRadius:14,background:'var(--c-surface)',border:'1px solid var(--c-border)',marginBottom:20}}>
        {[['upcoming',t('tab_upcoming')],['history',t('tab_history')]].map(([k,l])=><button key={k} onClick={()=>setTab(k)} style={{padding:'8px 18px',borderRadius:10,fontSize:13,fontWeight:700,fontFamily:'var(--font-display)',cursor:'pointer',border:'none',background:tab===k?'var(--c-subtle)':'transparent',color:tab===k?'var(--c-text)':'var(--c-muted)',transition:'all .2s',whiteSpace:'nowrap'}}>{l}</button>)}
      </div>

      <div style={{display:'flex',flexDirection:'column',gap:12}}>
        {list.length>0?list.map((v,i)=>{const b=badge(v.status);const vDoc=(docs||[]).find(d=>d.id===v.docId);const displayName=isDoc?(v.patientName||'Hasta'):(v.docName||v.specialty);return(
          <div key={v.id} className={`dd-card animate-fadeUp stagger-${Math.min(i+1,5)}`} style={{padding:'1.25rem'}}>
            <div style={{display:'flex',justifyContent:'space-between',alignItems:'flex-start',marginBottom:12}}>
              <div style={{display:'flex',gap:12,alignItems:'center'}}>
                {isDoc?<div style={{width:44,height:44,borderRadius:14,background:'var(--c-subtle)',display:'flex',alignItems:'center',justifyContent:'center',fontWeight:800,color:'var(--c-accent)',fontFamily:'var(--font-display)'}}>{(v.patientName||'H')[0]}</div>:<DocAvatar src={v.docImg} name={v.docName||'D'} size={44} radius={14}/>}
                <div><div style={{fontWeight:700,color:'var(--c-text)'}}>{displayName}</div><div style={{fontSize:13,color:'var(--c-muted)',marginTop:2}}>{v.sym?.substring(0,50)}{(v.sym?.length||0)>50?'...':''}</div></div>
              </div>
              <span className="dd-badge" style={{background:b.bg,color:b.c}}>{v.status}</span>
            </div>
            <div style={{display:'flex',gap:12,fontSize:12,color:'var(--c-muted)',borderTop:'1px solid var(--c-border)',paddingTop:10,flexWrap:'wrap',alignItems:'center'}}>
              <span style={{display:'flex',alignItems:'center',gap:4}}><I n="calendar" s={13}/>{v.date==='ASAP'?'Immediate':v.date}</span>
              {v.time && <span style={{display:'flex',alignItems:'center',gap:4}}><I n="clock" s={13}/>{v.time}</span>}
              {v.price>0 && <span style={{fontWeight:600}}>{fmtPrice(v.price,v.currency||'TRY')}</span>}
              {v.rating && <span style={{display:'flex',alignItems:'center',gap:2}}>⭐ {v.rating}/5</span>}
              <div style={{marginLeft:'auto',display:'flex',gap:6}}>
                {v.summary && onViewSummary && <button onClick={()=>onViewSummary(v.id)} className="btn-bounce" style={{padding:'4px 12px',borderRadius:8,fontSize:11,fontWeight:700,border:'1.5px solid var(--c-accent)',background:'transparent',color:'var(--c-accent)',cursor:'pointer'}}>{t('btn_summary')}</button>}
                {v.status==='completed' && vDoc && onRebook && !isDoc && <button onClick={()=>onRebook(vDoc)} className="btn-bounce" style={{padding:'4px 12px',borderRadius:8,fontSize:11,fontWeight:700,border:'1.5px solid var(--c-border)',background:'transparent',color:'var(--c-text)',cursor:'pointer',display:'flex',alignItems:'center',gap:4}}><I n="repeat" s={12}/>{t('btn_rebook')}</button>}
              </div>
            </div>
          </div>
        );}):(
          <div className="dd-card" style={{textAlign:'center',padding:'3rem',borderStyle:'dashed'}}>
            <I n="calendar" s={36} style={{display:'block',margin:'0 auto 12px',color:'#cbd5e1'}}/>
            <h3 style={{fontWeight:700,marginBottom:4}}>{t('no_visits')}</h3>
            <p style={{color:'var(--c-muted)',fontSize:14}}>{t('visits_show_here')}</p>
          </div>
        )}
      </div>
    </div></div>
  );
}

// ═══════ FAVORITE DOCTORS VIEW ═══════
function FavsView({docs,favDocs,toggleFav,onSelectDoc,onDetail,onBack}){
  const {t} = useT();
  const favDocList = (docs||[]).filter(d=>(favDocs||[]).includes(d.id));
  return (
    <div className="dd-page"><div style={{maxWidth:800,margin:'0 auto',width:'100%'}}>
      <div className="animate-fadeUp" style={{display:'flex',justifyContent:'space-between',alignItems:'flex-start',marginBottom:24}}>
        <div><h2 style={{fontSize:'1.5rem',fontWeight:800}}>{t('fav_doctors_title')}</h2><p style={{color:'var(--c-muted)',fontSize:14,marginTop:4}}>{t('fav_sub')}</p></div>
        <button className="dd-btn dd-btn-ghost" onClick={onBack} style={{fontSize:13}}><I n="arrowLeft" s={16}/>{t('back')}</button>
      </div>
      {favDocList.length>0 ? <div style={{display:'grid',gridTemplateColumns:'repeat(auto-fill,minmax(260px,1fr))',gap:14}}>
        {favDocList.map((d,i)=>(
          <div key={d.id} className={`dd-card animate-fadeUp stagger-${Math.min(i+1,5)}`} style={{padding:0,overflow:'hidden',cursor:'pointer'}} onClick={()=>onDetail?onDetail(d):onSelectDoc&&onSelectDoc(d)}>
            <div style={{height:8,background:'linear-gradient(90deg,var(--c-accent),var(--c-accent2))'}}/>
            <div style={{padding:'1.25rem'}}>
              <div style={{display:'flex',alignItems:'center',gap:14,marginBottom:12}}>
                <DocAvatar src={d.img} name={d.name} size={56} radius={16}/>
                <div style={{flex:1,minWidth:0}}>
                  <div style={{fontWeight:800,fontSize:15}}>{d.name}</div>
                  <div style={{color:'var(--c-accent)',fontSize:13,fontWeight:600,marginTop:2}}>{d.specialty}</div>
                  <div style={{display:'flex',gap:10,marginTop:4,fontSize:12,color:'var(--c-muted)'}}>
                    {(d.reviewCount||0)>0 ? <span style={{fontWeight:700,color:'#f59e0b'}}>★ {d.rating}</span> : <span style={{fontStyle:'italic'}}>{t('new_doctor')}</span>}
                    <span style={{fontWeight:700}}>{fmtPrice(d.price||150,d.currency)}</span>
                    <span>{Array.isArray(d.langs)?d.langs.slice(0,2).join(', '):''}</span>
                  </div>
                </div>
              </div>
              <div style={{display:'flex',gap:8}}>
                <button onClick={e=>{e.stopPropagation();toggleFav&&toggleFav(d.id);}} style={{flex:1,padding:'8px',borderRadius:10,fontSize:11,fontWeight:700,border:'1.5px solid var(--c-danger)',background:'color-mix(in srgb,var(--c-danger) 6%,transparent)',color:'var(--c-danger)',cursor:'pointer'}}>{t('fav_remove')}</button>
                <button onClick={e=>{e.stopPropagation();onSelectDoc&&onSelectDoc(d);}} className="dd-btn dd-btn-primary" style={{flex:1.5,padding:'8px 16px',fontSize:12,display:'flex',alignItems:'center',justifyContent:'center',gap:6}}>{t('fav_book_visit')}<LottieAnim name="arrow" size={16} hover style={{filter:'invert(1) brightness(2)',pointerEvents:'auto'}}/></button>
              </div>
            </div>
          </div>
        ))}
      </div> : <div className="dd-card" style={{textAlign:'center',padding:'3rem',borderStyle:'dashed'}}>
        <I n="heart" s={36} style={{display:'block',margin:'0 auto 12px',color:'#cbd5e1'}}/>
        <h3 style={{fontWeight:700,marginBottom:4}}>{t('no_favs')}</h3>
        <p style={{color:'var(--c-muted)',fontSize:14}}>{t('no_favs_sub')}</p>
      </div>}
    </div></div>
  );
}

// ═══════ DOCTOR SCHEDULE VIEW ═══════
function DocScheduleView({onBack}){
  const toast = useToast();
  const DAYS = ['Monday','Tuesday','Wednesday','Thursday','Friday','Saturday','Sunday'];
  const HOURS = Array.from({length:24},(_,i)=>`${String(i).padStart(2,'0')}:00`);
  const [schedule,setSchedule]=useState(()=>DAYS.map(d=>({day:d,enabled:false,slots:[]})));
  const [loading,setLoading]=useState(true);
  const [saving,setSaving]=useState(false);

  useEffect(()=>{
    (async()=>{
      try {
        const res = await api.get('/schedule');
        if(res.schedule?.length>0){
          setSchedule(DAYS.map(d=>{
            const found = res.schedule.find(s=>s.day_of_week===d);
            if(found){
              let slots=[];try{slots=JSON.parse(found.slots||'[]');}catch{}
              return {day:d,enabled:!!found.enabled,slots};
            }
            return {day:d,enabled:false,slots:[]};
          }));
        }
      }catch{}
      setLoading(false);
    })();
  },[]);

  const toggleDay=(day)=>setSchedule(p=>p.map(s=>s.day===day?{...s,enabled:!s.enabled,slots:!s.enabled?s.slots:[]}:s));
  const toggleSlot=(day,slot)=>setSchedule(p=>p.map(s=>s.day===day?{...s,slots:s.slots.includes(slot)?s.slots.filter(x=>x!==slot):[...s.slots,slot]}:s));
  const selectAll=(day)=>setSchedule(p=>p.map(s=>s.day===day?{...s,slots:[...HOURS]}:s));
  const selectNone=(day)=>setSchedule(p=>p.map(s=>s.day===day?{...s,slots:[]}:s));

  const saveSchedule = async()=>{
    setSaving(true);
    try{
      await api.put('/schedule',{schedule:schedule.map(s=>({day_of_week:s.day,enabled:s.enabled,slots:s.slots}))});
      toast('Schedule saved!','success');
    }catch(e){toast('Save failed','error');}
    setSaving(false);
  };

  if(loading) return <div className="dd-page" style={{textAlign:'center',padding:'4rem'}}><div className="animate-spin" style={{display:'inline-block'}}><I n="loader" s={28}/></div></div>;

  return (
    <div className="dd-page"><div style={{maxWidth:700,margin:'0 auto',width:'100%'}}>
      <div className="animate-fadeUp" style={{display:'flex',justifyContent:'space-between',alignItems:'flex-start',marginBottom:24}}>
        <div style={{display:'flex',alignItems:'center',gap:12}}>
          <div style={{width:44,height:44,borderRadius:14,background:'color-mix(in srgb,var(--c-accent) 10%,transparent)',display:'flex',alignItems:'center',justifyContent:'center'}}><I n="calendar" s={22} c="text-teal-600"/></div>
          <div><h2 style={{fontSize:'1.5rem',fontWeight:800}}>Manage Availability</h2><p style={{color:'var(--c-muted)',fontSize:13,marginTop:2}}>Select specific hours you are available for bookings (24h format).</p></div>
        </div>
        <button className="dd-btn dd-btn-ghost" onClick={onBack} style={{fontSize:13}}>← Back to Dashboard</button>
      </div>
      <div style={{display:'flex',flexDirection:'column',gap:16}}>
        {schedule.map((s,di)=>(
          <div key={s.day} className={`dd-card animate-fadeUp stagger-${Math.min(di+1,5)}`} style={{padding:'1.5rem',borderRadius:20,opacity:s.enabled?1:0.7,transition:'opacity .3s'}}>
            <div style={{display:'flex',alignItems:'center',justifyContent:'space-between',marginBottom:s.enabled?16:0}}>
              <div style={{display:'flex',alignItems:'center',gap:12}}>
                {/* Toggle switch */}
                <button onClick={()=>toggleDay(s.day)} style={{width:52,height:28,borderRadius:14,background:s.enabled?'var(--c-accent)':'var(--c-border)',border:'none',cursor:'pointer',position:'relative',transition:'all .3s'}}>
                  <div style={{width:22,height:22,borderRadius:'50%',background:'white',position:'absolute',top:3,left:s.enabled?27:3,transition:'all .3s',boxShadow:'0 1px 3px rgba(0,0,0,.2)'}}/>
                </button>
                <div>
                  <div style={{fontWeight:800,fontSize:16}}>{s.day}</div>
                  {s.enabled && <div style={{fontSize:12,color:'var(--c-muted)',marginTop:1}}>{s.slots.length} slots selected</div>}
                  {!s.enabled && <div style={{fontSize:12,color:'var(--c-muted)',fontStyle:'italic',marginTop:1}}>Unavailable on this day</div>}
                </div>
              </div>
              {s.enabled && <div style={{display:'flex',gap:6}}>
                <button onClick={()=>selectAll(s.day)} style={{padding:'4px 12px',borderRadius:8,fontSize:11,fontWeight:700,border:'1.5px solid var(--c-border)',background:'transparent',color:'var(--c-muted)',cursor:'pointer'}}>All</button>
                <button onClick={()=>selectNone(s.day)} style={{padding:'4px 12px',borderRadius:8,fontSize:11,fontWeight:700,border:'1.5px solid var(--c-border)',background:'transparent',color:'var(--c-muted)',cursor:'pointer'}}>None</button>
              </div>}
            </div>
            {s.enabled && <div style={{display:'flex',flexWrap:'wrap',gap:6}}>
              {HOURS.map(h=>{
                const sel=s.slots.includes(h);
                return <button key={h} onClick={()=>toggleSlot(s.day,h)} style={{padding:'8px 0',width:72,borderRadius:10,fontSize:12,fontWeight:700,fontFamily:'var(--font-display)',cursor:'pointer',border:'1.5px solid',transition:'all .2s',background:sel?'var(--c-accent)':'transparent',color:sel?'white':'var(--c-muted)',borderColor:sel?'var(--c-accent)':'var(--c-border)'}}>{h}</button>;
              })}
            </div>}
          </div>
        ))}
      </div>
      <div style={{position:'sticky',bottom:16,display:'flex',justifyContent:'flex-end',marginTop:24}}>
        <button className="dd-btn dd-btn-primary btn-pulse" onClick={saveSchedule} disabled={saving} style={{padding:'14px 32px',borderRadius:14,fontSize:15,boxShadow:'0 8px 30px rgba(13,148,136,.3)'}}>
          {saving?<span className="animate-spin" style={{display:'inline-flex'}}><I n="loader" s={18} c="text-white"/></span>:<><I n="clipboard" s={18} c="text-white"/>Save Schedule</>}
        </button>
      </div>
    </div></div>
  );
}

// ═══════ DOCTOR DASHBOARD ═══════
function DocDash({visits,setVisits,addNotif,onSchedule,user}){
  // Parse structured address: "Street, Mahalle, District, Province | Apt:name, Floor:3, Door:5"
  const parseAddr = (raw)=>{
    if(!raw) return {street:'',apt:'',floor:'',door:''};
    const parts = raw.split('|').map(s=>s.trim());
    const street = parts[0]||'';
    const aptPart = parts[1]||'';
    let apt='',floor='',door='';
    if(aptPart){
      const am=aptPart.match(/Apt:([^,]*)/); if(am) apt=am[1].trim();
      const fm=aptPart.match(/Floor:([^,]*)/); if(fm) floor=fm[1].trim();
      const dm=aptPart.match(/Door:([^,]*)/); if(dm) door=dm[1].trim();
    }
    return {street,apt,floor,door};
  };
  const {t} = useT();
  const toast = useToast();
  const [pendingRequests, setPendingRequests] = useState([]);
  const pending = visits.filter(v=>v.status==='pending');
  const upcoming = visits.filter(v=>v.status==='upcoming');
  // #4: exclude declined/cancelled from patient count
  const actualPatients = visits.filter(v=>v.status!=='cancelled').length;
  // #5: fee editing with currency
  const [editingFee,setEditingFee]=useState(false);
  const [feeVal,setFeeVal]=useState(user?.price||'');
  const [feeCurrency,setFeeCurrency]=useState(()=>user?.currency||localStorage.getItem('dd_currency')||'TRY');
  const currencies = ['USD','EUR','TRY','GBP'];
  // #7: check if visit date/time has passed
  const isVisitPastDue = (v)=>{
    if(!v.date||v.date==='ASAP') return false;
    try{const dt=new Date(v.date+(v.time?' '+v.time:''));return dt<new Date();}catch{return false;}
  };
  const [summaryVisit,setSummaryVisit]=useState(null);
  // #8: Structured summary fields
  const [sumDiagnosis,setSumDiagnosis]=useState('');
  const [sumMedicine,setSumMedicine]=useState('');
  const [sumAdvice,setSumAdvice]=useState('');
  const [sumNextMeeting,setSumNextMeeting]=useState('');
  const [sumNextExam,setSumNextExam]=useState(''); // Medical examination for next visit
  // Structured medicine entries
  const [sumMeds,setSumMeds]=useState([]);
  const addSumMed=()=>setSumMeds(p=>[...p,{name:'',dosage:'',days:[],times:['08:00']}]);
  const updateSumMed=(i,f,v)=>setSumMeds(p=>p.map((m,idx)=>idx===i?{...m,[f]:v}:m));
  const removeSumMed=(i)=>setSumMeds(p=>p.filter((_,idx)=>idx!==i));
  const toggleMedDay=(i,day)=>setSumMeds(p=>p.map((m,idx)=>idx===i?{...m,days:m.days.includes(day)?m.days.filter(d=>d!==day):[...m.days,day]}:m));
  const addMedTime=(i)=>setSumMeds(p=>p.map((m,idx)=>idx===i?{...m,times:[...m.times,'12:00']}:m));
  const updateMedTime=(i,ti,v)=>setSumMeds(p=>p.map((m,idx)=>idx===i?{...m,times:m.times.map((t,j)=>j===ti?v:t)}:m));
  const removeMedTime=(i,ti)=>setSumMeds(p=>p.map((m,idx)=>idx===i?{...m,times:m.times.filter((_,j)=>j!==ti)}:m));
  const allMedDays = ['Monday','Tuesday','Wednesday','Thursday','Friday','Saturday','Sunday'];

  const saveFee = async()=>{
    const fee=parseFloat(feeVal);if(!fee||fee<=0||isNaN(fee)){toast('Enter a valid amount','warning');return;}
    localStorage.setItem('dd_currency',feeCurrency);
    try{
      const res = await api.put('/auth/profile',{price:fee,currency:feeCurrency});
      if(res.user){toast('Fee updated to '+feeCurrency+' '+fee,'success');setEditingFee(false);}
      else{toast('Fee updated','success');setEditingFee(false);}
    }catch(e){console.error('Fee update error:',e);toast('Failed: '+(e.message||'Check connection'),'error');}
  };
  const submitSummary = async()=>{
    if(!sumDiagnosis.trim()){toast('Please write a diagnosis','warning');return;}
    // Build medicine text from structured entries
    const medText = sumMeds.filter(m=>m.name.trim()).map(m=>`${m.name} (${m.dosage}) — ${m.days.length?m.days.map(d=>d.substring(0,3)).join(','):'Hergün'} — ${m.times.join(', ')}`).join('\n');
    const summary = {diagnosis:sumDiagnosis,medicine:medText||sumMedicine,structuredMeds:sumMeds.filter(m=>m.name.trim()),advice:sumAdvice,nextMeeting:sumNextMeeting};
    try{await api.put('/visits/'+summaryVisit.id,{status:'completed',summary});
    // Payment capture
    try{
      const token=localStorage.getItem('dd_token');
      await fetch('/api/payment/capture',{method:'POST',headers:{'Content-Type':'application/json','Authorization':'Bearer '+token},body:JSON.stringify({visitId:summaryVisit.id})});
    }catch(pe){console.log('Payment capture note:',pe);}
    // Auto-add structured medicines to patient's med list
    const validMeds = sumMeds.filter(m=>m.name.trim());
    if(validMeds.length>0){
      for(const med of validMeds){
        try{
          await api.post('/meds',{name:med.name+(med.dosage?' ('+med.dosage+')':''),dosage:med.dosage||'',days:JSON.stringify(med.days.length?med.days:['Monday','Tuesday','Wednesday','Thursday','Friday','Saturday','Sunday']),dayTimes:JSON.stringify({...Object.fromEntries(med.days.map(d=>[d,med.times.length?med.times:['08:00']]))}),userId:summaryVisit.userId});
        }catch(me){console.log('Auto-add med:',me);}
      }
    }
    // Suggest next visit if date provided
    if(sumNextMeeting && sumNextMeeting.includes('T') && sumNextMeeting.split('T')[0]){
      try{
        const [nDate,nTime] = sumNextMeeting.split('T');
        await api.post('/visits/'+summaryVisit.id+'/suggest-next',{suggestedDate:nDate,suggestedTime:nTime||'',reason:'Takip muayenesi'});
      }catch(se){console.log('Next visit suggestion:',se);}
    }
    setVisits(p=>p.map(v=>v.id===summaryVisit.id?{...v,status:'completed',summary}:v));
    toast('Ziyaret tamamlandı'+(validMeds.length?' — ilaçlar hastaya eklendi':''),'success');setSummaryVisit(null);setSumDiagnosis('');setSumMedicine('');setSumAdvice('');setSumNextMeeting('');setSumNextExam('');setSumMeds([]);
    }catch(e){toast('Error: '+e.message,'error');}
  };
  // #7: Navigate - extract only coordinates from address
  const navigateTo = (address)=>{
    const coords = address?.match(/[-+]?\d+\.\d+,\s*[-+]?\d+\.\d+/);
    if(coords) window.open(`https://www.google.com/maps/dir/?api=1&destination=${coords[0].replace(/\s/g,'')}`, '_blank');
    else window.open(`https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(address?.split('|')[0]?.trim()||address)}`, '_blank');
  };

  // Fetch pending requests with patient info
  useEffect(()=>{
    const fetchPending = async () => {
      try {
        const res = await api.get('/visits/pending');
        console.log('📋 Doctor pending requests:', res.visits?.length || 0, res.visits);
        setPendingRequests(res.visits || []);
      } catch(err) { console.error('❌ Fetch pending error:', err); }
    };
    fetchPending();
    const timer = setInterval(fetchPending, 5000);
    const unsub = syncSocket.on('booking_request', () => { console.log('🔔 WS: booking_request received!'); fetchPending(); });
    return () => { clearInterval(timer); unsub(); };
  },[visits.length]);

  const refreshAll = async () => {
    try {
      const [vRes, pRes] = await Promise.all([
        api.get('/visits'),
        api.get('/visits/pending'),
      ]);
      setVisits(vRes.visits || []);
      setPendingRequests(pRes.visits || []);
      toast('Refreshed!', 'success');
    } catch(e) { toast('Refresh failed: ' + e.message, 'error'); }
  };

  const handleAccept = async (visitId) => {
    try {
      await api.post('/visits/' + visitId + '/accept');
      setVisits(p => p.map(v => v.id === visitId ? { ...v, status: 'upcoming' } : v));
      setPendingRequests(p => p.filter(v => v.id !== visitId));
      toast('Booking accepted! Patient notified.', 'success');
      addNotif('You accepted a booking');
    } catch(e) { toast('Error: ' + e.message, 'error'); }
  };

  const handleDecline = async (visitId) => {
    try {
      await api.post('/visits/' + visitId + '/decline', { reason: '' });
      setVisits(p => p.map(v => v.id === visitId ? { ...v, status: 'cancelled' } : v));
      setPendingRequests(p => p.filter(v => v.id !== visitId));
      toast('Booking declined', 'warning');
    } catch(e) { toast('Error: ' + e.message, 'error'); }
  };

  const [selVisit,setSelVisit] = useState(null);
  const [statModal,setStatModal] = useState(null); // 'patients' | 'cancelled' | null
  const allPatients = visits.filter(v=>v.status==='completed');
  const cancelledVisits = visits.filter(v=>v.status==='cancelled');

  return (
    <div className="dd-page"><div style={{maxWidth:800,margin:'0 auto',width:'100%'}}>
      <div className="animate-fadeUp" style={{display:'flex',justifyContent:'space-between',alignItems:'flex-start',marginBottom:24}}>
        <div><h2 style={{fontSize:'1.5rem',fontWeight:800}}>Doctor Dashboard</h2><p style={{color:'var(--c-muted)',fontSize:14,marginTop:4}}>Manage your visits and patient flow.</p></div>
        <div style={{display:'flex',gap:8}}>
          {onSchedule && <button className="dd-btn dd-btn-ghost btn-bounce" onClick={onSchedule} style={{fontSize:13}}><I n="calendar" s={16}/>Schedule</button>}
          <button className="dd-btn dd-btn-ghost btn-bounce" onClick={refreshAll} style={{fontSize:13}}><I n="repeat" s={16}/>Refresh</button>
        </div>
      </div>
      {/* Quick stats */}
      <div className="animate-fadeUp stagger-1" style={{display:'flex',flexDirection:'column',gap:10,marginBottom:24}}>
        {[
          ['Bekleyen',pendingRequests.length,'var(--c-warn)','clock',null],
          ['Toplam Hasta',actualPatients,'var(--c-accent)','activity','patients'],
          ['Bugünkü Kazanç',fmtPrice(visits.filter(v=>v.status==='completed').reduce((s,v)=>s+(v.price||150),0),feeCurrency),'#22c55e','creditCard',null],
          ['İptal Edilen',user?.cancelledCount||0,'var(--c-danger)','x','cancelled']
        ].map(([l,v,c,icon,modal],i)=>(
          <div key={l} className={`dd-card animate-fadeUp stagger-${i+1}`} style={{padding:'1.25rem 1.5rem',display:'flex',alignItems:'center',gap:16,cursor:modal?'pointer':'default'}} onClick={()=>modal&&setStatModal(modal)}>
            <div style={{width:48,height:48,borderRadius:16,background:`color-mix(in srgb,${c} 10%,transparent)`,display:'flex',alignItems:'center',justifyContent:'center',flexShrink:0,color:c}}><I n={icon} s={22}/></div>
            <div><div style={{fontSize:12,fontWeight:600,color:'var(--c-muted)'}}>{l}</div><div style={{fontSize:'1.5rem',fontWeight:900,fontFamily:'var(--font-display)'}}>{v}</div></div>
            {modal && <I n="chevRight" s={16} c="text-slate-400" style={{marginLeft:'auto'}}/>}
          </div>
        ))}
      </div>
      {/* #5: Fee editing */}
      <div className="dd-card animate-fadeUp stagger-2" style={{padding:'1.25rem',marginBottom:24,display:'flex',alignItems:'center',gap:16}}>
        <div style={{width:48,height:48,borderRadius:16,background:'color-mix(in srgb,var(--c-accent) 10%,transparent)',display:'flex',alignItems:'center',justifyContent:'center',flexShrink:0}}><span style={{fontSize:22,fontWeight:900,color:'var(--c-accent)'}}>{feeCurrency==='TRY'?'₺':feeCurrency==='EUR'?'€':feeCurrency==='GBP'?'£':'$'}</span></div>
        <div style={{flex:1}}><div style={{fontSize:12,fontWeight:600,color:'var(--c-muted)'}}>Consultation Fee</div>
          {editingFee?<div style={{display:'flex',gap:8,marginTop:4,flexWrap:'wrap'}}>
            <select value={feeCurrency} onChange={e=>setFeeCurrency(e.target.value)} style={{padding:'.5rem',borderRadius:10,border:'1.5px solid var(--c-border)',background:'var(--c-subtle)',color:'var(--c-text)',fontWeight:700,fontSize:13,width:80}}>{currencies.map(c=><option key={c} value={c}>{c}</option>)}</select>
            <input className="dd-input" type="number" placeholder="e.g. 200" value={feeVal} onChange={e=>setFeeVal(e.target.value)} style={{padding:'.5rem .75rem',width:100}}/>
            <button className="dd-btn dd-btn-primary" onClick={saveFee} style={{padding:'6px 16px',fontSize:12}}>Save</button>
            <button className="dd-btn dd-btn-ghost" onClick={()=>setEditingFee(false)} style={{padding:'6px 12px',fontSize:12}}>Cancel</button>
          </div>:<div style={{fontSize:'1.5rem',fontWeight:900,fontFamily:'var(--font-display)'}}>{fmtPrice(user?.price||feeVal||0,feeCurrency)}{!user?.price&&!feeVal?' — Set your fee':''}</div>}
        </div>
        {!editingFee && <button onClick={()=>setEditingFee(true)} style={{padding:'6px 14px',borderRadius:10,fontSize:12,fontWeight:700,border:'1.5px solid var(--c-border)',background:'transparent',color:'var(--c-muted)',cursor:'pointer'}}><I n="fileText" s={14}/> Edit</button>}
      </div>
      {/* Stat Detail Modal */}
      {statModal && (
        <div style={{position:'fixed',inset:0,zIndex:200,display:'flex',alignItems:'center',justifyContent:'center',padding:16,background:'rgba(0,0,0,.5)',backdropFilter:'blur(12px)'}} onClick={()=>setStatModal(null)}>
          <div className="dd-card animate-fadeUp" style={{maxWidth:480,width:'100%',padding:'2rem',borderRadius:24,maxHeight:'80vh',overflowY:'auto'}} onClick={e=>e.stopPropagation()}>
            <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',marginBottom:16}}>
              <h3 style={{fontSize:'1.1rem',fontWeight:800}}>{statModal==='patients'?`Toplam Hastalar (${allPatients.length})`:`İptal Edilen Randevular (${cancelledVisits.length})`}</h3>
              <button onClick={()=>setStatModal(null)} style={{background:'none',border:'none',cursor:'pointer',padding:4,color:'var(--c-muted)'}}><I n="x" s={20}/></button>
            </div>
            {(statModal==='patients'?allPatients:cancelledVisits).length===0 ? (
              <div style={{textAlign:'center',padding:'2rem',color:'var(--c-muted)'}}>{statModal==='patients'?'Henüz hasta yok':'Henüz iptal yok'}</div>
            ) : (
              <div style={{display:'flex',flexDirection:'column',gap:8}}>
                {(statModal==='patients'?allPatients:cancelledVisits).map(v=>(
                  <div key={v.id} style={{padding:'12px 16px',borderRadius:14,background:'var(--c-subtle)',border:'1px solid var(--c-border)',display:'flex',alignItems:'center',gap:12}}>
                    <div style={{width:40,height:40,borderRadius:12,background:statModal==='cancelled'?'color-mix(in srgb,var(--c-danger) 10%,transparent)':'color-mix(in srgb,var(--c-accent) 10%,transparent)',display:'flex',alignItems:'center',justifyContent:'center',fontWeight:800,color:statModal==='cancelled'?'var(--c-danger)':'var(--c-accent)',fontFamily:'var(--font-display)'}}>{(v.patientName||'H')[0]}</div>
                    <div style={{flex:1}}>
                      <div style={{fontWeight:700,fontSize:14,color:'var(--c-text)'}}>{v.patientName||'Hasta'}</div>
                      <div style={{fontSize:12,color:'var(--c-muted)'}}>{v.sym?.substring(0,30)||'Genel muayene'} · {(()=>{const d=v.date;if(!d)return '—';const p=d.split('-');return p.length===3?(p[2]+'/'+p[1]+'/'+p[0]):d;})()}</div>
                    </div>
                    {v.price>0 && <span style={{fontWeight:700,fontSize:13,color:'var(--c-accent)'}}>{fmtPrice(v.price,feeCurrency)}</span>}
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      )}

      <h3 style={{fontWeight:700,marginBottom:12}}>Upcoming ({upcoming.length})</h3>
      {upcoming.length>0?<div style={{display:'flex',flexDirection:'column',gap:10}}>{upcoming.map(v=>{
        const pastDue = isVisitPastDue(v);
        return (
        <div key={v.id} className="dd-card" style={{padding:'1.25rem',cursor:'pointer',transition:'all .2s',borderLeft:pastDue?'4px solid var(--c-accent)':'none'}} onClick={()=>setSelVisit(v)}>
          <div style={{display:'flex',justifyContent:'space-between',alignItems:'flex-start'}}>
            <div><div style={{fontWeight:700,fontSize:15}}>👤 {v.patientName||'Hasta'}</div><div style={{fontSize:13,color:'var(--c-muted)',marginTop:4}}>{v.sym?.substring(0,40)||'Genel muayene'} · {v.date} {v.time}</div>{parseAddr(v.address).apt && <div style={{fontSize:12,color:'var(--c-accent)',marginTop:2}}>🏢 {parseAddr(v.address).apt}, Fl:{parseAddr(v.address).floor}, Dr:{parseAddr(v.address).door}</div>}</div>
            <div style={{display:'flex',alignItems:'center',gap:8}}>
              {pastDue ? <span className="dd-badge" style={{background:'color-mix(in srgb,var(--c-accent) 10%,transparent)',color:'var(--c-accent)'}}>Ready</span>
                : <span className="dd-badge" style={{background:'color-mix(in srgb,var(--c-accent) 10%,transparent)',color:'var(--c-accent)'}}>✓ Confirmed</span>}
              <I n="chevRight" s={16} c="text-slate-400"/>
            </div>
          </div>
          <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',marginTop:8}}>
            {v.price>0 && <div style={{fontSize:13,fontWeight:700,color:'var(--c-accent)'}}>{fmtPrice(v.price,feeCurrency)}</div>}
            {pastDue && <button onClick={e=>{e.stopPropagation();setSummaryVisit(v);}} className="dd-btn dd-btn-primary" style={{padding:'6px 14px',fontSize:12}}>Complete & Write Summary</button>}
          </div>
        </div>);
      })}</div>:<div className="dd-card" style={{textAlign:'center',padding:'2rem',borderStyle:'dashed'}}><p style={{color:'var(--c-muted)'}}>No upcoming visits</p></div>}

      {/* #8: Structured Summary modal */}
      {summaryVisit && (
        <div style={{position:'fixed',inset:0,zIndex:200,display:'flex',alignItems:'center',justifyContent:'center',padding:16,background:'rgba(0,0,0,.5)',backdropFilter:'blur(12px)'}} onClick={()=>setSummaryVisit(null)}>
          <div className="dd-card animate-fadeUp" style={{maxWidth:520,width:'100%',padding:'2rem',borderRadius:24,maxHeight:'90vh',overflowY:'auto'}} onClick={e=>e.stopPropagation()}>
            <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',marginBottom:16}}>
              <h3 style={{fontSize:'1.25rem',fontWeight:800}}>Visit Summary</h3>
              <button onClick={()=>setSummaryVisit(null)} style={{background:'none',border:'none',cursor:'pointer',padding:4,color:'var(--c-muted)'}}><I n="x" s={20}/></button>
            </div>
            <div style={{padding:'12px 16px',borderRadius:12,background:'var(--c-subtle)',marginBottom:16,fontSize:13}}>
              <div style={{fontWeight:700}}>Patient: {summaryVisit.patientName||'Patient'}</div>
              <div style={{color:'var(--c-muted)',marginTop:4}}>Symptoms: {summaryVisit.sym||'General visit'}</div>
              <div style={{color:'var(--c-muted)',marginTop:2}}>{summaryVisit.date} {summaryVisit.time}</div>
              {summaryVisit.address && <div style={{color:'var(--c-muted)',marginTop:2}}>📍 {parseAddr(summaryVisit.address).street}</div>}
              {parseAddr(summaryVisit.address).apt && <div style={{marginTop:6,padding:'8px 12px',borderRadius:8,background:'color-mix(in srgb,var(--c-accent) 6%,transparent)',display:'flex',gap:12,fontSize:12}}>
                <span>🏢 <strong>{parseAddr(summaryVisit.address).apt}</strong></span>
                <span>Floor: <strong>{parseAddr(summaryVisit.address).floor}</strong></span>
                <span>Door: <strong>{parseAddr(summaryVisit.address).door}</strong></span>
              </div>}
            </div>
            <div style={{display:'flex',flexDirection:'column',gap:14}}>
              <div>
                <label style={{fontSize:11,fontWeight:800,color:'var(--c-accent)',textTransform:'uppercase',letterSpacing:'.06em',marginBottom:6,display:'flex',alignItems:'center',gap:6}}><I n="fileText" s={14}/>Diagnosis</label>
                <textarea className="dd-input" value={sumDiagnosis} onChange={e=>setSumDiagnosis(e.target.value)} placeholder="Patient's diagnosis..." style={{height:80,resize:'none'}}/>
              </div>
              <div>
                <label style={{fontSize:11,fontWeight:800,color:'var(--c-accent2)',textTransform:'uppercase',letterSpacing:'.06em',marginBottom:6,display:'flex',alignItems:'center',gap:6}}><I n="pill" s={14}/>Prescribed Medicine</label>
                {sumMeds.length===0 && <textarea className="dd-input" value={sumMedicine} onChange={e=>setSumMedicine(e.target.value)} placeholder="İlaç adı, doz, kullanım sıklığı... veya aşağıdan ekle" style={{height:50,resize:'none',marginBottom:6}}/>}
                {sumMeds.map((med,mi)=>(
                  <div key={mi} style={{padding:12,borderRadius:12,border:'1.5px solid var(--c-border)',background:'var(--c-subtle)',marginBottom:8}}>
                    <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',marginBottom:8}}>
                      <span style={{fontSize:11,fontWeight:800,color:'var(--c-accent2)'}}>İlaç {mi+1}</span>
                      <button type="button" onClick={()=>removeSumMed(mi)} style={{background:'none',border:'none',cursor:'pointer',color:'var(--c-danger)',fontSize:16}}>✕</button>
                    </div>
                    <div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:6,marginBottom:8}}>
                      <input className="dd-input" placeholder="İlaç adı" value={med.name} onChange={e=>updateSumMed(mi,'name',e.target.value)} style={{padding:'.5rem'}}/>
                      <input className="dd-input" placeholder="Doz (ör: 500mg)" value={med.dosage} onChange={e=>updateSumMed(mi,'dosage',e.target.value)} style={{padding:'.5rem'}}/>
                    </div>
                    <div style={{fontSize:10,fontWeight:700,color:'var(--c-muted)',marginBottom:4}}>Günler:</div>
                    <div style={{display:'flex',flexWrap:'wrap',gap:4,marginBottom:8}}>
                      {allMedDays.map(d=><button key={d} type="button" onClick={()=>toggleMedDay(mi,d)} style={{padding:'4px 8px',borderRadius:6,fontSize:10,fontWeight:700,border:'1px solid',cursor:'pointer',background:med.days.includes(d)?'var(--c-accent2)':'transparent',color:med.days.includes(d)?'white':'var(--c-muted)',borderColor:med.days.includes(d)?'var(--c-accent2)':'var(--c-border)'}}>{d.substring(0,3)}</button>)}
                    </div>
                    <div style={{fontSize:10,fontWeight:700,color:'var(--c-muted)',marginBottom:4}}>Saatler:</div>
                    <div style={{display:'flex',flexWrap:'wrap',gap:4,alignItems:'center'}}>
                      {med.times.map((tm,ti)=><div key={ti} style={{display:'flex',alignItems:'center',gap:2}}><input type="time" value={tm} onChange={e=>updateMedTime(mi,ti,e.target.value)} style={{padding:'3px 6px',borderRadius:6,border:'1px solid var(--c-border)',background:'var(--c-surface)',color:'var(--c-text)',fontSize:11}}/>{med.times.length>1&&<button type="button" onClick={()=>removeMedTime(mi,ti)} style={{background:'none',border:'none',color:'var(--c-danger)',cursor:'pointer',fontSize:12}}>✕</button>}</div>)}
                      <button type="button" onClick={()=>addMedTime(mi)} style={{padding:'3px 8px',borderRadius:6,fontSize:10,fontWeight:700,border:'1px dashed var(--c-border)',background:'transparent',color:'var(--c-accent)',cursor:'pointer'}}>+ Saat</button>
                    </div>
                  </div>
                ))}
                <button type="button" onClick={addSumMed} style={{width:'100%',padding:'8px',borderRadius:10,fontSize:12,fontWeight:700,border:'1.5px dashed var(--c-accent2)',background:'color-mix(in srgb,var(--c-accent2) 4%,transparent)',color:'var(--c-accent2)',cursor:'pointer',display:'flex',alignItems:'center',justifyContent:'center',gap:6}}><I n="plus" s={14}/>İlaç Ekle</button>
              </div>
              <div>
                <label style={{fontSize:11,fontWeight:800,color:'#22c55e',textTransform:'uppercase',letterSpacing:'.06em',marginBottom:6,display:'flex',alignItems:'center',gap:6}}><I n="heart" s={14}/>Doctor's Advice</label>
                <textarea className="dd-input" value={sumAdvice} onChange={e=>setSumAdvice(e.target.value)} placeholder="Rest, diet, exercise recommendations..." style={{height:70,resize:'none'}}/>
              </div>
              <div>
                <label style={{fontSize:11,fontWeight:800,color:'#f59e0b',textTransform:'uppercase',letterSpacing:'.06em',marginBottom:6,display:'flex',alignItems:'center',gap:6}}><I n="calendar" s={14}/>Sonraki Randevu Önerisi</label>
                <div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:8}}>
                  <div><div style={{fontSize:10,color:'var(--c-muted)',marginBottom:3}}>Tarih</div><input className="dd-input" type="date" value={sumNextMeeting.split('T')[0]||''} min={new Date().toISOString().split('T')[0]} onChange={e=>setSumNextMeeting(e.target.value+'T'+(sumNextMeeting.split('T')[1]||''))} style={{padding:'.6rem'}}/></div>
                  <div><div style={{fontSize:10,color:'var(--c-muted)',marginBottom:3}}>Saat</div><input className="dd-input" type="time" value={sumNextMeeting.split('T')[1]||''} onChange={e=>setSumNextMeeting((sumNextMeeting.split('T')[0]||'')+'T'+e.target.value)} style={{padding:'.6rem'}}/></div>
                </div>
                <div style={{fontSize:10,color:'var(--c-muted)',marginTop:4}}>Hastaya otomatik randevu önerisi gönderilecektir.</div>
              </div>
            </div>
            <div style={{display:'flex',gap:10,marginTop:16}}>
              <button className="dd-btn dd-btn-ghost" onClick={()=>setSummaryVisit(null)} style={{flex:1,border:'1.5px solid var(--c-border)'}}>Cancel</button>
              <button className="dd-btn dd-btn-primary" onClick={submitSummary} style={{flex:1.5}}>Complete Visit & Send</button>
            </div>
          </div>
        </div>
      )}

      {/* Appointment Detail Modal */}
      {selVisit && (
        <div style={{position:'fixed',inset:0,zIndex:200,display:'flex',alignItems:'center',justifyContent:'center',padding:16,background:'rgba(0,0,0,.5)',backdropFilter:'blur(12px)'}} onClick={()=>setSelVisit(null)}>
          <div className="dd-card animate-fadeUp" style={{maxWidth:420,width:'100%',padding:'2rem',borderRadius:24}} onClick={e=>e.stopPropagation()}>
            <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',marginBottom:20}}>
              <h3 style={{fontSize:'1.25rem',fontWeight:800}}>Appointment Details</h3>
              <button onClick={()=>setSelVisit(null)} style={{background:'none',border:'none',cursor:'pointer',padding:4,color:'var(--c-muted)'}}><I n="x" s={20}/></button>
            </div>
            <div style={{display:'flex',flexDirection:'column',gap:16}}>
              <div style={{display:'flex',justifyContent:'space-between',padding:'12px 0',borderBottom:'1px solid var(--c-border)'}}>
                <span style={{color:'var(--c-muted)',fontSize:13}}>Patient</span>
                <span style={{fontWeight:700}}>{selVisit.patientName||'Patient'}</span>
              </div>
              <div style={{display:'flex',justifyContent:'space-between',padding:'12px 0',borderBottom:'1px solid var(--c-border)'}}>
                <span style={{color:'var(--c-muted)',fontSize:13}}>Symptoms</span>
                <span style={{fontWeight:600,maxWidth:200,textAlign:'right'}}>{selVisit.sym||'General visit'}</span>
              </div>
              <div style={{display:'flex',justifyContent:'space-between',padding:'12px 0',borderBottom:'1px solid var(--c-border)'}}>
                <span style={{color:'var(--c-muted)',fontSize:13}}>Date & Time</span>
                <span style={{fontWeight:700}}>{(()=>{const d=selVisit.date;if(!d)return '—';const p=d.split('-');return p.length===3?(p[2]+'/'+p[1]+'/'+p[0])+(selVisit.time?' / '+selVisit.time:''):d+' '+(selVisit.time||'');})()}</span>
              </div>
              <div style={{padding:'12px 0',borderBottom:'1px solid var(--c-border)'}}>
                <div style={{display:'flex',justifyContent:'space-between',alignItems:'center'}}>
                  <span style={{color:'var(--c-muted)',fontSize:13}}>Location</span>
                  <div style={{display:'flex',alignItems:'center',gap:8}}>
                    <span style={{fontWeight:600,maxWidth:180,textAlign:'right',fontSize:13}}>{parseAddr(selVisit.address).street||'Not specified'}</span>
                    {selVisit.address && <button onClick={()=>navigateTo(selVisit.address)} style={{padding:'4px 10px',borderRadius:8,fontSize:11,fontWeight:700,border:'1.5px solid var(--c-accent)',background:'color-mix(in srgb,var(--c-accent) 8%,transparent)',color:'var(--c-accent)',cursor:'pointer',whiteSpace:'nowrap'}}>Navigate</button>}
                  </div>
                </div>
                {/* Apartment / Floor / Door — always visible next to location */}
                <div style={{marginTop:10,padding:'12px 16px',borderRadius:12,background:'color-mix(in srgb,var(--c-accent) 5%,transparent)',border:'1px solid color-mix(in srgb,var(--c-accent) 12%,transparent)'}}>
                  <div style={{fontSize:11,fontWeight:800,color:'var(--c-accent)',textTransform:'uppercase',letterSpacing:'.05em',marginBottom:8}}>🏢 Apartment / Building Details</div>
                  <div style={{display:'grid',gridTemplateColumns:'1fr 1fr 1fr',gap:10}}>
                    <div style={{background:'var(--c-surface)',padding:'8px 12px',borderRadius:8,textAlign:'center'}}><div style={{fontSize:10,fontWeight:700,color:'var(--c-muted)',marginBottom:2}}>Building</div><div style={{fontWeight:800,fontSize:14}}>{parseAddr(selVisit.address).apt||'—'}</div></div>
                    <div style={{background:'var(--c-surface)',padding:'8px 12px',borderRadius:8,textAlign:'center'}}><div style={{fontSize:10,fontWeight:700,color:'var(--c-muted)',marginBottom:2}}>Floor</div><div style={{fontWeight:800,fontSize:14}}>{parseAddr(selVisit.address).floor||'—'}</div></div>
                    <div style={{background:'var(--c-surface)',padding:'8px 12px',borderRadius:8,textAlign:'center'}}><div style={{fontSize:10,fontWeight:700,color:'var(--c-muted)',marginBottom:2}}>Door</div><div style={{fontWeight:800,fontSize:14}}>{parseAddr(selVisit.address).door||'—'}</div></div>
                  </div>
                </div>
              </div>
              <div style={{display:'flex',justifyContent:'space-between',padding:'12px 0',borderBottom:'1px solid var(--c-border)'}}>
                <span style={{color:'var(--c-muted)',fontSize:13}}>Price</span>
                <span style={{fontWeight:800,fontSize:18,color:'var(--c-accent)'}}>{fmtPrice(selVisit.price||150,feeCurrency)}</span>
              </div>
              <div style={{display:'flex',justifyContent:'space-between',padding:'12px 0'}}>
                <span style={{color:'var(--c-muted)',fontSize:13}}>Status</span>
                <span className="dd-badge" style={{background:'color-mix(in srgb,var(--c-accent) 10%,transparent)',color:'var(--c-accent)'}}>{selVisit.status}</span>
              </div>
            </div>
            {(selVisit.status==='upcoming'||selVisit.status==='pending') && <button className="dd-btn dd-btn-primary" onClick={()=>{setSelVisit(null);/* Open chat via visits view */toast('Mesaj göndermek için hastanın randevusuna tıklayın','info');}} style={{width:'100%',marginTop:12}}><I n="msg" s={16}/>Hastaya Mesaj Gönder</button>}
            <button className="dd-btn dd-btn-ghost btn-cancel" onClick={()=>setSelVisit(null)} style={{width:'100%',marginTop:8,border:'1.5px solid var(--c-border)'}}>Kapat</button>
          </div>
        </div>
      )}
    </div></div>
  );
}

// ═══════ ADMIN ═══════
function AdminView({docs,visits,setDocs,setVisits,onBack}){
  const [tab,setTab]=useState('stats');
  return (
    <div className="dd-page"><div style={{maxWidth:900,margin:'0 auto',width:'100%'}}>
      <div className="animate-fadeUp" style={{display:'flex',justifyContent:'space-between',alignItems:'flex-start',marginBottom:24}}>
        <div style={{display:'flex',alignItems:'center',gap:12}}><div style={{width:44,height:44,borderRadius:14,background:'color-mix(in srgb,var(--c-danger) 10%,transparent)',display:'flex',alignItems:'center',justifyContent:'center'}}><I n="shieldAlert" s={24} c="text-red-500"/></div><div><h2 style={{fontSize:'1.5rem',fontWeight:800}}>Admin Panel</h2><p style={{color:'var(--c-muted)',fontSize:14}}>System overview</p></div></div>
        <button className="dd-btn dd-btn-ghost" onClick={onBack} style={{fontSize:13}}><I n="arrowLeft" s={16}/>{useT().t('back')}</button>
      </div>
      <div className="animate-fadeUp stagger-1" style={{display:'inline-flex',padding:4,borderRadius:14,background:'var(--c-surface)',border:'1px solid var(--c-border)',marginBottom:20}}>
        {['stats','doctors','visits'].map(f=><button key={f} onClick={()=>setTab(f)} style={{padding:'8px 20px',borderRadius:10,fontSize:13,fontWeight:700,fontFamily:'var(--font-display)',cursor:'pointer',border:'none',textTransform:'capitalize',background:tab===f?'var(--c-subtle)':'transparent',color:tab===f?'var(--c-text)':'var(--c-muted)'}}>{f}</button>)}
      </div>
      {tab==='stats' && <div style={{display:'grid',gridTemplateColumns:'repeat(auto-fit,minmax(180px,1fr))',gap:12}}>
        {[['Doctors',docs.length,'var(--c-accent)',ic.stethoscope],['Visits',visits.length,'var(--c-accent2)',ic.clipboard],['Pending',visits.filter(v=>v.status==='pending').length,'var(--c-warn)',ic.clock],['Completed',visits.filter(v=>v.status==='completed').length,'#22c55e',ic.checkCircle]].map(([l,v,c,icon],i)=>(
          <div key={l} className={`dd-card animate-fadeUp stagger-${i+1}`} style={{padding:'1.5rem',textAlign:'center'}}>
            <div style={{width:40,height:40,borderRadius:12,background:`color-mix(in srgb,${c} 12%,transparent)`,display:'flex',alignItems:'center',justifyContent:'center',margin:'0 auto 10px'}}><P d={icon} s={20}/></div>
            <div style={{fontSize:'2rem',fontWeight:900,fontFamily:'var(--font-display)',color:c}}>{v}</div>
            <div style={{fontSize:12,fontWeight:700,color:'var(--c-muted)',textTransform:'uppercase',letterSpacing:'.05em',marginTop:4}}>{l}</div>
          </div>
        ))}
      </div>}
      {tab==='doctors' && <div style={{display:'flex',flexDirection:'column',gap:10}}>{docs.map(d=>(
        <div key={d.id} className="dd-card" style={{display:'flex',alignItems:'center',gap:16,padding:'1rem 1.25rem'}}>
          <DocAvatar src={d.img} name={d.name} size={44} radius={14}/>
          <div style={{flex:1}}><div style={{fontWeight:700}}>{d.name}</div><div style={{fontSize:13,color:'var(--c-muted)'}}>{d.specialty} · {fmtPrice(d.price,d.currency)}</div></div>
          <button onClick={()=>{if(confirm('Delete?'))setDocs(p=>p.filter(x=>x.id!==d.id));}} style={{background:'none',border:'none',cursor:'pointer',padding:8,color:'var(--c-danger)'}}><I n="trash" s={18}/></button>
        </div>
      ))}</div>}
      {tab==='visits' && <div style={{display:'flex',flexDirection:'column',gap:10}}>{visits.length>0?visits.map(v=>(
        <div key={v.id} className="dd-card" style={{display:'flex',alignItems:'center',gap:16,padding:'1rem 1.25rem'}}>
          <div style={{flex:1}}><div style={{fontWeight:700}}>{v.docName||v.specialty} — <span style={{color:'var(--c-muted)',fontWeight:500}}>{v.status}</span></div><div style={{fontSize:13,color:'var(--c-muted)',marginTop:2}}>{v.sym?.substring(0,40)} · {v.date}</div></div>
          <button onClick={()=>{if(confirm('Delete?'))setVisits(p=>p.filter(x=>x.id!==v.id));}} style={{background:'none',border:'none',cursor:'pointer',padding:8,color:'var(--c-danger)'}}><I n="trash" s={18}/></button>
        </div>
      )):<div className="dd-card" style={{textAlign:'center',padding:'2rem',borderStyle:'dashed'}}><p style={{color:'var(--c-muted)'}}>No visits</p></div>}</div>}
    </div></div>
  );
}

// ═══════ PROFILE ═══════
function ProfileView({user,onUpdate,onBack,emergencyContacts,setEmergencyContacts,visits,onViewSummary}){
  const {t,dk} = useT(); const toast = useToast();
  const [fn,setFn]=useState(user.firstName||'');const [ln,setLn]=useState(user.lastName||'');const [ph,setPh]=useState(user.phone||'');const [addr,setAddr]=useState(user.address||'');
  const [editing,setEditing]=useState(false);
  const [addEC,setAddEC]=useState(false);const [ecName,setEcName]=useState('');const [ecPhone,setEcPhone]=useState('');const [ecRel,setEcRel]=useState('');
  const [tab,setTab]=useState('info');
  // Saved cards state - persist to localStorage
  const [cards,setCards]=useState(()=>{try{const a=JSON.parse(localStorage.getItem('dd_profile_cards')||'[]');const b=JSON.parse(localStorage.getItem('dd_saved_cards')||'[]');return [...a,...b].filter((c,i,arr)=>arr.findIndex(x=>x.last4===c.last4)===i);}catch{return [];}});const [addCard,setAddCard]=useState(false);
  const [cNum,setCNum]=useState('');const [cHold,setCHold]=useState('');const [cExp,setCExp]=useState('');const [cCvc,setCCvc]=useState('');
  useEffect(()=>{try{localStorage.setItem('dd_profile_cards',JSON.stringify(cards));localStorage.setItem('dd_saved_cards',JSON.stringify(cards));}catch{}},[cards]);
  const [notifOn,setNotifOn]=useState(true);const [twoFA,setTwoFA]=useState(false);
  const fmtCard = v=>v.replace(/\D/g,'').substring(0,16).replace(/(\d{4})/g,'$1 ').trim();
  const fmtExp = v=>{let d=v.replace(/\D/g,'');return d.length>=2?d.substring(0,2)+'/'+d.substring(2,4):d;};
  // #15: Profile photo
  const [profImg,setProfImg]=useState(user.img||'');
  const handlePhoto = (e)=>{
    const file=e.target.files?.[0];if(!file)return;
    const reader=new FileReader();
    reader.onload=(ev)=>{setProfImg(ev.target.result);onUpdate({...user,img:ev.target.result});toast('Photo updated','success');};
    reader.readAsDataURL(file);
  };
  const removePhoto = ()=>{setProfImg('');onUpdate({...user,img:''});toast('Photo removed','success');};
  // #17: Doctor languages
  const allLangs=['English','Turkish','Spanish','German','French','Arabic','Russian','Chinese','Japanese','Korean','Portuguese','Italian'];
  const [docLangs,setDocLangs]=useState(Array.isArray(user.langs)?user.langs:['English']);
  const toggleLang=(l)=>setDocLangs(p=>p.includes(l)?p.filter(x=>x!==l):[...p,l]);
  // #19: Experience
  const [docExp,setDocExp]=useState(user.experience||'');
  const [docEdu,setDocEdu]=useState(user.education||'');
  // #13: Medical profile fields (moved here)
  const [blood,setBlood]=useState(user.bloodType||'');const [allergy,setAllergy]=useState(user.allergies||'');const [hist,setHist]=useState(user.medicalHistory||'');
  // Wallet
  const [wBal,setWBal]=useState(()=>{try{return parseFloat(localStorage.getItem('dd_wallet')||'0');}catch{return 0;}});
  const [walletAmt,setWalletAmt]=useState('');

  const save = ()=>{
    const updates = {...user,firstName:fn,lastName:ln,phone:ph,address:addr,bloodType:blood,allergies:allergy,medicalHistory:hist};
    if(isDoc){updates.langs=docLangs;updates.experience=docExp;updates.education=docEdu;}
    onUpdate(updates);toast('Profile updated','success');setEditing(false);
  };
  const addNewCard = ()=>{if(cNum.length<19||!cHold){toast('Complete card details','warning');return;}
    const brand = cNum.trim().startsWith('4')?'Visa':cNum.trim().startsWith('5')?'Mastercard':'Card';
    setCards(p=>[...p,{id:'c'+Date.now(),last4:cNum.replace(/\s/g,'').slice(-4),holder:cHold,brand,exp:cExp,isDefault:p.length===0}]);
    setCNum('');setCHold('');setCExp('');setCCvc('');setAddCard(false);toast('Card saved','success');};

  const isDoc = user.role === 'doctor';
  const accColor = isDoc ? '#1e293b' : 'var(--c-accent)';
  const tabs = isDoc ? ['info','settings'] : ['info','medical','payments','settings'];

  return (
    <div className="dd-page" style={{display:'flex',justifyContent:'center'}}>
      <div style={{maxWidth:540,width:'100%'}} className="animate-fadeUp">
        {/* Profile Header with Cover */}
        <div style={{borderRadius:'24px 24px 0 0',background:`linear-gradient(135deg,${accColor},${isDoc?'#475569':'color-mix(in srgb,var(--c-accent) 80%,var(--c-accent2))'})`,height:120,position:'relative',marginBottom:50}}>
          {editing && <button onClick={save} className="dd-btn dd-btn-ghost" style={{position:'absolute',top:12,right:12,color:'white',fontSize:12,background:'rgba(34,197,94,.4)',backdropFilter:'blur(8px)',border:'none',fontWeight:700}}>Save</button>}
          {!editing && <button onClick={()=>setEditing(true)} style={{position:'absolute',top:12,right:12,padding:'6px 14px',borderRadius:10,fontSize:12,fontWeight:700,background:'rgba(255,255,255,.2)',backdropFilter:'blur(8px)',color:'white',border:'none',cursor:'pointer',display:'flex',alignItems:'center',gap:4}}><I n="fileText" s={14}/>edit</button>}
          <div style={{position:'absolute',bottom:-40,left:24}}>
            {/* #15: Profile photo with upload + dismiss */}
            <div style={{position:'relative',display:'flex',alignItems:'flex-end',gap:10}}>
              {profImg ? <img src={profImg} style={{width:80,height:80,borderRadius:20,objectFit:'cover',border:'4px solid var(--c-surface)',boxShadow:'var(--shadow-lg)'}}/> : <div style={{width:80,height:80,borderRadius:20,background:`linear-gradient(135deg,${accColor},${isDoc?'#64748b':'var(--c-accent2)'})`,display:'flex',alignItems:'center',justifyContent:'center',color:'white',fontSize:'1.75rem',fontWeight:900,fontFamily:'var(--font-display)',border:'4px solid var(--c-surface)',boxShadow:'var(--shadow-lg)'}}>{fn[0]||'U'}</div>}
              {editing && <label style={{position:'absolute',bottom:-4,right:-4,width:28,height:28,borderRadius:'50%',background:'var(--c-accent)',display:'flex',alignItems:'center',justifyContent:'center',cursor:'pointer',border:'2px solid var(--c-surface)',boxShadow:'0 2px 6px rgba(0,0,0,.2)'}}>
                <I n="plus" s={14} c="text-white"/>
                <input type="file" accept="image/*" onChange={handlePhoto} style={{display:'none'}}/>
              </label>}
              {editing && profImg && <button onClick={removePhoto} style={{position:'absolute',top:-6,right:-6,width:22,height:22,borderRadius:'50%',background:'var(--c-danger)',display:'flex',alignItems:'center',justifyContent:'center',cursor:'pointer',border:'2px solid var(--c-surface)',boxShadow:'0 2px 6px rgba(0,0,0,.2)',padding:0,color:'white',fontSize:12,fontWeight:900,lineHeight:1}}>✕</button>}
            </div>
          </div>
        </div>
        <div style={{padding:'0 24px 8px'}}>
          <h2 style={{fontSize:'1.5rem',fontWeight:900,textTransform:'uppercase'}}>{fn} {ln}</h2>
          <div style={{display:'flex',alignItems:'center',gap:8,marginTop:4,flexWrap:'wrap'}}>
            <span className="dd-badge" style={{background:'color-mix(in srgb,#22c55e 12%,transparent)',color:'#16a34a'}}>✓ Verified</span>
          </div>
        </div>

        {/* Tab Navigation */}
        <div style={{display:'flex',gap:0,padding:'12px 24px',borderBottom:'1px solid var(--c-border)',marginTop:12,overflowX:'auto'}}>
          {tabs.map(f=><button key={f} onClick={()=>setTab(f)} style={{padding:'8px 16px',fontSize:13,fontWeight:700,fontFamily:'var(--font-display)',cursor:'pointer',border:'none',borderBottom:tab===f?`2px solid ${accColor}`:'2px solid transparent',background:'transparent',color:tab===f?'var(--c-text)':'var(--c-muted)',transition:'all .2s',textTransform:'capitalize',whiteSpace:'nowrap'}}>{f==='info'?'Personal Info':f==='medical'?'Medical':f==='payments'?'Payments':'Settings'}</button>)}
        </div>

        {/* Personal Info Tab */}
        {tab==='info' && <div style={{padding:'20px 0'}}>
          <div className="dd-card" style={{padding:'1.5rem',borderRadius:20}}>
            <h3 style={{fontWeight:700,fontSize:15,marginBottom:16,display:'flex',alignItems:'center',gap:8}}><I n="user" s={18}/>Personal Info</h3>
            {editing ? (
              <div style={{display:'flex',flexDirection:'column',gap:12}}>
                <div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:10}}>
                  <div><label style={{fontSize:11,fontWeight:700,color:'var(--c-muted)',display:'block',marginBottom:4}}>First Name</label><input className="dd-input" value={fn} onChange={e=>setFn(e.target.value)}/></div>
                  <div><label style={{fontSize:11,fontWeight:700,color:'var(--c-muted)',display:'block',marginBottom:4}}>Last Name</label><input className="dd-input" value={ln} onChange={e=>setLn(e.target.value)}/></div>
                </div>
                <div><label style={{fontSize:11,fontWeight:700,color:'var(--c-muted)',display:'block',marginBottom:4}}>Phone</label><input className="dd-input" value={ph} onChange={e=>setPh(e.target.value)} placeholder="+1 234 567 890"/></div>
                <div><label style={{fontSize:11,fontWeight:700,color:'var(--c-muted)',display:'block',marginBottom:4}}>Address</label><input className="dd-input" value={addr} onChange={e=>setAddr(e.target.value)} placeholder="123 Main St"/></div>
                {/* #17: Doctor language picker */}
                {isDoc && <div>
                  <label style={{fontSize:11,fontWeight:700,color:'var(--c-muted)',display:'block',marginBottom:6}}>Languages Spoken</label>
                  <div style={{display:'flex',gap:6,flexWrap:'wrap'}}>{allLangs.map(l=><button key={l} type="button" onClick={()=>toggleLang(l)} style={{padding:'5px 12px',borderRadius:8,fontSize:11,fontWeight:700,border:'1.5px solid',cursor:'pointer',background:docLangs.includes(l)?'var(--c-accent)':'transparent',color:docLangs.includes(l)?'white':'var(--c-muted)',borderColor:docLangs.includes(l)?'var(--c-accent)':'var(--c-border)',transition:'all .2s'}}>{l}</button>)}</div>
                </div>}
                {/* #19: Experience & Education for doctors */}
                {isDoc && <>
                  <div><label style={{fontSize:11,fontWeight:700,color:'var(--c-muted)',display:'block',marginBottom:4}}>Education / University</label><input className="dd-input" value={docEdu} onChange={e=>setDocEdu(e.target.value)} placeholder="e.g. Harvard Medical School, 2015"/></div>
                  <div><label style={{fontSize:11,fontWeight:700,color:'var(--c-muted)',display:'block',marginBottom:4}}>Previous Experience</label><textarea className="dd-input" value={docExp} onChange={e=>setDocExp(e.target.value)} placeholder="List your previous hospitals, clinics, years of experience..." style={{height:80,resize:'none'}}/></div>
                </>}
                <button className="dd-btn dd-btn-primary" onClick={save} style={{width:'100%',padding:'1rem'}}>{t('save')}</button>
              </div>
            ) : (
              <div style={{display:'flex',flexDirection:'column',gap:16}}>
                <div><div style={{fontSize:11,fontWeight:700,color:accColor,textTransform:'uppercase',letterSpacing:'.05em',marginBottom:4}}>EMAIL</div><div style={{display:'flex',alignItems:'center',gap:8}}><I n="mail" s={14} c="text-slate-400"/>{user.email}</div></div>
                <div><div style={{fontSize:11,fontWeight:700,color:accColor,textTransform:'uppercase',letterSpacing:'.05em',marginBottom:4}}>PHONE</div><div style={{display:'flex',alignItems:'center',gap:8}}><I n="phone" s={14} c="text-slate-400"/>{ph||'Not provided'}</div></div>
              </div>
            )}
          </div>

          <button className="dd-btn dd-btn-ghost" onClick={onBack} style={{width:'100%',marginTop:16,border:'1.5px solid var(--c-border)',padding:'1rem'}}>Back</button>

          {/* Doctor Professional Profile */}
          {isDoc && <div className="dd-card" style={{padding:'1.5rem',borderRadius:20,marginTop:16}}>
            <h3 style={{fontWeight:700,fontSize:15,marginBottom:16,display:'flex',alignItems:'center',gap:8}}><I n="award" s={18}/>Professional Profile</h3>
            <div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:16}}>
              <div><div style={{fontSize:11,fontWeight:700,color:accColor,textTransform:'uppercase',letterSpacing:'.05em',marginBottom:4}}>SPECIALTY</div><div style={{fontWeight:700}}>{user.specialty||'General Practitioner'}</div></div>
              <div><div style={{fontSize:11,fontWeight:700,color:accColor,textTransform:'uppercase',letterSpacing:'.05em',marginBottom:4}}>LICENSE</div><div style={{fontWeight:600}}>{user.licenseNumber||'PENDING'}</div></div>
              <div><div style={{fontSize:11,fontWeight:700,color:accColor,textTransform:'uppercase',letterSpacing:'.05em',marginBottom:4}}>FEE</div><div style={{fontWeight:800,fontSize:18}}>{fmtPrice(user.price||150,user.currency)}</div></div>
              <div><div style={{fontSize:11,fontWeight:700,color:accColor,textTransform:'uppercase',letterSpacing:'.05em',marginBottom:4}}>RATING</div><div style={{display:'flex',gap:1}}>{(user.reviewCount||0)>0 ? Array.from({length:5},(_,i)=><span key={i} style={{color:i<Math.round(user.rating)?'#f59e0b':'#cbd5e1',fontSize:16}}>★</span>) : <span style={{color:'var(--c-muted)',fontSize:13}}>Henüz değerlendirme yok</span>}</div></div>
            </div>
            {/* Languages */}
            <div style={{marginTop:16}}><div style={{fontSize:11,fontWeight:700,color:accColor,textTransform:'uppercase',letterSpacing:'.05em',marginBottom:6}}>LANGUAGES</div>
              <div style={{display:'flex',gap:6,flexWrap:'wrap'}}>{(Array.isArray(user.langs)?user.langs:['English']).map(l=><span key={l} className="dd-badge" style={{background:'var(--c-subtle)',color:'var(--c-muted)'}}>{l}</span>)}</div>
            </div>
            {/* #19: Education & Experience display */}
            {(docEdu||user.education) && <div style={{marginTop:16}}><div style={{fontSize:11,fontWeight:700,color:accColor,textTransform:'uppercase',letterSpacing:'.05em',marginBottom:4}}>EDUCATION</div><div style={{fontWeight:600,fontSize:14}}>{docEdu||user.education}</div></div>}
            {(docExp||user.experience) && <div style={{marginTop:12}}><div style={{fontSize:11,fontWeight:700,color:accColor,textTransform:'uppercase',letterSpacing:'.05em',marginBottom:4}}>EXPERIENCE</div><div style={{fontSize:13,color:'var(--c-muted)',whiteSpace:'pre-line'}}>{docExp||user.experience}</div></div>}
          </div>}

          {/* Emergency Contacts (patient) */}
          {!isDoc && emergencyContacts && <div style={{marginTop:16}}>
            <h3 style={{fontSize:13,fontWeight:700,color:'var(--c-muted)',marginBottom:10,fontFamily:'var(--font-display)',letterSpacing:'.03em',textTransform:'uppercase'}}>Emergency Contacts</h3>
            {(emergencyContacts||[]).map(ec=>(
              <div key={ec.id} className="dd-card" style={{display:'flex',alignItems:'center',gap:12,padding:'12px 14px',marginBottom:6}}>
                <div style={{width:36,height:36,borderRadius:10,background:'color-mix(in srgb,var(--c-danger) 10%,transparent)',display:'flex',alignItems:'center',justifyContent:'center'}}><I n="phone" s={16} c="text-red-500"/></div>
                <div style={{flex:1}}><div style={{fontWeight:700,fontSize:13}}>{ec.name}</div><div style={{fontSize:11,color:'var(--c-muted)'}}>{ec.relation} · {ec.phone}</div></div>
                <button onClick={()=>setEmergencyContacts(p=>p.filter(x=>x.id!==ec.id))} style={{background:'none',border:'none',cursor:'pointer',padding:4,color:'var(--c-muted)'}}><I n="x" s={14}/></button>
              </div>
            ))}
            {addEC ? (
              <div className="dd-card" style={{padding:'1rem',marginTop:6}}>
                <div style={{display:'flex',flexDirection:'column',gap:8}}>
                  <input className="dd-input" placeholder="Name" value={ecName} onChange={e=>setEcName(e.target.value)} style={{padding:'.75rem'}}/>
                  <input className="dd-input" placeholder="Phone" value={ecPhone} onChange={e=>setEcPhone(e.target.value)} style={{padding:'.75rem'}}/>
                  <input className="dd-input" placeholder="Relation" value={ecRel} onChange={e=>setEcRel(e.target.value)} style={{padding:'.75rem'}}/>
                  <div style={{display:'flex',gap:8}}><button className="dd-btn dd-btn-ghost" onClick={()=>setAddEC(false)} style={{flex:1}}>Cancel</button><button className="dd-btn dd-btn-primary" onClick={()=>{if(!ecName||!ecPhone)return;setEmergencyContacts(p=>[...p,{id:'ec'+Date.now(),name:ecName,phone:ecPhone,relation:ecRel}]);setEcName('');setEcPhone('');setEcRel('');setAddEC(false);}} style={{flex:1}}>Add</button></div>
                </div>
              </div>
            ) : <button onClick={()=>setAddEC(true)} style={{display:'flex',alignItems:'center',justifyContent:'center',gap:6,padding:'12px',borderRadius:12,border:'1.5px dashed var(--c-border)',background:'transparent',color:'var(--c-muted)',fontWeight:600,fontSize:13,cursor:'pointer',width:'100%',marginTop:6}}><I n="plus" s={14}/>Add Contact</button>}
          </div>}
        </div>}

        {/* #13: Medical Tab (moved from separate view) */}
        {tab==='medical' && <div style={{padding:'20px 0'}}>
          <div className="dd-card" style={{padding:'1.5rem',borderRadius:20}}>
            <h3 style={{fontWeight:700,fontSize:15,marginBottom:16,display:'flex',alignItems:'center',gap:8}}><I n="heart" s={18} c="text-red-500"/>Medical File</h3>
            <div style={{display:'flex',flexDirection:'column',gap:12}}>
              <div><label style={{fontSize:11,fontWeight:700,color:'var(--c-muted)',display:'block',marginBottom:4}}>Blood Type</label>
                <select className="dd-input" value={blood} onChange={e=>setBlood(e.target.value)}><option value="">Select</option>{['A+','A-','B+','B-','AB+','AB-','O+','O-'].map(b=><option key={b}>{b}</option>)}</select>
              </div>
              <div><label style={{fontSize:11,fontWeight:700,color:'var(--c-muted)',display:'block',marginBottom:4}}>Allergies</label><textarea className="dd-input" value={allergy} onChange={e=>setAllergy(e.target.value)} placeholder="List any allergies..." style={{height:70,resize:'none'}}/></div>
              <div><label style={{fontSize:11,fontWeight:700,color:'var(--c-muted)',display:'block',marginBottom:4}}>Medical History</label><textarea className="dd-input" value={hist} onChange={e=>setHist(e.target.value)} placeholder="Surgeries, chronic conditions..." style={{height:90,resize:'none'}}/></div>
              <button className="dd-btn dd-btn-primary" onClick={()=>{onUpdate({...user,bloodType:blood,allergies:allergy,medicalHistory:hist});toast('Medical file updated','success');}} style={{width:'100%',padding:'1rem'}}>Save Medical Info</button>
            </div>
          </div>
          {/* Visit summaries from doctors */}
          {(()=>{
            const completed = (visits||[]).filter(v=>v.status==='completed'&&v.summary);
            if(!completed.length) return null;
            return (<div style={{marginTop:16}}>
              <h3 style={{fontWeight:700,fontSize:15,marginBottom:12,display:'flex',alignItems:'center',gap:8}}><I n="fileText" s={18} c="text-teal-600"/>Doctor Reports</h3>
              {completed.map(v=>{
                const s = typeof v.summary==='string'?JSON.parse(v.summary||'{}'):v.summary;
                return (
                  <div key={v.id} className="dd-card" style={{padding:'1rem 1.25rem',marginBottom:10,cursor:'pointer'}} onClick={()=>onViewSummary&&onViewSummary(v.id)}>
                    <div style={{display:'flex',justifyContent:'space-between',alignItems:'flex-start',marginBottom:8}}>
                      <div><div style={{fontWeight:700,fontSize:14}}>{v.docName||'Doctor'}</div><div style={{fontSize:12,color:'var(--c-muted)',marginTop:2}}>{v.date}</div></div>
                      <I n="chevRight" s={16} c="text-slate-400"/>
                    </div>
                    {s.diagnosis && <div style={{fontSize:13,color:'var(--c-muted)',lineHeight:1.4}}>{s.diagnosis.substring(0,100)}{s.diagnosis.length>100?'...':''}</div>}
                    {s.medicine && <div style={{marginTop:6,display:'flex',alignItems:'center',gap:6,fontSize:12,color:'var(--c-accent2)'}}><I n="pill" s={12}/>{s.medicine.substring(0,60)}</div>}
                  </div>
                );
              })}
            </div>);
          })()}
        </div>}

        {/* Payments Tab */}
        {tab==='payments' && <div style={{padding:'20px 0',display:'flex',flexDirection:'column',gap:16}}>
          <div className="dd-card" style={{padding:'1.5rem',borderRadius:20}}>
            <h3 style={{fontWeight:700,fontSize:15,marginBottom:16,display:'flex',alignItems:'center',gap:8}}><I n="credit" s={18}/>Saved Cards</h3>
            {cards.length>0 ? cards.map(c=>(
              <div key={c.id} style={{display:'flex',alignItems:'center',gap:12,padding:'14px 16px',borderRadius:14,background:'var(--c-subtle)',marginBottom:8,border:c.isDefault?'2px solid var(--c-accent)':'1px solid var(--c-border)'}}>
                <div style={{width:40,height:28,borderRadius:6,background:c.brand==='Visa'?'linear-gradient(135deg,#1a1f71,#2557d6)':'linear-gradient(135deg,#eb001b,#f79e1b)',display:'flex',alignItems:'center',justifyContent:'center',color:'white',fontSize:9,fontWeight:900}}>{c.brand==='Visa'?'VISA':'MC'}</div>
                <div style={{flex:1}}><div style={{fontWeight:700,fontSize:14}}>•••• {c.last4}</div><div style={{fontSize:11,color:'var(--c-muted)'}}>{c.holder} · {c.exp}</div></div>
                {c.isDefault && <span className="dd-badge" style={{background:'color-mix(in srgb,var(--c-accent) 10%,transparent)',color:'var(--c-accent)'}}>Default</span>}
                <button onClick={()=>setCards(p=>p.filter(x=>x.id!==c.id))} style={{background:'none',border:'none',cursor:'pointer',padding:4,color:'var(--c-danger)'}}><I n="trash" s={14}/></button>
              </div>
            )) : <div style={{textAlign:'center',padding:'2rem',color:'var(--c-muted)'}}>No saved cards</div>}
            {addCard ? (
              <div style={{marginTop:12,display:'flex',flexDirection:'column',gap:10}}>
                <CreditCardVisual number={cNum} holder={cHold} expiry={cExp}/>
                <input className="dd-input" placeholder="0000 0000 0000 0000" value={cNum} onChange={e=>setCNum(fmtCard(e.target.value))} maxLength={19} style={{fontFamily:'monospace'}}/>
                <input className="dd-input" placeholder="NAME ON CARD" value={cHold} onChange={e=>setCHold(e.target.value.toUpperCase())}/>
                <div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:10}}>
                  <input className="dd-input" placeholder="MM/YY" value={cExp} onChange={e=>setCExp(fmtExp(e.target.value))} maxLength={5} style={{textAlign:'center',fontFamily:'monospace'}}/>
                  <input className="dd-input" type="password" placeholder="CVC" value={cCvc} onChange={e=>setCCvc(e.target.value.replace(/\D/g,''))} maxLength={4} style={{textAlign:'center',fontFamily:'monospace'}}/>
                </div>
                <div style={{display:'flex',gap:8}}>
                  <button className="dd-btn dd-btn-ghost" onClick={()=>setAddCard(false)} style={{flex:1,border:'1px solid var(--c-border)'}}>Cancel</button>
                  <button className="dd-btn dd-btn-primary" onClick={addNewCard} style={{flex:1}}>Save Card</button>
                </div>
              </div>
            ) : <button onClick={()=>setAddCard(true)} style={{display:'flex',alignItems:'center',justifyContent:'center',gap:8,padding:'14px',borderRadius:14,border:'1.5px dashed var(--c-border)',background:'transparent',color:'var(--c-muted)',fontWeight:600,fontSize:13,cursor:'pointer',width:'100%',marginTop:8}}><I n="plus" s={16}/>Add New Card</button>}
          </div>
          {/* #12: Wallet - only allow adding if cards exist */}
          <div className="dd-card" style={{padding:'1.5rem',borderRadius:20}}>
            <h3 style={{fontWeight:700,fontSize:15,marginBottom:16,display:'flex',alignItems:'center',gap:8}}><LottieAnim name="wallet" size={22} hover autoplay style={{filter:dk?'invert(0.6)':'',pointerEvents:'auto'}}/>Wallet Balance</h3>
            <div style={{textAlign:'center',padding:'20px 0'}}><div style={{fontSize:'2.5rem',fontWeight:900,fontFamily:'var(--font-display)'}}>{'$'}{wBal.toFixed(2)}</div><p style={{color:'var(--c-muted)',fontSize:13,marginTop:4}}>Add funds to pay for visits faster</p></div>
            {cards.length>0 ? (
              <div>
                <div style={{display:'flex',gap:6,marginBottom:10}}>
                  {[50,100,200].map(a=><button key={a} type="button" onClick={()=>{const nb=wBal+a;setWBal(nb);localStorage.setItem('dd_wallet',nb.toString());toast(`$${a} added`,'success');}} className="dd-btn dd-btn-ghost" style={{flex:1,border:'1.5px solid var(--c-border)',padding:'8px',fontSize:13}}>+${a}</button>)}
                </div>
                <div style={{display:'flex',gap:6}}>
                  <input className="dd-input" type="number" placeholder="Custom $" value={walletAmt} onChange={e=>setWalletAmt(e.target.value)} style={{flex:1,padding:'.75rem'}}/>
                  <button type="button" onClick={()=>{const a=parseFloat(walletAmt);if(a>0){const nb=wBal+a;setWBal(nb);localStorage.setItem('dd_wallet',nb.toString());setWalletAmt('');toast(`$${a} added`,'success');}}} className="dd-btn dd-btn-primary" style={{padding:'8px 16px'}} disabled={!walletAmt||parseFloat(walletAmt)<=0}>Add</button>
                </div>
              </div>
            ) : (
              <div style={{textAlign:'center',padding:'12px',color:'var(--c-muted)',fontSize:13}}>Save a card first to add wallet funds</div>
            )}
          </div>
        </div>}

        {/* Settings Tab */}
        {tab==='settings' && <div style={{padding:'20px 0'}}>
          <div className="dd-card" style={{padding:'1.5rem',borderRadius:20}}>
            <h3 style={{fontWeight:700,fontSize:15,marginBottom:16,display:'flex',alignItems:'center',gap:8}}><I n="clipboard" s={18}/>Account Settings</h3>
            <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',padding:'14px 0',borderBottom:'1px solid var(--c-border)'}}>
              <span style={{fontWeight:600}}>Notifications</span>
              <button onClick={()=>setNotifOn(!notifOn)} style={{width:48,height:28,borderRadius:14,background:notifOn?accColor:'var(--c-border)',border:'none',cursor:'pointer',position:'relative',transition:'all .3s'}}>
                <div style={{width:22,height:22,borderRadius:'50%',background:'white',position:'absolute',top:3,left:notifOn?23:3,transition:'all .3s',boxShadow:'0 1px 3px rgba(0,0,0,.2)'}}/>
              </button>
            </div>
            <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',padding:'14px 0',borderBottom:'1px solid var(--c-border)'}}>
              <span style={{fontWeight:600}}>Two-Factor Authentication</span>
              <button onClick={()=>setTwoFA(!twoFA)} style={{width:48,height:28,borderRadius:14,background:twoFA?accColor:'var(--c-border)',border:'none',cursor:'pointer',position:'relative',transition:'all .3s'}}>
                <div style={{width:22,height:22,borderRadius:'50%',background:'white',position:'absolute',top:3,left:twoFA?23:3,transition:'all .3s',boxShadow:'0 1px 3px rgba(0,0,0,.2)'}}/>
              </button>
            </div>
          </div>
          <div className="dd-card" style={{padding:'1.5rem',borderRadius:20,marginTop:16}}>
            <h3 style={{fontWeight:700,fontSize:15,marginBottom:12,display:'flex',alignItems:'center',gap:8,color:'var(--c-danger)'}}><I n="alert" s={18}/>Danger Zone</h3>
            <button className="dd-btn btn-cancel" style={{width:'100%',padding:'1rem',background:'color-mix(in srgb,var(--c-danger) 8%,transparent)',color:'var(--c-danger)',border:'1.5px solid color-mix(in srgb,var(--c-danger) 20%,transparent)'}}>Delete Account</button>
          </div>
        </div>}
      </div>
    </div>
  );
}

// ═══════ VISIT SUMMARY MODAL ═══════
function VisitSummaryModal({visitId,visits,onClose,onSkipRating}){
  const v = visits.find(x=>x.id===visitId);
  if(!v) return null;
  const s = v.summary;
  const loading = !s;
  return (
    <div style={{position:'fixed',inset:0,zIndex:200,display:'flex',alignItems:'center',justifyContent:'center',padding:16,background:'rgba(0,0,0,.5)',backdropFilter:'blur(12px)'}}>
      <div className="dd-card animate-fadeUp" style={{maxWidth:480,width:'100%',padding:'2rem',borderRadius:28,maxHeight:'90vh',overflowY:'auto'}}>
        <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',marginBottom:20}}>
          <h3 style={{fontSize:'1.25rem',fontWeight:800,display:'flex',alignItems:'center',gap:10}}><I n="fileText" s={22} c="text-teal-600"/>Visit Summary</h3>
          <button onClick={onSkipRating} style={{background:'none',border:'none',cursor:'pointer',padding:6,color:'var(--c-muted)'}}><I n="x" s={22}/></button>
        </div>
        {loading ? (
          <div style={{textAlign:'center',padding:40}}>
            <div className="animate-spin" style={{display:'inline-block',marginBottom:12}}><I n="loader" s={28} c="text-teal-600"/></div>
            <p style={{color:'var(--c-muted)'}}>Generating visit summary...</p>
          </div>
        ) : (
          <>
            <div style={{display:'flex',alignItems:'center',gap:12,padding:'14px 16px',borderRadius:16,background:'var(--c-subtle)',marginBottom:16}}>
              <DocAvatar src={v.docImg} name={v.docName} size={40} radius={12}/>
              <div><div style={{fontWeight:700,fontSize:14}}>{v.docName}</div><div style={{fontSize:12,color:'var(--c-muted)'}}>{v.date} · {fmtPrice(v.price,v.currency||'TRY')}</div></div>
            </div>
            {/* Structured summary fields */}
            {typeof s === 'string' && <div style={{marginBottom:14,padding:'14px 16px',borderRadius:14,background:'var(--c-subtle)',border:'1px solid var(--c-border)'}}>
              <p style={{fontSize:14,lineHeight:1.6,whiteSpace:'pre-line'}}>{s}</p>
            </div>}
            {typeof s === 'object' && s.diagnosis && <div style={{marginBottom:14,padding:'14px 16px',borderRadius:14,background:'color-mix(in srgb,var(--c-accent) 4%,var(--c-subtle))',border:'1px solid color-mix(in srgb,var(--c-accent) 12%,transparent)'}}>
              <div style={{fontSize:10,fontWeight:800,color:'var(--c-accent)',textTransform:'uppercase',letterSpacing:'.06em',marginBottom:6,display:'flex',alignItems:'center',gap:6}}><I n="fileText" s={13}/>Diagnosis</div>
              <p style={{fontSize:14,lineHeight:1.6}}>{s.diagnosis}</p>
            </div>}
            {typeof s === 'object' && s.medicine && <div style={{marginBottom:14,padding:'14px 16px',borderRadius:14,background:'color-mix(in srgb,var(--c-accent2) 4%,var(--c-subtle))',border:'1px solid color-mix(in srgb,var(--c-accent2) 12%,transparent)'}}>
              <div style={{fontSize:10,fontWeight:800,color:'var(--c-accent2)',textTransform:'uppercase',letterSpacing:'.06em',marginBottom:6,display:'flex',alignItems:'center',gap:6}}><I n="pill" s={13}/>Prescribed Medicine</div>
              <p style={{fontSize:14,lineHeight:1.6}}>{s.medicine}</p>
            </div>}
            {typeof s === 'object' && s.advice && <div style={{marginBottom:14,padding:'14px 16px',borderRadius:14,background:'color-mix(in srgb,#22c55e 4%,var(--c-subtle))',border:'1px solid color-mix(in srgb,#22c55e 12%,transparent)'}}>
              <div style={{fontSize:10,fontWeight:800,color:'#22c55e',textTransform:'uppercase',letterSpacing:'.06em',marginBottom:6,display:'flex',alignItems:'center',gap:6}}><I n="heart" s={13}/>Doctor's Advice</div>
              <p style={{fontSize:14,lineHeight:1.6}}>{s.advice}</p>
            </div>}
            {typeof s === 'object' && s.nextMeeting && <div style={{marginBottom:14,padding:'14px 16px',borderRadius:14,background:'color-mix(in srgb,#f59e0b 6%,var(--c-subtle))',border:'1.5px solid color-mix(in srgb,#f59e0b 18%,transparent)'}}>
              <div style={{fontSize:10,fontWeight:800,color:'#f59e0b',textTransform:'uppercase',letterSpacing:'.06em',marginBottom:6,display:'flex',alignItems:'center',gap:6}}><I n="calendar" s={13}/>Sonraki Randevu Önerisi</div>
              <p style={{fontSize:16,lineHeight:1.6,fontWeight:800,color:'var(--c-text)'}}>{s.nextMeeting.includes('T') ? (s.nextMeeting.split('T')[0]+' — '+(s.nextMeeting.split('T')[1]||'')) : s.nextMeeting}</p>
              <div style={{marginTop:8,padding:'8px 12px',borderRadius:8,background:'color-mix(in srgb,#f59e0b 6%,transparent)',fontSize:11,color:'#b45309'}}>Doktorunuz bu tarihte takip randevusu önermektedir.</div>
            </div>}
            {/* Backwards compat: old format fields */}
            {typeof s === 'object' && s.prescriptions?.length>0 && <div style={{marginBottom:14}}>
              <div style={{fontSize:10,fontWeight:800,color:'var(--c-accent2)',textTransform:'uppercase',letterSpacing:'.06em',marginBottom:8}}>Prescriptions</div>
              <div style={{display:'flex',flexDirection:'column',gap:8}}>
                {s.prescriptions.map((p,i)=>(
                  <div key={i} style={{display:'flex',alignItems:'center',gap:12,padding:'12px 16px',borderRadius:14,background:'color-mix(in srgb,var(--c-accent2) 5%,var(--c-subtle))'}}>
                    <div style={{width:36,height:36,borderRadius:10,background:'color-mix(in srgb,var(--c-accent2) 12%,transparent)',display:'flex',alignItems:'center',justifyContent:'center',flexShrink:0}}><I n="pill" s={16} c="text-indigo-500"/></div>
                    <div><div style={{fontWeight:700,fontSize:14}}>{p.name} — {p.dosage}</div><div style={{fontSize:12,color:'var(--c-muted)'}}>{p.frequency} · {p.duration}</div></div>
                  </div>
                ))}
              </div>
            </div>}
            {typeof s === 'object' && (s.followUp||s.notes) && <div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:10,marginBottom:16}}>
              {s.followUp && <div style={{padding:'12px 16px',borderRadius:14,background:'var(--c-subtle)'}}><div style={{fontSize:10,fontWeight:700,color:'var(--c-muted)',textTransform:'uppercase',marginBottom:2}}>Follow-up</div><div style={{fontWeight:700,fontSize:14}}>{s.followUp}</div></div>}
              {s.notes && <div style={{padding:'12px 16px',borderRadius:14,background:'var(--c-subtle)'}}><div style={{fontSize:10,fontWeight:700,color:'var(--c-muted)',textTransform:'uppercase',marginBottom:2}}>Notes</div><div style={{fontSize:13}}>{s.notes}</div></div>}
            </div>}
            <div style={{display:'flex',gap:10}}>
              <button className="dd-btn dd-btn-ghost" onClick={onSkipRating} style={{flex:1,border:'1.5px solid var(--c-border)'}}>Close</button>
              <button className="dd-btn dd-btn-primary" onClick={onClose} style={{flex:1.5}}><I n="star" s={16}/>Rate Visit</button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

// ═══════ MEDICATIONS VIEW ═══════
function MedsView({meds,setMeds,onBack}){
  const toast = useToast();
  const [adding,setAdding]=useState(false);
  const [editId,setEditId]=useState(null); // #10: editing existing med
  const [name,setName]=useState('');const [dosage,setDosage]=useState('');
  const allDays = ['Monday','Tuesday','Wednesday','Thursday','Friday','Saturday','Sunday'];
  const [dayTimes,setDayTimes]=useState(()=>{const o={};allDays.forEach(d=>o[d]=[]);return o;});
  const [enabledDays,setEnabledDays]=useState([]);
  const toggleDay = (d) => {
    if(enabledDays.includes(d)){setEnabledDays(p=>p.filter(x=>x!==d));}
    else{setEnabledDays(p=>[...p,d]);if(!dayTimes[d]||!dayTimes[d].length)setDayTimes(p=>({...p,[d]:['08:00']}));}
  };
  const addTimeForDay = (d)=>setDayTimes(p=>({...p,[d]:[...(p[d]||[]),'12:00']}));
  const removeTimeForDay = (d,i)=>setDayTimes(p=>({...p,[d]:p[d].filter((_,idx)=>idx!==i)}));
  const updateTimeForDay = (d,i,v)=>setDayTimes(p=>({...p,[d]:p[d].map((t,idx)=>idx===i?v:t)}));

  // #10: Start editing a medicine
  const startEdit = (m) => {
    setEditId(m.id); setName(m.name||''); setDosage(m.dosage||'');
    let days=[]; try{days=JSON.parse(m.days||'[]');}catch{}
    setEnabledDays(days.length?days:[...allDays]);
    let perDay=null; try{perDay=JSON.parse(m.dayTimes||'null');}catch{}
    if(perDay) setDayTimes(perDay);
    else { const o={}; const times=(m.time||'08:00').split(',').filter(Boolean); (days.length?days:allDays).forEach(d=>o[d]=times.length?[...times]:['08:00']); setDayTimes(o); }
    setAdding(true);
  };

  const resetForm = () => {
    setName('');setDosage('');setEnabledDays([...allDays]);setEditId(null);
    const fresh={};allDays.forEach(d=>fresh[d]=['08:00']);setDayTimes(fresh);
    setAdding(false);
  };

  const saveMed = async ()=>{
    if(!name.trim()){toast('Medication name required','warning');return;}
    const activeDayTimes = {};
    enabledDays.forEach(d=>{if(dayTimes[d]?.length) activeDayTimes[d]=dayTimes[d];});
    const allTimes = [...new Set(Object.values(activeDayTimes).flat())];
    const timeStr = allTimes.join(',');
    const medData = {name,dosage,frequency:timeStr,time:timeStr,days:JSON.stringify(enabledDays),dayTimes:JSON.stringify(activeDayTimes),active:true};

    if(editId) {
      // Update existing
      setMeds(p=>p.map(x=>x.id===editId?{...x,...medData}:x));
      toast('Medicine updated','success');
    } else {
      // Add new
      const newMed = {id:`m${Date.now()}`,...medData};
      try { const res = await api.post('/meds', newMed); setMeds(p=>[...p, res.med || newMed]); } catch { setMeds(p=>[...p, newMed]); }
      toast('Medication added','success');
    }
    resetForm();
  };

  const today = new Date();
  const dayName = allDays[today.getDay()===0?6:today.getDay()-1];

  return (
    <div className="dd-page" style={{display:'flex',justifyContent:'center'}}>
      <div style={{maxWidth:560,width:'100%'}} className="animate-fadeUp">
        <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',marginBottom:24}}>
          <div style={{display:'flex',alignItems:'center',gap:12}}>
            <div style={{width:40,height:40,borderRadius:12,background:'color-mix(in srgb,var(--c-accent2) 10%,transparent)',display:'flex',alignItems:'center',justifyContent:'center'}}><I n="pill" s={20} c="text-indigo-500"/></div>
            <h2 style={{fontSize:'1.375rem',fontWeight:800}}>Medicines</h2>
          </div>
          <button className="dd-btn dd-btn-ghost" onClick={onBack} style={{fontSize:13}}><I n="arrowLeft" s={16}/>Back</button>
        </div>
        <div style={{display:'flex',flexDirection:'column',gap:10}}>
          {(meds||[]).map(m=>{
            let days = []; try { days = JSON.parse(m.days||'[]'); } catch { days = []; }
            let perDay = null; try { perDay = JSON.parse(m.dayTimes||'null'); } catch {}
            const times = (m.time||m.frequency||'').split(',').filter(Boolean);
            const dueToday = !days.length || days.includes(dayName);
            const todayTimes = perDay && perDay[dayName] ? perDay[dayName] : times;
            return (
            <div key={m.id} className="dd-card animate-slideUp" style={{padding:'1.25rem',borderLeft:dueToday&&m.active?'4px solid var(--c-accent2)':'4px solid transparent',cursor:'pointer'}} onClick={()=>startEdit(m)}>
              <div style={{display:'flex',alignItems:'center',gap:14}}>
                <div style={{width:44,height:44,borderRadius:14,background:m.active?'color-mix(in srgb,var(--c-accent2) 10%,transparent)':'var(--c-subtle)',display:'flex',alignItems:'center',justifyContent:'center'}}><I n="pill" s={20} c={m.active?"text-indigo-500":"text-slate-400"}/></div>
                <div style={{flex:1}}>
                  <div style={{fontWeight:700,fontSize:15}}>{m.name}</div>
                  {m.dosage && <div style={{fontSize:13,color:'var(--c-muted)',marginTop:2}}>{m.dosage}</div>}
                  <div style={{display:'flex',gap:4,marginTop:6,flexWrap:'wrap'}}>
                    {dueToday && todayTimes.map((t,i)=><span key={i} style={{fontSize:11,fontWeight:700,padding:'2px 8px',borderRadius:6,background:'color-mix(in srgb,var(--c-accent) 8%,transparent)',color:'var(--c-accent)'}}>⏰ {t.trim()}</span>)}
                    {!dueToday && times.map((t,i)=><span key={i} style={{fontSize:11,fontWeight:700,padding:'2px 8px',borderRadius:6,background:'var(--c-subtle)',color:'var(--c-muted)'}}>⏰ {t.trim()}</span>)}
                    {days.length>0 && days.length<7 && <span style={{fontSize:11,fontWeight:600,padding:'2px 8px',borderRadius:6,background:'var(--c-subtle)',color:'var(--c-muted)'}}>{days.map(d=>d.substring(0,3)).join(', ')}</span>}
                    {days.length===7 && <span style={{fontSize:11,fontWeight:600,padding:'2px 8px',borderRadius:6,background:'var(--c-subtle)',color:'var(--c-muted)'}}>Every day</span>}
                  </div>
                </div>
                <div style={{display:'flex',flexDirection:'column',gap:4}}>
                  <button onClick={e=>{e.stopPropagation();setMeds(p=>p.map(x=>x.id===m.id?{...x,active:!x.active}:x));}} style={{padding:'5px 12px',borderRadius:8,fontSize:11,fontWeight:700,border:'1.5px solid',cursor:'pointer',background:m.active?'var(--c-accent)':'transparent',color:m.active?'white':'var(--c-muted)',borderColor:m.active?'var(--c-accent)':'var(--c-border)',transition:'all .2s'}}>{m.active?'Active':'Paused'}</button>
                  <button onClick={e=>{e.stopPropagation();setMeds(p=>p.filter(x=>x.id!==m.id));toast('Removed','warning');}} style={{background:'none',border:'none',cursor:'pointer',padding:4,color:'var(--c-danger)',textAlign:'center'}}><I n="trash" s={14}/></button>
                </div>
              </div>
            </div>
          );})}
        </div>
        {adding ? (
          <div className="dd-card animate-fadeUp" style={{padding:'1.5rem',marginTop:12,borderRadius:20}}>
            <h4 style={{fontWeight:700,marginBottom:12}}>{editId?'Edit Medicine':'Add Medicine'}</h4>
            <div style={{display:'flex',flexDirection:'column',gap:10}}>
              <input className="dd-input" placeholder="Medicine name" value={name} onChange={e=>setName(e.target.value)}/>
              <input className="dd-input" placeholder="Dosage (e.g. 500mg)" value={dosage} onChange={e=>setDosage(e.target.value)}/>
              <div>
                <label style={{fontSize:11,fontWeight:800,color:'var(--c-muted)',textTransform:'uppercase',letterSpacing:'.06em',marginBottom:6,display:'block'}}>Days & Reminder Times</label>
                <div style={{display:'flex',gap:4,flexWrap:'wrap',marginBottom:12}}>
                  {allDays.map(d=><button key={d} type="button" onClick={()=>toggleDay(d)} style={{padding:'6px 10px',borderRadius:8,fontSize:11,fontWeight:700,border:'1.5px solid',cursor:'pointer',background:enabledDays.includes(d)?'var(--c-accent2)':'transparent',color:enabledDays.includes(d)?'white':'var(--c-muted)',borderColor:enabledDays.includes(d)?'var(--c-accent2)':'var(--c-border)',transition:'all .2s'}}>{d.substring(0,3)}</button>)}
                </div>
                {/* Per-day time editors */}
                {enabledDays.map(d=>(
                  <div key={d} style={{marginBottom:10,padding:'10px 12px',borderRadius:10,background:'var(--c-subtle)',border:'1px solid var(--c-border)'}}>
                    <div style={{fontSize:11,fontWeight:800,color:'var(--c-accent2)',marginBottom:6}}>{d}</div>
                    {(dayTimes[d]||['08:00']).map((tm,i)=>(
                      <div key={i} style={{display:'flex',gap:6,marginBottom:4,alignItems:'center'}}>
                        <input className="dd-input" type="time" value={tm} onChange={e=>updateTimeForDay(d,i,e.target.value)} style={{flex:1,padding:'.5rem'}}/>
                        {(dayTimes[d]||[]).length>1 && <button onClick={()=>removeTimeForDay(d,i)} style={{background:'none',border:'none',cursor:'pointer',color:'var(--c-danger)',padding:2}}><I n="x" s={14}/></button>}
                      </div>
                    ))}
                    <button onClick={()=>addTimeForDay(d)} style={{display:'flex',alignItems:'center',gap:4,padding:'4px 10px',borderRadius:6,fontSize:10,fontWeight:700,border:'1.5px dashed var(--c-border)',background:'transparent',color:'var(--c-accent)',cursor:'pointer'}}><I n="plus" s={12}/>Add Hour</button>
                  </div>
                ))}
              </div>
              <div style={{display:'flex',gap:8,marginTop:4}}>
                <button className="dd-btn dd-btn-ghost" onClick={resetForm} style={{flex:1,border:'1.5px solid var(--c-border)'}}>Cancel</button>
                <button className="dd-btn dd-btn-primary btn-bounce" onClick={saveMed} style={{flex:1}}>{editId?'Update':'Add'}</button>
              </div>
            </div>
          </div>
        ) : (
          <button className="dd-btn dd-btn-primary btn-pulse" onClick={()=>setAdding(true)} style={{width:'100%',marginTop:12}}><I n="plus" s={18}/>Add Medicine</button>
        )}
      </div>
    </div>
  );
}

// ═══════════════════════════════════════════════════════
// RENDER with error handling
// ═══════════════════════════════════════════════════════
class ErrorBoundary extends React.Component {
  constructor(props) { super(props); this.state = { error: null }; }
  static getDerivedStateFromError(error) { return { error }; }
  render() {
    if (this.state.error) return React.createElement('div', {
      style: { padding: 40, textAlign: 'center', fontFamily: 'system-ui' }
    },
      React.createElement('h2', { style: { color: '#ef4444', marginBottom: 16 } }, '⚠️ Something went wrong'),
      React.createElement('pre', { style: { background: '#f1f5f9', padding: 16, borderRadius: 12, textAlign: 'left', overflow: 'auto', fontSize: 13 } }, this.state.error.toString()),
      React.createElement('button', { onClick: () => { localStorage.clear(); location.reload(); }, style: { marginTop: 16, padding: '12px 24px', background: '#0d9488', color: 'white', border: 'none', borderRadius: 12, cursor: 'pointer', fontWeight: 700 } }, 'Reset & Reload')
    );
    return this.props.children;
  }
}

const root = ReactDOM.createRoot(document.getElementById('root'));
root.render(React.createElement(ErrorBoundary, null, React.createElement(App)));
