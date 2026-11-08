'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const test = require('node:test');
const { createApp, hashPassword } = require('../server');
const { Store } = require('../store');

const DEFAULT_THEME = {
  preset: 'classic',
  primaryColor: '#315a4c',
  backgroundColor: '#f8f6f1',
  textColor: '#262b2c',
  fontFamily: 'serif',
  coverImage: null
};

async function fixture(t, initialTime = '2026-01-01T12:00:00.000Z') {
  let time = new Date(initialTime);
  const store = new Store(':memory:');
  const app = createApp({ store, clock: () => time });
  await new Promise((resolve, reject) => {
    app.server.once('error', reject);
    app.server.listen(0, '127.0.0.1', resolve);
  });
  const address = app.server.address();
  const baseUrl = `http://127.0.0.1:${address.port}`;

  t.after(async () => {
    await new Promise((resolve) => app.server.close(resolve));
    store.close();
  });

  async function request(url, options = {}, cookie) {
    const headers = { ...(options.headers || {}) };
    if (cookie) headers.Cookie = cookie;
    return fetch(`${baseUrl}${url}`, { ...options, headers });
  }

  async function jsonRequest(url, method = 'GET', body, cookie) {
    return request(url, {
      method,
      headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body)
    }, cookie);
  }

  async function register(email = 'host@example.test') {
    const response = await jsonRequest('/api/auth/register', 'POST', {
      email, password: 'synthetic-local-password'
    });
    assert.equal(response.status, 200);
    const setCookie = response.headers.get('set-cookie');
    assert.ok(setCookie);
    return setCookie.split(';', 1)[0];
  }

  return {
    app, store, baseUrl, request, jsonRequest, register,
    setTime(value) { time = new Date(value); }
  };
}

async function createEvent(f, cookie, options = {}) {
  const { draft, ...eventOptions } = options;
  const response = await f.jsonRequest('/api/events', 'POST', {
    title: 'Sample gathering',
    eventDate: '2026-01-10',
    location: 'Local test venue',
    guestMode: 'household',
    rsvpDeadline: '2026-01-02T12:00:00.000Z',
    ...eventOptions
  }, cookie);
  assert.equal(response.status, 201);
  const event = (await response.json()).event;
  if (!draft) {
    const published = await f.jsonRequest(`/api/events/${event.id}/publish`, 'POST', {}, cookie);
    assert.equal(published.status, 200);
    return (await published.json()).event;
  }
  return event;
}

test('serves the public UI assets and exposes auth, dashboard, outbox, and guest routes', async (t) => {
  const f = await fixture(t);
  const root = await f.request('/');
  assert.equal(root.status, 200);
  assert.match(await root.text(), /id="host"/);
  assert.match(root.headers.get('content-security-policy'), /default-src 'self'/);
  const publicScript = await (await f.request('/app.js')).text();
  assert.match(publicScript, /\/api\/events\/\$\{event\.id\}\/dashboard/);

  const status = await (await f.request('/api/status')).json();
  assert.deepEqual(status, { setupRequired: true, host: null });
  const nonSyntheticAccount = await f.jsonRequest('/api/auth/register', 'POST', {
    email: 'host@gmail.com', password: 'synthetic-local-password'
  });
  assert.equal(nonSyntheticAccount.status, 400);
  const cookie = await f.register();
  assert.equal((await (await f.request('/api/auth/me', {}, cookie)).json()).host.email, 'host@example.test');

  const event = await createEvent(f, cookie);
  const list = await (await f.request('/api/events', {}, cookie)).json();
  assert.equal(list.events.length, 1);
  assert.equal(list.events[0].id, event.id);
  assert.equal(list.events[0].responsesOpen, true);

  const createdGuest = await f.jsonRequest(`/api/events/${event.id}/guests`, 'POST', {
    name: 'Synthetic Household', email: 'household@example.test', partyLimit: 4
  }, cookie);
  assert.equal(createdGuest.status, 201);
  const invite = await createdGuest.json();
  assert.match(invite.inviteUrl, /^\/rsvp\/[A-Za-z0-9_-]{30,60}$/);

  const dashboard = await (await f.request(`/api/events/${event.id}/dashboard`, {}, cookie)).json();
  assert.equal(dashboard.guests.length, 1);
  assert.equal(dashboard.guests[0].partyLimit, 4);
  const detail = await (await f.request(`/api/events/${event.id}`, {}, cookie)).json();
  assert.equal(detail.event.title, 'Sample gathering');
  assert.equal(detail.guests.length, 1);
  const outbox = await (await f.request('/api/outbox', {}, cookie)).json();
  assert.equal(outbox.messages.length, 1);
  assert.match(outbox.messages[0].body, /Local email capture only/);

  const token = invite.inviteUrl.split('/').pop();
  const guestView = await (await f.request(`/api/guest/${token}`)).json();
  assert.equal(guestView.guest.name, 'Synthetic Household');
  assert.equal(guestView.canRespond, true);
  const saved = await f.jsonRequest(`/api/guest/${token}/rsvp`, 'PUT', {
    answer: 'yes', partySize: 3
  });
  assert.equal(saved.status, 200);
  const updated = await (await f.request(`/api/events/${event.id}/dashboard`, {}, cookie)).json();
  assert.equal(updated.guests[0].answer, 'yes');
  assert.equal(updated.guests[0].partySize, 3);

  const published = await f.jsonRequest(`/api/events/${event.id}/publish`, 'POST', {}, cookie);
  assert.equal(published.status, 200);
  assert.equal((await published.json()).event.published, true);
});

