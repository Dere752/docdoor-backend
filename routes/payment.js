const express = require('express');
const { v4: uuid } = require('uuid');
const { getDb } = require('../db/init');
const { authMiddleware } = require('../middleware/auth');
const router = express.Router();

// ═══ IYZICO MOCK GATEWAY ═══
// When real iyzico is ready, replace only the gateway functions below.
// The rest of the flow stays identical.

const MOCK_MODE = !process.env.IYZICO_API_KEY;

const iyzicoMock = {
  async createProvision(params) {
    // Simulate 1-2s gateway latency
    await new Promise(r => setTimeout(r, 300 + Math.random() * 200));
    // 95% success rate simulation
    if (Math.random() < 0.05) {
      return { status: 'failure', errorCode: '10051', errorMessage: 'Insufficient funds', paymentId: null };
    }
    const paymentId = 'IYZ' + Date.now().toString(36).toUpperCase();
    return {
      status: 'success', paymentId, fraudStatus: 1,
      token: 'PROV_' + uuid().split('-')[0].toUpperCase(),
      paidPrice: params.amount, currency: params.currency || 'TRY',
    };
  },
  async captureProvision(token) {
    await new Promise(r => setTimeout(r, 200));
    return { status: 'success', paymentId: token };
  },
  async refund(paymentId, amount) {
    await new Promise(r => setTimeout(r, 300));
    return { status: 'success', paymentId, refundedAmount: amount };
  },
  async cancelProvision(token) {
    await new Promise(r => setTimeout(r, 200));
    return { status: 'success' };
  }
};

// When real iyzico keys are set, this would use the real SDK
function getGateway() {
  if (MOCK_MODE) return iyzicoMock;
  // TODO: Replace with real iyzico SDK calls
  // const Iyzipay = require('iyzipay');
  // const iyzipay = new Iyzipay({ apiKey: process.env.IYZICO_API_KEY, secretKey: process.env.IYZICO_SECRET_KEY, uri: process.env.IYZICO_URI });
  return iyzicoMock;
}

