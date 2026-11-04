'use strict';

const fs = require('node:fs');
const path = require('node:path');
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
        location TEXT NOT NULL DEFAULT '',
        guest_mode TEXT NOT NULL CHECK (guest_mode IN ('individual', 'household')),
        rsvp_deadline TEXT,
        responses_open INTEGER NOT NULL DEFAULT 1 CHECK (responses_open IN (0, 1)),
        reopened_at TEXT,
        created_at TEXT NOT NULL,
        published INTEGER NOT NULL DEFAULT 0 CHECK (published IN (0, 1)),
        theme_json TEXT NOT NULL DEFAULT '${JSON.stringify(DEFAULT_THEME)}',
        invitation_settings_json TEXT NOT NULL DEFAULT '${JSON.stringify(DEFAULT_INVITATION_SETTINGS)}'
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
      CREATE TABLE IF NOT EXISTS email_outbox (
        id INTEGER PRIMARY KEY,
        guest_unit_id INTEGER NOT NULL REFERENCES guest_units(id) ON DELETE CASCADE,
        recipient TEXT NOT NULL,
        subject TEXT NOT NULL,
        body TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS sessions_expiry_idx ON sessions(expires_at);
      CREATE INDEX IF NOT EXISTS events_host_idx ON events(host_id, created_at);
      CREATE INDEX IF NOT EXISTS guests_event_idx ON guest_units(event_id, created_at);
      CREATE INDEX IF NOT EXISTS outbox_guest_idx ON email_outbox(guest_unit_id, created_at);
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
    const guestColumns = this.db.prepare('PRAGMA table_info(guest_units)').all();
    if (!guestColumns.some((column) => column.name === 'invite_url')) {
      this.db.exec('ALTER TABLE guest_units ADD COLUMN invite_url TEXT NOT NULL DEFAULT ""');
    }
    if (!guestColumns.some((column) => column.name === 'email')) {
      // Legacy schema without email; nothing to backfill safely.
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
       (host_id, title, event_date, location, guest_mode, rsvp_deadline, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).run(hostId, event.title, event.eventDate, event.location, event.guestMode,
      event.rsvpDeadline, createdAt).lastInsertRowid;
  }

  listEvents(hostId) {
    return this.db.prepare(
      `SELECT e.id, e.title, e.event_date AS eventDate, e.location,
              e.guest_mode AS guestMode, e.rsvp_deadline AS rsvpDeadline,
              e.responses_open AS responsesOpen, e.reopened_at AS reopenedAt,
              e.published, e.theme_json AS themeJson,
              e.invitation_settings_json AS invitationSettingsJson,
              COUNT(g.id) AS invitedUnits,
              SUM(CASE WHEN r.answer = 'yes' THEN 1 ELSE 0 END) AS yesUnits,
              SUM(CASE WHEN r.answer = 'no' THEN 1 ELSE 0 END) AS noUnits,
              SUM(CASE WHEN r.answer = 'maybe' THEN 1 ELSE 0 END) AS maybeUnits,
              SUM(CASE WHEN r.answer = 'yes' THEN r.party_size ELSE 0 END) AS attendingPeople
       FROM events e
       LEFT JOIN guest_units g ON g.event_id = e.id
       LEFT JOIN rsvps r ON r.guest_unit_id = g.id
       WHERE e.host_id = ? GROUP BY e.id ORDER BY e.created_at DESC`
    ).all(hostId).map(({ themeJson, invitationSettingsJson, ...row }) => ({
      ...row,
      theme: storedTheme(themeJson),
      invitationSettings: storedInvitationSettings(invitationSettingsJson),
      responsesOpen: Boolean(row.responsesOpen),
      invitedUnits: Number(row.invitedUnits || 0),
      yesUnits: Number(row.yesUnits || 0),
      noUnits: Number(row.noUnits || 0),
      maybeUnits: Number(row.maybeUnits || 0),
      attendingPeople: Number(row.attendingPeople || 0),
      published: Boolean(row.published)
    }));
  }

  getEventForHost(eventId, hostId) {
    const event = this.db.prepare(
      `SELECT id, host_id AS hostId, title, event_date AS eventDate, location,
              guest_mode AS guestMode, rsvp_deadline AS rsvpDeadline,
              responses_open AS responsesOpen, reopened_at AS reopenedAt,
              published, theme_json AS themeJson,
              invitation_settings_json AS invitationSettingsJson
       FROM events WHERE id = ? AND host_id = ?`
    ).get(eventId, hostId);
    if (!event) return event;
    const { invitationSettingsJson, ...result } = event;
    return {
      ...result,
      theme: storedTheme(event.themeJson),
      invitationSettings: storedInvitationSettings(invitationSettingsJson)
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
              g.revoked_at AS revokedAt, r.answer, r.party_size AS partySize,
              r.updated_at AS updatedAt
       FROM guest_units g JOIN events e ON e.id = g.event_id
       LEFT JOIN rsvps r ON r.guest_unit_id = g.id
       WHERE g.event_id = ? AND e.host_id = ? ORDER BY g.created_at`
    ).all(eventId, hostId);
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
              g.revoked_at AS revokedAt, e.title, e.event_date AS eventDate,
              e.location, e.rsvp_deadline AS rsvpDeadline,
              e.responses_open AS responsesOpen, e.reopened_at AS reopenedAt,
              e.theme_json AS themeJson,
              e.invitation_settings_json AS invitationSettingsJson,
              r.answer, r.party_size AS partySize, r.updated_at AS updatedAt
       FROM guest_units g JOIN events e ON e.id = g.event_id
       LEFT JOIN rsvps r ON r.guest_unit_id = g.id
       WHERE g.token_hash = ?`
    ).get(tokenHash);
    if (!guest) return guest;
    const { invitationSettingsJson, ...result } = guest;
    return {
      ...result,
      theme: storedTheme(guest.themeJson),
      invitationSettings: storedInvitationSettings(invitationSettingsJson)
    };
  }

  saveRsvp(guestId, answer, partySize, updatedAt) {
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
      return true;
    });
  }

  listOutbox(hostId) {
    return this.db.prepare(
      `SELECT o.id, o.recipient, o.subject, o.body, o.created_at AS createdAt
       FROM email_outbox o
       JOIN guest_units g ON g.id = o.guest_unit_id
       JOIN events e ON e.id = g.event_id
       WHERE e.host_id = ? ORDER BY o.created_at DESC LIMIT 100`
    ).all(hostId);
  }
}

module.exports = { Store, DEFAULT_THEME, DEFAULT_INVITATION_SETTINGS };
