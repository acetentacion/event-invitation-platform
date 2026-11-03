'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createApp } = require('../server');

async function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'gatherly-v01-'));
  const dbPath = path.join(directory, 'test.sqlite');
  let app = createApp({ dbPath });
  let cookie = '';

  const start = () => new Promise((resolve) => {
    app.server.listen(0, '127.0.0.1', () => {
      resolve(`http://127.0.0.1:${app.server.address().port}`);
    });
  });
  let baseUrl = await start();

  async function request(url, options = {}) {
    const headers = { ...(options.headers || {}) };
    if (cookie) headers.Cookie = cookie;
    if (options.body && !headers['Content-Type']) headers['Content-Type'] = 'application/json';
    const response = await fetch(`${baseUrl}${url}`, { ...options, headers });
    const setCookie = response.headers.get('set-cookie');
    if (setCookie) cookie = setCookie.split(';')[0];
    return { response, data: await response.json() };
  }

  async function authenticate() {
    const result = await request('/api/auth/register', {
      method: 'POST',
      body: JSON.stringify({
        email: 'host@example.test',
        password: 'synthetic-test-password'
      })
    });
    assert.equal(result.response.status, 200, JSON.stringify(result.data));
  }

  async function restart() {
    await new Promise((resolve, reject) => {
      app.server.close((error) => error ? reject(error) : resolve());
    });
    app = createApp({ dbPath });
    baseUrl = await start();
  }

  t.after(async () => {
    if (app.server.listening) {
      await new Promise((resolve) => app.server.close(() => resolve()));
    }
    fs.rmSync(directory, { recursive: true, force: true });
  });
  return { request, authenticate, restart };
}

test('host to household guest RSVP and revised persisted totals', async (t) => {
  const f = await fixture(t);
  await f.authenticate();

  const secondHost = await f.request('/api/auth/register', {
    method: 'POST',
    body: JSON.stringify({
      email: 'another@example.test',
      password: 'synthetic-test-password'
    })
  });
  assert.equal(secondHost.response.status, 409);

  const createdEvent = await f.request('/api/events', {
    method: 'POST',
    body: JSON.stringify({
      title: 'Synthetic Family Picnic',
      eventDate: '2035-06-15',
      location: 'Sample Park',
      guestMode: 'household',
      rsvpDeadline: new Date(Date.now() + 60 * 60 * 1000).toISOString()
    })
  });
  assert.equal(createdEvent.response.status, 201, JSON.stringify(createdEvent.data));
  const eventId = createdEvent.data.event.id;
  const createdGuest = await f.request(`/api/events/${eventId}/guests`, {
    method: 'POST',
    body: JSON.stringify({
      name: 'Sample Household',
      email: 'family@example.test',
      partyLimit: 4
    })
  });
  assert.equal(createdGuest.response.status, 201, JSON.stringify(createdGuest.data));
  assert.equal(createdGuest.data.guest.partyLimit, 4);
  assert.match(createdGuest.data.inviteUrl, /^\/rsvp\/[A-Za-z0-9_-]{40,50}$/);
  const token = createdGuest.data.inviteUrl.split('/').pop();

  const view = await f.request(`/api/guest/${token}`);
  assert.equal(view.response.status, 200);
  assert.equal(view.data.canRespond, true);
  const overLimit = await f.request(`/api/guest/${token}/rsvp`, {
    method: 'PUT',
    body: JSON.stringify({ answer: 'yes', partySize: 5 })
  });
  assert.equal(overLimit.response.status, 400);

  const submitted = await f.request(`/api/guest/${token}/rsvp`, {
    method: 'PUT',
    body: JSON.stringify({ answer: 'yes', partySize: 3 })
  });
  assert.equal(submitted.response.status, 200);
  const revised = await f.request(`/api/guest/${token}/rsvp`, {
    method: 'PUT',
    body: JSON.stringify({ answer: 'yes', partySize: 2 })
  });
  assert.equal(revised.response.status, 200);

  const dashboard = await f.request(`/api/events/${eventId}/dashboard`);
  assert.equal(dashboard.response.status, 200);
  assert.equal(dashboard.data.guests.length, 1);
  assert.equal(dashboard.data.guests[0].partySize, 2);
  const events = await f.request('/api/events');
  assert.equal(events.data.events[0].yesUnits, 1);
  assert.equal(events.data.events[0].attendingPeople, 2);
  assert.equal((await f.request('/api/outbox')).data.messages.length, 1);

  await f.restart();
  const afterRestart = await f.request(`/api/events/${eventId}/dashboard`);
  assert.equal(afterRestart.response.status, 200);
  assert.equal(afterRestart.data.guests[0].answer, 'yes');
  assert.equal(afterRestart.data.guests[0].partySize, 2);
});

