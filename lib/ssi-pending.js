'use strict';

// Server-side roster safety net: create-checkout parks each roster as
// roster-inbox/pending/<checkoutSessionId>.json, the thank-you page promotes
// it, and /api/reconcile-pending recovers paid sessions whose buyer closed the
// tab before thank-you.html loaded. Every promotion lands at one deterministic
// path per session, so the same session can never be written twice.

const crypto = require('crypto');
const {
  rosterRepo,
  rosterBranch,
  buildRosterRows,
  rosterPayload
} = require('./ssi-roster');

// sha256 of the reconcile secret (the secret itself is never committed).
// RECONCILE_SECRET on Vercel, if ever set, is accepted as well.
const RECONCILE_SECRET_SHA256 = '8962f8d2621c17bd23d3ea4d4471a16a138c11cf5f183b79b7384b18d360fede';

const INBOX = 'roster-inbox';
const TEST_INBOX = 'roster-inbox/test';
const PENDING_MIN_AGE_MS = 20 * 60 * 1000;
const ABANDON_AFTER_MS = 48 * 60 * 60 * 1000;
const PAY_WINDOW_MS = 20 * 60 * 1000; // Clover sessions live 15 minutes.
const NEIGHBOR_WINDOW_MS = 45 * 60 * 1000;

function env(key, fallback = '') {
  const v = process.env[key] != null ? String(process.env[key]).trim() : '';
  return v || fallback;
}

// Always the private roster repo (see lib/ssi-roster.js), never the public site repo.
function repoName() { return rosterRepo(process.env); }
function branchName() { return rosterBranch(process.env); }

function safeEqualHex(a, b) {
  const x = Buffer.from(String(a), 'utf8');
  const y = Buffer.from(String(b), 'utf8');
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

function secretOk(value) {
  const given = String(value || '').trim();
  if (!given) return false;
  const digest = crypto.createHash('sha256').update(given).digest('hex');
  if (safeEqualHex(digest, RECONCILE_SECRET_SHA256)) return true;
  const fromEnv = env('RECONCILE_SECRET');
  if (fromEnv) {
    const envDigest = crypto.createHash('sha256').update(fromEnv).digest('hex');
    if (safeEqualHex(digest, envDigest)) return true;
  }
  return false;
}

// Test traffic (header x-ssi-test carrying the reconcile secret) is kept under
// roster-inbox/test/ so it never reaches the workbook routine.
function baseFor(req) {
  const h = req && req.headers ? req.headers['x-ssi-test'] : '';
  return h && secretOk(h) ? TEST_INBOX : INBOX;
}

function cleanSessionId(raw) {
  const s = String(raw || '').trim();
  return /^[A-Za-z0-9-]{8,80}$/.test(s) ? s : '';
}

function stampOf(iso) {
  const d = new Date(iso);
  return (Number.isNaN(d.getTime()) ? new Date() : d).toISOString().replace(/:/g, '-');
}

function stampToMs(name) {
  const m = /^(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})(\.\d+)?Z/.exec(String(name || ''));
  if (!m) return NaN;
  return Date.parse(`${m[1]}T${m[2]}:${m[3]}:${m[4]}${m[5] || ''}Z`);
}

function pendingPath(base, sid) { return `${base}/pending/${sid}.json`; }
function confirmedPath(base, createdAt, sid) { return `${base}/${stampOf(createdAt)}_${sid}.json`; }
function abandonedPath(base, sid) { return `${base}/abandoned/${sid}.json`; }

// ---------- GitHub contents helpers ----------

function ghHeaders() {
  const token = env('GITHUB_TOKEN');
  if (!token) {
    const err = new Error('GITHUB_TOKEN is not set on Vercel.');
    err.status = 503;
    throw err;
  }
  return {
    Authorization: `Bearer ${token}`,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'sunbury-seminars-roster',
    'content-type': 'application/json'
  };
}

