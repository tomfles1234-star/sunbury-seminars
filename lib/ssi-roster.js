'use strict';

const SSI_COLUMNS = Object.freeze([
  'Submitted',
  'CourseDate',
  'Practice',
  'PayerFirst',
  'PayerLast',
  'PayerEmail',
  'PayerPhone',
  'PayerAttending',
  'FirstName',
  'LastName',
  'Email',
  'Phone',
  'Street',
  'City',
  'State',
  'ZIP',
  'Title',
  'Fee'
]);

const COLUMN_ALIASES = Object.freeze({
  Submitted: ['Submitted', 'submittedAt', 'submitted'],
  CourseDate: ['CourseDate', 'courseDate'],
  Practice: ['Practice', 'practice'],
  PayerFirst: ['PayerFirst', 'payerFirst', 'buyerFirst'],
  PayerLast: ['PayerLast', 'payerLast', 'buyerLast'],
  PayerEmail: ['PayerEmail', 'payerEmail', 'buyerEmail'],
  PayerPhone: ['PayerPhone', 'payerPhone', 'buyerPhone'],
  PayerAttending: ['PayerAttending', 'payerAttending', 'buyerAttending', 'attending'],
  FirstName: ['FirstName', 'first'],
  LastName: ['LastName', 'last'],
  Email: ['Email', 'email'],
  Phone: ['Phone', 'phone'],
  Street: ['Street', 'street'],
  City: ['City', 'city'],
  State: ['State', 'state'],
  ZIP: ['ZIP', 'Zip', 'zip'],
  Title: ['Title', 'title', 'seat'],
  Fee: ['Fee', 'fee', 'price']
});

const DEFAULT_REPO = 'tomfles1234-star/sunbury-seminars';
const DEFAULT_BRANCH = 'main';
const DEFAULT_COURSE_DATE = '2026-10-24';
const ISSUE_ASSIGNEE = 'tomfles1234-star';
const ISSUE_LABEL = 'ssi-roster';

function trimEnv(env, key, fallback = '') {
  const value = env && env[key] != null ? String(env[key]) : '';
  const trimmed = value.trim();
  return trimmed || fallback;
}

function pick(obj, names, fallback = '') {
  if (!obj || typeof obj !== 'object') return fallback;
  for (const name of names) {
    if (obj[name] !== undefined && obj[name] !== null && obj[name] !== '') {
      return obj[name];
    }
  }
  return fallback;
}

function yesNo(value) {
  if (value === true || value === 'Yes' || value === 'yes' || value === 'YES') return 'Yes';
  if (value === false || value === 'No' || value === 'no' || value === 'NO' || value === '') return 'No';
  return 'Yes';
}

function feeFor(person, explicit) {
  if (explicit !== undefined && explicit !== null && explicit !== '') {
    const n = Number(explicit);
    return Number.isFinite(n) ? n : explicit;
  }
  return person && person.role === 'staff' ? 300 : 525;
}

function titleFor(person, explicit) {
  if (explicit) return explicit;
  return person && person.role === 'staff' ? 'Staff' : 'Dentist';
}

function personToRow(person, buyer, submittedAt, courseDate) {
  const p = person || {};
  const b = buyer || {};
  return {
    Submitted: submittedAt,
    CourseDate: courseDate,
    Practice: pick(b, ['practice', 'Practice']),
    PayerFirst: pick(b, ['first', 'PayerFirst', 'buyerFirst']),
    PayerLast: pick(b, ['last', 'PayerLast', 'buyerLast']),
    PayerEmail: pick(b, ['email', 'PayerEmail', 'buyerEmail']),
    PayerPhone: pick(b, ['phone', 'PayerPhone', 'buyerPhone']),
    PayerAttending: yesNo(b.attending ?? b.PayerAttending),
    FirstName: pick(p, ['first', 'FirstName']),
    LastName: pick(p, ['last', 'LastName']),
    Email: pick(p, ['email', 'Email']),
    Phone: pick(p, ['phone', 'Phone']),
    Street: pick(p, ['street', 'Street']),
    City: pick(p, ['city', 'City']),
    State: pick(p, ['state', 'State']),
    ZIP: pick(p, ['zip', 'ZIP', 'Zip']),
    Title: titleFor(p, pick(p, ['Title', 'title', 'seat'], '')),
    Fee: feeFor(p, pick(p, ['Fee', 'fee', 'price'], ''))
  };
}

function objectRowToCanonical(row, buyer, person, submittedAt, courseDate) {
  const merged = personToRow(person, buyer, submittedAt, courseDate);
  if (!row || typeof row !== 'object' || Array.isArray(row)) return merged;
  for (const col of SSI_COLUMNS) {
    const value = pick(row, COLUMN_ALIASES[col], null);
    if (value === null) continue;
    if (col === 'PayerAttending') merged[col] = yesNo(value);
    else if (col === 'Fee') merged[col] = feeFor(person, value);
    else if (col === 'Title') merged[col] = titleFor(person, value);
    else merged[col] = value;
  }
  return merged;
}

