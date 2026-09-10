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
    const rows = buildRosterRows(body);
    const payload = rosterPayload(body, rows);
    const written = await writeRosterInbox(payload);
    const out = { ok: true, saved: written.saved };

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
