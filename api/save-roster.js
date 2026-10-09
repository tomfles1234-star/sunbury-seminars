'use strict';

const {
  parseJsonBody,
  buildRosterRows,
  rosterPayload,
  powerAutomateUrl,
  writeRosterInbox,
  createRosterIssue,
  forwardPowerAutomate
} = require('../lib/ssi-roster');

function prettyBrand(raw) {
  const t = String(raw || '').toUpperCase();
  if (t.includes('AMEX') || t.includes('AMERICAN')) return 'American Express';
  if (t.includes('VISA')) return 'Visa';
  if (t.includes('MASTER')) return 'Mastercard';
  if (t.includes('DISC')) return 'Discover';
  return raw ? String(raw) : '';
}

function formatPayMethod(payment) {
  if (!payment || typeof payment !== 'object') return '';
  const tender = payment.tender || {};
  const card = payment.cardTransaction || payment.card_transaction || {};
  const blob = [
    tender.label,
    tender.labelKey,
    tender.label_key,
    card.entryType,
    card.entry_type,
    payment.source,
    payment.walletType,
    payment.wallet_type
  ].filter(Boolean).join(' ').toLowerCase();
  if (blob.includes('apple')) return 'Apple Pay';
  if (blob.includes('google') || blob.includes('android')) return 'Google Pay';
  const brand = prettyBrand(card.cardType || card.card_type || card.brand);
  return brand ? `Credit Card (${brand})` : 'Credit Card';
}

async function cloverGet(url, merchantId, token) {
  const headers = {
    accept: 'application/json',
    'X-Clover-Merchant-Id': merchantId
  };
  let r = await fetch(url, { headers: { ...headers, Authorization: `Bearer ${token}` } });
  let text = await r.text();
  if (r.status === 401) {
    r = await fetch(url, { headers: { ...headers, Authorization: token } });
    text = await r.text();
  }
  let data = {};
  try { data = JSON.parse(text); } catch { data = { raw: text }; }
  return { ok: r.ok, status: r.status, data };
}

async function resolvePaymentMethod(body) {
  if (body.paymentMethod || body.PaymentMethod) {
    return String(body.paymentMethod || body.PaymentMethod);
  }
  const merchantId = String(process.env.CLOVER_MERCHANT_ID || '').trim();
  const token = String(process.env.CLOVER_PRIVATE_TOKEN || '').trim();
  if (!merchantId || !token) return 'Credit Card';

  const sessionId = body.checkoutSessionId || body.session_id || '';
  if (sessionId) {
    const urls = [
      `https://api.clover.com/invoicingcheckoutservice/v1/checkouts/${encodeURIComponent(sessionId)}`,
      `https://api.clover.com/invoicingcheckoutservice/v1/checkouts/${encodeURIComponent(sessionId)}?expand=payments`
    ];
    for (const url of urls) {
      try {
        const { ok, data } = await cloverGet(url, merchantId, token);
        if (!ok) continue;
        const list = (data.payments && (data.payments.elements || data.payments)) || [];
        const payment = data.payment || list[0] || data;
        const method = formatPayMethod(payment);
        if (method) return method;
      } catch (e) {}
    }
  }
  return 'Credit Card';
}

async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

  const body = parseJsonBody(req.body);
  const people = Array.isArray(body.people) ? body.people : [];
  if (!people.length) return res.status(400).json({ error: 'Add at least one attendee.' });

  try {
    const paymentMethod = await resolvePaymentMethod(body);
    body.paymentMethod = paymentMethod;
    const rows = buildRosterRows(body).map((row) => {
      row.PaymentMethod = paymentMethod;
      return row;
    });
    const payload = rosterPayload(body, rows);
    payload.paymentMethod = paymentMethod;
    const written = await writeRosterInbox(payload);
    const out = { ok: true, saved: written.saved, paymentMethod };

    try {
      const issue = await createRosterIssue(payload, written.path);
      if (issue && issue.assignError) out.assignError = issue.assignError;
    } catch (err) {
      out.issueError = String((err && err.message) || err).slice(0, 400);
    }

    const hook = powerAutomateUrl();
    if (hook) {
      try {
        await forwardPowerAutomate(hook, payload);
      } catch {
        // GitHub inbox is the source of truth; the flow is optional.
      }
    }

    return res.status(200).json(out);
  } catch (err) {
    return res.status(err.status || 502).json({
      error: err.message || 'Could not save the attendee list.',
      detail: err.detail
    });
  }
}

module.exports = handler;
