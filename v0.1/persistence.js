'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');

const sha256 = (value) => crypto.createHash('sha256').update(value).digest('hex');
function legacyInvitationUrl(record) {
  const prefix = `Hello ${record.name}\n\nYou are invited to ${record.title} on ${record.eventDate}.\nRSVP using your private local link: `;
  const suffix = '\n\nLocal email capture only. No email was sent.';
  if (typeof record.body !== 'string' || !record.body.startsWith(prefix) || !record.body.endsWith(suffix)) {
    return null;
  }
  if (record.subject !== `Your invitation: ${record.title}` ||
      (record.email !== null && record.recipient !== record.email)) {
    return null;
  }
  const inviteUrl = record.body.slice(prefix.length, -suffix.length);
  if (!/^\/rsvp\/[A-Za-z0-9_-]{30,60}$/.test(inviteUrl)) return null;
  return sha256(inviteUrl.slice('/rsvp/'.length)) === record.tokenHash ? inviteUrl : null;
}

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
  footerNote: '',
  image: null,
  imageShape: 'circle',
  imageAlt: ''
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
    const legacy = ['greeting', 'title', 'intro', 'rsvpHeading', 'rsvpHelper', 'footerNote'].sort();
    const expected = Object.keys(DEFAULT_INVITATION_COPY).sort();
    if (copy && typeof copy === 'object' && !Array.isArray(copy) &&
        (keys.join(',') === legacy.join(',') || keys.join(',') === expected.join(',')) &&
        legacy.every((key) => typeof copy[key] === 'string')) {
      let image = null;
      if (copy.image === null || copy.image === undefined) {
        image = null;
      } else if (typeof copy.image === 'string') {
        const match = /^data:image\/(?:png|jpeg|webp);base64,([A-Za-z0-9+/]+={0,2})$/.exec(copy.image);
        if (match && match[1].length % 4 === 0) {
          const decoded = Buffer.from(match[1], 'base64');
          if (decoded.length > 0 && decoded.length <= 1024 * 1024 && decoded.toString('base64') === match[1]) {
            image = copy.image;
          }
        }
      }
      const imageShape = ['circle', 'rounded-square', 'square', 'arch'].includes(copy.imageShape)
        ? copy.imageShape : DEFAULT_INVITATION_COPY.imageShape;
      const imageAlt = typeof copy.imageAlt === 'string' && copy.imageAlt.length <= 200 ? copy.imageAlt : '';
      return { ...DEFAULT_INVITATION_COPY, ...copy, image, imageShape, imageAlt };
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
        ['small', 'medium', 'large'].includes(theme.fontSize || 'medium') &&
        validCoverImage) {
      const result = {
        preset: theme.preset,
        primaryColor: theme.primaryColor,
        backgroundColor: theme.backgroundColor,
        textColor: theme.textColor,
        fontFamily: theme.fontFamily,
        coverImage: theme.coverImage
      };
      if (['small', 'medium', 'large'].includes(theme.fontSize)) result.fontSize = theme.fontSize;
      return result;
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
      CREATE TABLE IF NOT EXISTS seating_plans (
        id INTEGER PRIMARY KEY,
        event_id INTEGER NOT NULL REFERENCES events(id) ON DELETE CASCADE,
        name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 100),
        status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'saved', 'published', 'stale', 'archived')),
        algorithm_version TEXT NOT NULL DEFAULT 'heuristic-1',
        seed INTEGER NOT NULL DEFAULT 1,
        input_hash TEXT NOT NULL DEFAULT '',
        score INTEGER NOT NULL DEFAULT 0,
        payload_json TEXT NOT NULL DEFAULT '{}',
        venue_items_json TEXT NOT NULL DEFAULT '[]',
        floor_plan_json TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        published_at TEXT
      );
      CREATE TABLE IF NOT EXISTS seating_tables (
        id INTEGER PRIMARY KEY,
        plan_id INTEGER NOT NULL REFERENCES seating_plans(id) ON DELETE CASCADE,
        name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 100),
        capacity INTEGER NOT NULL CHECK (capacity BETWEEN 1 AND 100),
        shape TEXT NOT NULL DEFAULT 'round' CHECK (shape IN ('round', 'rectangle', 'square', 'banquet')),
        position_x REAL NOT NULL DEFAULT 50,
        position_y REAL NOT NULL DEFAULT 50,
        initial_position_x REAL NOT NULL DEFAULT 50,
        initial_position_y REAL NOT NULL DEFAULT 50,
        sort_order INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS seating_assignments (
        plan_id INTEGER NOT NULL REFERENCES seating_plans(id) ON DELETE CASCADE,
        attendee_id INTEGER NOT NULL REFERENCES rsvp_attendees(id) ON DELETE CASCADE,
        table_id INTEGER NOT NULL REFERENCES seating_tables(id) ON DELETE CASCADE,
        PRIMARY KEY (plan_id, attendee_id),
        UNIQUE (plan_id, attendee_id, table_id)
      );
      CREATE TABLE IF NOT EXISTS seating_constraints (
        id INTEGER PRIMARY KEY,
        plan_id INTEGER NOT NULL REFERENCES seating_plans(id) ON DELETE CASCADE,
        relationship_type TEXT NOT NULL CHECK (relationship_type IN ('keep-together', 'keep-apart')),
        relationship TEXT NOT NULL DEFAULT '',
        priority TEXT NOT NULL DEFAULT 'preferred' CHECK (priority IN ('required', 'preferred')),
        attendee_ids_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS sessions_expiry_idx ON sessions(expires_at);
      CREATE INDEX IF NOT EXISTS events_host_idx ON events(host_id, created_at);
      CREATE INDEX IF NOT EXISTS guests_event_idx ON guest_units(event_id, created_at);
      CREATE INDEX IF NOT EXISTS outbox_guest_idx ON email_outbox(guest_unit_id, created_at);
      CREATE INDEX IF NOT EXISTS local_messages_event_idx ON local_messages(event_id, created_at);
      CREATE INDEX IF NOT EXISTS check_ins_event_idx ON check_ins(event_id, checked_in_at);
      CREATE INDEX IF NOT EXISTS seating_plans_event_idx ON seating_plans(event_id, updated_at);
      CREATE INDEX IF NOT EXISTS seating_assignments_plan_idx ON seating_assignments(plan_id, table_id);
      CREATE INDEX IF NOT EXISTS seating_constraints_plan_idx ON seating_constraints(plan_id, id);
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
    const seatingTableColumns = this.db.prepare('PRAGMA table_info(seating_tables)').all();
    const seatingConstraintColumns = this.db.prepare('PRAGMA table_info(seating_constraints)').all();
    const seatingPlanColumns = this.db.prepare('PRAGMA table_info(seating_plans)').all();
    if (seatingPlanColumns.length > 0 && !seatingPlanColumns.some((column) => column.name === 'venue_items_json')) {
      this.db.exec("ALTER TABLE seating_plans ADD COLUMN venue_items_json TEXT NOT NULL DEFAULT '[]'");
    }
    if (seatingPlanColumns.length > 0 && !seatingPlanColumns.some((column) => column.name === 'floor_plan_json')) {
      this.db.exec("ALTER TABLE seating_plans ADD COLUMN floor_plan_json TEXT NOT NULL DEFAULT '{}'");
    }
    if (seatingTableColumns.length > 0 && !seatingTableColumns.some((column) => column.name === 'shape')) {
      this.db.exec("ALTER TABLE seating_tables ADD COLUMN shape TEXT NOT NULL DEFAULT 'round'");
      this.db.exec('ALTER TABLE seating_tables ADD COLUMN position_x REAL NOT NULL DEFAULT 50');
      this.db.exec('ALTER TABLE seating_tables ADD COLUMN position_y REAL NOT NULL DEFAULT 50');
    }
    if (seatingConstraintColumns.length > 0 &&
        !seatingConstraintColumns.some((column) => column.name === 'relationship')) {
      this.db.exec("ALTER TABLE seating_constraints ADD COLUMN relationship TEXT NOT NULL DEFAULT ''");
    }
    const refreshedSeatingTableColumns = this.db.prepare('PRAGMA table_info(seating_tables)').all();
    if (refreshedSeatingTableColumns.length > 0 &&
        !refreshedSeatingTableColumns.some((column) => column.name === 'initial_position_x')) {
      this.db.exec('ALTER TABLE seating_tables ADD COLUMN initial_position_x REAL NOT NULL DEFAULT 50');
      this.db.exec('ALTER TABLE seating_tables ADD COLUMN initial_position_y REAL NOT NULL DEFAULT 50');
      this.db.exec('UPDATE seating_tables SET initial_position_x = position_x, initial_position_y = position_y');
    }
    this.backfillLegacyInviteUrls();
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

  backfillLegacyInviteUrls() {
    const candidates = this.db.prepare(
      `SELECT g.id, g.name, g.email, g.token_hash AS tokenHash,
              e.title, e.event_date AS eventDate,
              o.recipient, o.subject, o.body
       FROM guest_units g
       JOIN events e ON e.id = g.event_id
       JOIN email_outbox o ON o.guest_unit_id = g.id
       WHERE g.invite_url IS NULL OR g.invite_url = ''
       ORDER BY g.id, o.id`
    ).all();
    const update = this.db.prepare(
      "UPDATE guest_units SET invite_url = ? WHERE id = ? AND (invite_url IS NULL OR invite_url = '')"
    );
    const candidatesByGuest = new Map();
    for (const candidate of candidates) {
      const entries = candidatesByGuest.get(candidate.id) || [];
      entries.push(candidate);
      candidatesByGuest.set(candidate.id, entries);
    }
    this.transaction(() => {
      for (const [guestId, entries] of candidatesByGuest) {
        if (entries.length !== 1) continue;
        const inviteUrl = legacyInvitationUrl(entries[0]);
        if (inviteUrl) update.run(inviteUrl, guestId);
      }
    });
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

  cleanupExpiredSessions(at) {
    return this.db.prepare('DELETE FROM sessions WHERE expires_at <= ?').run(at).changes;
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
    const record = this.db.prepare(
      `SELECT g.id, g.name, g.email, g.token_hash AS tokenHash,
              g.revoked_at AS revokedAt, g.invite_url AS inviteUrl,
              g.walk_in AS walkIn, e.title, e.event_date AS eventDate
       FROM guest_units g
       JOIN events e ON e.id = g.event_id
       WHERE g.id = ? AND e.host_id = ?`
    ).get(guestId, hostId);
    if (!record || record.revokedAt || record.inviteUrl || record.walkIn) return record;
    const inviteUrl = this.recoverLegacyInviteUrl(record);
    if (!inviteUrl) return { ...record, inviteStatus: 'unrecoverable' };
    this.db.prepare(
      'UPDATE guest_units SET invite_url = ? WHERE id = ? AND (invite_url IS NULL OR invite_url = \'\')'
    ).run(inviteUrl, guestId);
    return { ...record, inviteUrl };
  }

  recoverLegacyInviteUrl(guest) {
    const entries = this.db.prepare(
      `SELECT recipient, subject, body FROM email_outbox
       WHERE guest_unit_id = ? ORDER BY id`
    ).all(guest.id);
    if (entries.length !== 1) return null;
    return legacyInvitationUrl({ ...guest, ...entries[0] });
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
        'SELECT id, event_id AS eventId FROM guest_units WHERE id = ?'
      ).get(guestId);
      if (!guest) {
        const error = new Error('Guest not found.');
        error.code = 'NOT_FOUND';
        throw error;
      }
      const event = this.db.prepare(
        `SELECT capacity,
                COALESCE((SELECT SUM(party_size) FROM rsvps
                          JOIN guest_units ON guest_units.id = rsvps.guest_unit_id
                          WHERE guest_units.event_id = events.id AND rsvps.answer = 'yes'), 0) AS attending
         FROM events WHERE id = ?`
      ).get(guest.eventId);
      if (answer === 'yes' && event.capacity !== null) {
        const previous = this.db.prepare(
          "SELECT party_size FROM rsvps WHERE guest_unit_id = ? AND answer = 'yes'"
        ).get(guestId);
        const replacement = previous ? Number(previous.party_size) : 0;
        if (Number(event.attending) - replacement + Number(partySize) > Number(event.capacity)) {
          const error = new Error(`This event has a capacity of ${event.capacity}; there are not enough remaining places.`);
          error.status = 409;
          error.code = 'CAPACITY_EXCEEDED';
          throw error;
        }
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
          (attendee.name || '').trim(),
          (attendee.dietary || '').trim(),
          (attendee.accessibility || '').trim(),
          attendee.ageBand === 'child' ? 'child' : 'adult',
          updatedAt
        );
      }
      this.db.prepare(
        `UPDATE seating_plans SET status = 'stale', updated_at = ?
         WHERE event_id = ? AND status IN ('draft', 'saved', 'published')`
      ).run(updatedAt, guest.eventId);
      return true;
    });
  }

  attendeesForGuest(guestId) {
    return this.db.prepare(
      `SELECT id, name, dietary, accessibility, age_band AS ageBand
       FROM rsvp_attendees WHERE guest_unit_id = ? ORDER BY id`
    ).all(guestId);
  }

  seatingAttendees(eventId, hostId) {
    return this.db.prepare(
      `SELECT a.id, a.guest_unit_id AS guestUnitId, a.name, a.dietary,
              a.accessibility, a.age_band AS ageBand, g.name AS groupName
       FROM rsvp_attendees a
       JOIN guest_units g ON g.id = a.guest_unit_id
       JOIN events e ON e.id = g.event_id
       JOIN rsvps r ON r.guest_unit_id = g.id
       WHERE g.event_id = ? AND e.host_id = ? AND r.answer = 'yes'
         AND g.revoked_at IS NULL AND a.name <> ''
       ORDER BY a.id`
    ).all(eventId, hostId);
  }

  listSeatingPlans(eventId, hostId) {
    return this.db.prepare(
      `SELECT p.id, p.name, p.status, p.algorithm_version AS algorithmVersion,
              p.seed, p.input_hash AS inputHash, p.score, p.created_at AS createdAt,
              p.updated_at AS updatedAt, p.published_at AS publishedAt
       FROM seating_plans p JOIN events e ON e.id = p.event_id
       WHERE p.event_id = ? AND e.host_id = ? ORDER BY p.updated_at DESC, p.id DESC`
    ).all(eventId, hostId).map((plan) => ({
      ...plan, id: Number(plan.id), seed: Number(plan.seed), score: Number(plan.score)
    }));
  }

  getSeatingPlan(planId, eventId, hostId) {
    const plan = this.db.prepare(
      `SELECT p.id, p.event_id AS eventId, p.name, p.status,
              p.algorithm_version AS algorithmVersion, p.seed, p.input_hash AS inputHash,
              p.score, p.payload_json AS payloadJson, p.venue_items_json AS venueItemsJson,
              p.floor_plan_json AS floorPlanJson, p.created_at AS createdAt,
              p.updated_at AS updatedAt, p.published_at AS publishedAt
       FROM seating_plans p JOIN events e ON e.id = p.event_id
       WHERE p.id = ? AND p.event_id = ? AND e.host_id = ?`
    ).get(planId, eventId, hostId);
    if (!plan) return null;
    let payload = {};
    try { payload = JSON.parse(plan.payloadJson); } catch { payload = {}; }
    let venueItems = [];
    try { venueItems = JSON.parse(plan.venueItemsJson); } catch { venueItems = []; }
    let floorPlan = {};
    try { floorPlan = JSON.parse(plan.floorPlanJson); } catch { floorPlan = {}; }
    const tables = this.db.prepare(
      `SELECT id, name, capacity, shape, position_x AS positionX, position_y AS positionY,
              sort_order AS sortOrder
       FROM seating_tables WHERE plan_id = ? ORDER BY sort_order, id`
    ).all(planId).map((table) => ({
      ...table, id: Number(table.id), capacity: Number(table.capacity),
      positionX: Number(table.positionX), positionY: Number(table.positionY),
      sortOrder: Number(table.sortOrder)
    }));
    const assignments = this.db.prepare(
      `SELECT attendee_id AS attendeeId, table_id AS tableId
       FROM seating_assignments WHERE plan_id = ? ORDER BY attendee_id`
    ).all(planId).map((assignment) => ({
      attendeeId: Number(assignment.attendeeId), tableId: Number(assignment.tableId)
    }));
    let constraints = this.db.prepare(
      `SELECT relationship_type AS relationshipType, relationship, priority, attendee_ids_json AS attendeeIdsJson
       FROM seating_constraints WHERE plan_id = ? ORDER BY id`
    ).all(planId).map((constraint) => {
      let attendeeIds = [];
      try { attendeeIds = JSON.parse(constraint.attendeeIdsJson); } catch { attendeeIds = []; }
      return {
        relationship: constraint.relationship || '', relationshipType: constraint.relationshipType,
        type: constraint.relationshipType === 'keep-together' ? 'together' : 'apart',
        priority: constraint.priority, attendeeIds: attendeeIds.map(Number)
      };
    });
    if (!constraints.length && Array.isArray(payload.constraints)) constraints = payload.constraints;
    return {
      id: Number(plan.id), eventId: Number(plan.eventId), name: plan.name, status: plan.status,
      algorithmVersion: plan.algorithmVersion, seed: Number(plan.seed), inputHash: plan.inputHash,
      score: Number(plan.score), createdAt: plan.createdAt, updatedAt: plan.updatedAt,
      publishedAt: plan.publishedAt, tables, assignments, venueItems, floorPlan, payload, ...payload, constraints
    };
  }

  createSeatingPlan(eventId, hostId, input, now) {
    return this.transaction(() => {
      const event = this.db.prepare('SELECT id FROM events WHERE id = ? AND host_id = ?')
        .get(eventId, hostId);
      if (!event) return null;
      const inserted = this.db.prepare(
        `INSERT INTO seating_plans
         (event_id, name, algorithm_version, seed, input_hash, payload_json, venue_items_json,
          floor_plan_json, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(eventId, input.name, input.algorithmVersion, input.seed, input.inputHash,
        JSON.stringify({ constraints: input.constraints || [], violations: [], unassigned: [] }),
        JSON.stringify(input.venueItems || []), JSON.stringify(input.floorPlan || {}), now, now);
      const planId = Number(inserted.lastInsertRowid);
      const insertTable = this.db.prepare(
        `INSERT INTO seating_tables
         (plan_id, name, capacity, shape, position_x, position_y, initial_position_x, initial_position_y, sort_order)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      );
      input.tables.forEach((table, index) => insertTable.run(
        planId, table.name, table.capacity, table.shape,
        table.positionX, table.positionY, table.positionX, table.positionY, index
      ));
      const insertConstraint = this.db.prepare(
        `INSERT INTO seating_constraints
         (plan_id, relationship_type, relationship, priority, attendee_ids_json, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      );
      (input.constraints || []).forEach((constraint) => insertConstraint.run(
        planId, constraint.relationshipType, constraint.relationship || '', constraint.priority,
        JSON.stringify(constraint.attendeeIds), now, now
      ));
      return planId;
    });
  }

  createSyntheticConfirmedGuests(eventId, hostId, entries, now) {
    return this.transaction(() => {
      const event = this.db.prepare('SELECT id FROM events WHERE id = ? AND host_id = ?')
        .get(eventId, hostId);
      if (!event) return null;
      const insertGuest = this.db.prepare(
        `INSERT INTO guest_units (event_id, name, email, party_limit, token_hash, invite_url, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      );
      const insertOutbox = this.db.prepare(
        `INSERT INTO email_outbox (guest_unit_id, recipient, subject, body, created_at)
         VALUES (?, ?, ?, ?, ?)`
      );
      const insertRsvp = this.db.prepare(
        `INSERT INTO rsvps (guest_unit_id, answer, party_size, updated_at) VALUES (?, 'yes', ?, ?)`
      );
      const insertAttendee = this.db.prepare(
        `INSERT INTO rsvp_attendees (guest_unit_id, name, dietary, accessibility, age_band, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`
      );
      const ids = entries.map((entry) => {
        const inserted = insertGuest.run(
          entry.eventId, entry.name, entry.email, entry.partyLimit,
          entry.tokenHash, entry.inviteUrl, entry.createdAt
        );
        const id = Number(inserted.lastInsertRowid);
        insertOutbox.run(id, entry.message.recipient, entry.message.subject, entry.message.body, entry.createdAt);
        insertRsvp.run(id, entry.partyLimit, now);
        entry.attendees.forEach((attendee) => insertAttendee.run(
          id, attendee.name, attendee.dietary || '', attendee.accessibility || '',
          attendee.ageBand === 'child' ? 'child' : 'adult', now
        ));
        return id;
      });
      return ids;
    });
  }

  saveSeatingResult(planId, eventId, hostId, result, now, status = 'saved', expectedInputHash = null) {
    return this.transaction(() => {
      const owned = this.db.prepare(
        `SELECT p.id, p.input_hash AS inputHash FROM seating_plans p JOIN events e ON e.id = p.event_id
         WHERE p.id = ? AND p.event_id = ? AND e.host_id = ?`
      ).get(planId, eventId, hostId);
      if (!owned) return false;
      if (expectedInputHash !== null && owned.inputHash !== expectedInputHash) return false;
      this.db.prepare(
        `UPDATE seating_plans SET status = ?, score = ?, input_hash = ?, payload_json = ?, updated_at = ?
         WHERE id = ?`
      ).run(status, result.score, result.inputHash, JSON.stringify(result.payload), now, planId);
      this.db.prepare('DELETE FROM seating_assignments WHERE plan_id = ?').run(planId);
      const insert = this.db.prepare(
        'INSERT INTO seating_assignments (plan_id, attendee_id, table_id) VALUES (?, ?, ?)'
      );
      for (const assignment of result.assignments) {
        insert.run(planId, assignment.attendeeId, assignment.tableId);
      }

      return true;
    });
  }

  updateSeatingTablePositions(planId, eventId, hostId, positions, now) {
    return this.transaction(() => {
      const owned = this.db.prepare(
        `SELECT p.id FROM seating_plans p JOIN events e ON e.id = p.event_id
         WHERE p.id = ? AND p.event_id = ? AND e.host_id = ?`
      ).get(planId, eventId, hostId);
      if (!owned) return false;
      const tableIds = this.db.prepare(
        'SELECT id FROM seating_tables WHERE plan_id = ?'
      ).all(planId).map((table) => Number(table.id));
      const validIds = new Set(tableIds);
      if (!positions.length || positions.some((position) => !validIds.has(Number(position.tableId))) ||
          new Set(positions.map((position) => Number(position.tableId))).size !== positions.length) {
        return false;
      }

      const update = this.db.prepare(
        'UPDATE seating_tables SET position_x = ?, position_y = ? WHERE id = ? AND plan_id = ?'
      );
      positions.forEach((position) => update.run(position.positionX, position.positionY, position.tableId, planId));
      this.db.prepare('UPDATE seating_plans SET updated_at = ? WHERE id = ?').run(now, planId);
      return true;
    });
  }

  updateSeatingConstraints(planId, eventId, hostId, constraints, inputHash, now) {
    return this.transaction(() => {
      const owned = this.db.prepare(
        `SELECT p.id, p.payload_json AS payloadJson FROM seating_plans p JOIN events e ON e.id = p.event_id
         WHERE p.id = ? AND p.event_id = ? AND e.host_id = ?`
      ).get(planId, eventId, hostId);
      if (!owned) return false;
      let payload = {};
      try { payload = JSON.parse(owned.payloadJson); } catch { payload = {}; }
      payload.constraints = constraints;
      payload.violations = [];
      this.db.prepare('DELETE FROM seating_constraints WHERE plan_id = ?').run(planId);
      const insertConstraint = this.db.prepare(
        `INSERT INTO seating_constraints
         (plan_id, relationship_type, relationship, priority, attendee_ids_json, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      );
      constraints.forEach((constraint) => insertConstraint.run(
        planId, constraint.relationshipType ||
          (constraint.type === 'together' ? 'keep-together' : 'keep-apart'),
        constraint.relationship || '', constraint.priority || 'preferred',
        JSON.stringify(constraint.attendeeIds), now, now
      ));
      this.db.prepare(
        `UPDATE seating_plans SET status = 'draft', input_hash = ?, payload_json = ?, updated_at = ?
         WHERE id = ?`
      ).run(inputHash, JSON.stringify(payload), now, planId);
      this.db.prepare('DELETE FROM seating_assignments WHERE plan_id = ?').run(planId);
      return true;
    });
  }



  resetSeatingTablePositions(planId, eventId, hostId, now) {
    return this.transaction(() => {
      const owned = this.db.prepare(
        `SELECT p.id FROM seating_plans p JOIN events e ON e.id = p.event_id
         WHERE p.id = ? AND p.event_id = ? AND e.host_id = ?`
      ).get(planId, eventId, hostId);
      if (!owned) return false;
      const tables = this.db.prepare(
        'SELECT id, sort_order AS sortOrder, initial_position_x AS initialX, initial_position_y AS initialY FROM seating_tables WHERE plan_id = ? ORDER BY sort_order, id'
      ).all(planId);
      const update = this.db.prepare(
        'UPDATE seating_tables SET position_x = ?, position_y = ? WHERE id = ? AND plan_id = ?'
      );
      tables.forEach((table, index) => {
        const fallbackX = 18 + (Number(table.sortOrder ?? index) % 4) * 21;
        const fallbackY = 24 + (Math.floor(Number(table.sortOrder ?? index) / 4) % 3) * 28;
        const initialX = Number(table.initialX);
        const initialY = Number(table.initialY);
        const current = this.db.prepare(
          'SELECT position_x AS x, position_y AS y FROM seating_tables WHERE id = ? AND plan_id = ?'
        ).get(table.id, planId);
        const baselineWasCaptured = Number.isFinite(initialX) && Number.isFinite(initialY) &&
          (initialX !== Number(current.x) || initialY !== Number(current.y));
        update.run(
          baselineWasCaptured ? initialX : fallbackX,
          baselineWasCaptured ? initialY : fallbackY,
          table.id,
          planId
        );
      });
      this.db.prepare('UPDATE seating_plans SET updated_at = ? WHERE id = ?').run(now, planId);
      return true;
    });
  }

  updateSeatingVenueItems(planId, eventId, hostId, venueItems, now) {
    return this.db.prepare(
      `UPDATE seating_plans SET venue_items_json = ?, updated_at = ?
       WHERE id = ? AND event_id = ? AND EXISTS
       (SELECT 1 FROM events WHERE id = ? AND host_id = ?)`
    ).run(JSON.stringify(venueItems), now, planId, eventId, eventId, hostId).changes;
  }

  publishSeatingPlan(planId, eventId, hostId, now) {
    return this.db.prepare(
      `UPDATE seating_plans SET status = 'published', published_at = ?, updated_at = ?
       WHERE id = ? AND event_id = ? AND EXISTS
       (SELECT 1 FROM events WHERE id = ? AND host_id = ?)`
    ).run(now, now, planId, eventId, eventId, hostId).changes;
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
