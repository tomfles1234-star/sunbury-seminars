export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

  const hook = String(process.env.POWER_AUTOMATE_URL || '').trim();
  if (!hook) {
    return res.status(503).json({
      error: 'Attendee list is not connected to OneDrive yet. Add POWER_AUTOMATE_URL on Vercel after you create the flow.'
    });
  }

  let body = req.body;
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch { body = {}; }
  }
  const people = Array.isArray(body.people) ? body.people : [];
  const buyer = body.buyer || {};
  if (!people.length) return res.status(400).json({ error: 'Add at least one attendee.' });

  const rows = people.map((p) => ({
    submittedAt: new Date().toISOString(),
    courseDate: '2026-10-24',
    practice: buyer.practice || '',
    buyerFirst: buyer.first || '',
    buyerLast: buyer.last || '',
    buyerEmail: buyer.email || '',
    buyerPhone: buyer.phone || '',
    buyerAttending: buyer.attending ? 'Yes' : 'No',
    first: p.first || '',
    last: p.last || '',
    email: p.email || '',
    phone: p.phone || '',
    street: p.street || '',
    city: p.city || '',
    state: p.state || '',
    zip: p.zip || '',
    seat: p.role === 'staff' ? 'Staff' : 'Dentist',
    fee: p.role === 'staff' ? 300 : 525
  }));

  const r = await fetch(hook, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ buyer, people, rows, total: rows.reduce((s, x) => s + x.fee, 0) })
  });
  const text = await r.text();
  if (!r.ok) {
    return res.status(502).json({ error: 'OneDrive flow did not accept the list.', detail: text.slice(0, 400) });
  }
  return res.status(200).json({ ok: true, saved: rows.length });
}
