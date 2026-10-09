'use strict';

// Recovers paid Clover checkouts whose buyer closed the tab before
// thank-you.html could save the roster. Clover has no "get checkout session"
// endpoint, so a parked roster is matched to a successful Clover payment by
// exact cart (line-item names + amount) inside the 20-minute session window.
// Anything ambiguous is left alone for a human.

const { createRosterIssue } = require('../lib/ssi-roster');
const P = require('../lib/ssi-pending');

const MAX_NEIGHBOR_FILES = 60;

function parseBody(raw) {
  if (raw == null) return {};
  if (typeof raw === 'string') {
    try { return JSON.parse(raw); } catch { return {}; }
  }
  return typeof raw === 'object' ? raw : {};
}

function secretFrom(req) {
  const h = req.headers || {};
  const auth = String(h.authorization || '');
  return h['x-reconcile-secret'] || (auth.startsWith('Bearer ') ? auth.slice(7) : '');
}

async function confirmedNeighbors(dirs, fromMs, toMs) {
  const seen = new Set();
  const files = [];
  for (const dir of dirs) {
    let list = [];
    try { list = await P.ghList(dir); } catch { list = []; }
    for (const f of list) {
      if (!f.name.endsWith('.json') || seen.has(f.path)) continue;
      const ms = P.stampToMs(f.name);
      if (!Number.isFinite(ms) || ms < fromMs || ms > toMs) continue;
      seen.add(f.path);
      files.push({ ...f, ms });
    }
  }
  files.sort((a, b) => a.ms - b.ms);
  if (files.length > MAX_NEIGHBOR_FILES) {
    const err = new Error('Too many nearby roster files to compare safely.');
    err.status = 503;
    throw err;
  }
  const out = [];
  for (const f of files) {
    const got = await P.ghGet(f.path);
    const j = got && got.json;
    if (!j) continue;
    const cart = Array.isArray(j.people) && j.people.length ? P.cartOf(j.people) : P.cartFromRows(j.rows);
    out.push({
      path: f.path,
      ms: f.ms,
      sid: j.checkoutSessionId || '',
      cloverPaymentId: j.cloverPaymentId || '',
      cart
    });
  }
  return out;
}

async function abandon(base, item, reason, dryRun) {
  if (dryRun) return;
  const obj = { ...item.json, status: 'abandoned', reason, abandonedAt: new Date().toISOString() };
  await P.ghCreate(P.abandonedPath(base, item.sid), obj, `Abandon pending roster ${item.sid} (${reason})`);
  await P.ghDelete(item.path, item.sha, `Move pending roster ${item.sid} to abandoned`);
}

