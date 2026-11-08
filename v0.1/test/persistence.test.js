'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { DatabaseSync } = require('node:sqlite');
const {
  Store, DEFAULT_THEME, DEFAULT_INVITATION_SETTINGS, DEFAULT_INVITATION_COPY
} = require('../persistence');

test('creates durable seating preference storage with organizer priority fields', () => {
  const store = new Store(':memory:');
  try {
    const columns = store.db.prepare('PRAGMA table_info(seating_constraints)').all()
      .map((column) => column.name);
    assert.deepEqual(columns, [
      'id', 'plan_id', 'relationship_type', 'relationship', 'priority',
      'attendee_ids_json', 'created_at', 'updated_at'
    ]);
  } finally {
    store.close();
  }
});

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
  assert.equal(event.eventStartTime, null);
  assert.equal(event.eventEndTime, null);
  assert.equal(event.timezone, null);
  assert.equal(event.status, 'active');
  assert.equal(event.statusNote, null);
  assert.deepEqual(
    legacyColumns(store).filter((name) => name.startsWith('event_') || name === 'event_timezone'),
    ['event_date', 'event_start_time', 'event_end_time', 'event_timezone']
  );
  assert.deepEqual(event.theme, DEFAULT_THEME);
  assert.deepEqual(event.invitationSettings, DEFAULT_INVITATION_SETTINGS);
  assert.deepEqual(event.invitationCopy, DEFAULT_INVITATION_COPY);
  assert.equal(
    store.db.prepare('SELECT theme_json FROM events WHERE id = 7').get().theme_json,
    JSON.stringify(DEFAULT_THEME)
  );
  assert.equal(
    store.db.prepare('SELECT invitation_settings_json FROM events WHERE id = 7').get()
      .invitation_settings_json,
    JSON.stringify(DEFAULT_INVITATION_SETTINGS)
  );
  assert.equal(
    store.db.prepare('SELECT invitation_copy_json FROM events WHERE id = 7').get()
      .invitation_copy_json,
    JSON.stringify(DEFAULT_INVITATION_COPY)
  );
});

function legacyColumns(store) {
  return store.db.prepare('PRAGMA table_info(events)').all().map((column) => column.name);
}

