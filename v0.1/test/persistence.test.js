'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { DatabaseSync } = require('node:sqlite');
const {
  Store, DEFAULT_THEME, DEFAULT_INVITATION_SETTINGS
} = require('../persistence');

test('adds default theme and invitation settings to an existing event database', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'gatherly-theme-migration-'));
  const filename = path.join(directory, 'legacy.sqlite');
  const legacyDb = new DatabaseSync(filename);
  legacyDb.exec(`
    CREATE TABLE events (
      id INTEGER PRIMARY KEY,
      host_id INTEGER NOT NULL,
      title TEXT NOT NULL,
      event_date TEXT NOT NULL,
      location TEXT NOT NULL DEFAULT '',
      guest_mode TEXT NOT NULL,
      rsvp_deadline TEXT,
      responses_open INTEGER NOT NULL DEFAULT 1,
      reopened_at TEXT,
      created_at TEXT NOT NULL
    );
    INSERT INTO events
      (id, host_id, title, event_date, guest_mode, created_at)
    VALUES (7, 3, 'Legacy event', '2026-04-05', 'individual', '2026-01-01');
  `);
  legacyDb.close();

  const store = new Store(filename);
  t.after(() => {
    store.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });

  const event = store.getEventForHost(7, 3);
  assert.equal(event.title, 'Legacy event');
  assert.deepEqual(event.theme, DEFAULT_THEME);
  assert.deepEqual(event.invitationSettings, DEFAULT_INVITATION_SETTINGS);
  assert.equal(
    store.db.prepare('SELECT theme_json FROM events WHERE id = 7').get().theme_json,
    JSON.stringify(DEFAULT_THEME)
  );
  assert.equal(
    store.db.prepare('SELECT invitation_settings_json FROM events WHERE id = 7').get()
      .invitation_settings_json,
    JSON.stringify(DEFAULT_INVITATION_SETTINGS)
  );
});

test('persists and reads event invitation settings', () => {
  const store = new Store(':memory:');
  try {
    const hostId = Number(store.createHost('host@example.test', 'hash', '2026-01-01'));
    const eventId = Number(store.createEvent(hostId, {
      title: 'Settings event',
      eventDate: '2026-04-05',
      location: '',
      guestMode: 'individual',
      rsvpDeadline: null
    }, '2026-01-01'));
    const settings = {
      revealMode: 'envelope', chimeEnabled: true, revealMotion: 'slide-up', celebration: 'sparkle'
    };

    assert.deepEqual(store.getEventForHost(eventId, hostId).invitationSettings, DEFAULT_INVITATION_SETTINGS);
    assert.equal(store.updateEventInvitationSettings(eventId, hostId, settings), 1);
    assert.deepEqual(store.getEventForHost(eventId, hostId).invitationSettings, settings);
    assert.deepEqual(store.listEvents(hostId)[0].invitationSettings, settings);
    const leafSettings = { ...settings, celebration: 'leaves' };
    assert.equal(store.updateEventInvitationSettings(eventId, hostId, leafSettings), 1);
    assert.deepEqual(store.getEventForHost(eventId, hostId).invitationSettings, leafSettings);
    assert.equal(store.updateEventInvitationSettings(eventId, hostId + 1, DEFAULT_INVITATION_SETTINGS), 0);

    store.db.prepare('UPDATE events SET invitation_settings_json = ? WHERE id = ?')
      .run(JSON.stringify({ revealMode: 'envelope', chimeEnabled: true }), eventId);
    assert.deepEqual(store.getEventForHost(eventId, hostId).invitationSettings, {
      ...DEFAULT_INVITATION_SETTINGS, revealMode: 'envelope', chimeEnabled: true
    });
  } finally {
    store.close();
  }
});