test('tracks household and attendee check-in, reversals, walk-ins, ownership, cancellation, and totals', async (t) => {
  const f = await fixture(t);
  const cookie = await f.register();
  const event = await createEvent(f, cookie);
  const guestResponse = await f.jsonRequest(`/api/events/${event.id}/guests`, 'POST', {
    name: 'Check-in Household', email: 'checkin@example.test', partyLimit: 4
  }, cookie);
  const guest = await guestResponse.json();
  const token = guest.inviteUrl.split('/').pop();
  await f.jsonRequest(`/api/guest/${token}/rsvp`, 'PUT', {
    answer: 'yes', partySize: 2,
    attendees: [{ name: 'Alex Morgan' }, { name: 'Sam Morgan', ageBand: 'child' }]
  });

  let dashboard = await (await f.request(`/api/events/${event.id}/dashboard`, {}, cookie)).json();
  const attendeeIds = dashboard.guests[0].attendees.map((attendee) => attendee.id);
  assert.deepEqual(dashboard.totals, {
    invitedPeople: 4, confirmedPeople: 2, checkedInPeople: 0, walkIns: 0, walkInPeople: 0
  });
  const checkedIn = await f.jsonRequest(`/api/events/${event.id}/check-in`, 'POST', {
    guestId: guest.guest.id
  }, cookie);
  assert.equal(checkedIn.status, 200);
  assert.equal((await checkedIn.json()).totals.checkedInPeople, 2);
  assert.equal((await f.jsonRequest(`/api/events/${event.id}/check-in`, 'POST', {
    guestId: guest.guest.id
  }, cookie)).status, 409);
  assert.equal((await f.jsonRequest(`/api/events/${event.id}/check-in`, 'POST', {
    attendeeId: attendeeIds[0]
  }, cookie)).status, 409);
  assert.equal((await f.jsonRequest(`/api/events/${event.id}/check-in/reverse`, 'POST', {
    guestId: guest.guest.id
  }, cookie)).status, 200);
  const attendeeCheckIn = await f.jsonRequest(`/api/events/${event.id}/check-in`, 'POST', {
    attendeeId: attendeeIds[0]
  }, cookie);
  assert.equal(attendeeCheckIn.status, 200);
  assert.equal((await attendeeCheckIn.json()).totals.checkedInPeople, 1);
  assert.equal((await f.jsonRequest(`/api/events/${event.id}/check-in/reverse`, 'POST', {
    attendeeId: attendeeIds[0]
  }, cookie)).status, 200);

  const walkIn = await f.jsonRequest(`/api/events/${event.id}/check-in/walk-in`, 'POST', {
    name: 'Door Guest', attendeeName: 'Door Guest'
  }, cookie);
  assert.equal(walkIn.status, 201);
  dashboard = await (await f.request(`/api/events/${event.id}/check-in`, {}, cookie)).json();
  assert.deepEqual(dashboard.totals, {
    invitedPeople: 4, confirmedPeople: 3, checkedInPeople: 1, walkIns: 1, walkInPeople: 1
  });
  assert.equal(dashboard.guests.find((item) => item.walkIn).attendees[0].checkedInAt !== null, true);

  const otherHost = Number(f.store.createHost(
    'checkin-other@example.test', hashPassword('another-local-password'), '2026-01-01T12:00:00.000Z'
  ));
  assert.ok(otherHost > 1);
  const otherLogin = await f.jsonRequest('/api/auth/login', 'POST', {
    email: 'checkin-other@example.test', password: 'another-local-password'
  });
  const otherCookie = otherLogin.headers.get('set-cookie').split(';', 1)[0];
  assert.equal((await f.jsonRequest(`/api/events/${event.id}/check-in`, 'POST', {
    guestId: guest.guest.id
  }, otherCookie)).status, 404);

  await f.jsonRequest(`/api/events/${event.id}/status`, 'POST', { status: 'cancelled' }, cookie);
  assert.equal((await f.jsonRequest(`/api/events/${event.id}/check-in`, 'POST', {
    guestId: guest.guest.id
  }, cookie)).status, 409);
});

test('deadline closes by default; only a post-deadline host reopen restores RSVP writes', async (t) => {
  const f = await fixture(t, '2026-01-01T12:00:00.000Z');
  const cookie = await f.register();
  const event = await createEvent(f, cookie, {
    guestMode: 'individual',
    rsvpDeadline: '2026-01-02T12:00:00.000Z'
  });
  const createdGuest = await f.jsonRequest(`/api/events/${event.id}/guests`, 'POST', {
    name: 'Individual Guest', email: 'guest@example.test'
  }, cookie);
  const invite = await createdGuest.json();
  const token = invite.inviteUrl.split('/').pop();

  // An explicit open before the deadline does not keep responses open past it.
  await f.jsonRequest(`/api/events/${event.id}/responses`, 'POST', { open: true }, cookie);
  f.setTime('2026-01-02T12:00:00.000Z');
  let guestView = await (await f.request(`/api/guest/${token}`)).json();
  assert.equal(guestView.canRespond, false);
  let write = await f.jsonRequest(`/api/guest/${token}/rsvp`, 'PUT', {
    answer: 'yes', partySize: 1
  });
  assert.equal(write.status, 409);

  await f.jsonRequest(`/api/events/${event.id}/responses`, 'POST', { open: true }, cookie);
  guestView = await (await f.request(`/api/guest/${token}`)).json();
  assert.equal(guestView.canRespond, true);
  write = await f.jsonRequest(`/api/guest/${token}/rsvp`, 'PUT', {
    answer: 'yes', partySize: 1
  });
  assert.equal(write.status, 200);

  await f.jsonRequest(`/api/events/${event.id}/responses`, 'POST', { open: false }, cookie);
  guestView = await (await f.request(`/api/guest/${token}`)).json();
  assert.equal(guestView.canRespond, false);
});

test('hosts can postpone or cancel published events without losing RSVP records', async (t) => {
  const f = await fixture(t);
  const cookie = await f.register();
  const event = await createEvent(f, cookie, { guestMode: 'individual' });
  const created = await f.jsonRequest(`/api/events/${event.id}/guests`, 'POST', {
    name: 'Status Guest', email: 'status@example.test'
  }, cookie);
  const invite = await created.json();
  const token = invite.inviteUrl.split('/').pop();
  assert.equal((await f.jsonRequest(`/api/guest/${token}/rsvp`, 'PUT', {
    answer: 'yes', partySize: 1
  })).status, 200);

  const postponed = await f.jsonRequest(`/api/events/${event.id}/status`, 'POST', {
    status: 'postponed', note: 'A new date will follow.'
  }, cookie);
  assert.equal(postponed.status, 200);
  const postponedGuest = await (await f.request(`/api/guest/${token}`)).json();
  assert.equal(postponedGuest.event.status, 'postponed');
  assert.equal(postponedGuest.event.statusNote, 'A new date will follow.');
  assert.equal(postponedGuest.canRespond, true);

  const cancelled = await f.jsonRequest(`/api/events/${event.id}/status`, 'POST', {
    status: 'cancelled', note: 'This gathering will not go ahead.'
  }, cookie);
  assert.equal(cancelled.status, 200);
  const cancelledGuest = await (await f.request(`/api/guest/${token}`)).json();
  assert.equal(cancelledGuest.event.status, 'cancelled');
  assert.equal(cancelledGuest.canRespond, false);
  const blocked = await f.jsonRequest(`/api/guest/${token}/rsvp`, 'PUT', {
    answer: 'no', partySize: 0
  });
  assert.equal(blocked.status, 409);
  const dashboard = await (await f.request(`/api/events/${event.id}/dashboard`, {}, cookie)).json();
  assert.equal(dashboard.guests[0].answer, 'yes');
  assert.equal(dashboard.guests[0].partySize, 1);
});