test('server deadline closure, host reopen, and manual close are enforced', async (t) => {
  const f = await fixture(t);
  await f.authenticate();
  const event = await f.request('/api/events', {
    method: 'POST',
    body: JSON.stringify({
      title: 'Past Deadline Test',
      eventDate: '2035-01-01',
      guestMode: 'individual',
      rsvpDeadline: new Date(Date.now() - 60_000).toISOString()
    })
  });
  const eventId = event.data.event.id;
  const guest = await f.request(`/api/events/${eventId}/guests`, {
    method: 'POST',
    body: JSON.stringify({ name: 'Sample Guest', email: 'guest@example.test' })
  });
  const token = guest.data.inviteUrl.split('/').pop();

  assert.equal((await f.request(`/api/guest/${token}`)).data.canRespond, false);
  assert.equal((await f.request(`/api/guest/${token}/rsvp`, {
    method: 'PUT', body: JSON.stringify({ answer: 'yes', partySize: 1 })
  })).response.status, 409);

  const reopen = await f.request(`/api/events/${eventId}/responses`, {
    method: 'POST', body: JSON.stringify({ open: true })
  });
  assert.equal(reopen.response.status, 200);
  assert.equal((await f.request(`/api/guest/${token}`)).data.canRespond, true);
  assert.equal((await f.request(`/api/guest/${token}/rsvp`, {
    method: 'PUT', body: JSON.stringify({ answer: 'yes', partySize: 1 })
  })).response.status, 200);

  await f.request(`/api/events/${eventId}/responses`, {
    method: 'POST', body: JSON.stringify({ open: false })
  });
  assert.equal((await f.request(`/api/guest/${token}`)).data.canRespond, false);
  assert.equal((await f.request(`/api/guest/${token}/rsvp`, {
    method: 'PUT', body: JSON.stringify({ answer: 'no', partySize: 0 })
  })).response.status, 409);
});

test('individual guest party limits and link revocation are enforced', async (t) => {
  const f = await fixture(t);
  await f.authenticate();
  const event = await f.request('/api/events', {
    method: 'POST',
    body: JSON.stringify({
      title: 'Individual Unit Test',
      eventDate: '2035-02-02',
      guestMode: 'individual'
    })
  });
  const guest = await f.request(`/api/events/${event.data.event.id}/guests`, {
    method: 'POST',
    body: JSON.stringify({
      name: 'Solo Guest', email: 'solo@example.test', partyLimit: 6
    })
  });
  assert.equal(guest.data.guest.partyLimit, 1);
  const token = guest.data.inviteUrl.split('/').pop();
  const invalidParty = await f.request(`/api/guest/${token}/rsvp`, {
    method: 'PUT',
    body: JSON.stringify({ answer: 'yes', partySize: 2 })
  });
  assert.equal(invalidParty.response.status, 400);
  const revoked = await f.request(`/api/guests/${guest.data.guest.id}/revoke`, {
    method: 'POST', body: '{}'
  });
  assert.equal(revoked.response.status, 200);
  assert.equal((await f.request(`/api/guest/${token}`)).response.status, 404);
});
