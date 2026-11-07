'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { DatabaseSync } = require('node:sqlite');
const { createApp } = require('../server');

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

async function request(baseUrl, url, options = {}, cookie = '') {
  const headers = { ...(options.headers || {}) };
  if (cookie) headers.Cookie = cookie;
  if (options.body && !headers['Content-Type']) headers['Content-Type'] = 'application/json';
  return fetch(`${baseUrl}${url}`, { ...options, headers });
}

test('legacy guest_units migration keeps API paths usable without inventing identities', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'gatherly-legacy-api-'));
  const dbPath = path.join(directory, 'legacy.sqlite');
  const token = 'legacy-bearer-token-012345678901234567890123';
  const legacyDb = new DatabaseSync(dbPath);
  legacyDb.exec(`
    CREATE TABLE events (
      id INTEGER PRIMARY KEY, host_id INTEGER NOT NULL, title TEXT NOT NULL,
      event_date TEXT NOT NULL, location TEXT NOT NULL DEFAULT '', guest_mode TEXT NOT NULL,
      rsvp_deadline TEXT, responses_open INTEGER NOT NULL DEFAULT 1,
      reopened_at TEXT, created_at TEXT NOT NULL
    );
    CREATE TABLE guest_units (
      id INTEGER PRIMARY KEY, event_id INTEGER NOT NULL, name TEXT NOT NULL,
      party_limit INTEGER NOT NULL, token_hash TEXT NOT NULL UNIQUE,
      revoked_at TEXT, created_at TEXT NOT NULL
    );
    CREATE TABLE rsvps (
      id INTEGER PRIMARY KEY, guest_unit_id INTEGER NOT NULL UNIQUE,
      answer TEXT NOT NULL, party_size INTEGER NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE TABLE email_outbox (
      id INTEGER PRIMARY KEY, guest_unit_id INTEGER NOT NULL, recipient TEXT NOT NULL,
      subject TEXT NOT NULL, body TEXT NOT NULL, created_at TEXT NOT NULL
    );
    INSERT INTO events (id, host_id, title, event_date, guest_mode, created_at)
      VALUES (1, 1, 'Legacy API event', '2035-04-05', 'household', '2026-01-01');
    INSERT INTO guest_units (id, event_id, name, party_limit, token_hash, created_at)
      VALUES (1, 1, 'Historical household', 4, '${sha256(token)}', '2026-01-02');
  `);
  legacyDb.close();

  const app = createApp({ dbPath });
  const baseUrl = await new Promise((resolve) => {
    app.server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${app.server.address().port}`));
  });
  t.after(async () => {
    await new Promise((resolve) => app.server.close(resolve));
    fs.rmSync(directory, { recursive: true, force: true });
  });

  const register = await request(baseUrl, '/api/auth/register', {
    method: 'POST',
    body: JSON.stringify({ email: 'legacy-host@example.test', password: 'synthetic-test-password' })
  });
  assert.equal(register.status, 200);
  const cookie = register.headers.get('set-cookie').split(';', 1)[0];

  const dashboard = await request(baseUrl, '/api/events/1/dashboard', {}, cookie);
  assert.equal(dashboard.status, 200);
  assert.equal((await dashboard.json()).guests[0].email, null);

  const publish = await request(baseUrl, '/api/events/1/publish', { method: 'POST', body: '{}' }, cookie);
  assert.equal(publish.status, 200);
  const guestView = await request(baseUrl, `/api/guest/${token}`);
  assert.equal(guestView.status, 200);
  const rsvp = await request(baseUrl, `/api/guest/${token}/rsvp`, {
    method: 'PUT', body: JSON.stringify({ answer: 'yes', partySize: 2 })
  });
  assert.equal(rsvp.status, 200);

  const link = await request(baseUrl, '/api/guests/1/invite-link', {}, cookie);
  assert.equal(link.status, 404);
  const csv = await request(baseUrl, '/api/events/1/export', {}, cookie);
  assert.equal(csv.status, 200);
  assert.match(await csv.text(), /"Historical household","","yes","2"/);

  const single = await request(baseUrl, '/api/events/1/guests', {
    method: 'POST', body: JSON.stringify({ name: 'New guest', email: 'new@example.test', partyLimit: 2 })
  }, cookie);
  assert.equal(single.status, 201);
  const singleData = await single.json();
  const newLink = await request(baseUrl, `/api/guests/${singleData.guest.id}/invite-link`, {}, cookie);
  assert.equal(newLink.status, 200);
  assert.equal((await newLink.json()).inviteUrl, singleData.inviteUrl);

  const bulk = await request(baseUrl, '/api/events/1/guests/bulk', {
    method: 'POST', body: JSON.stringify({ guests: [
      { name: 'Bulk guest', email: 'bulk@example.test', partyLimit: 2 }
    ] })
  }, cookie);
  assert.equal(bulk.status, 201);
});