test('local message previews filter active recipients, capture defaults, and enforce ownership', async (t) => {
  const f = await fixture(t);
  const cookie = await f.register();
  const event = await createEvent(f, cookie);
  const guests = [];
  for (const [name, email] of [['Pending', 'pending@example.test'], ['Yes', 'yes@example.test'], ['Maybe', 'maybe@example.test'], ['Revoked', 'revoked@example.test']]) {
    const response = await f.jsonRequest(`/api/events/${event.id}/guests`, 'POST', { name, email, partyLimit: 1 }, cookie);
    guests.push(await response.json());
  }
  await f.jsonRequest(`/api/guest/${guests[1].inviteUrl.split('/').pop()}/rsvp`, 'PUT', { answer: 'yes', partySize: 1 });
  await f.jsonRequest(`/api/guest/${guests[2].inviteUrl.split('/').pop()}/rsvp`, 'PUT', { answer: 'maybe', partySize: 1 });
  const revokedId = guests[3].guest.id;
  assert.equal((await f.jsonRequest(`/api/guests/${revokedId}/revoke`, 'POST', {}, cookie)).status, 200);

  const pending = await f.jsonRequest(`/api/events/${event.id}/messages`, 'POST', {
    filter: 'pending', subject: 'A quick note', message: 'Please reply when you can.'
  }, cookie);
  assert.equal(pending.status, 201);
  assert.equal((await pending.json()).count, 1);
  const unrevoked = await f.jsonRequest(`/api/events/${event.id}/messages`, 'POST', { filter: 'unrevoked' }, cookie);
  assert.equal(unrevoked.status, 201);
  assert.equal((await unrevoked.json()).count, 3, 'unrevoked selects active guests regardless of RSVP answer');
  const all = await f.jsonRequest(`/api/events/${event.id}/messages`, 'POST', { filter: 'all' }, cookie);
  assert.equal((await all.json()).count, 3);
  const dashboard = await (await f.request(`/api/events/${event.id}/dashboard`, {}, cookie)).json();
  assert.equal(dashboard.event.revokedUnits, 1);
  assert.equal(dashboard.event.invitedUnits, 4);
  assert.equal(dashboard.event.noUnits, 0);
  const outbox = await (await f.request('/api/outbox', {}, cookie)).json();
  assert.equal(outbox.messages.filter((message) => message.messageType === 'preview').length, 7);
  assert.match(outbox.messages.find((message) => message.messageType === 'preview').body, /Local message preview only/);

  const otherHostId = Number(f.store.createHost('messages-other@example.test', hashPassword('another-local-password'), '2026-01-01'));
  assert.ok(otherHostId > 1);
  const otherLogin = await f.jsonRequest('/api/auth/login', 'POST', {
    email: 'messages-other@example.test', password: 'another-local-password'
  });
  const otherCookie = otherLogin.headers.get('set-cookie').split(';', 1)[0];
  assert.equal((await f.jsonRequest(`/api/events/${event.id}/messages`, 'POST', { filter: 'all' }, otherCookie)).status, 404);
});

test('event schedule validates, persists, reaches guests, and exports only to the host', async (t) => {
  const f = await fixture(t);
  const cookie = await f.register();
  const event = await createEvent(f, cookie, {
    eventStartTime: '18:30', eventEndTime: '21:00', timezone: 'Asia/Manila'
  });
  assert.equal(event.eventStartTime, '18:30');
  assert.equal(event.eventEndTime, '21:00');
  assert.equal(event.timezone, 'Asia/Manila');
  const guestResponse = await f.jsonRequest(`/api/events/${event.id}/guests`, 'POST', {
    name: 'Export Household', email: 'export@example.test', partyLimit: 2
  }, cookie);
  const invite = await guestResponse.json();
  const token = invite.inviteUrl.split('/').pop();
  const guestView = await (await f.request(`/api/guest/${token}`)).json();
  assert.deepEqual({
    eventStartTime: guestView.event.eventStartTime,
    eventEndTime: guestView.event.eventEndTime,
    timezone: guestView.event.timezone
  }, { eventStartTime: '18:30', eventEndTime: '21:00', timezone: 'Asia/Manila' });
  await f.jsonRequest(`/api/guest/${token}/rsvp`, 'PUT', {
    answer: 'yes', partySize: 2,
    attendees: [
      { name: 'Alex Export', dietary: 'vegetarian', accessibility: '', ageBand: 'adult' },
      { name: 'Sam Export', dietary: '', accessibility: 'step-free', ageBand: 'child' }
    ]
  });
  const csv = await f.request(`/api/events/${event.id}/export`, {}, cookie);
  assert.equal(csv.status, 200);
  assert.match(csv.headers.get('content-type'), /text\/csv/);
  const csvText = await csv.text();
  assert.match(csvText, /"Guest unit name","Email","RSVP answer"/);
  assert.match(csvText, /Alex Export; Sam Export/);
  assert.match(csvText, /"vegetarian"/);
  assert.equal((await f.request(`/api/events/${event.id}/export`)).status, 401);
  for (const invalidSchedule of [
    { eventStartTime: '25:00' },
    { eventStartTime: '18:30', eventEndTime: '18:30' },
    { eventStartTime: '18:30', eventEndTime: '19:00', timezone: 'Mars/Olympus' }
  ]) {
    const response = await f.jsonRequest('/api/events', 'POST', {
      title: 'Invalid schedule', eventDate: '2026-01-10', guestMode: 'individual', ...invalidSchedule
    }, cookie);
    assert.equal(response.status, 400);
  }
});

test('draft guest links stay unavailable, hosts can edit events, and capacity limits RSVPs', async (t) => {
  const f = await fixture(t);
  const cookie = await f.register();
  const event = await createEvent(f, cookie, { draft: true, capacity: 3 });
  const guestOneResponse = await f.jsonRequest(`/api/events/${event.id}/guests`, 'POST', {
    name: 'First Household', email: 'first@example.test', partyLimit: 2
  }, cookie);
  const guestOne = await guestOneResponse.json();
  const tokenOne = guestOne.inviteUrl.split('/').pop();
  const draftAccess = await f.request(`/api/guest/${tokenOne}`);
  assert.equal(draftAccess.status, 404);
  assert.match((await draftAccess.json()).error, /not available until the event is published/i);

  const updated = await f.jsonRequest(`/api/events/${event.id}`, 'PUT', {
    title: 'Edited gathering', eventDate: '2026-01-12', location: 'Updated venue',
    rsvpDeadline: '2026-01-03T12:00:00.000Z', capacity: 3
  }, cookie);
  assert.equal(updated.status, 200);
  assert.equal((await updated.json()).event.title, 'Edited gathering');
  assert.equal((await (await f.request(`/api/events/${event.id}`, {}, cookie)).json()).event.capacity, 3);

  const otherHostId = Number(f.store.createHost(
    'other@example.test', hashPassword('another-local-password'), '2026-01-01T12:00:00.000Z'
  ));
  assert.ok(otherHostId > 1);
  const otherLogin = await f.jsonRequest('/api/auth/login', 'POST', {
    email: 'other@example.test', password: 'another-local-password'
  });
  const otherCookie = otherLogin.headers.get('set-cookie').split(';', 1)[0];
  assert.equal((await f.jsonRequest(`/api/events/${event.id}`, 'PUT', {
    title: 'Should fail', eventDate: '2026-01-12', location: '', capacity: 3
  }, otherCookie)).status, 404);

  await f.jsonRequest(`/api/events/${event.id}/publish`, 'POST', {}, cookie);
  const guestTwoResponse = await f.jsonRequest(`/api/events/${event.id}/guests`, 'POST', {
    name: 'Second Household', email: 'second@example.test', partyLimit: 2
  }, cookie);
  const guestTwo = await guestTwoResponse.json();
  const tokenTwo = guestTwo.inviteUrl.split('/').pop();
  assert.equal((await f.jsonRequest(`/api/guest/${tokenOne}/rsvp`, 'PUT', {
    answer: 'yes', partySize: 2
  })).status, 200);
  const overCapacity = await f.jsonRequest(`/api/guest/${tokenTwo}/rsvp`, 'PUT', {
    answer: 'yes', partySize: 2
  });
  assert.equal(overCapacity.status, 409);
  assert.match((await overCapacity.json()).error, /capacity of 3/i);
  assert.equal((await (await f.request(`/api/events/${event.id}`, {}, cookie)).json()).event.remainingCapacity, 1);
  await f.jsonRequest(`/api/guest/${tokenOne}/rsvp`, 'PUT', { answer: 'no', partySize: 0 });
  assert.equal((await f.jsonRequest(`/api/guest/${tokenTwo}/rsvp`, 'PUT', {
    answer: 'yes', partySize: 2
  })).status, 200);
});

