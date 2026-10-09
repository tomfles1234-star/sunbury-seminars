'use strict';

const {
  baseFor,
  cleanSessionId,
  pendingPath,
  ghCreate,
  lineName,
  cartOf,
  TEST_INBOX
} = require('../lib/ssi-pending');

function parseBody(raw) {
  if (raw == null) return {};
  if (typeof raw === 'string') {
    try { return JSON.parse(raw); } catch { return {}; }
  }
  return typeof raw === 'object' ? raw : {};
}

function withTimeout(promise, ms) {
  let timer;
  const limit = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`timed out after ${ms}ms`)), ms);
  });
  return Promise.race([promise, limit]).finally(() => clearTimeout(timer));
}

async function callClover(merchantId, authValue, payload) {
  const r = await fetch('https://api.clover.com/invoicingcheckoutservice/v1/checkouts', {
    method: 'POST',
    headers: {
      accept: 'application/json',
      'content-type': 'application/json',
      'X-Clover-Merchant-Id': merchantId,
      Authorization: authValue
    },
    body: JSON.stringify(payload)
  });
  const text = await r.text();
  let data = {};
  try { data = JSON.parse(text); } catch { data = { raw: text.slice(0, 300) }; }
  return { r, data };
}

async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

  const merchantId = String(process.env.CLOVER_MERCHANT_ID || '').trim();
  const token = String(process.env.CLOVER_PRIVATE_TOKEN || '').trim();
  if (!merchantId || !token) {
    return res.status(500).json({ error: 'Clover keys are not set on Vercel yet.' });
  }

  const body = parseBody(req.body);
  const people = Array.isArray(body.people) ? body.people : [];
  const buyer = body.buyer || {};
  if (!people.length) return res.status(400).json({ error: 'Add at least one attendee.' });

  const lineItems = people.map((p) => ({
    name: lineName(p),
    price: p.role === 'staff' ? 30000 : 52500,
    unitQty: 1,
    note: p.email || ''
  }));

  const person = people[0] || {};
  const address1 = buyer.address1 || buyer.street || person.address1 || person.street || '';
  const city = buyer.city || person.city || '';
  const state = buyer.state || person.state || '';
  const zip = buyer.zip || person.zip || '';

  const payload = {
    customer: {
      firstName: buyer.first || 'Buyer',
      lastName: buyer.last || 'Office',
      email: buyer.email || undefined,
      phoneNumber: (buyer.phone || '').replace(/\D/g, '') || undefined,
      address1: address1 || undefined,
      city: city || undefined,
      state: state || undefined,
      zip: zip || undefined
    },
    shoppingCart: { lineItems },
    redirectUrls: {
      success: 'https://sunburyseminars.com/thank-you.html?session_id={CHECKOUT_SESSION_ID}',
      failure: 'https://sunburyseminars.com/#register'
    }
  };

  let r;
  let data;
  try {
    ({ r, data } = await callClover(merchantId, `Bearer ${token}`, payload));
    if ((!r.ok || !data.href) && r.status === 401) {
      ({ r, data } = await callClover(merchantId, token, payload));
    }
  } catch (err) {
    console.error('create-checkout: Clover request failed', err && err.message);
    return res.status(502).json({ error: 'Could not reach Clover. Please try again in a minute.' });
  }
  if (!r.ok || !data.href) {
    return res.status(r.status && r.status >= 400 ? r.status : 502).json({
      error: data.message || data.error || `Clover ${r.status}`,
      cloverStatus: r.status
    });
  }

  const out = { href: data.href, checkoutSessionId: data.checkoutSessionId };

  // Park the roster server-side so a paid buyer who closes the tab before
  // thank-you.html loads is still logged by /api/reconcile-pending.
  // Nothing in here may ever block or break the payment link.
  let test = false;
  try {
    const sid = cleanSessionId(data.checkoutSessionId);
    const base = baseFor(req);
    test = base === TEST_INBOX;
    if (test) out.test = true;
    if (!sid) {
      console.error('create-checkout: Clover returned no usable checkoutSessionId');
      out.pendingSaved = false;
    } else {
      const pending = {
        status: 'pending',
        checkoutSessionId: sid,
        createdAt: new Date().toISOString(),
        cart: cartOf(people),
        buyer,
        people
      };
      await withTimeout(
        ghCreate(pendingPath(base, sid), pending, `Pending roster ${sid} (${people.length} attendee${people.length === 1 ? '' : 's'})`),
        6000
      );
      out.pendingSaved = true;
    }
  } catch (err) {
    console.error('create-checkout: pending roster write failed', err && err.message);
    out.pendingSaved = false;
    if (test) out.pendingError = String((err && err.message) || err).slice(0, 200);
  }

  return res.status(200).json(out);
}

// Last-resort guard: always answer with clean JSON instead of a platform 500.
module.exports = async function guarded(req, res) {
  try {
    return await handler(req, res);
  } catch (err) {
    console.error('create-checkout crashed', err && err.stack);
    if (res.headersSent) return undefined;
    let detail;
    try {
      if (require('../lib/ssi-pending').baseFor(req) !== 'roster-inbox') detail = String(err && err.message).slice(0, 200);
    } catch { /* ignore */ }
    return res.status(500).json({ error: 'Server error. Please try again.', detail });
  }
};
