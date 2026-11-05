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
  const response = await f.jsonRequest('/api/events', 'POST', {
    title: 'Sample gathering',
    eventDate: '2026-01-10',
    location: 'Local test venue',
    guestMode: 'household',
    rsvpDeadline: '2026-01-02T12:00:00.000Z',
    ...options
  }, cookie);
  assert.equal(response.status, 201);
  return (await response.json()).event;
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

  // Fetch invitation detail and verify attendees are returned
  const detail = await (await f.jsonRequest(`/api/guest/${token}`)).json();
  assert.equal(detail.guest.answer, 'yes');
  assert.equal(detail.guest.partySize, 3);
  assert.equal(detail.guest.attendees.length, 2);
  assert.equal(detail.guest.attendees[0].name, 'Alex Morgan');
  assert.equal(detail.guest.attendees[0].dietary, 'vegetarian');
  assert.equal(detail.guest.attendees[1].name, 'Sam Morgan');
  assert.equal(detail.guest.attendees[1].ageBand, 'child');

  // Dashboard also includes attendees
  const dashboard = await (await f.jsonRequest(`/api/events/${event.id}/dashboard`, {}, cookie)).json();
  const dashboardGuest = dashboard.guests.find((g) => g.id === guest.id);
  assert.ok(dashboardGuest);
  assert.equal(dashboardGuest.attendees.length, 2);
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
