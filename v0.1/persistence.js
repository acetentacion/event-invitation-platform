'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');

const DEFAULT_THEME = Object.freeze({
  preset: 'classic',
  primaryColor: '#315a4c',
  backgroundColor: '#f8f6f1',
  textColor: '#262b2c',
  fontFamily: 'serif',
  coverImage: null
});

const DEFAULT_INVITATION_SETTINGS = Object.freeze({
  revealMode: 'direct',
  chimeEnabled: false,
  revealMotion: 'none',
  celebration: 'off'
});

const DEFAULT_INVITATION_COPY = Object.freeze({
  greeting: '',
  title: '',
  intro: '',
  rsvpHeading: '',
  rsvpHelper: '',
  footerNote: ''
});

function storedInvitationSettings(value) {
  try {
    const settings = JSON.parse(value);
    const keys = settings && typeof settings === 'object' && !Array.isArray(settings)
      ? Object.keys(settings).sort() : [];
    const isLegacy = keys.join(',') === 'chimeEnabled,revealMode';
    const isCurrent = keys.join(',') === 'celebration,chimeEnabled,revealMode,revealMotion';
    if (settings && typeof settings === 'object' && !Array.isArray(settings) &&
        (isLegacy || isCurrent) &&
        ['envelope', 'direct'].includes(settings.revealMode) &&
        typeof settings.chimeEnabled === 'boolean' &&
        (!isCurrent ||
          (['none', 'fade', 'slide-up'].includes(settings.revealMotion) &&
           ['off', 'sparkle', 'leaves'].includes(settings.celebration)))) {
      return {
        revealMode: settings.revealMode,
        chimeEnabled: settings.chimeEnabled,
        revealMotion: isCurrent ? settings.revealMotion : DEFAULT_INVITATION_SETTINGS.revealMotion,
        celebration: isCurrent ? settings.celebration : DEFAULT_INVITATION_SETTINGS.celebration
      };
    }
  } catch {
    // Missing or malformed persisted settings should never break event reads.
  }
  return { ...DEFAULT_INVITATION_SETTINGS };
}

function storedInvitationCopy(value) {
  try {
    const copy = JSON.parse(value);
    const keys = copy && typeof copy === 'object' && !Array.isArray(copy)
      ? Object.keys(copy).sort() : [];
    const expected = Object.keys(DEFAULT_INVITATION_COPY).sort();
    if (copy && typeof copy === 'object' && !Array.isArray(copy) &&
        keys.join(',') === expected.join(',') &&
        expected.every((key) => typeof copy[key] === 'string')) {
      return { ...DEFAULT_INVITATION_COPY, ...copy };
    }
  } catch {
    // Missing or malformed persisted copy should never break event reads.
  }
  return { ...DEFAULT_INVITATION_COPY };
}

function storedTheme(value) {
  try {
    const theme = JSON.parse(value);
    let validCoverImage = theme && theme.coverImage === null;
    if (theme && typeof theme.coverImage === 'string') {
      const match = /^data:image\/(?:png|jpeg|webp);base64,([A-Za-z0-9+/]+={0,2})$/.exec(theme.coverImage);
      if (match && match[1].length % 4 === 0) {
        const decoded = Buffer.from(match[1], 'base64');
        validCoverImage = decoded.length > 0 && decoded.length <= 1024 * 1024 &&
          decoded.toString('base64') === match[1];
      }
    }
    if (theme && typeof theme === 'object' &&
        ['classic', 'garden', 'midnight', 'custom'].includes(theme.preset) &&
        /^#[0-9a-fA-F]{6}$/.test(theme.primaryColor) &&
        /^#[0-9a-fA-F]{6}$/.test(theme.backgroundColor) &&
        /^#[0-9a-fA-F]{6}$/.test(theme.textColor) &&
        ['serif', 'sans'].includes(theme.fontFamily) &&
        validCoverImage) {
      return {
        preset: theme.preset,
        primaryColor: theme.primaryColor,
        backgroundColor: theme.backgroundColor,
        textColor: theme.textColor,
        fontFamily: theme.fontFamily,
        coverImage: theme.coverImage
      };
    }
  } catch {
    // A missing or malformed persisted value should never break event reads.
  }
  return { ...DEFAULT_THEME };
}