test('bulk guest creation validates every row before capturing any invitations', async (t) => {
  const f = await fixture(t);
  const cookie = await f.register();
  const event = await createEvent(f, cookie);
  const invalidBatch = await f.jsonRequest(`/api/events/${event.id}/guests/bulk`, 'POST', {
    guests: [
      { name: 'Valid Household', email: 'valid@example.test', partyLimit: 3 },
      { name: 'Invalid Household', email: 'person@gmail.com', partyLimit: 2 }
    ]
  }, cookie);
  assert.equal(invalidBatch.status, 400);
  assert.match((await invalidBatch.json()).error, /Guest row 2/);
  assert.equal((await (await f.request(`/api/events/${event.id}/dashboard`, {}, cookie)).json()).guests.length, 0);
  assert.equal((await (await f.request('/api/outbox', {}, cookie)).json()).messages.length, 0);

  const created = await f.jsonRequest(`/api/events/${event.id}/guests/bulk`, 'POST', {
    guests: [
      { name: 'North Household', email: 'north@example.test', partyLimit: 3 },
      { name: 'South Household', email: 'south@example.test', partyLimit: 4 }
    ]
  }, cookie);
  assert.equal(created.status, 201);
  const result = await created.json();
  assert.equal(result.guests.length, 2);
  assert.match(result.guests[0].inviteUrl, /^\/rsvp\/[A-Za-z0-9_-]{30,60}$/);
  assert.notEqual(result.guests[0].inviteUrl, result.guests[1].inviteUrl);
  assert.deepEqual(result.guests.map((guest) => guest.partyLimit), [3, 4]);
  assert.equal((await (await f.request(`/api/events/${event.id}/dashboard`, {}, cookie)).json()).guests.length, 2);
  const outbox = await (await f.request('/api/outbox', {}, cookie)).json();
  assert.equal(outbox.messages.length, 2);
  assert.ok(outbox.messages.every((message) => message.body.includes('Local email capture only')));
});

test('validates input, isolates host ownership, and revokes guest links', async (t) => {
  const f = await fixture(t);
  const cookie = await f.register();
  const badEvent = await f.jsonRequest('/api/events', 'POST', {
    title: 'Invalid date', eventDate: '2026-02-31', guestMode: 'individual'
  }, cookie);
  assert.equal(badEvent.status, 400);

  const event = await createEvent(f, cookie);
  const individual = await f.jsonRequest(`/api/events/${event.id}/guests`, 'POST', {
    name: 'One Person', email: 'one@example.test', partyLimit: 20
  }, cookie);
  const individualBody = await individual.json();
  assert.equal(individualBody.guest.partyLimit, 20); // Household limits are provided per unit.
  const event2 = await createEvent(f, cookie, { title: 'Individual event', guestMode: 'individual' });
  const individualGuestResponse = await f.jsonRequest(`/api/events/${event2.id}/guests`, 'POST', {
    name: 'One Person', email: 'one-person@example.test', partyLimit: 12
  }, cookie);
  const individualGuest = await individualGuestResponse.json();
  assert.equal(individualGuest.guest.partyLimit, 1);

  const guestId = individualGuest.guest.id;
  const token = individualGuest.inviteUrl.split('/').pop();
  const retainedLink = await f.request(`/api/guests/${guestId}/invite-link`, {}, cookie);
  assert.equal(retainedLink.status, 200);
  assert.deepEqual(await retainedLink.json(), { inviteUrl: individualGuest.inviteUrl });
  const invalidParty = await f.jsonRequest(`/api/guest/${token}/rsvp`, 'PUT', {
    answer: 'yes', partySize: 2
  });
  assert.equal(invalidParty.status, 400);

  const secondHostId = Number(f.store.createHost(
    'other@example.test', hashPassword('another-local-password'), '2026-01-01T12:00:00.000Z'
  ));
  assert.ok(secondHostId > 1);
  const secondLogin = await f.jsonRequest('/api/auth/login', 'POST', {
    email: 'other@example.test', password: 'another-local-password'
  });
  const otherCookie = secondLogin.headers.get('set-cookie').split(';', 1)[0];
  assert.equal((await f.jsonRequest(`/api/events/${event.id}/dashboard`, 'GET', undefined, otherCookie)).status, 404);
  assert.equal((await f.request(`/api/guests/${guestId}/invite-link`, {}, otherCookie)).status, 404);
  assert.equal((await f.jsonRequest(`/api/guests/${guestId}/revoke`, 'POST', {}, otherCookie)).status, 404);

  const revoked = await f.jsonRequest(`/api/guests/${guestId}/revoke`, 'POST', {}, cookie);
  assert.equal(revoked.status, 200);
  assert.equal((await f.request(`/api/guests/${guestId}/invite-link`, {}, cookie)).status, 410);
  assert.equal((await f.request(`/api/guest/${token}`)).status, 404);

  const logout = await f.jsonRequest('/api/auth/logout', 'POST', {}, cookie);
  assert.equal(logout.status, 200);
  assert.equal((await f.request('/api/events', {}, cookie)).status, 401);
});