function contentsUrl(path, withRef) {
  const url = `https://api.github.com/repos/${repoName()}/contents/${path}`;
  return withRef ? `${url}?ref=${encodeURIComponent(branchName())}` : url;
}

async function ghJson(r) {
  const text = await r.text();
  try { return JSON.parse(text); } catch { return { raw: text.slice(0, 300) }; }
}

async function ghGet(path) {
  const r = await fetch(contentsUrl(path, true), { headers: ghHeaders() });
  if (r.status === 404) return null;
  const data = await ghJson(r);
  if (!r.ok) {
    const err = new Error(`GitHub read ${r.status}: ${data.message || ''}`);
    err.status = 502;
    throw err;
  }
  let json = null;
  if (data.content) {
    try { json = JSON.parse(Buffer.from(data.content, 'base64').toString('utf8')); } catch { json = null; }
  }
  return { sha: data.sha, json };
}

async function ghList(dir) {
  const r = await fetch(contentsUrl(dir, true), { headers: ghHeaders() });
  if (r.status === 404) return [];
  const data = await ghJson(r);
  if (!r.ok || !Array.isArray(data)) {
    const err = new Error(`GitHub list ${r.status}: ${data.message || ''}`);
    err.status = 502;
    throw err;
  }
  return data.filter((f) => f.type === 'file').map((f) => ({ name: f.name, path: f.path, sha: f.sha }));
}

// Create-only PUT. Returns 'created' or 'exists'; throws on anything else.
async function ghCreate(path, obj, message) {
  const content = Buffer.from(`${JSON.stringify(obj, null, 2)}\n`, 'utf8').toString('base64');
  const r = await fetch(contentsUrl(path, false), {
    method: 'PUT',
    headers: ghHeaders(),
    body: JSON.stringify({ message, content, branch: branchName() })
  });
  const data = await ghJson(r);
  if (r.ok) return 'created';
  if (r.status === 422 || r.status === 409) {
    // 422 "sha wasn't supplied" means the file already exists.
    const existing = await ghGet(path).catch(() => null);
    if (existing) return 'exists';
  }
  const err = new Error(`GitHub write ${r.status}: ${data.message || ''}`);
  err.status = 502;
  throw err;
}

async function ghDelete(path, sha, message) {
  const r = await fetch(contentsUrl(path, false), {
    method: 'DELETE',
    headers: ghHeaders(),
    body: JSON.stringify({ message, sha, branch: branchName() })
  });
  await r.text();
  return r.ok || r.status === 404;
}

async function ghDeleteFresh(path, message) {
  for (let i = 0; i < 3; i += 1) {
    const cur = await ghGet(path);
    if (!cur) return true;
    if (await ghDelete(path, cur.sha, message)) return true;
  }
  return false;
}

// ---------- roster shape ----------

function lineName(person) {
  const p = person || {};
  const role = p.role === 'staff' ? 'staff' : 'dentist';
  const name = [p.first, p.last].filter(Boolean).join(' ') || role;
  return role === 'staff' ? `Staff — ${name}` : `Dentist — ${name}`;
}

function cartOf(people) {
  const names = (people || []).map(lineName).sort();
  const cents = (people || []).reduce((s, p) => s + (p && p.role === 'staff' ? 30000 : 52500), 0);
  return { names, cents };
}

function cartFromRows(rows) {
  const names = (rows || []).map((r) => {
    const title = String((r && r.Title) || 'Dentist');
    const name = [r && r.FirstName, r && r.LastName].filter(Boolean).join(' ') || title.toLowerCase();
    return `${/staff/i.test(title) ? 'Staff' : 'Dentist'} — ${name}`;
  }).sort();
  const cents = Math.round((rows || []).reduce((s, r) => s + Number((r && r.Fee) || 0), 0) * 100);
  return { names, cents };
}

function sameCart(a, b) {
  return a && b && a.cents === b.cents && a.names.length === b.names.length
    && a.names.every((n, i) => n.toLowerCase() === String(b.names[i]).toLowerCase());
}