async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });
  if (!P.secretOk(secretFrom(req))) return res.status(401).json({ error: 'unauthorized' });

  const body = parseBody(req.body);
  const base = P.baseFor(req);
  const test = base === P.TEST_INBOX;
  const dryRun = body.dryRun === true;
  const minAge = test && Number.isFinite(Number(body.minAgeMinutes))
    ? Math.max(0, Number(body.minAgeMinutes)) * 60 * 1000
    : P.PENDING_MIN_AGE_MS;
  const now = Date.now();
  const report = { ok: true, base, dryRun, checked: 0, recovered: [], abandoned: [], left: [], cleared: [] };

  try {
    const files = (await P.ghList(`${base}/pending`)).filter((f) => f.name.endsWith('.json'));
    const items = [];
    for (const f of files) {
      const got = await P.ghGet(f.path);
      if (!got) continue;
      const j = got.json || {};
      const sid = P.cleanSessionId(j.checkoutSessionId || f.name.replace(/\.json$/, ''));
      const createdMs = Date.parse(j.createdAt);
      if (!sid || !Number.isFinite(createdMs) || !Array.isArray(j.people) || !j.people.length) {
        report.left.push({ file: f.name, why: 'unreadable pending file' });
        continue;
      }
      items.push({ path: f.path, sha: got.sha, json: j, sid, createdMs, age: now - createdMs, cart: P.cartOf(j.people) });
    }
    report.checked = items.length;

    const due = items.filter((it) => it.age >= minAge).sort((a, b) => a.createdMs - b.createdMs);
    items.filter((it) => it.age < minAge).forEach((it) => report.left.push({ sid: it.sid, why: 'fresh' }));
    if (!due.length) return res.status(200).json(report);

    const minMs = due[0].createdMs;
    const maxMs = due[due.length - 1].createdMs;

    let payments;
    try {
      payments = await P.cloverPayments(minMs - 60 * 1000, maxMs + P.PAY_WINDOW_MS);
    } catch (err) {
      due.forEach((it) => report.left.push({ sid: it.sid, why: `clover lookup failed (${err.message})` }));
      report.ok = false;
      return res.status(200).json(report);
    }

    // Test-only: ignoreLogged compares against test files only, so the
    // recovery path can be exercised end to end against real Clover data.
    const ignoreLogged = test && body.ignoreLogged === true;
    const dirs = ignoreLogged ? [base, `${base}/done`] : [P.INBOX, `${P.INBOX}/done`];
    if (test && !ignoreLogged) dirs.unshift(base, `${base}/done`);
    const neighbors = await confirmedNeighbors(dirs, minMs - P.NEIGHBOR_WINDOW_MS, maxMs + P.NEIGHBOR_WINDOW_MS);
    const claimed = new Set(neighbors.map((n) => n.cloverPaymentId).filter(Boolean));

    for (const it of due) {
      // Already promoted by the thank-you page under this session id?
      const same = neighbors.find((n) => n.sid === it.sid);
      if (same) {
        if (!dryRun) await P.ghDelete(it.path, it.sha, `Clear pending roster ${it.sid} (already saved)`);
        report.cleared.push({ sid: it.sid, why: 'already saved', file: same.path });
        continue;
      }

      const lo = it.createdMs - 60 * 1000;
      const hi = it.createdMs + P.PAY_WINDOW_MS;
      const matches = payments.filter((p) => p.createdTime >= lo && p.createdTime <= hi
        && P.sameCart(it.cart, p.cart) && !claimed.has(p.id));
      const loggedNoId = neighbors.filter((n) => !n.cloverPaymentId && P.sameCart(it.cart, n.cart)
        && Math.abs(n.ms - it.createdMs) <= P.NEIGHBOR_WINDOW_MS).length;
      const twins = items.filter((o) => o !== it && P.sameCart(it.cart, o.cart)
        && Math.abs(o.createdMs - it.createdMs) <= P.PAY_WINDOW_MS).length;
      const unclaimed = matches.length - loggedNoId;
      const old = it.age >= P.ABANDON_AFTER_MS;

      if (!matches.length) {
        if (old) {
          await abandon(base, it, 'not paid after 48h', dryRun);
          report.abandoned.push({ sid: it.sid, why: 'not paid after 48h' });
        } else {
          report.left.push({ sid: it.sid, why: 'no matching Clover payment yet' });
        }
        continue;
      }
      if (unclaimed <= 0) {
        await abandon(base, it, 'already logged (matching payment already has a roster row)', dryRun);
        report.abandoned.push({ sid: it.sid, why: 'already logged' });
        continue;
      }
      if (twins > 0 && unclaimed < twins + 1) {
        if (old) {
          await abandon(base, it, 'ambiguous duplicate cart - check Clover by hand', dryRun);
          report.abandoned.push({ sid: it.sid, why: 'ambiguous - check by hand' });
        } else {
          report.left.push({ sid: it.sid, why: 'ambiguous duplicate cart' });
        }
        continue;
      }

      const pay = matches.sort((a, b) => a.createdTime - b.createdTime)[0];
      claimed.add(pay.id);
      const payload = P.confirmedPayload(it.json, {
        sid: it.sid,
        createdAt: it.json.createdAt,
        submittedAt: new Date(pay.createdTime).toISOString(),
        paymentMethod: pay.method || 'Credit Card',
        source: 'reconcile',
        cloverPaymentId: pay.id,
        note: 'recovered (tab closed)'
      });
      const path = P.confirmedPath(base, it.json.createdAt, it.sid);
      const entry = { sid: it.sid, rows: payload.rows.length, paymentMethod: payload.paymentMethod, path };
      if (!dryRun) {
        const result = await P.ghCreate(path, payload, `Add roster submission (${payload.rows.length} attendee${payload.rows.length === 1 ? '' : 's'}, recovered)`);
        await P.ghDelete(it.path, it.sha, `Promote pending roster ${it.sid} (recovered)`);
        if (result === 'exists') {
          report.cleared.push({ sid: it.sid, why: 'already saved', file: path });
          continue;
        }
        try {
          const issue = await createRosterIssue(payload, path, new Date(), process.env, fetch, { test });
          if (issue && issue.number != null) entry.issue = issue.number;
        } catch (err) {
          entry.issueError = String(err.message || err).slice(0, 200);
        }
      }
      neighbors.push({ path, ms: it.createdMs, sid: it.sid, cloverPaymentId: pay.id, cart: it.cart });
      report.recovered.push(entry);
    }
    return res.status(200).json(report);
  } catch (err) {
    console.error('reconcile-pending failed', err && err.message);
    return res.status(err.status || 502).json({ ok: false, error: err.message || 'reconcile failed', partial: report });
  }
}

// Last-resort guard: always answer with clean JSON instead of a platform 500.
module.exports = async function guarded(req, res) {
  try {
    return await handler(req, res);
  } catch (err) {
    console.error('reconcile-pending crashed', err && err.stack);
    if (res.headersSent) return undefined;
    let detail;
    try {
      if (require('../lib/ssi-pending').baseFor(req) !== 'roster-inbox') detail = String(err && err.message).slice(0, 200);
    } catch { /* ignore */ }
    return res.status(500).json({ error: 'Server error. Please try again.', detail });
  }
};