test('adds nullable email and invite URL columns to legacy guest units without rewriting records', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'gatherly-guest-migration-'));
  const filename = path.join(directory, 'legacy.sqlite');
  const legacyDb = new DatabaseSync(filename);
  legacyDb.exec(`
    CREATE TABLE hosts (
      id INTEGER PRIMARY KEY,
      email TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
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
    CREATE TABLE guest_units (
      id INTEGER PRIMARY KEY,
      event_id INTEGER NOT NULL,
      name TEXT NOT NULL,
      party_limit INTEGER NOT NULL,
      token_hash TEXT NOT NULL UNIQUE,
      revoked_at TEXT,
      created_at TEXT NOT NULL
    );
    CREATE TABLE rsvps (
      id INTEGER PRIMARY KEY,
      guest_unit_id INTEGER NOT NULL UNIQUE,
      answer TEXT NOT NULL,
      party_size INTEGER NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE email_outbox (
      id INTEGER PRIMARY KEY,
      guest_unit_id INTEGER NOT NULL,
      recipient TEXT NOT NULL,
      subject TEXT NOT NULL,
      body TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    INSERT INTO events (id, host_id, title, event_date, guest_mode, created_at)
      VALUES (7, 1, 'Legacy event', '2026-04-05', 'individual', '2026-01-01');
    INSERT INTO guest_units (id, event_id, name, party_limit, token_hash, created_at)
      VALUES (9, 7, 'Historical guest', 1, 'legacy-token-hash', '2026-01-02');
    INSERT INTO rsvps (guest_unit_id, answer, party_size, updated_at)
      VALUES (9, 'yes', 1, '2026-01-03');
  `);
  legacyDb.close();

  const store = new Store(filename);
  try {
    const columns = store.db.prepare('PRAGMA table_info(guest_units)').all();
    assert.equal(columns.find((column) => column.name === 'email').notnull, 0);
    assert.equal(columns.find((column) => column.name === 'invite_url').notnull, 1);
    const guest = store.db.prepare(
      'SELECT id, name, email, invite_url FROM guest_units'
    ).get();
    assert.deepEqual(
      { id: guest.id, name: guest.name, email: guest.email, invite_url: guest.invite_url },
      { id: 9, name: 'Historical guest', email: null, invite_url: '' }
    );
    assert.equal(store.dashboardGuests(7, 1)[0].email, null);
    assert.equal(store.dashboardGuests(7, 1)[0].walkIn, 0);
    assert.equal(store.db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'check_ins'").get().name, 'check_ins');
    assert.equal(store.guestInviteLink(9, 1).inviteUrl, '');
    assert.deepEqual(store.eventRecipients(7, 1, 'all'), []);
  } finally {
    store.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('persists reversible unit and attendee check-ins without changing RSVP data', () => {
  const store = new Store(':memory:');
  try {
    const hostId = Number(store.createHost('host@example.test', 'hash', '2026-01-01'));
    const eventId = Number(store.createEvent(hostId, {
      title: 'Door check-in', eventDate: '2026-04-05', location: '', guestMode: 'household', rsvpDeadline: null
    }, '2026-01-01'));
    const guestId = Number(store.createGuestAndOutbox({
      eventId, name: 'Door household', email: 'door@example.test', partyLimit: 3,
      tokenHash: 'check-in-token', inviteUrl: '/rsvp/check-in-token'
    }, { recipient: 'door@example.test', subject: 'Invite', body: 'Invite' }, '2026-01-01'));
    store.saveRsvp(guestId, 'yes', 2, '2026-01-02', [{ name: 'Named guest' }]);
    const attendeeId = store.attendeesForGuest(guestId)[0].id;
    const checkedAt = '2026-04-05T18:00:00.000Z';
    assert.equal(store.checkInTarget(eventId, hostId, { attendeeId }, checkedAt, checkedAt).id > 0, true);
    assert.equal(store.checkInTarget(eventId, hostId, { attendeeId }, checkedAt, checkedAt).duplicate, true);
    assert.equal(store.reverseCheckIn(eventId, hostId, { attendeeId }, '2026-04-05T18:01:00.000Z'), 1);
    assert.equal(store.getGuestByToken('check-in-token').answer, 'yes');
    assert.equal(store.getGuestByToken('check-in-token').attendees[0].name, 'Named guest');
    assert.equal(store.checkInState(eventId, hostId)[0].reversedAt, '2026-04-05T18:01:00.000Z');
  } finally {
    store.close();
  }
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

test('persists invitation copy separately from presentation settings', () => {
  const store = new Store(':memory:');
  try {
    const hostId = Number(store.createHost('copy-host@example.test', 'hash', '2026-01-01'));
    const eventId = Number(store.createEvent(hostId, {
      title: 'Copy event', eventDate: '2026-04-05', location: '', guestMode: 'individual', rsvpDeadline: null
    }, '2026-01-01'));
    const copy = {
      greeting: 'Welcome', title: 'A new title', intro: 'Join us.',
      rsvpHeading: 'Can you come?', rsvpHelper: 'Choose one.', footerNote: 'See you soon.'
    };
    assert.deepEqual(store.getEventForHost(eventId, hostId).invitationCopy, DEFAULT_INVITATION_COPY);
    assert.equal(store.updateEventInvitationCopy(eventId, hostId, copy), 1);
    assert.deepEqual(store.getEventForHost(eventId, hostId).invitationCopy, {
      ...DEFAULT_INVITATION_COPY, ...copy
    });
    assert.deepEqual(store.getGuestByToken('missing-copy-token'), undefined);
    assert.equal(store.updateEventInvitationCopy(eventId, hostId + 1, copy), 0);
    store.db.prepare('UPDATE events SET invitation_copy_json = ? WHERE id = ?')
      .run(JSON.stringify({
        greeting: 'Legacy', title: '', intro: '', rsvpHeading: '', rsvpHelper: '', footerNote: ''
      }), eventId);
    assert.deepEqual(store.getEventForHost(eventId, hostId).invitationCopy, {
      ...DEFAULT_INVITATION_COPY, greeting: 'Legacy'
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
