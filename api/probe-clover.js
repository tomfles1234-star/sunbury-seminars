'use strict';
const crypto = require('crypto');
const HASH = '9048d7a82610728c4f99699157ceb1cc82e4c2104dc7e6f7f51c4d3c3bd68283';
async function get(url, headers) {
  try {
    const r = await fetch(url, { headers });
    const t = await r.text();
    let d = {}; try { d = JSON.parse(t); } catch {}
    const els = Array.isArray(d.elements) ? d.elements : (Array.isArray(d.data) ? d.data : null);
    const first = els && els[0] ? els[0] : null;
    return { status: r.status, count: els ? els.length : null, keys: first ? Object.keys(first).slice(0, 40) : Object.keys(d).slice(0, 15),
      hasLineItems: !!(first && (first.lineItems || (first.order && first.order.lineItems) || first.items)),
      sample: first ? { amount: first.amount, total: first.total, createdTime: first.createdTime || first.created, result: first.result || first.status,
        orderKeys: first.order ? Object.keys(first.order).slice(0, 30) : null,
        lineItemNames: ((first.lineItems && (first.lineItems.elements || first.lineItems)) || (first.order && first.order.lineItems && (first.order.lineItems.elements || first.order.lineItems)) || first.items || []).map(x => String(x.name || x.description || '').replace(/ — .*/, ' — [name]')).slice(0, 5),
        extKeys: Object.keys(first).filter(k => /extern|checkout|session|note|title|metadata/i.test(k)) } : null };
  } catch (e) { return { error: String(e.message).slice(0, 100) }; }
}
module.exports = async (req, res) => {
  const k = String(req.headers['x-probe'] || '');
  if (crypto.createHash('sha256').update(k).digest('hex') !== HASH) return res.status(401).json({ error: 'no' });
  const m = String(process.env.CLOVER_MERCHANT_ID || '').trim();
  const t = String(process.env.CLOVER_PRIVATE_TOKEN || '').trim();
  const H = (a) => ({ accept: 'application/json', Authorization: a, 'X-Clover-Merchant-Id': m });
  const out = {};
  const since = Date.now() - 45 * 24 * 3600 * 1000;
  out.v3payments = await get('https://api.clover.com/v3/merchants/' + m + '/payments?limit=2&expand=order,order.lineItems,tender,cardTransaction&filter=createdTime>=' + since, H('Bearer ' + t));
  out.v3orders = await get('https://api.clover.com/v3/merchants/' + m + '/orders?limit=2&expand=lineItems,payments&filter=createdTime>=' + since, H('Bearer ' + t));
  out.sclOrders = await get('https://scl.clover.com/v1/orders?limit=2', H('Bearer ' + t));
  out.sclCharges = await get('https://scl.clover.com/v1/charges?limit=2', H('Bearer ' + t));
  out.hcoGet = await get('https://api.clover.com/invoicingcheckoutservice/v1/checkouts?limit=2', H('Bearer ' + t));
  res.status(200).json(out);
};