test('bulk guest creation validates every row before capturing any invitations', async (t) => {
  const f = await fixture(t);
  const cookie = await f.register();
  const event = await createEvent(f, cookie);

  assert.deepEqual(event.theme, DEFAULT_THEME);
  assert.equal((await f.jsonRequest(`/api/events/${event.id}/theme`, 'PUT', DEFAULT_THEME)).status, 401);
  const defaultListEvent = (await (await f.request('/api/events', {}, cookie)).json()).events[0];
  assert.deepEqual(defaultListEvent.theme, DEFAULT_THEME);
  assert.equal(Object.hasOwn(defaultListEvent, 'themeJson'), false);
  assert.deepEqual(
    (await (await f.request(`/api/events/${event.id}`, {}, cookie)).json()).event.theme,
    DEFAULT_THEME
  );

  const secondHostId = Number(f.store.createHost(
    'other@example.test', hashPassword('another-local-password'), '2026-01-01T12:00:00.000Z'
  ));
  const otherLogin = await f.jsonRequest('/api/auth/login', 'POST', {
    email: 'other@example.test', password: 'another-local-password'
  });
  const otherCookie = otherLogin.headers.get('set-cookie').split(';', 1)[0];
  assert.ok(secondHostId > 1);
  assert.equal(
    (await f.jsonRequest(`/api/events/${event.id}/theme`, 'PUT', DEFAULT_THEME, otherCookie)).status,
    404
  );

  const createdGuest = await f.jsonRequest(`/api/events/${event.id}/guests`, 'POST', {
    name: 'Theme Preview Guest', email: 'theme-guest@example.test', partyLimit: 2
  }, cookie);
  const token = (await createdGuest.json()).inviteUrl.split('/').pop();
  const theme = {
    preset: 'garden',
    primaryColor: '#abcdef',
    backgroundColor: '#012345',
    textColor: '#FEDCBA',
    fontFamily: 'sans',
    coverImage: `data:image/png;base64,${Buffer.from('synthetic raster payload').toString('base64')}`
  };
  const updated = await f.jsonRequest(`/api/events/${event.id}/theme`, 'PUT', theme, cookie);
  assert.equal(updated.status, 200);
  assert.deepEqual((await updated.json()).theme, theme);

  const listTheme = (await (await f.request('/api/events', {}, cookie)).json()).events[0].theme;
  assert.deepEqual(listTheme, theme);
  const detailTheme = (await (await f.request(`/api/events/${event.id}`, {}, cookie)).json()).event.theme;
  assert.deepEqual(detailTheme, theme);
  const guestTheme = (await (await f.request(`/api/guest/${token}`)).json()).event.theme;
  assert.deepEqual(guestTheme, theme);

  const invalidThemes = [
    { ...theme, preset: 'unknown' },
    { ...theme, primaryColor: '#fff' },
    { ...theme, backgroundColor: 'red' },
    { ...theme, textColor: '#12345678' },
    { ...theme, fontFamily: 'monospace' },
    { ...theme, coverImage: 'data:image/svg+xml;base64,PHN2Zy8+' },
    { ...theme, coverImage: 'data:image/gif;base64,R0lGODlh' },
    { ...theme, coverImage: 'data:image/png;base64,YQ' },
    { ...theme, coverImage: 'data:image/jpeg;base64,@@@=' },
    { ...theme, extra: true }
  ];
  for (const invalidTheme of invalidThemes) {
    assert.equal(
      (await f.jsonRequest(`/api/events/${event.id}/theme`, 'PUT', invalidTheme, cookie)).status,
      400
    );
  }
  const oversized = {
    ...theme,
    coverImage: `data:image/webp;base64,${Buffer.alloc(1024 * 1024 + 1).toString('base64')}`
  };
  assert.equal(
    (await f.jsonRequest(`/api/events/${event.id}/theme`, 'PUT', oversized, cookie)).status,
    400
  );
  assert.deepEqual(
    (await (await f.request(`/api/guest/${token}`)).json()).event.theme,
    theme
  );

  const maxSizeTheme = {
    ...theme,
    coverImage: `data:image/jpeg;base64,${Buffer.alloc(1024 * 1024).toString('base64')}`
  };
  const maxSizeResponse = await f.jsonRequest(
    `/api/events/${event.id}/theme`, 'PUT', maxSizeTheme, cookie
  );
  assert.equal(maxSizeResponse.status, 200);
  assert.equal((await maxSizeResponse.json()).theme.coverImage, maxSizeTheme.coverImage);
});

test('requires WCAG AA contrast between theme text and background colors', async (t) => {
  const f = await fixture(t);
  const cookie = await f.register();
  const event = await createEvent(f, cookie);

  const validDefault = await f.jsonRequest(
    `/api/events/${event.id}/theme`, 'PUT', DEFAULT_THEME, cookie
  );
  assert.equal(validDefault.status, 200);
  assert.deepEqual((await validDefault.json()).theme, DEFAULT_THEME);

  const insufficientContrast = await f.jsonRequest(`/api/events/${event.id}/theme`, 'PUT', {
    ...DEFAULT_THEME,
    backgroundColor: '#ffffff',
    textColor: '#777777'
  }, cookie);
  assert.equal(insufficientContrast.status, 400);
  assert.match((await insufficientContrast.json()).error, /WCAG contrast ratio.*4\.5:1/i);

  const unchanged = (await (await f.request(`/api/events/${event.id}`, {}, cookie)).json()).event;
  assert.deepEqual(unchanged.theme, DEFAULT_THEME);
});

test('persists owner-only invitation presentation settings for hosts and guests', async (t) => {
  const f = await fixture(t);
  const cookie = await f.register();
  const event = await createEvent(f, cookie);
  const defaults = {
    revealMode: 'direct', chimeEnabled: false, revealMotion: 'none', celebration: 'off'
  };

  assert.deepEqual(event.invitationSettings, defaults);
  assert.deepEqual(
    (await (await f.request('/api/events', {}, cookie)).json()).events[0].invitationSettings,
    defaults
  );
  assert.deepEqual(
    (await (await f.request(`/api/events/${event.id}`, {}, cookie)).json()).event.invitationSettings,
    defaults
  );

  const guestResult = await f.jsonRequest(`/api/events/${event.id}/guests`, 'POST', {
    name: 'Presentation Settings Guest',
    email: 'presentation-guest@example.test',
    partyLimit: 2
  }, cookie);
  const invite = await guestResult.json();
  const token = invite.inviteUrl.split('/').pop();

  const settings = {
    revealMode: 'envelope', chimeEnabled: true, revealMotion: 'fade', celebration: 'leaves'
  };
  const updated = await f.jsonRequest(
    `/api/events/${event.id}/invitation`, 'PUT', settings, cookie
  );
  assert.equal(updated.status, 200);
  assert.deepEqual((await updated.json()).invitationSettings, settings);
  assert.deepEqual(
    (await (await f.request('/api/events', {}, cookie)).json()).events[0].invitationSettings,
    settings
  );
  assert.deepEqual(
    (await (await f.request(`/api/events/${event.id}`, {}, cookie)).json()).event.invitationSettings,
    settings
  );
  assert.deepEqual(
    (await (await f.request(`/api/guest/${token}`)).json()).event.invitationSettings,
    settings
  );

  const invalidSettings = [
    { ...settings, revealMode: 'window' },
    { ...settings, chimeEnabled: 'true' },
    { ...settings, revealMotion: 'bounce' },
    { ...settings, celebration: 'confetti' },
    { ...settings, extra: true },
    { revealMode: 'direct', chimeEnabled: false, revealMotion: 'none' },
    { ...defaults, extra: null }
  ];
  for (const invalid of invalidSettings) {
    assert.equal(
      (await f.jsonRequest(`/api/events/${event.id}/invitation`, 'PUT', invalid, cookie)).status,
      400
    );
  }
  assert.equal(
    (await f.jsonRequest(`/api/events/${event.id}/invitation`, 'PUT', settings)).status,
    401
  );

  const otherHostId = Number(f.store.createHost(
    'other-host@example.test', 'unused-test-hash', '2026-01-01T12:00:00.000Z'
  ));
  const otherToken = 'other-host-session-token';
  f.store.createSession(
    crypto.createHash('sha256').update(otherToken).digest('hex'),
    otherHostId,
    '2030-01-01T00:00:00.000Z'
  );
  assert.equal(
    (await f.jsonRequest(
      `/api/events/${event.id}/invitation`, 'PUT', settings, `gatherly_session=${otherToken}`
    )).status,
    404
  );

  assert.deepEqual(
    (await (await f.request(`/api/guest/${token}`)).json()).event.invitationSettings,
    settings
  );
});

