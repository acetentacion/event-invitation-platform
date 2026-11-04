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