class Store {
  constructor(filename) {
    if (filename !== ':memory:') fs.mkdirSync(path.dirname(filename), { recursive: true });
    this.db = new DatabaseSync(filename);
    this.db.exec('PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS hosts (
        id INTEGER PRIMARY KEY,
        email TEXT NOT NULL UNIQUE,
        password_hash TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS sessions (
        token_hash TEXT PRIMARY KEY,
        host_id INTEGER NOT NULL REFERENCES hosts(id) ON DELETE CASCADE,
        expires_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS events (
        id INTEGER PRIMARY KEY,
        host_id INTEGER NOT NULL REFERENCES hosts(id) ON DELETE CASCADE,
        title TEXT NOT NULL CHECK (length(title) BETWEEN 1 AND 100),
        event_date TEXT NOT NULL,
        event_start_time TEXT,
        event_end_time TEXT,
        event_timezone TEXT,
        location TEXT NOT NULL DEFAULT '',
        guest_mode TEXT NOT NULL CHECK (guest_mode IN ('individual', 'household')),
        rsvp_deadline TEXT,
        capacity INTEGER CHECK (capacity IS NULL OR capacity BETWEEN 1 AND 100000),
        responses_open INTEGER NOT NULL DEFAULT 1 CHECK (responses_open IN (0, 1)),
        reopened_at TEXT,
        status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'postponed', 'cancelled')),
        status_note TEXT,
        replacement_event_date TEXT,
        replacement_event_start_time TEXT,
        replacement_event_end_time TEXT,
        replacement_event_timezone TEXT,
        created_at TEXT NOT NULL,
        published INTEGER NOT NULL DEFAULT 0 CHECK (published IN (0, 1)),
        theme_json TEXT NOT NULL DEFAULT '${JSON.stringify(DEFAULT_THEME)}',
        invitation_settings_json TEXT NOT NULL DEFAULT '${JSON.stringify(DEFAULT_INVITATION_SETTINGS)}',
        invitation_copy_json TEXT NOT NULL DEFAULT '${JSON.stringify(DEFAULT_INVITATION_COPY)}'
      );
      CREATE TABLE IF NOT EXISTS guest_units (
        id INTEGER PRIMARY KEY,
        event_id INTEGER NOT NULL REFERENCES events(id) ON DELETE CASCADE,
        name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 100),
        email TEXT NOT NULL,
        party_limit INTEGER NOT NULL CHECK (party_limit BETWEEN 1 AND 20),
        token_hash TEXT NOT NULL UNIQUE,
        invite_url TEXT NOT NULL,
        revoked_at TEXT,
        walk_in INTEGER NOT NULL DEFAULT 0 CHECK (walk_in IN (0, 1)),
        created_at TEXT NOT NULL,
        UNIQUE(event_id, email)
      );
      CREATE TABLE IF NOT EXISTS rsvps (
        id INTEGER PRIMARY KEY,
        guest_unit_id INTEGER NOT NULL UNIQUE REFERENCES guest_units(id) ON DELETE CASCADE,
        answer TEXT NOT NULL CHECK (answer IN ('yes', 'no', 'maybe')),
        party_size INTEGER NOT NULL CHECK (party_size BETWEEN 0 AND 20),
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS rsvp_attendees (
         id INTEGER PRIMARY KEY,
         guest_unit_id INTEGER NOT NULL REFERENCES guest_units(id) ON DELETE CASCADE,
         name TEXT NOT NULL DEFAULT '',
         dietary TEXT NOT NULL DEFAULT '',
         accessibility TEXT NOT NULL DEFAULT '',
         age_band TEXT NOT NULL DEFAULT 'adult' CHECK (age_band IN ('adult', 'child')),
         created_at TEXT NOT NULL
       );
       CREATE TABLE IF NOT EXISTS check_ins (
         id INTEGER PRIMARY KEY,
         event_id INTEGER NOT NULL REFERENCES events(id) ON DELETE CASCADE,
         guest_unit_id INTEGER REFERENCES guest_units(id) ON DELETE CASCADE,
         attendee_id INTEGER REFERENCES rsvp_attendees(id) ON DELETE CASCADE,
         checked_in_at TEXT NOT NULL,
         reversed_at TEXT,
         created_at TEXT NOT NULL,
         CHECK ((guest_unit_id IS NOT NULL AND attendee_id IS NULL) OR
                (guest_unit_id IS NULL AND attendee_id IS NOT NULL))
       );
       CREATE TABLE IF NOT EXISTS email_outbox (
        id INTEGER PRIMARY KEY,
        guest_unit_id INTEGER NOT NULL REFERENCES guest_units(id) ON DELETE CASCADE,
        recipient TEXT NOT NULL,
        subject TEXT NOT NULL,
        body TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS local_messages (
        id INTEGER PRIMARY KEY,
        event_id INTEGER NOT NULL REFERENCES events(id) ON DELETE CASCADE,
        recipient TEXT NOT NULL,
        subject TEXT NOT NULL,
        body TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS sessions_expiry_idx ON sessions(expires_at);
      CREATE INDEX IF NOT EXISTS events_host_idx ON events(host_id, created_at);
      CREATE INDEX IF NOT EXISTS guests_event_idx ON guest_units(event_id, created_at);
      CREATE INDEX IF NOT EXISTS outbox_guest_idx ON email_outbox(guest_unit_id, created_at);
      CREATE INDEX IF NOT EXISTS local_messages_event_idx ON local_messages(event_id, created_at);
      CREATE INDEX IF NOT EXISTS check_ins_event_idx ON check_ins(event_id, checked_in_at);
      CREATE UNIQUE INDEX IF NOT EXISTS check_ins_guest_active_idx
        ON check_ins(guest_unit_id) WHERE guest_unit_id IS NOT NULL AND reversed_at IS NULL;
      CREATE UNIQUE INDEX IF NOT EXISTS check_ins_attendee_active_idx
        ON check_ins(attendee_id) WHERE attendee_id IS NOT NULL AND reversed_at IS NULL;
    `);
    const eventColumns = this.db.prepare('PRAGMA table_info(events)').all();
    if (!eventColumns.some((column) => column.name === 'published')) {
      this.db.exec('ALTER TABLE events ADD COLUMN published INTEGER NOT NULL DEFAULT 0');
    }
    if (!eventColumns.some((column) => column.name === 'theme_json')) {
      this.db.exec(
        `ALTER TABLE events ADD COLUMN theme_json TEXT NOT NULL DEFAULT '${JSON.stringify(DEFAULT_THEME)}'`
      );
    }
    if (!eventColumns.some((column) => column.name === 'invitation_settings_json')) {
      this.db.exec(
        `ALTER TABLE events ADD COLUMN invitation_settings_json TEXT NOT NULL DEFAULT '${JSON.stringify(DEFAULT_INVITATION_SETTINGS)}'`
      );
    }
    if (!eventColumns.some((column) => column.name === 'invitation_copy_json')) {
      this.db.exec(
        `ALTER TABLE events ADD COLUMN invitation_copy_json TEXT NOT NULL DEFAULT '${JSON.stringify(DEFAULT_INVITATION_COPY)}'`
      );
    }
    if (!eventColumns.some((column) => column.name === 'capacity')) {
      this.db.exec('ALTER TABLE events ADD COLUMN capacity INTEGER');
    }
    if (!eventColumns.some((column) => column.name === 'event_start_time')) {
      this.db.exec('ALTER TABLE events ADD COLUMN event_start_time TEXT');
    }
    if (!eventColumns.some((column) => column.name === 'event_end_time')) {
      this.db.exec('ALTER TABLE events ADD COLUMN event_end_time TEXT');
    }
    if (!eventColumns.some((column) => column.name === 'event_timezone')) {
      this.db.exec('ALTER TABLE events ADD COLUMN event_timezone TEXT');
    }
    if (!eventColumns.some((column) => column.name === 'status')) {
      this.db.exec("ALTER TABLE events ADD COLUMN status TEXT NOT NULL DEFAULT 'active'");
    }
    if (!eventColumns.some((column) => column.name === 'status_note')) {
      this.db.exec('ALTER TABLE events ADD COLUMN status_note TEXT');
    }
    if (!eventColumns.some((column) => column.name === 'replacement_event_date')) {
      this.db.exec('ALTER TABLE events ADD COLUMN replacement_event_date TEXT');
    }
    if (!eventColumns.some((column) => column.name === 'replacement_event_start_time')) {
      this.db.exec('ALTER TABLE events ADD COLUMN replacement_event_start_time TEXT');
    }
    if (!eventColumns.some((column) => column.name === 'replacement_event_end_time')) {
      this.db.exec('ALTER TABLE events ADD COLUMN replacement_event_end_time TEXT');
    }
    if (!eventColumns.some((column) => column.name === 'replacement_event_timezone')) {
      this.db.exec('ALTER TABLE events ADD COLUMN replacement_event_timezone TEXT');
    }
    const guestColumns = this.db.prepare('PRAGMA table_info(guest_units)').all();
    if (!guestColumns.some((column) => column.name === 'invite_url')) {
      this.db.exec('ALTER TABLE guest_units ADD COLUMN invite_url TEXT NOT NULL DEFAULT ""');
    }
    if (!guestColumns.some((column) => column.name === 'email')) {
      // Historical email addresses are unavailable; keep those identities nullable.
      this.db.exec('ALTER TABLE guest_units ADD COLUMN email TEXT');
    }
    if (!guestColumns.some((column) => column.name === 'walk_in')) {
      this.db.exec('ALTER TABLE guest_units ADD COLUMN walk_in INTEGER NOT NULL DEFAULT 0');
    }
    const rsvpAttendeeTables = this.db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='rsvp_attendees'"
    ).all();
    if (rsvpAttendeeTables.length === 0) {
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS rsvp_attendees (
          id INTEGER PRIMARY KEY,
          guest_unit_id INTEGER NOT NULL REFERENCES guest_units(id) ON DELETE CASCADE,
          name TEXT NOT NULL DEFAULT '',
          dietary TEXT NOT NULL DEFAULT '',
          accessibility TEXT NOT NULL DEFAULT '',
          age_band TEXT NOT NULL DEFAULT 'adult' CHECK (age_band IN ('adult', 'child')),
          created_at TEXT NOT NULL
        );
      `);
    }
    const checkInTables = this.db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='check_ins'"
    ).all();
    if (checkInTables.length === 0) {
      this.db.exec(`
        CREATE TABLE check_ins (
          id INTEGER PRIMARY KEY,
          event_id INTEGER NOT NULL REFERENCES events(id) ON DELETE CASCADE,
          guest_unit_id INTEGER REFERENCES guest_units(id) ON DELETE CASCADE,
          attendee_id INTEGER REFERENCES rsvp_attendees(id) ON DELETE CASCADE,
          checked_in_at TEXT NOT NULL,
          reversed_at TEXT,
          created_at TEXT NOT NULL,
          CHECK ((guest_unit_id IS NOT NULL AND attendee_id IS NULL) OR
                 (guest_unit_id IS NULL AND attendee_id IS NOT NULL))
        );
        CREATE INDEX check_ins_event_idx ON check_ins(event_id, checked_in_at);
        CREATE UNIQUE INDEX check_ins_guest_active_idx
          ON check_ins(guest_unit_id) WHERE guest_unit_id IS NOT NULL AND reversed_at IS NULL;
        CREATE UNIQUE INDEX check_ins_attendee_active_idx
          ON check_ins(attendee_id) WHERE attendee_id IS NOT NULL AND reversed_at IS NULL;
      `);
    }
  }

  close() { this.db.close(); }

  transaction(callback) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const value = callback();
      this.db.exec('COMMIT');
      return value;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  hostCount() {
    return Number(this.db.prepare('SELECT COUNT(*) AS count FROM hosts').get().count);
  }

  createFirstHost(email, passwordHash, createdAt) {
    return this.transaction(() => {
      if (this.hostCount()) {
        const error = new Error('Host account already exists.');
        error.code = 'SQLITE_CONSTRAINT_UNIQUE';
        throw error;
      }
      return this.db.prepare(
        'INSERT INTO hosts (email, password_hash, created_at) VALUES (?, ?, ?)'
      ).run(email, passwordHash, createdAt).lastInsertRowid;
    });
  }

  createHost(email, passwordHash, createdAt) {
    return this.db.prepare(
      'INSERT INTO hosts (email, password_hash, created_at) VALUES (?, ?, ?)'
    ).run(email, passwordHash, createdAt).lastInsertRowid;
  }

  getHostByEmail(email) {
    return this.db.prepare('SELECT * FROM hosts WHERE email = ?').get(email);
  }

  createSession(tokenHash, hostId, expiresAt) {
    this.db.prepare(
      'INSERT INTO sessions (token_hash, host_id, expires_at) VALUES (?, ?, ?)'
    ).run(tokenHash, hostId, expiresAt);
  }

  getSession(tokenHash, at) {
    return this.db.prepare(
      `SELECT hosts.id, hosts.email FROM sessions
       JOIN hosts ON hosts.id = sessions.host_id
       WHERE sessions.token_hash = ? AND sessions.expires_at > ?`
    ).get(tokenHash, at);
  }

  deleteSession(tokenHash) {
    this.db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(tokenHash);
  }

  createEvent(hostId, event, createdAt) {
    return this.db.prepare(
      `INSERT INTO events
       (host_id, title, event_date, event_start_time, event_end_time, event_timezone,
        location, guest_mode, rsvp_deadline, capacity, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(hostId, event.title, event.eventDate, event.eventStartTime ?? null,
      event.eventEndTime ?? null, event.timezone ?? null, event.location, event.guestMode,
      event.rsvpDeadline, event.capacity ?? null, createdAt).lastInsertRowid;
  }

  listEvents(hostId) {
    return this.db.prepare(
            `SELECT e.id, e.title, e.event_date AS eventDate,
              e.event_start_time AS eventStartTime, e.event_end_time AS eventEndTime,
              e.event_timezone AS timezone, e.location,
              e.guest_mode AS guestMode, e.rsvp_deadline AS rsvpDeadline,
              e.capacity,
              e.responses_open AS responsesOpen, e.reopened_at AS reopenedAt,
              e.status, e.status_note AS statusNote,
              e.replacement_event_date AS replacementEventDate,
              e.replacement_event_start_time AS replacementEventStartTime,
              e.replacement_event_end_time AS replacementEventEndTime,
              e.replacement_event_timezone AS replacementTimezone,
              e.published, e.theme_json AS themeJson,
              e.invitation_settings_json AS invitationSettingsJson,
              e.invitation_copy_json AS invitationCopyJson,
              COUNT(g.id) AS invitedUnits,
              SUM(CASE WHEN g.revoked_at IS NOT NULL THEN 1 ELSE 0 END) AS revokedUnits,
              SUM(CASE WHEN r.answer = 'yes' THEN 1 ELSE 0 END) AS yesUnits,
              SUM(CASE WHEN r.answer = 'no' THEN 1 ELSE 0 END) AS noUnits,
              SUM(CASE WHEN r.answer = 'maybe' THEN 1 ELSE 0 END) AS maybeUnits,
              SUM(CASE WHEN r.answer = 'yes' THEN r.party_size ELSE 0 END) AS attendingPeople
       FROM events e
       LEFT JOIN guest_units g ON g.event_id = e.id
       LEFT JOIN rsvps r ON r.guest_unit_id = g.id
       WHERE e.host_id = ? GROUP BY e.id ORDER BY e.created_at DESC`
    ).all(hostId).map(({ themeJson, invitationSettingsJson, invitationCopyJson, ...row }) => ({
      ...row,
      theme: storedTheme(themeJson),
      invitationSettings: storedInvitationSettings(invitationSettingsJson),
      invitationCopy: storedInvitationCopy(invitationCopyJson),
      responsesOpen: Boolean(row.responsesOpen),
      invitedUnits: Number(row.invitedUnits || 0),
      revokedUnits: Number(row.revokedUnits || 0),
      yesUnits: Number(row.yesUnits || 0),
      noUnits: Number(row.noUnits || 0),
      maybeUnits: Number(row.maybeUnits || 0),
      attendingPeople: Number(row.attendingPeople || 0),
      remainingCapacity: row.capacity === null ? null : Math.max(0, Number(row.capacity) - Number(row.attendingPeople || 0)),
      published: Boolean(row.published)
    }));
  }

  getEventForHost(eventId, hostId) {
    const event = this.db.prepare(
            `SELECT id, host_id AS hostId, title, event_date AS eventDate,
              event_start_time AS eventStartTime, event_end_time AS eventEndTime,
              event_timezone AS timezone, location,
              guest_mode AS guestMode, rsvp_deadline AS rsvpDeadline,
              capacity,
              responses_open AS responsesOpen, reopened_at AS reopenedAt,
              status, status_note AS statusNote,
              replacement_event_date AS replacementEventDate,
              replacement_event_start_time AS replacementEventStartTime,
              replacement_event_end_time AS replacementEventEndTime,
              replacement_event_timezone AS replacementTimezone,
              published, theme_json AS themeJson,
              invitation_settings_json AS invitationSettingsJson,
              invitation_copy_json AS invitationCopyJson
       FROM events WHERE id = ? AND host_id = ?`
    ).get(eventId, hostId);
    if (!event) return event;
    const { invitationSettingsJson, invitationCopyJson, ...result } = event;
    return {
      ...result,
      theme: storedTheme(event.themeJson),
      invitationSettings: storedInvitationSettings(invitationSettingsJson),
      invitationCopy: storedInvitationCopy(invitationCopyJson)
    };
  }

  updateEventTheme(eventId, hostId, theme) {
    return this.db.prepare(
      'UPDATE events SET theme_json = ? WHERE id = ? AND host_id = ?'
    ).run(JSON.stringify(theme), eventId, hostId).changes;
  }

  updateEventInvitationSettings(eventId, hostId, settings) {
    return this.db.prepare(
      'UPDATE events SET invitation_settings_json = ? WHERE id = ? AND host_id = ?'
    ).run(JSON.stringify(settings), eventId, hostId).changes;
  }

  updateEventInvitationCopy(eventId, hostId, copy) {
    return this.db.prepare(
      'UPDATE events SET invitation_copy_json = ? WHERE id = ? AND host_id = ?'
    ).run(JSON.stringify(copy), eventId, hostId).changes;
  }

  updateEventStatus(eventId, hostId, status, statusNote, replacement = {}) {
    return this.db.prepare(
      `UPDATE events SET status = ?, status_note = ?, replacement_event_date = ?,
       replacement_event_start_time = ?, replacement_event_end_time = ?,
       replacement_event_timezone = ? WHERE id = ? AND host_id = ?`
    ).run(status, statusNote, replacement.eventDate || null, replacement.startTime || null,
      replacement.endTime || null, replacement.timezone || null, eventId, hostId).changes;
  }

  updateEvent(eventId, hostId, event) {
    return this.db.prepare(
      `UPDATE events SET title = ?, event_date = ?, event_start_time = ?,
       event_end_time = ?, event_timezone = ?, location = ?, rsvp_deadline = ?,
       capacity = ? WHERE id = ? AND host_id = ?`
    ).run(event.title, event.eventDate, event.eventStartTime, event.eventEndTime,
      event.timezone, event.location, event.rsvpDeadline, event.capacity, eventId, hostId).changes;
  }

  createGuestAndOutbox(guest, message, createdAt) {
    return this.createGuestsAndOutbox([{ guest, message, createdAt }])[0];
  }

  createGuestsAndOutbox(entries) {
    return this.transaction(() => {
      const insertGuest = this.db.prepare(
        `INSERT INTO guest_units (event_id, name, email, party_limit, token_hash, invite_url, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      );
      const insertOutbox = this.db.prepare(
        `INSERT INTO email_outbox (guest_unit_id, recipient, subject, body, created_at)
         VALUES (?, ?, ?, ?, ?)`
      );
      return entries.map(({ guest, message, createdAt }) => {
        const inserted = insertGuest.run(
          guest.eventId, guest.name, guest.email, guest.partyLimit,
          guest.tokenHash, guest.inviteUrl, createdAt
        );
        const id = Number(inserted.lastInsertRowid);
        insertOutbox.run(id, message.recipient, message.subject, message.body, createdAt);
        return id;
      });
    });
  }

  dashboardGuests(eventId, hostId) {
    return this.db.prepare(
      `SELECT g.id, g.name, g.email, g.party_limit AS partyLimit,
              g.revoked_at AS revokedAt, g.walk_in AS walkIn,
              r.answer, r.party_size AS partySize,
              r.updated_at AS updatedAt
       FROM guest_units g JOIN events e ON e.id = g.event_id
       LEFT JOIN rsvps r ON r.guest_unit_id = g.id
       WHERE g.event_id = ? AND e.host_id = ? ORDER BY g.created_at`
    ).all(eventId, hostId);
  }

  exportGuests(eventId, hostId) {
    return this.dashboardGuests(eventId, hostId);
  }

  revokeGuest(guestId, hostId, revokedAt) {
    return this.db.prepare(
      `UPDATE guest_units SET revoked_at = ?
       WHERE id = ? AND revoked_at IS NULL AND EXISTS (
         SELECT 1 FROM events WHERE events.id = guest_units.event_id AND events.host_id = ?
       )`
    ).run(revokedAt, guestId, hostId).changes;
  }

  guestInviteLink(guestId, hostId) {
    return this.db.prepare(
      `SELECT g.revoked_at AS revokedAt, g.invite_url AS inviteUrl
       FROM guest_units g
       JOIN events e ON e.id = g.event_id
       WHERE g.id = ? AND e.host_id = ?`
    ).get(guestId, hostId);
  }

  emailExists(eventId, email) {
    return Boolean(this.db.prepare(
      'SELECT 1 FROM guest_units WHERE event_id = ? AND email = ?'
    ).get(eventId, email));
  }

  attendingPeopleForEvent(eventId) {
    return Number(this.db.prepare(
      `SELECT COALESCE(SUM(r.party_size), 0) AS attending
       FROM rsvps r JOIN guest_units g ON g.id = r.guest_unit_id
       WHERE g.event_id = ? AND r.answer = 'yes'`
    ).get(eventId).attending);
  }

  setEventOpen(eventId, hostId, open, updatedAt) {
    return this.db.prepare(
      `UPDATE events
       SET responses_open = ?,
           reopened_at = CASE
             WHEN ? = 1 AND rsvp_deadline IS NOT NULL AND rsvp_deadline <= ? THEN ?
             ELSE NULL
           END
       WHERE id = ? AND host_id = ?`
    ).run(open ? 1 : 0, open ? 1 : 0, updatedAt, updatedAt, eventId, hostId).changes;
  }

  publishEvent(eventId, hostId) {
    return this.db.prepare(
      'UPDATE events SET published = 1 WHERE id = ? AND host_id = ?'
    ).run(eventId, hostId).changes;
  }

  getGuestByToken(tokenHash) {
    const guest = this.db.prepare(
      `SELECT g.id AS guestId, g.name, g.party_limit AS partyLimit,
              g.revoked_at AS revokedAt, e.id AS eventId, e.title,
              e.published, e.capacity, e.guest_mode AS guestMode,
              e.event_date AS eventDate,
              e.event_start_time AS eventStartTime, e.event_end_time AS eventEndTime,
              e.event_timezone AS timezone,
              e.replacement_event_date AS replacementEventDate,
              e.replacement_event_start_time AS replacementEventStartTime,
              e.replacement_event_end_time AS replacementEventEndTime,
              e.replacement_event_timezone AS replacementTimezone,
              e.location, e.rsvp_deadline AS rsvpDeadline,
              e.responses_open AS responsesOpen, e.reopened_at AS reopenedAt,
              e.status, e.status_note AS statusNote,
              e.theme_json AS themeJson,
              e.invitation_settings_json AS invitationSettingsJson,
              e.invitation_copy_json AS invitationCopyJson,
              r.answer, r.party_size AS partySize, r.updated_at AS updatedAt
       FROM guest_units g JOIN events e ON e.id = g.event_id
       LEFT JOIN rsvps r ON r.guest_unit_id = g.id
       WHERE g.token_hash = ?`
    ).get(tokenHash);
    if (!guest) return guest;
    const { invitationSettingsJson, invitationCopyJson, ...result } = guest;
    return {
      ...result,
      theme: storedTheme(guest.themeJson),
      invitationSettings: storedInvitationSettings(invitationSettingsJson),
      invitationCopy: storedInvitationCopy(invitationCopyJson),
      attendees: this.attendeesForGuest(guest.guestId)
    };
  }

  saveRsvp(guestId, answer, partySize, updatedAt, attendees = []) {
    return this.transaction(() => {
      const guest = this.db.prepare(
        'SELECT id FROM guest_units WHERE id = ?'
      ).get(guestId);
      if (!guest) {
        const error = new Error('Guest not found.');
        error.code = 'NOT_FOUND';
        throw error;
      }
      this.db.prepare(
        `INSERT INTO rsvps (guest_unit_id, answer, party_size, updated_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(guest_unit_id) DO UPDATE SET
           answer = excluded.answer, party_size = excluded.party_size,
           updated_at = excluded.updated_at`
      ).run(guestId, answer, partySize, updatedAt);
      // Replace attendee details for this guest unit.
      this.db.prepare('DELETE FROM rsvp_attendees WHERE guest_unit_id = ?').run(guestId);
      const insert = this.db.prepare(
        `INSERT INTO rsvp_attendees (guest_unit_id, name, dietary, accessibility, age_band, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`
      );
      for (const attendee of attendees) {
        insert.run(
          guestId,
          String(attendee.name || '').trim().slice(0, 100),
          String(attendee.dietary || '').trim().slice(0, 200),
          String(attendee.accessibility || '').trim().slice(0, 200),
          attendee.ageBand === 'child' ? 'child' : 'adult',
          updatedAt
        );
      }
      return true;
    });
  }

  attendeesForGuest(guestId) {
    return this.db.prepare(
      `SELECT id, name, dietary, accessibility, age_band AS ageBand
       FROM rsvp_attendees WHERE guest_unit_id = ? ORDER BY id`
    ).all(guestId);
  }

  checkInState(eventId, hostId) {
    const rows = this.db.prepare(
      `SELECT c.id, c.guest_unit_id AS guestUnitId, c.attendee_id AS attendeeId,
              c.checked_in_at AS checkedInAt, c.reversed_at AS reversedAt
       FROM check_ins c JOIN events e ON e.id = c.event_id
       WHERE c.event_id = ? AND e.host_id = ? ORDER BY c.id`
    ).all(eventId, hostId);
    return rows;
  }

  checkInTarget(eventId, hostId, target, checkedInAt, createdAt) {
    return this.transaction(() => {
      const targetColumn = target.attendeeId ? 'attendee_id' : 'guest_unit_id';
      const targetId = target.attendeeId || target.guestUnitId;
      const targetRow = target.attendeeId
        ? this.db.prepare(
          `SELECT a.id, a.guest_unit_id AS guestUnitId FROM rsvp_attendees a
           JOIN guest_units g ON g.id = a.guest_unit_id JOIN events e ON e.id = g.event_id
           WHERE a.id = ? AND e.id = ? AND e.host_id = ?`
        ).get(targetId, eventId, hostId)
        : this.db.prepare(
          `SELECT g.id, g.event_id AS eventId FROM guest_units g
           JOIN events e ON e.id = g.event_id WHERE g.id = ? AND e.id = ? AND e.host_id = ?`
        ).get(targetId, eventId, hostId);
      if (!targetRow) return null;
      const activeTarget = this.db.prepare(
        `SELECT id FROM check_ins WHERE ${targetColumn} = ? AND reversed_at IS NULL`
      ).get(targetId);
      if (activeTarget) return { duplicate: true };
      const conflicting = target.attendeeId
        ? this.db.prepare(
          `SELECT 1 FROM check_ins c WHERE c.guest_unit_id = ? AND c.reversed_at IS NULL`
        ).get(targetRow.guestUnitId)
        : this.db.prepare(
          `SELECT 1 FROM check_ins c WHERE c.guest_unit_id = ? AND c.reversed_at IS NULL
           UNION ALL
           SELECT 1 FROM check_ins c JOIN rsvp_attendees a ON a.id = c.attendee_id
           WHERE a.guest_unit_id = ? AND c.reversed_at IS NULL`
        ).get(targetId, targetId);
      if (conflicting) return { conflict: true };
      const existing = this.db.prepare(
        `SELECT id FROM check_ins WHERE ${targetColumn} = ? ORDER BY id DESC LIMIT 1`
      ).get(targetId);
      if (existing) {
        this.db.prepare(
          `UPDATE check_ins SET checked_in_at = ?, reversed_at = NULL WHERE id = ?`
        ).run(checkedInAt, existing.id);
        return { id: Number(existing.id), duplicate: false };
      }
      const columns = target.attendeeId ? 'event_id, attendee_id' : 'event_id, guest_unit_id';
      const inserted = this.db.prepare(
        `INSERT INTO check_ins (${columns}, checked_in_at, created_at) VALUES (?, ?, ?, ?)`
      ).run(eventId, targetId, checkedInAt, createdAt);
      return { id: Number(inserted.lastInsertRowid), duplicate: false };
    });
  }

  reverseCheckIn(eventId, hostId, target, reversedAt) {
    const targetColumn = target.attendeeId ? 'attendee_id' : 'guest_unit_id';
    const targetId = target.attendeeId || target.guestUnitId;
    return this.db.prepare(
      `UPDATE check_ins SET reversed_at = ? WHERE ${targetColumn} = ? AND event_id = ?
       AND reversed_at IS NULL AND EXISTS (SELECT 1 FROM events WHERE id = ? AND host_id = ?)`
    ).run(reversedAt, targetId, eventId, eventId, hostId).changes;
  }

  createWalkIn(eventId, hostId, name, attendeeName, createdAt) {
    return this.createWalkInWithOptions(eventId, hostId, name, attendeeName, createdAt);
  }

  createWalkInWithOptions(eventId, hostId, name, attendeeName, createdAt, options = {}) {
    return this.transaction(() => {
      const event = this.db.prepare('SELECT id, capacity FROM events WHERE id = ? AND host_id = ?').get(eventId, hostId);
      if (!event) return null;
      const attending = this.db.prepare(
        `SELECT COALESCE(SUM(r.party_size), 0) AS attending
         FROM rsvps r JOIN guest_units g ON g.id = r.guest_unit_id
         WHERE g.event_id = ? AND r.answer = 'yes'`
      ).get(eventId).attending;
      if (event.capacity !== null && Number(attending) + 1 > Number(event.capacity) && !options.override) {
        return { overCapacity: true, capacity: Number(event.capacity), attending: Number(attending) };
      }
      const tokenHash = `walk-in-${crypto.randomUUID()}`;
      const email = `walk-in-${crypto.randomUUID()}@example.test`;
      const guestId = Number(this.db.prepare(
        `INSERT INTO guest_units (event_id, name, email, party_limit, token_hash, invite_url, walk_in, created_at)
         VALUES (?, ?, ?, 1, ?, '', 1, ?)`
      ).run(eventId, name, email, tokenHash, createdAt).lastInsertRowid);
      this.db.prepare(
        `INSERT INTO rsvps (guest_unit_id, answer, party_size, updated_at) VALUES (?, 'yes', 1, ?)`
      ).run(guestId, createdAt);
      const attendeeId = Number(this.db.prepare(
        `INSERT INTO rsvp_attendees (guest_unit_id, name, dietary, accessibility, age_band, created_at)
         VALUES (?, ?, '', '', 'adult', ?)`
      ).run(guestId, attendeeName || name, createdAt).lastInsertRowid);
      return { guestId, attendeeId, overCapacity: false };
    });
  }

  listOutbox(hostId) {
    return this.db.prepare(
      `SELECT o.id, o.recipient, o.subject, o.body, o.created_at AS createdAt,
              'invitation' AS messageType
       FROM email_outbox o
       JOIN guest_units g ON g.id = o.guest_unit_id
       JOIN events e ON e.id = g.event_id
       WHERE e.host_id = ?
       UNION ALL
       SELECT m.id, m.recipient, m.subject, m.body, m.created_at AS createdAt,
              'preview' AS messageType
       FROM local_messages m JOIN events e ON e.id = m.event_id
       WHERE e.host_id = ?
       ORDER BY createdAt DESC LIMIT 100`
    ).all(hostId, hostId);
  }

  eventRecipients(eventId, hostId, filter) {
    const answers = { pending: 'r.answer IS NULL', yes: "r.answer = 'yes'", maybe: "r.answer = 'maybe'", no: "r.answer = 'no'" };
    const answerClause = answers[filter] ? ` AND ${answers[filter]}` : '';
    return this.db.prepare(
      `SELECT g.email AS recipient, g.name
       FROM guest_units g JOIN events e ON e.id = g.event_id
       LEFT JOIN rsvps r ON r.guest_unit_id = g.id
       WHERE g.event_id = ? AND e.host_id = ? AND g.revoked_at IS NULL
         AND g.email IS NOT NULL${answerClause}
       ORDER BY g.created_at`
    ).all(eventId, hostId);
  }

  captureEventMessages(eventId, hostId, messages, createdAt) {
    return this.transaction(() => {
      const event = this.db.prepare('SELECT id FROM events WHERE id = ? AND host_id = ?').get(eventId, hostId);
      if (!event) return 0;
      const insert = this.db.prepare(
        `INSERT INTO local_messages (event_id, recipient, subject, body, created_at)
         VALUES (?, ?, ?, ?, ?)`
      );
      for (const message of messages) {
        insert.run(eventId, message.recipient, message.subject, message.body, createdAt);
      }
      return messages.length;
    });
  }
}

module.exports = {
  Store, DEFAULT_THEME, DEFAULT_INVITATION_SETTINGS, DEFAULT_INVITATION_COPY
};