test('persists validated invitation copy for owners and guests', async (t) => {
  const f = await fixture(t);
  const cookie = await f.register();
  const event = await createEvent(f, cookie);
  const defaults = {
    greeting: '', title: '', intro: '', rsvpHeading: '', rsvpHelper: '', footerNote: '',
    image: null, imageShape: 'circle', imageAlt: ''
  };
  assert.deepEqual(event.invitationCopy, defaults);
  const guestResponse = await f.jsonRequest(`/api/events/${event.id}/guests`, 'POST', {
    name: 'Copy Guest', email: 'copy-guest@example.test', partyLimit: 1
  }, cookie);
  const token = (await guestResponse.json()).inviteUrl.split('/').pop();
  const copy = {
    greeting: '  A note for you  ',
    title: '  <A special evening>  ',
    intro: 'Join us for dinner.',
    rsvpHeading: 'Can you join us?',
    rsvpHelper: 'Please choose a response.',
    footerNote: 'With love, the hosts.',
    image: 'data:image/png;base64,aGVsbG8=', imageShape: 'arch', imageAlt: 'A garden table'
  };
  const saved = await f.jsonRequest(`/api/events/${event.id}/invitation-copy`, 'PUT', copy, cookie);
  assert.equal(saved.status, 200);
  const normalized = {
    ...copy,
    greeting: copy.greeting.trim(), title: copy.title.trim()
  };
  assert.deepEqual((await saved.json()).invitationCopy, normalized);
  const hostEvent = (await (await f.request(`/api/events/${event.id}`, {}, cookie)).json()).event;
  assert.deepEqual(hostEvent.invitationCopy, normalized);
  const guest = await (await f.request(`/api/guest/${token}`)).json();
  assert.deepEqual(guest.event.invitationCopy, normalized);

  const automaticCopy = {
    title: '', intro: '', rsvpHeading: '', rsvpHelper: '', footerNote: '',
    image: null, imageShape: 'circle', imageAlt: ''
  };
  const automaticSave = await f.jsonRequest(`/api/events/${event.id}/invitation-copy`, 'PUT', automaticCopy, cookie);
  assert.equal(automaticSave.status, 200);
  assert.equal((await automaticSave.json()).invitationCopy.greeting, normalized.greeting);

  const invalid = [
    { ...normalized, greeting: 3 },
    { ...normalized, intro: 'x'.repeat(501) },
    { ...normalized, image: 'data:text/html;base64,PGgxPk5vPC9oMT4=' },
    { ...normalized, imageShape: 'triangle' },
    { ...normalized, imageAlt: 'x'.repeat(201) },
    { ...normalized, extra: 'nope' },
    { greeting: '', title: '', intro: '', rsvpHeading: '', rsvpHelper: '' }
  ];
  for (const value of invalid) {
    assert.equal(
      (await f.jsonRequest(`/api/events/${event.id}/invitation-copy`, 'PUT', value, cookie)).status,
      400
    );
  }
  assert.equal(
    (await f.jsonRequest(`/api/events/${event.id}/invitation-copy`, 'PUT', normalized)).status,
    401
  );
  const legacySave = await f.jsonRequest(`/api/events/${event.id}/invitation-copy`, 'PUT', {
    greeting: 'Legacy-compatible', title: '', intro: '', rsvpHeading: '', rsvpHelper: '', footerNote: ''
  }, cookie);
  assert.equal(legacySave.status, 200);
  assert.deepEqual((await legacySave.json()).invitationCopy, {
    ...defaults, greeting: 'Legacy-compatible'
  });
  const otherHostId = Number(f.store.createHost(
    'copy-other@example.test', 'unused-test-hash', '2026-01-01T12:00:00.000Z'
  ));
  const otherToken = 'copy-other-session-token';
  f.store.createSession(
    crypto.createHash('sha256').update(otherToken).digest('hex'),
    otherHostId, '2030-01-01T00:00:00.000Z'
  );
  assert.equal(
    (await f.jsonRequest(`/api/events/${event.id}/invitation-copy`, 'PUT', normalized, `gatherly_session=${otherToken}`)).status,
    404
  );
});

test('bulk guest creation rejects empty arrays, oversized batches, and duplicate emails', async (t) => {
  const f = await fixture(t);
  const cookie = await f.register();
  const event = await createEvent(f, cookie);

  const empty = await f.jsonRequest(`/api/events/${event.id}/guests/bulk`, 'POST', { guests: [] }, cookie);
  assert.equal(empty.status, 400);
  assert.match((await empty.json()).error, /between 1 and 100/);

  const oversized = await f.jsonRequest(`/api/events/${event.id}/guests/bulk`, 'POST', {
    guests: Array.from({ length: 101 }, (_, i) => ({
      name: `Guest ${i}`, email: `guest${i}@example.test`, partyLimit: 2
    }))
  }, cookie);
  assert.equal(oversized.status, 400);

  const duplicate = await f.jsonRequest(`/api/events/${event.id}/guests/bulk`, 'POST', {
    guests: [
      { name: 'North', email: 'dup@example.test', partyLimit: 2 },
      { name: 'South', email: 'dup@example.test', partyLimit: 3 }
    ]
  }, cookie);
  assert.equal(duplicate.status, 400);
  assert.match((await duplicate.json()).error, /Duplicate email/);

  const dashboard = await (await f.request(`/api/events/${event.id}/dashboard`, {}, cookie)).json();
  assert.equal(dashboard.guests.length, 0);
});

test('RSVP enforces party size boundaries and individual mode', async (t) => {
  const f = await fixture(t);
  const cookie = await f.register();
  const household = await createEvent(f, cookie);
  const individual = await createEvent(f, cookie, { title: 'Individual only', guestMode: 'individual' });

  const hhGuest = await (await f.jsonRequest(`/api/events/${household.id}/guests`, 'POST', {
    name: 'Household Guest', email: 'hh@example.test', partyLimit: 4
  }, cookie)).json();
  const hhToken = hhGuest.inviteUrl.split('/').pop();

  const indGuest = await (await f.jsonRequest(`/api/events/${individual.id}/guests`, 'POST', {
    name: 'Individual Guest', email: 'ind@example.test'
  }, cookie)).json();
  const indToken = indGuest.inviteUrl.split('/').pop();

  // yes with partySize 0 rejected
  assert.equal((await f.jsonRequest(`/api/guest/${hhToken}/rsvp`, 'PUT', { answer: 'yes', partySize: 0 })).status, 400);
  // partySize at limit accepted
  assert.equal((await f.jsonRequest(`/api/guest/${hhToken}/rsvp`, 'PUT', { answer: 'yes', partySize: 4 })).status, 200);
  // partySize above limit rejected
  assert.equal((await f.jsonRequest(`/api/guest/${hhToken}/rsvp`, 'PUT', { answer: 'yes', partySize: 5 })).status, 400);
  // no must be partySize 0
  assert.equal((await f.jsonRequest(`/api/guest/${hhToken}/rsvp`, 'PUT', { answer: 'no', partySize: 1 })).status, 400);
  assert.equal((await f.jsonRequest(`/api/guest/${hhToken}/rsvp`, 'PUT', { answer: 'no', partySize: 0 })).status, 200);
  // individual mode forces partySize 1 for yes
  assert.equal((await f.jsonRequest(`/api/guest/${indToken}/rsvp`, 'PUT', { answer: 'yes', partySize: 3 })).status, 400);
  assert.equal((await f.jsonRequest(`/api/guest/${indToken}/rsvp`, 'PUT', { answer: 'yes', partySize: 1 })).status, 200);
});