function arrayRowToCanonical(arr, submittedAt, courseDate) {
  const row = {};
  SSI_COLUMNS.forEach((col, i) => {
    row[col] = arr[i] !== undefined && arr[i] !== null ? arr[i] : '';
  });
  if (!row.Submitted) row.Submitted = submittedAt;
  if (!row.CourseDate) row.CourseDate = courseDate;
  return row;
}

function parseJsonBody(body) {
  if (body == null) return {};
  if (typeof body === 'string') {
    try { return JSON.parse(body); } catch { return {}; }
  }
  if (typeof body === 'object') return body;
  return {};
}

function buildRosterRows(body, now = new Date(), env = process.env) {
  const submittedAt = now.toISOString();
  const courseDate = trimEnv(env, 'SSI_COURSE_DATE', DEFAULT_COURSE_DATE);
  const payload = body || {};
  const buyer = payload.buyer || {};
  const people = Array.isArray(payload.people) ? payload.people : [];
  const incoming = Array.isArray(payload.rows) ? payload.rows : [];

  if (incoming.length) {
    return incoming.map((row, i) => {
      if (Array.isArray(row)) return arrayRowToCanonical(row, submittedAt, courseDate);
      return objectRowToCanonical(row, buyer, people[i], submittedAt, courseDate);
    });
  }
  return people.map((person) => personToRow(person, buyer, submittedAt, courseDate));
}

function rosterPayload(body, rows) {
  const buyer = (body && body.buyer) || {};
  const people = Array.isArray(body && body.people) ? body.people : [];
  return {
    buyer,
    people,
    rows,
    total: rows.reduce((sum, row) => sum + Number(row.Fee || 0), 0)
  };
}

function inboxPath(now = new Date(), attempt = 0) {
  const stamp = now.toISOString().replace(/:/g, '-');
  const extra = attempt ? `-${attempt}` : '';
  return `roster-inbox/${stamp}${extra}.json`;
}

function githubToken(env = process.env) {
  return trimEnv(env, 'GITHUB_TOKEN');
}

function powerAutomateUrl(env = process.env) {
  return trimEnv(env, 'POWER_AUTOMATE_URL');
}

function httpError(message, status, detail) {
  const err = new Error(message);
  err.status = status;
  if (detail) err.detail = String(detail).slice(0, 400);
  return err;
}

function apiErrorMessage(text) {
  try {
    const data = JSON.parse(text);
    return data.message || data.error || text;
  } catch {
    return text;
  }
}

function githubHeaders(token) {
  return {
    Authorization: `Bearer ${token}`,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'sunbury-seminars-save-roster'
  };
}

function contentsUrl(repo, path, branch) {
  const url = `https://api.github.com/repos/${repo}/contents/${path}`;
  return branch ? `${url}?ref=${encodeURIComponent(branch)}` : url;
}

async function readContentsSha(fetchFn, repo, path, branch, token) {
  const r = await fetchFn(contentsUrl(repo, path, branch), {
    headers: githubHeaders(token)
  });
  const text = await r.text();
  if (r.status === 404) return null;
  if (!r.ok) {
    throw httpError(apiErrorMessage(text) || 'GitHub could not read roster-inbox.', 502, text);
  }
  let data = {};
  try { data = JSON.parse(text); } catch { data = {}; }
  return data.sha || null;
}

async function putContents(fetchFn, { repo, path, branch, token, content, message, sha }) {
  const body = { message, content, branch };
  if (sha) body.sha = sha;
  const r = await fetchFn(contentsUrl(repo, path), {
    method: 'PUT',
    headers: {
      ...githubHeaders(token),
      'content-type': 'application/json'
    },
    body: JSON.stringify(body)
  });
  const text = await r.text();
  let data = {};
  if (text) {
    try { data = JSON.parse(text); } catch { data = { raw: text }; }
  }
  return { r, text, data };
}

async function writeRosterInbox(payload, env = process.env, fetchFn = fetch, now = new Date()) {
  const token = githubToken(env);
  if (!token) {
    throw httpError(
      'Attendee list is not connected yet. Set GITHUB_TOKEN on Vercel (contents:write and issues:write on this repo).',
      503
    );
  }

  const repo = trimEnv(env, 'GITHUB_REPO', DEFAULT_REPO);
  const branch = trimEnv(env, 'GITHUB_BRANCH', DEFAULT_BRANCH);
  const json = `${JSON.stringify(payload, null, 2)}\n`;
  const content = Buffer.from(json, 'utf8').toString('base64');
  const count = Array.isArray(payload.rows) ? payload.rows.length : 0;
  const message = `Add roster submission (${count} attendee${count === 1 ? '' : 's'})`;

  let lastError;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const path = inboxPath(now, attempt);
    const sha = await readContentsSha(fetchFn, repo, path, branch, token);
    const { r, text, data } = await putContents(fetchFn, {
      repo, path, branch, token, content, message, sha
    });
    if (r.ok) {
      return { path, saved: count, sha: data.content && data.content.sha, updated: Boolean(sha) };
    }
    lastError = text;
    if (r.status !== 409 && r.status !== 422) {
      throw httpError(
        apiErrorMessage(text) || 'GitHub did not accept the attendee list.',
        502,
        text
      );
    }
  }

  throw httpError('GitHub did not accept the attendee list.', 502, lastError);
}

