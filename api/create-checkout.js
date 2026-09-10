export default async function handler(req, res) {
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

  let body = req.body;
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch { body = {}; }
  }
  const people = Array.isArray(body.people) ? body.people : [];
  const buyer = body.buyer || {};
  if (!people.length) return res.status(400).json({ error: 'Add at least one attendee.' });

  const lineItems = people.map((p) => {
    const role = p.role === 'staff' ? 'staff' : 'dentist';
    const price = role === 'staff' ? 30000 : 52500;
    const name = [p.first, p.last].filter(Boolean).join(' ') || role;
    return {
      name: role === 'staff' ? `Staff — ${name}` : `Dentist — ${name}`,
      price,
      unitQty: 1,
      note: p.email || ''
    };
  });

  const payload = {
    customer: {
      firstName: buyer.first || 'Buyer',
      lastName: buyer.last || 'Office',
      email: buyer.email || undefined,
      phoneNumber: (buyer.phone || '').replace(/\D/g, '') || undefined
    },
    shoppingCart: { lineItems },
    redirectUrls: {
      success: 'https://sunburyseminars.com/thank-you.html',
      failure: 'https://sunburyseminars.com/'
    }
  };

  async function callClover(authValue) {
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
    try { data = JSON.parse(text); } catch { data = { raw: text }; }
    return { r, data };
  }

  let { r, data } = await callClover(`Bearer ${token}`);
  if ((!r.ok || !data.href) && r.status === 401) {
    ({ r, data } = await callClover(token));
  }
  if (!r.ok || !data.href) {
    return res.status(r.status || 502).json({
      error: data.message || data.error || `Clover ${r.status}`,
      cloverStatus: r.status,
      detail: data
    });
  }
  return res.status(200).json({ href: data.href, checkoutSessionId: data.checkoutSessionId });
}