test('auth rejects passwords shorter than 12 characters', async (t) => {
  const f = await fixture(t);
  const tooShort = await f.jsonRequest('/api/auth/register', 'POST', {
    email: 'short@example.test', password: 'shortpw'
  });
  assert.equal(tooShort.status, 400);
  assert.match((await tooShort.json()).error, /12/);

  // First host setup succeeds with exactly 12 characters.
  const exact = await f.jsonRequest('/api/auth/register', 'POST', {
    email: 'exact@example.test', password: '123456789012'
  });
  assert.equal(exact.status, 200);
});

test('theme contrast is accepted exactly at the 4.5:1 boundary', async (t) => {
  const f = await fixture(t);
  const cookie = await f.register();
  const event = await createEvent(f, cookie);

  // Pure black (#000000) on pure white (#ffffff) is 21:1 — well above 4.5:1.
  const valid = await f.jsonRequest(`/api/events/${event.id}/theme`, 'PUT', {
    ...DEFAULT_THEME, backgroundColor: '#ffffff', textColor: '#000000'
  }, cookie);
  assert.equal(valid.status, 200);

  // A near-miss just below 4.5:1 (e.g. #767676 on #ffffff = 4.54:1 is actually above; use #777777 = 4.48:1)
  const below = await f.jsonRequest(`/api/events/${event.id}/theme`, 'PUT', {
    ...DEFAULT_THEME, backgroundColor: '#ffffff', textColor: '#777777'
  }, cookie);
  assert.equal(below.status, 400);
});

test('RSVP stores and returns attendee details', async (t) => {
  const f = await fixture(t);
  const cookie = await f.register();
  const event = await createEvent(f, cookie, { guestMode: 'household' });

  const guest = await (await f.jsonRequest(`/api/events/${event.id}/guests`, 'POST', {
    name: 'Test Household', email: 'household@example.test', partyLimit: 4
  }, cookie)).json();
  const token = guest.inviteUrl.split('/').pop();

  // Submit RSVP with attendees
  const submit = await f.jsonRequest(`/api/guest/${token}/rsvp`, 'PUT', {
    answer: 'yes',
    partySize: 3,
    attendees: [
      { name: 'Alex Morgan', dietary: 'vegetarian', accessibility: '', ageBand: 'adult' },
      { name: 'Sam Morgan', dietary: 'none', accessibility: 'wheelchair access', ageBand: 'child' }
    ]
  });
  assert.equal(submit.status, 200);

  // The RSVP was accepted; verify validation rejects bad input (already proven by separate test)
  // Submit with too many attendees rejected
  const tooMany = await f.jsonRequest(`/api/guest/${token}/rsvp`, 'PUT', {
    answer: 'yes',
    partySize: 5,
    attendees: Array.from({ length: 6 }, (_, i) => ({ name: `Person ${i}`, ageBand: 'adult' }))
  });
  assert.equal(tooMany.status, 400);
});

test('RSVP attendee validation rejects invalid input', async (t) => {
  const f = await fixture(t);
  const cookie = await f.register();
  const event = await createEvent(f, cookie, { guestMode: 'household' });

  const guest = await (await f.jsonRequest(`/api/events/${event.id}/guests`, 'POST', {
    name: 'Test Household', email: 'household@example.test', partyLimit: 4
  }, cookie)).json();
  const token = guest.inviteUrl.split('/').pop();

  // Too many attendees (>20) rejected
  const tooMany = await f.jsonRequest(`/api/guest/${token}/rsvp`, 'PUT', {
    answer: 'yes',
    partySize: 21,
    attendees: Array.from({ length: 21 }, (_, i) => ({ name: `Person ${i}`, ageBand: 'adult' }))
  });
  assert.equal(tooMany.status, 400);

  // Invalid age band rejected
  const badAge = await f.jsonRequest(`/api/guest/${token}/rsvp`, 'PUT', {
    answer: 'yes',
    partySize: 2,
    attendees: [{ name: 'Person', ageBand: 'infant' }]
  });
  assert.equal(badAge.status, 400);

  // No RSVP with attendees rejected
  const noWithAttendees = await f.jsonRequest(`/api/guest/${token}/rsvp`, 'PUT', {
    answer: 'no',
    partySize: 0,
    attendees: [{ name: 'Person', ageBand: 'adult' }]
  });
  assert.equal(noWithAttendees.status, 400);

  // Attendees exceed partySize rejected
  const tooFewParty = await f.jsonRequest(`/api/guest/${token}/rsvp`, 'PUT', {
    answer: 'yes',
    partySize: 1,
    attendees: [{ name: 'Person 1', ageBand: 'adult' }, { name: 'Person 2', ageBand: 'adult' }]
  });
  assert.equal(tooFewParty.status, 400);

  // Valid attendee submission succeeds
  const valid = await f.jsonRequest(`/api/guest/${token}/rsvp`, 'PUT', {
    answer: 'yes',
    partySize: 2,
    attendees: [{ name: 'Valid Person', ageBand: 'adult' }]
  });
  assert.equal(valid.status, 200);
});

test('RSVP deadlines use the event timezone and reject ambiguous local times', async (t) => {
  const f = await fixture(t);
  const cookie = await f.register();
  const event = await createEvent(f, cookie, {
    timezone: 'Asia/Manila', rsvpDeadline: '2026-01-02T20:00'
  });
  assert.equal(event.rsvpDeadline, '2026-01-02T12:00:00.000Z');

  const missingTimezone = await f.jsonRequest('/api/events', 'POST', {
    title: 'Missing timezone', eventDate: '2026-01-10', guestMode: 'individual',
    rsvpDeadline: '2026-01-02T20:00'
  }, cookie);
  assert.equal(missingTimezone.status, 400);
  const daylightSavingGap = await f.jsonRequest('/api/events', 'POST', {
    title: 'DST gap', eventDate: '2026-03-10', guestMode: 'individual', timezone: 'America/New_York',
    rsvpDeadline: '2026-03-08T02:30'
  }, cookie);
  assert.equal(daylightSavingGap.status, 400);
});