// POST /api/payment/provision — Create payment provision (pre-auth)
router.post('/provision', authMiddleware, async (req, res) => {
  try {
    const db = getDb();
    const { visitId, cardId, cardNumber, expMonth, expYear, cvc, holderName, saveCard } = req.body;

    if (!visitId) return res.status(400).json({ error: 'visitId required' });

    const visit = db.prepare('SELECT * FROM visits WHERE id = ? AND user_id = ?').get(visitId, req.user.id);
    if (!visit) return res.status(404).json({ error: 'Visit not found' });
    if (visit.payment_status === 'provisioned' || visit.payment_status === 'captured') {
      return res.status(400).json({ error: 'Payment already processed' });
    }

    const amount = visit.price;
    if (!amount || amount <= 0) return res.status(400).json({ error: 'Invalid visit price' });

    // Get commission rate from settings
    const setting = db.prepare("SELECT value FROM system_settings WHERE key = 'commission_rate'").get();
    const commRate = setting ? parseFloat(setting.value) : 0.20;

    // Resolve card details
    let last4 = '****', brand = 'Visa';
    if (cardId) {
      const card = db.prepare('SELECT * FROM saved_cards WHERE id = ? AND user_id = ?').get(cardId, req.user.id);
      if (card) { last4 = card.last4; brand = card.brand; }
    } else if (cardNumber) {
      last4 = cardNumber.slice(-4);
      brand = cardNumber.startsWith('5') ? 'Mastercard' : cardNumber.startsWith('4') ? 'Visa' : 'Troy';
    } else {
      return res.status(400).json({ error: 'Card details or saved card ID required' });
    }

    // Call gateway
    const gw = getGateway();
    const result = await gw.createProvision({ amount, currency: 'TRY', last4, brand });

    const payId = 'PAY' + Date.now().toString(36).toUpperCase() + uuid().split('-')[0];
    const now = Date.now();

    if (result.status === 'success') {
      const commission = Math.round(amount * commRate * 100) / 100;
      const doctorPay = Math.round((amount - commission) * 100) / 100;

      db.prepare(`INSERT INTO payments (id,visit_id,user_id,doc_id,amount,currency,status,type,payment_method,
        card_last4,card_brand,gateway,gateway_payment_id,provision_token,commission_rate,commission_amount,
        doctor_payout,ip_address,created_at,updated_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
        .run(payId, visitId, req.user.id, visit.doc_id||'', amount, 'TRY', 'provisioned', 'provision',
          'card', last4, brand, 'iyzico', result.paymentId, result.token,
          commRate, commission, doctorPay, req.ip||'', now, now);

      db.prepare("UPDATE visits SET payment_status = 'provisioned', payment_id = ?, updated_at = ? WHERE id = ?")
        .run(payId, now, visitId);

      // Save card if requested
      if (saveCard && cardNumber && !cardId) {
        const cardSaveId = 'CRD' + Date.now().toString(36);
        db.prepare('INSERT INTO saved_cards (id,user_id,last4,holder,brand,exp,is_default,token,created_at) VALUES (?,?,?,?,?,?,?,?,?)')
          .run(cardSaveId, req.user.id, last4, holderName||'', brand, `${expMonth}/${expYear}`, 0, result.token, now);
      }

      res.json({
        success: true, paymentId: payId, gatewayId: result.paymentId,
        amount, commission, doctorPayout: doctorPay,
        status: 'provisioned', mock: MOCK_MODE,
      });
    } else {
      db.prepare(`INSERT INTO payments (id,visit_id,user_id,doc_id,amount,currency,status,type,error_message,ip_address,created_at,updated_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`)
        .run(payId, visitId, req.user.id, visit.doc_id||'', amount, 'TRY', 'failed', 'provision', result.errorMessage||'Gateway error', req.ip||'', now, now);

      res.status(402).json({ success: false, error: result.errorMessage || 'Payment failed', errorCode: result.errorCode });
    }
  } catch(err) {
    console.error('Payment provision error:', err);
    res.status(500).json({ error: 'Payment processing error' });
  }
});

// POST /api/payment/capture — Capture provisioned payment (after session complete)
router.post('/capture', authMiddleware, async (req, res) => {
  try {
    const db = getDb();
    const { visitId } = req.body;
    const visit = db.prepare('SELECT * FROM visits WHERE id = ?').get(visitId);
    if (!visit) return res.status(404).json({ error: 'Visit not found' });

    const payment = db.prepare("SELECT * FROM payments WHERE visit_id = ? AND status = 'provisioned'").get(visitId);
    if (!payment) return res.status(400).json({ error: 'No provisioned payment found' });

    const gw = getGateway();
    const result = await gw.captureProvision(payment.provision_token);
    const now = Date.now();

    if (result.status === 'success') {
      db.prepare("UPDATE payments SET status = 'captured', type = 'capture', updated_at = ? WHERE id = ?").run(now, payment.id);
      db.prepare("UPDATE visits SET payment_status = 'captured', updated_at = ? WHERE id = ?").run(now, visitId);
      res.json({ success: true, status: 'captured' });
    } else {
      res.status(500).json({ error: 'Capture failed' });
    }
  } catch(err) {
    console.error('Capture error:', err);
    res.status(500).json({ error: 'Capture error' });
  }
});

// POST /api/payment/refund — Refund a payment
router.post('/refund', authMiddleware, async (req, res) => {
  try {
    const db = getDb();
    const { visitId, reason } = req.body;
    const visit = db.prepare('SELECT * FROM visits WHERE id = ?').get(visitId);
    if (!visit) return res.status(404).json({ error: 'Visit not found' });

    const payment = db.prepare("SELECT * FROM payments WHERE visit_id = ? AND status IN ('provisioned','captured')").get(visitId);
    if (!payment) return res.status(400).json({ error: 'No refundable payment' });

    // Check cancellation policy: 12h full refund, after that no refund
    let refundAmount = payment.amount;
    if (visit.date && visit.date !== 'ASAP' && visit.time) {
      const apptTime = new Date(visit.date + 'T' + visit.time + ':00').getTime();
      const hoursLeft = (apptTime - Date.now()) / 3600000;
      if (hoursLeft < 12) {
        refundAmount = 0; // No refund within 12 hours
      }
    }

    if (refundAmount <= 0) {
      return res.status(400).json({ error: 'Cancellation too late. No refund available per 12-hour policy.' });
    }

    const gw = getGateway();
    if (payment.status === 'provisioned') {
      await gw.cancelProvision(payment.provision_token);
    } else {
      await gw.refund(payment.gateway_payment_id, refundAmount);
    }
    const now = Date.now();

    db.prepare("UPDATE payments SET status = 'refunded', refund_amount = ?, refund_reason = ?, updated_at = ? WHERE id = ?")
      .run(refundAmount, reason||'', now, payment.id);
    db.prepare("UPDATE visits SET payment_status = 'refunded', status = 'cancelled', updated_at = ? WHERE id = ?").run(now, visitId);

    res.json({ success: true, refundAmount, status: 'refunded' });
  } catch(err) {
    console.error('Refund error:', err);
    res.status(500).json({ error: 'Refund error' });
  }
});

// GET /api/payment/history — User payment history
router.get('/history', authMiddleware, (req, res) => {
  const db = getDb();
  const payments = db.prepare('SELECT * FROM payments WHERE user_id = ? ORDER BY created_at DESC').all(req.user.id);
  res.json({ payments: payments.map(formatPayment) });
});

// GET /api/payment/:visitId — Get payment for a visit
router.get('/:visitId', authMiddleware, (req, res) => {
  const db = getDb();
  const payment = db.prepare('SELECT * FROM payments WHERE visit_id = ? AND user_id = ?').get(req.params.visitId, req.user.id);
  if (!payment) return res.status(404).json({ error: 'No payment found' });
  res.json({ payment: formatPayment(payment) });
});

function formatPayment(p) {
  return {
    id: p.id, visitId: p.visit_id, userId: p.user_id, docId: p.doc_id,
    amount: p.amount, currency: p.currency, status: p.status, type: p.type,
    cardLast4: p.card_last4, cardBrand: p.card_brand, gateway: p.gateway,
    commissionRate: p.commission_rate, commissionAmount: p.commission_amount,
    doctorPayout: p.doctor_payout, refundAmount: p.refund_amount,
    refundReason: p.refund_reason, errorMessage: p.error_message,
    createdAt: p.created_at, updatedAt: p.updated_at,
  };
}

module.exports = router;