function confirmedPayload(roster, { sid, createdAt, submittedAt, paymentMethod, source, cloverPaymentId, note }) {
  const body = { buyer: roster.buyer || {}, people: roster.people || [] };
  const rows = buildRosterRows(body, new Date(submittedAt || Date.now())).map((row) => {
    row.PaymentMethod = paymentMethod || row.PaymentMethod || 'Credit Card';
    return row;
  });
  const payload = rosterPayload(body, rows);
  payload.paymentMethod = paymentMethod || 'Credit Card';
  payload.checkoutSessionId = sid;
  payload.checkoutCreatedAt = createdAt;
  payload.source = source;
  if (cloverPaymentId) payload.cloverPaymentId = cloverPaymentId;
  if (note) payload.note = note;
  return payload;
}

// ---------- Clover helpers ----------

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
  const blob = [tender.label, tender.labelKey, card.entryType, payment.source, payment.walletType]
    .filter(Boolean).join(' ').toLowerCase();
  if (blob.includes('apple')) return 'Apple Pay';
  if (blob.includes('google') || blob.includes('android')) return 'Google Pay';
  const brand = prettyBrand(card.cardType || card.card_type || card.brand);
  return brand ? `Credit Card (${brand})` : 'Credit Card';
}

function cloverCreds() {
  return {
    merchantId: env('CLOVER_MERCHANT_ID'),
    token: env('CLOVER_PRIVATE_TOKEN')
  };
}

// Successful Clover payments created in [fromMs, toMs], with order line items.
async function cloverPayments(fromMs, toMs) {
  const { merchantId, token } = cloverCreds();
  if (!merchantId || !token) {
    const err = new Error('Clover keys are not set on Vercel.');
    err.status = 503;
    throw err;
  }
  const out = [];
  for (let offset = 0; offset < 1000; offset += 100) {
    const url = `https://api.clover.com/v3/merchants/${encodeURIComponent(merchantId)}/payments`
      + `?filter=createdTime>=${Math.floor(fromMs)}&filter=createdTime<=${Math.ceil(toMs)}`
      + `&expand=order,order.lineItems,tender,cardTransaction&limit=100&offset=${offset}`;
    const r = await fetch(url, {
      headers: { accept: 'application/json', Authorization: `Bearer ${token}`, 'X-Clover-Merchant-Id': merchantId }
    });
    const data = await ghJson(r);
    if (!r.ok) {
      const err = new Error(`Clover payments ${r.status}`);
      err.status = 502;
      throw err;
    }
    const els = Array.isArray(data.elements) ? data.elements : [];
    out.push(...els);
    if (els.length < 100) break;
  }
  return out
    .filter((p) => p && p.result === 'SUCCESS')
    .map((p) => {
      const li = p.order && p.order.lineItems;
      const items = (li && (li.elements || li)) || [];
      return {
        id: p.id,
        createdTime: p.createdTime,
        cents: Number(p.amount || 0),
        cart: {
          names: (Array.isArray(items) ? items : []).map((x) => String(x.name || '')).sort(),
          cents: Number(p.amount || 0)
        },
        method: formatPayMethod(p)
      };
    });
}

module.exports = {
  repoName,
  INBOX,
  TEST_INBOX,
  PENDING_MIN_AGE_MS,
  ABANDON_AFTER_MS,
  PAY_WINDOW_MS,
  NEIGHBOR_WINDOW_MS,
  secretOk,
  baseFor,
  cleanSessionId,
  stampOf,
  stampToMs,
  pendingPath,
  confirmedPath,
  abandonedPath,
  ghGet,
  ghList,
  ghCreate,
  ghDelete,
  ghDeleteFresh,
  lineName,
  cartOf,
  cartFromRows,
  sameCart,
  confirmedPayload,
  formatPayMethod,
  cloverCreds,
  cloverPayments
};
