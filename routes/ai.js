const express = require('express');
const router = express.Router();

// POST /api/ai/triage
router.post('/triage', async (req, res) => {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return res.json(defaultTriage());

  try {
    const { symptoms } = req.body;
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({
        model: 'claude-sonnet-4-20250514', max_tokens: 500,
        messages: [{ role: 'user', content: `Medical triage AI. Analyze: "${symptoms}". Reply ONLY valid JSON: {"specialty":"...","urgency":"Low|Medium|High","advice":"one sentence","timeframe":"e.g. Within 2 hours"}` }]
      })
    });
    const d = await r.json();
    const text = d.content?.map(c => c.text || '').join('') || '';
    res.json(JSON.parse(text.replace(/```json|```/g, '').trim()));
  } catch {
    res.json(defaultTriage());
  }
});

// POST /api/ai/chat
router.post('/chat', async (req, res) => {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return res.json({ reply: "I'm on my way — see you shortly." });

  try {
    const { docName, specialty, symptoms, history, message } = req.body;
    const h = (history || []).map(m => `${m.s === 'user' ? 'Patient' : 'Doctor'}: ${m.t}`).join('\n');
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({
        model: 'claude-sonnet-4-20250514', max_tokens: 200,
        messages: [{ role: 'user', content: `You are ${docName}, a ${specialty}, en route to home visit. Symptoms: "${symptoms}". History:\n${h}\nPatient: "${message}"\nReply 1-2 sentences, professional, empathetic, SMS style.` }]
      })
    });
    const d = await r.json();
    res.json({ reply: d.content?.map(c => c.text || '').join('') || "On my way!" });
  } catch {
    res.json({ reply: "I'm on my way — see you shortly." });
  }
});

// POST /api/ai/summary
router.post('/summary', async (req, res) => {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return res.json(defaultSummary());

  try {
    const { symptoms, specialty } = req.body;
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({
        model: 'claude-sonnet-4-20250514', max_tokens: 400,
        messages: [{ role: 'user', content: `You are a ${specialty}. Patient symptoms: "${symptoms}". Generate a visit summary. Reply ONLY valid JSON: {"diagnosis":"1-2 sentences","prescriptions":[{"name":"med name","dosage":"e.g. 500mg","frequency":"e.g. Twice daily","duration":"e.g. 7 days"}],"followUp":"e.g. In 2 weeks","notes":"1 sentence care instruction"}` }]
      })
    });
    const d = await r.json();
    const text = d.content?.map(c => c.text || '').join('') || '';
    res.json(JSON.parse(text.replace(/```json|```/g, '').trim()));
  } catch {
    res.json(defaultSummary());
  }
});

function defaultTriage() {
  return { specialty: 'General Practitioner', urgency: 'Medium', advice: 'A doctor will assess you shortly.', timeframe: 'Within 1 hour' };
}
function defaultSummary() {
  return { diagnosis: 'General assessment completed. Follow up as needed.', prescriptions: [{ name: 'Ibuprofen', dosage: '400mg', frequency: 'As needed', duration: '5 days' }], followUp: 'In 2 weeks', notes: 'Rest well and stay hydrated.' };
}

module.exports = router;