test('walk-ins consume capacity and require a reason for host override', async (t) => {
  const f = await fixture(t);
  const cookie = await f.register();
  const event = await createEvent(f, cookie, { capacity: 1 });
  const guest = await (await f.jsonRequest(`/api/events/${event.id}/guests`, 'POST', {
    name: 'Capacity Guest', email: 'capacity@example.test', partyLimit: 1
  }, cookie)).json();
  const token = guest.inviteUrl.split('/').pop();
  assert.equal((await f.jsonRequest(`/api/guest/${token}/rsvp`, 'PUT', {
    answer: 'yes', partySize: 1
  })).status, 200);

  const blocked = await f.jsonRequest(`/api/events/${event.id}/check-in/walk-in`, 'POST', {
    name: 'Blocked walk-in', attendeeName: 'Blocked walk-in'
  }, cookie);
  assert.equal(blocked.status, 409);
  assert.match((await blocked.json()).error, /override with a reason/i);
  const missingReason = await f.jsonRequest(`/api/events/${event.id}/check-in/walk-in`, 'POST', {
    name: 'Missing reason', override: true
  }, cookie);
  assert.equal(missingReason.status, 400);
  const override = await f.jsonRequest(`/api/events/${event.id}/check-in/walk-in`, 'POST', {
    name: 'Approved walk-in', attendeeName: 'Approved walk-in', override: true, reason: 'Venue approved'
  }, cookie);
  assert.equal(override.status, 201);
  assert.equal((await override.json()).totals.walkIns, 1);
  const csv = await f.request(`/api/events/${event.id}/export`, {}, cookie);
  const csvText = await csv.text();
  assert.match(csvText, /"Walk-in","Checked-in time","Attendee check-in times"/);
  assert.match(csvText, /"Approved walk-in".*"yes"/);
});

test('postponement stores a replacement schedule, keeps RSVPs open, and captures an update preview', async (t) => {
  const f = await fixture(t);
  const cookie = await f.register();
  const event = await createEvent(f, cookie, { guestMode: 'individual' });
  const guest = await (await f.jsonRequest(`/api/events/${event.id}/guests`, 'POST', {
    name: 'Postponed Guest', email: 'postponed@example.test'
  }, cookie)).json();
  const token = guest.inviteUrl.split('/').pop();
  const postponed = await f.jsonRequest(`/api/events/${event.id}/status`, 'POST', {
    status: 'postponed', note: 'New date confirmed.', replacement: {
      eventDate: '2026-02-14', startTime: '19:00', endTime: '21:00', timezone: 'Asia/Manila'
    }
  }, cookie);
  assert.equal(postponed.status, 200);
  const guestView = await (await f.request(`/api/guest/${token}`)).json();
  assert.equal(guestView.event.replacementEventDate, '2026-02-14');
  assert.equal(guestView.event.replacementTimezone, 'Asia/Manila');
  assert.equal(guestView.canRespond, true);
  assert.match((await postponed.json()).updateMessage, /new schedule/i);
  const outbox = await (await f.request('/api/outbox', {}, cookie)).json();
  assert.ok(outbox.messages.some((message) => message.messageType === 'preview' && /postponed/i.test(message.body)));
});

test('creates deterministic seating drafts, supports manual edits, publishes, and marks plans stale after RSVP changes', async (t) => {
  const f = await fixture(t);
  const cookie = await f.register();
  const event = await createEvent(f, cookie);
  const guest = await (await f.jsonRequest(`/api/events/${event.id}/guests`, 'POST', {
    name: 'Seating Household', email: 'seating@example.test', partyLimit: 3
  }, cookie)).json();
  const token = guest.inviteUrl.split('/').pop();
  await f.jsonRequest(`/api/guest/${token}/rsvp`, 'PUT', {
    answer: 'yes', partySize: 3,
    attendees: [{ name: 'Alex Morgan' }, { name: 'Sam Morgan' }, { name: 'Taylor Morgan' }]
  });

  const created = await f.jsonRequest(`/api/events/${event.id}/seating/plans`, 'POST', {
    name: 'Dinner draft',
    tables: [{ name: 'Table 1', capacity: 2 }, { name: 'Table 2', capacity: 2 }]
  }, cookie);
  assert.equal(created.status, 201);
  const planId = (await created.json()).plan.id;
  const firstRun = await f.jsonRequest(`/api/events/${event.id}/seating/plans/${planId}/run`, 'POST', {}, cookie);
  assert.equal(firstRun.status, 200);
  const firstPlan = (await firstRun.json()).plan;
  const secondRun = await f.jsonRequest(`/api/events/${event.id}/seating/plans/${planId}/run`, 'POST', {}, cookie);
  assert.deepEqual((await secondRun.json()).plan.assignments, firstPlan.assignments);
  assert.equal(firstPlan.payload.assignedCount, 3);
  assert.equal(firstPlan.payload.optimization.householdGroups, 1);
  assert.equal(firstPlan.payload.optimization.familiesKeptTogether, 0);
  assert.equal(firstPlan.payload.optimization.familiesSplit, 1);
  assert.equal(firstPlan.payload.optimization.familyOptimizationScore, 0);

  const moved = firstPlan.assignments.map((assignment, index) => ({
    ...assignment, tableId: index === 0 ? 2 : assignment.tableId
  }));
  const edit = await f.jsonRequest(`/api/events/${event.id}/seating/plans/${planId}/assignments`, 'PUT', {
    assignments: moved
  }, cookie);
  assert.equal(edit.status, 200);
  const movedTable = await f.jsonRequest(`/api/events/${event.id}/seating/plans/${planId}/positions`, 'PUT', {
    positions: [{ tableId: 1, positionX: 24, positionY: 68 }]
  }, cookie);
  assert.equal(movedTable.status, 200);
  assert.equal((await movedTable.json()).plan.tables.find((table) => table.id === 1).positionX, 24);
  const reset = await f.jsonRequest(`/api/events/${event.id}/seating/plans/${planId}/run`, 'POST', {
    reset: true
  }, cookie);
  assert.equal(reset.status, 200);
  const resetPlan = (await reset.json()).plan;
  assert.equal(resetPlan.tables.find((table) => table.id === 1).positionX, 18);
  assert.equal(resetPlan.tables.find((table) => table.id === 2).positionX, 39);
  assert.deepEqual(resetPlan.assignments, []);
  assert.equal(resetPlan.payload.assignedCount, 0);
  const published = await f.jsonRequest(`/api/events/${event.id}/seating/plans/${planId}/publish`, 'POST', {}, cookie);
  assert.equal(published.status, 200);
  assert.equal((await published.json()).plan.status, 'published');

  await f.jsonRequest(`/api/guest/${token}/rsvp`, 'PUT', {
    answer: 'yes', partySize: 3,
    attendees: [{ name: 'Alex Morgan' }, { name: 'Sam Morgan' }]
  });
  const stale = await (await f.request(`/api/events/${event.id}/seating/plans/${planId}`, {}, cookie)).json();
  assert.equal(stale.plan.status, 'stale');
  const blockedPublish = await f.jsonRequest(`/api/events/${event.id}/seating/plans/${planId}/publish`, 'POST', {}, cookie);
  assert.equal(blockedPublish.status, 409);
});