function issueTitle(now = new Date()) {
  return `SSI roster ${now.toISOString()}`;
}

function issueBody(payload, path) {
  return [
    `Inbox file: \`${path}\``,
    '',
    '```json',
    JSON.stringify(payload, null, 2),
    '```',
    ''
  ].join('\n');
}

async function ensureSsiRosterLabel(fetchFn, repo, token) {
  try {
    const r = await fetchFn(`https://api.github.com/repos/${repo}/labels`, {
      method: 'POST',
      headers: {
        ...githubHeaders(token),
        'content-type': 'application/json'
      },
      body: JSON.stringify({
        name: ISSUE_LABEL,
        color: 'e67a28',
        description: 'Attendee roster ready for OneDrive Excel'
      })
    });
    await r.text();
  } catch {
    // Label may already exist; never fail the roster write for this.
  }
}

async function postIssue(fetchFn, repo, token, issue) {
  const r = await fetchFn(`https://api.github.com/repos/${repo}/issues`, {
    method: 'POST',
    headers: {
      ...githubHeaders(token),
      'content-type': 'application/json'
    },
    body: JSON.stringify(issue)
  });
  const text = await r.text();
  let data = {};
  if (text) {
    try { data = JSON.parse(text); } catch { data = { raw: text }; }
  }
  return { r, text, data };
}

async function assignIssue(fetchFn, repo, token, number) {
  const r = await fetchFn(`https://api.github.com/repos/${repo}/issues/${encodeURIComponent(number)}/assignees`, {
    method: 'POST',
    headers: {
      ...githubHeaders(token),
      'content-type': 'application/json'
    },
    body: JSON.stringify({ assignees: [ISSUE_ASSIGNEE] })
  });
  const text = await r.text();
  let data = {};
  if (text) {
    try { data = JSON.parse(text); } catch { data = { raw: text }; }
  }
  return { r, text, data };
}

async function createRosterIssue(payload, path, now = new Date(), env = process.env, fetchFn = fetch) {
  const token = githubToken(env);
  if (!token) {
    throw httpError(
      'Attendee list is not connected yet. Set GITHUB_TOKEN on Vercel (contents:write and issues:write on this repo).',
      503
    );
  }
  const repo = trimEnv(env, 'GITHUB_REPO', DEFAULT_REPO);
  await ensureSsiRosterLabel(fetchFn, repo, token);

  const issue = {
    title: issueTitle(now),
    body: issueBody(payload, path),
    labels: [ISSUE_LABEL]
  };

  let { r, text, data } = await postIssue(fetchFn, repo, token, issue);
  if (!r.ok && issue.labels) {
    const retry = { title: issue.title, body: issue.body };
    ({ r, text, data } = await postIssue(fetchFn, repo, token, retry));
  }
  if (!r.ok) {
    throw httpError(apiErrorMessage(text) || 'GitHub did not create the roster issue.', 502, text);
  }

  const created = {
    number: data.number,
    url: data.html_url,
    title: issue.title
  };

  if (created.number == null) {
    created.assignError = 'Issue was created without a number, so it could not be assigned.';
    return created;
  }

  try {
    const assigned = await assignIssue(fetchFn, repo, token, created.number);
    if (!assigned.r.ok) {
      created.assignError = String(
        apiErrorMessage(assigned.text) || 'GitHub did not assign the roster issue.'
      ).slice(0, 400);
    }
  } catch (err) {
    created.assignError = String((err && err.message) || err).slice(0, 400);
  }

  return created;
}

async function forwardPowerAutomate(hook, payload, fetchFn = fetch) {
  const r = await fetchFn(hook, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload)
  });
  const text = await r.text();
  if (!r.ok) {
    throw httpError('Optional webhook did not accept the list.', 502, text);
  }
  return text;
}

module.exports = {
  SSI_COLUMNS,
  DEFAULT_REPO,
  DEFAULT_BRANCH,
  DEFAULT_COURSE_DATE,
  parseJsonBody,
  buildRosterRows,
  rosterPayload,
  inboxPath,
  githubToken,
  powerAutomateUrl,
  writeRosterInbox,
  createRosterIssue,
  issueTitle,
  issueBody,
  ISSUE_ASSIGNEE,
  ISSUE_LABEL,
  forwardPowerAutomate
};