test('saveRsvp stores and retrieves attendee details', () => {
  const store = new Store(':memory:');
  try {
    const hostId = Number(store.createHost('host@example.test', 'hash', '2026-01-01'));
    const eventId = Number(store.createEvent(hostId, {
      title: 'Attendee test event',
      eventDate: '2026-04-05',
      location: '',
      guestMode: 'household',
      rsvpDeadline: null
    }, '2026-01-01'));
    const guestId = Number(store.createGuestAndOutbox({
      eventId, name: 'Sample Household', email: 'household@example.test',
      partyLimit: 4, groupName: '', tokenHash: 'abc123', inviteUrl: '/rsvp/abc123'
    }, {
      recipient: 'household@example.test',
      subject: 'Your invitation',
      body: 'You are invited.'
    }, '2026-01-01'));

    const updatedAt = '2026-01-05T10:00:00.000Z';
    assert.equal(store.saveRsvp(guestId, 'yes', 3, updatedAt, [
      { name: 'Alex Morgan', dietary: 'vegetarian', accessibility: '', ageBand: 'adult' },
      { name: 'Sam Morgan', dietary: 'none', accessibility: 'wheelchair access', ageBand: 'child' },
      { name: '', dietary: '', accessibility: '', ageBand: 'adult' }
    ]), true);

    const attendees = store.attendeesForGuest(guestId);
    assert.equal(attendees.length, 3);
    assert.equal(attendees[0].name, 'Alex Morgan');
    assert.equal(attendees[0].dietary, 'vegetarian');
    assert.equal(attendees[0].accessibility, '');
    assert.equal(attendees[0].ageBand, 'adult');
    assert.equal(attendees[1].name, 'Sam Morgan');
    assert.equal(attendees[1].ageBand, 'child');
    assert.equal(attendees[2].name, '');
    assert.equal(attendees[2].ageBand, 'adult');
  } finally {
    store.close();
  }
});

test('saveRsvp replaces existing attendees on update', () => {
  const store = new Store(':memory:');
  try {
    const hostId = Number(store.createHost('host@example.test', 'hash', '2026-01-01'));
    const eventId = Number(store.createEvent(hostId, {
      title: 'Replace attendees event',
      eventDate: '2026-04-05',
      location: '',
      guestMode: 'household',
      rsvpDeadline: null
    }, '2026-01-01'));
    const guestId = Number(store.createGuestAndOutbox({
      eventId, name: 'Sample Household', email: 'household@example.test',
      partyLimit: 4, groupName: '', tokenHash: 'def456', inviteUrl: '/rsvp/def456'
    }, {
      recipient: 'household@example.test',
      subject: 'Your invitation',
      body: 'You are invited.'
    }, '2026-01-01'));

    store.saveRsvp(guestId, 'yes', 2, '2026-01-05T10:00:00.000Z', [
      { name: 'First Person', dietary: '', accessibility: '', ageBand: 'adult' }
    ]);
    assert.equal(store.attendeesForGuest(guestId).length, 1);

    store.saveRsvp(guestId, 'yes', 1, '2026-01-06T10:00:00.000Z', []);
    assert.equal(store.attendeesForGuest(guestId).length, 0);

    store.saveRsvp(guestId, 'yes', 2, '2026-01-07T10:00:00.000Z', [
      { name: 'New Person', dietary: 'nut allergy', accessibility: '', ageBand: 'adult' }
    ]);
    const attendees = store.attendeesForGuest(guestId);
    assert.equal(attendees.length, 1);
    assert.equal(attendees[0].name, 'New Person');
    assert.equal(attendees[0].dietary, 'nut allergy');
  } finally {
    store.close();
  }
});

test('getGuestByToken includes attendees', () => {
  const store = new Store(':memory:');
  try {
    const hostId = Number(store.createHost('host@example.test', 'hash', '2026-01-01'));
    const eventId = Number(store.createEvent(hostId, {
      title: 'Token attendee event',
      eventDate: '2026-04-05',
      location: '',
      guestMode: 'household',
      rsvpDeadline: null
    }, '2026-01-01'));
    const guestId = Number(store.createGuestAndOutbox({
      eventId, name: 'Sample Household', email: 'household@example.test',
      partyLimit: 4, groupName: '', tokenHash: 'token789', inviteUrl: '/rsvp/token789'
    }, {
      recipient: 'household@example.test',
      subject: 'Your invitation',
      body: 'You are invited.'
    }, '2026-01-01'));

    store.saveRsvp(guestId, 'yes', 2, '2026-01-05T10:00:00.000Z', [
      { name: 'Guest One', dietary: '', accessibility: '', ageBand: 'adult' }
    ]);

    const record = store.getGuestByToken('token789');
    assert.ok(record);
    assert.equal(record.guestId, guestId);
    assert.equal(record.answer, 'yes');
    assert.equal(record.attendees.length, 1);
    assert.equal(record.attendees[0].name, 'Guest One');
  } finally {
    store.close();
  }
});
