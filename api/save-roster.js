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
const P = require('../lib/ssi-pending');

function withTimeout(promise, ms) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(`timed out after ${ms}ms`)), ms))
  ]);
}

async function findConfirmed(base, sid) {
  const suffix = `_${sid}.json`;
  const dirs = [base, `${base}/done`];
  for (const dir of dirs) {
    const files = await P.ghList(dir);
    const hit = files.find((f) => f.name.endsWith(suffix));
    if (hit) return hit.path;
  }
  return null;
}

// Best effort: find the Clover payment for this cart to record card brand + id.
async function lookupPayment(cart, createdAt) {
  try {
    const from = Date.parse(createdAt) || (Date.now() - P.PAY_WINDOW_MS);
    const pays = await withTimeout(P.cloverPayments(from - 60 * 1000, Date.now() + 60 * 1000), 5000);
    const hits = pays.filter((p) => P.sameCart(cart, p.cart)).sort((a, b) => b.createdTime - a.createdTime);
    return hits[0] || null;
  } catch {
    return null;
  }
}

async function fileIssue(out, payload, path, test) {
  try {
    const issue = await createRosterIssue(payload, path, new Date(), process.env, fetch, { test });
    if (issue && issue.assignError) out.assignError = issue.assignError;
    if (issue && issue.number != null) out.issue = issue.number;
  } catch (err) {
    out.issueError = String((err && err.message) || err).slice(0, 400);
  }
}

async function forwardHook(payload) {
  const hook = powerAutomateUrl();
  if (!hook) return;
  try { await forwardPowerAutomate(hook, payload); } catch { /* optional */ }
}

// Thank-you page path with a Clover checkout session id: one deterministic
// file per session, so repeats are deduped.
async function saveForSession(req, body, sid) {
  const base = P.baseFor(req);
  const test = base === P.TEST_INBOX;

  const already = await findConfirmed(base, sid);
  if (already) {
    const stale = await P.ghGet(P.pendingPath(base, sid)).catch(() => null);
    if (stale) await P.ghDelete(P.pendingPath(base, sid), stale.sha, `Clear pending roster ${sid} (already saved)`).catch(() => {});
    return { status: 200, out: { ok: true, saved: 0, duplicate: true, checkoutSessionId: sid } };
  }

  const pending = await P.ghGet(P.pendingPath(base, sid)).catch(() => null);
  const parked = pending && pending.json && Array.isArray(pending.json.people) && pending.json.people.length ? pending.json : null;
  const roster = parked || body;
  const people = Array.isArray(roster.people) ? roster.people : [];
  if (!people.length) return { status: 400, out: { error: 'Add at least one attendee.' } };

  const createdAt = (parked && parked.createdAt) || new Date().toISOString();
  const cart = P.cartOf(people);
  let paymentMethod = body.paymentMethod || body.PaymentMethod || '';
  let cloverPaymentId;
  if (!paymentMethod) {
    const pay = await lookupPayment(cart, createdAt);
    if (pay) { paymentMethod = pay.method; cloverPaymentId = pay.id; }
  }

  const payload = P.confirmedPayload(roster, {
    sid,
    createdAt,
    submittedAt: new Date().toISOString(),
    paymentMethod: paymentMethod || 'Credit Card',
    source: 'thank-you',
    cloverPaymentId
  });
  const path = P.confirmedPath(base, createdAt, sid);
  const result = await P.ghCreate(path, payload, `Add roster submission (${payload.rows.length} attendee${payload.rows.length === 1 ? '' : 's'})`);
  if (pending) {
    await P.ghDelete(P.pendingPath(base, sid), pending.sha, `Promote pending roster ${sid}`).catch(() => {});
  }
  if (result === 'exists') {
    return { status: 200, out: { ok: true, saved: 0, duplicate: true, checkoutSessionId: sid } };
  }

  const out = { ok: true, saved: payload.rows.length, paymentMethod: payload.paymentMethod, checkoutSessionId: sid, path };
  if (test) out.test = true;
  await fileIssue(out, payload, path, test);
  if (!test) await forwardHook(payload);
  return { status: 200, out };
}

async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

  const body = parseJsonBody(req.body);
  const sid = P.cleanSessionId(body.checkoutSessionId || body.session_id);

  try {
    if (sid) {
      const { status, out } = await saveForSession(req, body, sid);
      return res.status(status).json(out);
    }

    // Legacy path (no session id): timestamped inbox file, as before.
    if (P.baseFor(req) === P.TEST_INBOX) {
      return res.status(400).json({ error: 'Test saves need a checkoutSessionId.' });
    }
    const people = Array.isArray(body.people) ? body.people : [];
    if (!people.length) return res.status(400).json({ error: 'Add at least one attendee.' });
    let paymentMethod = String(body.paymentMethod || body.PaymentMethod || '');
    if (!paymentMethod) {
      const pay = await lookupPayment(P.cartOf(people), new Date(Date.now() - P.PAY_WINDOW_MS).toISOString());
      paymentMethod = (pay && pay.method) || 'Credit Card';
    }
    body.paymentMethod = paymentMethod;
    const rows = buildRosterRows(body).map((row) => {
      row.PaymentMethod = paymentMethod;
      return row;
    });
    const payload = rosterPayload(body, rows);
    payload.paymentMethod = paymentMethod;
    payload.source = 'thank-you (no session id)';
    const written = await writeRosterInbox(payload);
    const out = { ok: true, saved: written.saved, paymentMethod };
    await fileIssue(out, payload, written.path, false);
    await forwardHook(payload);
    return res.status(200).json(out);
  } catch (err) {
    console.error('save-roster failed', err && err.message);
    return res.status(err.status || 502).json({
      error: err.message || 'Could not save the attendee list.'
    });
  }
}

module.exports = handler;
