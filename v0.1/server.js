'use strict';

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const {
  Store, DEFAULT_THEME, DEFAULT_INVITATION_SETTINGS
} = require('./persistence');

const ROOT = __dirname;
const PUBLIC = path.join(ROOT, 'public');
const DEFAULT_DB = path.join(ROOT, 'data', 'gatherly.sqlite');
const COOKIE = 'gatherly_session';
const SESSION_MS = 7 * 24 * 60 * 60 * 1000;
const BODY_LIMIT = 16 * 1024;
const GUEST_BATCH_BODY_LIMIT = 64 * 1024;
const GUEST_BATCH_LIMIT = 100;
const THEME_BODY_LIMIT = 1536 * 1024;
const THEME_IMAGE_LIMIT = 1024 * 1024;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const RESERVED_EMAIL_DOMAIN_RE = /^(?:[a-z0-9-]+\.)*(?:test|example|invalid|localhost)$|^(?:[a-z0-9-]+\.)?example\.(?:com|net|org)$/i;
const LOOPBACK_HOSTS = new Set(['127.0.0.1', '::1', 'localhost']);
const CSP = "default-src 'self'; style-src 'self'; script-src 'self'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'";
const DUMMY_PASSWORD_HASH = 'scrypt$00000000000000000000000000000000$' + '00'.repeat(64);

const sha256 = (value) => crypto.createHash('sha256').update(value).digest('hex');
const defaultClock = () => new Date();

function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const result = crypto.scryptSync(password, salt, 64);
  return `scrypt$${salt.toString('hex')}$${result.toString('hex')}`;
}

function checkPassword(password, encoded) {
  const match = /^scrypt\$([a-f0-9]{32})\$([a-f0-9]{128})$/i.exec(String(encoded));
  if (!match) return false;
  const expected = Buffer.from(match[2], 'hex');
  const supplied = crypto.scryptSync(password, Buffer.from(match[1], 'hex'), expected.length);
  return crypto.timingSafeEqual(supplied, expected);
}

function json(res, status, data, headers = {}) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
    ...headers
  });
  res.end(body);
}

function cookies(header = '') {
  const result = {};
  for (const part of header.split(';')) {
    const index = part.indexOf('=');
    if (index > 0) result[part.slice(0, index).trim()] = part.slice(index + 1).trim();
  }
  return result;
}

function bodyJson(req, bodyLimit = BODY_LIMIT) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let length = 0;
    let oversized = false;
    req.on('data', (chunk) => {
      length += chunk.length;
      if (length > bodyLimit) {
        oversized = true;
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (oversized) return reject(invalid('Request body is too large.', 413));
      if (!length) return resolve({});
      try {
        const value = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        if (!value || Array.isArray(value) || typeof value !== 'object') throw new Error();
        resolve(value);
      } catch {
        reject(invalid('Request body must be a JSON object.'));
      }
    });
    req.on('error', reject);
  });
}

function invalid(message, status = 400) {
  return Object.assign(new Error(message), { status });
}

function dateOnly(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

function validSyntheticEmail(email) {
  if (!EMAIL_RE.test(email) || email.length > 254) return false;
  return RESERVED_EMAIL_DOMAIN_RE.test(email.slice(email.lastIndexOf('@') + 1));
}

function validateEvent(input) {
  const title = typeof input.title === 'string' ? input.title.trim() : '';
  const eventDate = typeof input.eventDate === 'string' ? input.eventDate.trim() : '';
  const location = typeof input.location === 'string' ? input.location.trim() : '';
  const deadlineValue = input.rsvpDeadline === '' || input.rsvpDeadline === null ||
    input.rsvpDeadline === undefined ? null : input.rsvpDeadline;

  if (!title || title.length > 100) throw invalid('Event name must be 1–100 characters.');
  if (!dateOnly(eventDate)) throw invalid('Event date must use a real YYYY-MM-DD date.');
  if (location.length > 200) throw invalid('Location must be 200 characters or fewer.');
  if (!['individual', 'household'].includes(input.guestMode)) {
    throw invalid('Choose individual or household guest units.');
  }

  let rsvpDeadline = null;
  if (deadlineValue !== null) {
    if (typeof deadlineValue !== 'string' || Number.isNaN(Date.parse(deadlineValue))) {
      throw invalid('Enter a valid RSVP deadline date and time.');
    }
    rsvpDeadline = new Date(deadlineValue).toISOString();
  }
  return { title, eventDate, location, guestMode: input.guestMode, rsvpDeadline };
}

function relativeLuminance(hexColor) {
  const channels = hexColor.slice(1).match(/.{2}/g).map((channel) => {
    const value = Number.parseInt(channel, 16) / 255;
    return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2];
}

function contrastRatio(firstColor, secondColor) {
  const firstLuminance = relativeLuminance(firstColor);
  const secondLuminance = relativeLuminance(secondColor);
  const lighter = Math.max(firstLuminance, secondLuminance);
  const darker = Math.min(firstLuminance, secondLuminance);
  return (lighter + 0.05) / (darker + 0.05);
}

function validateTheme(input) {
  const keys = [
    'preset', 'primaryColor', 'backgroundColor',
    'textColor', 'fontFamily', 'coverImage'
  ];
  if (!input || typeof input !== 'object' || Array.isArray(input) ||
      Object.keys(input).length !== keys.length ||
      keys.some((key) => !Object.hasOwn(input, key))) {
    throw invalid('Theme must contain exactly the required theme fields.');
  }
  if (!['classic', 'garden', 'midnight', 'custom'].includes(input.preset)) {
    throw invalid('Choose a supported theme preset.');
  }
  for (const key of ['primaryColor', 'backgroundColor', 'textColor']) {
    if (typeof input[key] !== 'string' || !/^#[0-9a-fA-F]{6}$/.test(input[key])) {
      throw invalid(`${key} must be a six-digit hex color such as #315a4c.`);
    }
  }
  if (contrastRatio(input.textColor, input.backgroundColor) < 4.5) {
    throw invalid('textColor and backgroundColor must have a WCAG contrast ratio of at least 4.5:1.');
  }
  if (!['serif', 'sans'].includes(input.fontFamily)) {
    throw invalid('Choose serif or sans for the theme font.');
  }

  let coverImage = input.coverImage;
  if (coverImage !== null) {
    if (typeof coverImage !== 'string') {
      throw invalid('Cover image must be null or a PNG, JPEG, or WebP data URL.');
    }
    const match = /^data:image\/(?:png|jpeg|webp);base64,([A-Za-z0-9+/]+={0,2})$/.exec(coverImage);
    if (!match) {
      throw invalid('Cover image must be a well-formed PNG, JPEG, or WebP base64 data URL.');
    }
    const encoded = match[1];
    if (encoded.length % 4 !== 0) {
      throw invalid('Cover image base64 data is malformed.');
    }
    const decoded = Buffer.from(encoded, 'base64');
    if (!decoded.length || decoded.toString('base64') !== encoded) {
      throw invalid('Cover image base64 data is malformed.');
    }
    if (decoded.length > THEME_IMAGE_LIMIT) {
      throw invalid('Cover image must be 1 MiB or smaller.');
    }
  }

  return {
    preset: input.preset,
    primaryColor: input.primaryColor,
    backgroundColor: input.backgroundColor,
    textColor: input.textColor,
    fontFamily: input.fontFamily,
    coverImage
  };
}

function validateInvitationSettings(input) {
  const keys = ['revealMode', 'chimeEnabled', 'revealMotion', 'celebration'];
  if (!input || typeof input !== 'object' || Array.isArray(input) ||
      Object.keys(input).length !== keys.length ||
      keys.some((key) => !Object.hasOwn(input, key))) {
    throw invalid('Invitation settings must contain exactly revealMode, chimeEnabled, revealMotion, and celebration.');
  }
  if (!['envelope', 'direct'].includes(input.revealMode)) {
    throw invalid('Choose envelope or direct for revealMode.');
  }
  if (typeof input.chimeEnabled !== 'boolean') {
    throw invalid('chimeEnabled must be true or false.');
  }
  if (!['none', 'fade', 'slide-up'].includes(input.revealMotion)) {
    throw invalid('Choose none, fade, or slide-up for revealMotion.');
  }
  if (!['off', 'sparkle', 'leaves'].includes(input.celebration)) {
    throw invalid('Choose off, sparkle, or leaves for celebration.');
  }
  return {
    revealMode: input.revealMode,
    chimeEnabled: input.chimeEnabled,
    revealMotion: input.revealMotion,
    celebration: input.celebration
  };
}

function effectiveOpen(event, currentTime = Date.now()) {
  const deadline = event.rsvpDeadline ? Date.parse(event.rsvpDeadline) : null;
  const beforeDeadline = deadline === null || deadline > currentTime;
  return Boolean(event.responsesOpen) &&
    (beforeDeadline || Boolean(event.reopenedAt));
}

function createApp(options = {}) {
  const host = options.host || '127.0.0.1';
  if (!LOOPBACK_HOSTS.has(host)) {
    throw new Error('Gatherly v0.1 can only bind to a loopback host.');
  }
  const ownsStore = !options.store;
  const store = options.store || new Store(options.dbPath || DEFAULT_DB);
  const clock = options.clock || defaultClock;
  const limits = new Map();
  let closed = false;

  function currentDate() {
    const value = clock();
    const date = value instanceof Date ? value : new Date(value);
    if (Number.isNaN(date.getTime())) throw new Error('Configured clock returned an invalid time.');
    return date;
  }

  function currentIso() {
    return currentDate().toISOString();
  }

  function limit(key, max, durationMs) {
    const timestamp = currentDate().getTime();
    let bucket = limits.get(key);
    if (!bucket || timestamp - bucket.started >= durationMs) {
      bucket = { started: timestamp, count: 0 };
      limits.set(key, bucket);
    }
    bucket.count += 1;
    if (bucket.count > max) throw invalid('Too many requests. Wait a minute and try again.', 429);
  }

  function hostFor(req) {
    const token = cookies(req.headers.cookie)[COOKIE];
    return token ? store.getSession(sha256(token), currentIso()) : null;
  }

  function requireHost(req) {
    const record = hostFor(req);
    if (!record) throw invalid('Sign in as the host to continue.', 401);
    return record;
  }

  function checkOrigin(req) {
    const origin = req.headers.origin;
    if (!origin) return;
    const hostHeader = req.headers.host;
    if (!hostHeader || origin !== `${req.socket.encrypted ? 'https' : 'http'}://${hostHeader}`) {
      throw invalid('Cross-origin request rejected.', 403);
    }
  }

  function login(res, hostRecord) {
    const raw = crypto.randomBytes(32).toString('base64url');
    store.createSession(sha256(raw), hostRecord.id, new Date(currentDate().getTime() + SESSION_MS).toISOString());
    return json(res, 200, { host: { email: hostRecord.email } }, {
      'Set-Cookie': `${COOKIE}=${raw}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${SESSION_MS / 1000}`
    });
  }

  function publicEvent(event, hostId) {
    const stored = store.listEvents(hostId).find((item) => Number(item.id) === Number(event.id));
    return {
      id: Number(event.id),
      title: event.title,
      eventDate: event.eventDate,
      location: event.location,
      guestMode: event.guestMode,
      rsvpDeadline: event.rsvpDeadline || null,
      responsesOpen: effectiveOpen(event, currentDate().getTime()),
      invitedUnits: stored ? stored.invitedUnits : 0,
      yesUnits: stored ? stored.yesUnits : 0,
      noUnits: stored ? stored.noUnits : 0,
      maybeUnits: stored ? stored.maybeUnits : 0,
      attendingPeople: stored ? stored.attendingPeople : 0,
      published: Boolean(event.published),
      theme: event.theme || { ...DEFAULT_THEME },
      invitationSettings: event.invitationSettings || { ...DEFAULT_INVITATION_SETTINGS }
    };
  }

  function dashboardGuests(eventId, hostId) {
    return store.dashboardGuests(eventId, hostId).map((guest) => ({
      id: Number(guest.id),
      name: guest.name,
      email: guest.email,
      groupName: guest.groupName,
      partyLimit: Number(guest.partyLimit),
      revokedAt: guest.revokedAt,
      answer: guest.answer || null,
      partySize: guest.partySize === null ? null : Number(guest.partySize),
      updatedAt: guest.updatedAt || null
    }));
  }

  function eventDetail(event, hostId) {
    return {
      ...publicEvent(event, hostId),
      guests: dashboardGuests(event.id, hostId)
    };
  }

  function sendStatic(res, relativePath, contentType) {
    const file = fs.readFileSync(path.join(PUBLIC, relativePath));
    res.writeHead(200, {
      'Content-Type': contentType,
      'Content-Length': file.length,
      'Cache-Control': 'no-store'
    });
    res.end(file);
  }

  async function handle(req, res) {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Content-Security-Policy', CSP);
    res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
    try {
      const requestUrl = new URL(req.url, 'http://127.0.0.1');
      const pathname = requestUrl.pathname;
      const method = req.method;

      if (method === 'GET' &&
          (pathname === '/' || pathname === '/index.html' || /^\/rsvp\/[A-Za-z0-9_-]{30,60}$/.test(pathname))) {
        return sendStatic(res, 'index.html', 'text/html; charset=utf-8');
      }
      if (method === 'GET' && pathname === '/app.js') {
        return sendStatic(res, 'app.js', 'text/javascript; charset=utf-8');
      }
      if (method === 'GET' && pathname === '/styles.css') {
        return sendStatic(res, 'styles.css', 'text/css; charset=utf-8');
      }
      if (!pathname.startsWith('/api/')) return json(res, 404, { error: 'Not found.' });
      if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(method)) checkOrigin(req);

      if (method === 'GET' && pathname === '/api/status') {
        const activeHost = hostFor(req);
        return json(res, 200, {
          setupRequired: store.hostCount() === 0,
          host: activeHost ? { email: activeHost.email } : null
        });
      }
      if (method === 'POST' && pathname === '/api/auth/register') {
        limit(`register:${req.socket.remoteAddress}`, 4, 60_000);
        const input = await bodyJson(req);
        const email = typeof input.email === 'string' ? input.email.trim().toLowerCase() : '';
        const password = typeof input.password === 'string' ? input.password : '';
        if (!validSyntheticEmail(email)) {
          throw invalid('Use a synthetic email at a reserved test domain, such as name@example.test.');
        }
        if (password.length < 12 || password.length > 200) {
          throw invalid('Password must be 12–200 characters.');
        }
        let hostId;
        try {
          hostId = Number(store.createFirstHost(email, hashPassword(password), currentIso()));
        } catch (error) {
          if (error.code === 'SQLITE_CONSTRAINT_UNIQUE' ||
              error.code === 'SQLITE_CONSTRAINT_PRIMARYKEY') {
            throw invalid('Local host setup has already been completed.', 409);
          }
          throw error;
        }
        return login(res, { id: hostId, email });
      }
      if (method === 'POST' && pathname === '/api/auth/login') {
        limit(`login:${req.socket.remoteAddress}`, 8, 60_000);
        const input = await bodyJson(req);
        const email = typeof input.email === 'string' ? input.email.trim().toLowerCase() : '';
        const password = typeof input.password === 'string' ? input.password : '';
        const record = store.getHostByEmail(email);
        const valid = checkPassword(password, record ? record.password_hash : DUMMY_PASSWORD_HASH) &&
          password.length <= 200;
        if (!valid) throw invalid('Email or password is incorrect.', 401);
        return login(res, record);
      }
      if (method === 'POST' && pathname === '/api/auth/logout') {
        const token = cookies(req.headers.cookie)[COOKIE];
        if (token) store.deleteSession(sha256(token));
        return json(res, 200, { ok: true }, {
          'Set-Cookie': `${COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0`
        });
      }
      if (method === 'GET' && pathname === '/api/auth/me') {
        const record = hostFor(req);
        return record ? json(res, 200, { host: { email: record.email } }) :
          json(res, 401, { error: 'Sign in to continue.' });
      }

      const guestMatch = pathname.match(/^\/api\/guest\/([A-Za-z0-9_-]{30,60})(?:\/rsvp)?$/);
      if (guestMatch && (method === 'GET' || (method === 'PUT' && pathname.endsWith('/rsvp')))) {
        limit(`guest:${req.socket.remoteAddress}`, method === 'PUT' ? 30 : 120, 60_000);
        const record = store.getGuestByToken(sha256(guestMatch[1]));
        if (!record || record.revokedAt) {
          throw invalid('This invitation link is invalid or has been revoked.', 404);
        }
        const canRespond = effectiveOpen(record, currentDate().getTime());
        if (method === 'GET') {
          return json(res, 200, {
            event: {
              title: record.title,
              eventDate: record.eventDate,
              location: record.location,
              rsvpDeadline: record.rsvpDeadline,
              theme: record.theme,
              invitationSettings: record.invitationSettings
            },
            guest: {
              name: record.name,
              partyLimit: Number(record.partyLimit),
              answer: record.answer || null,
              partySize: record.partySize === null ? null : Number(record.partySize)
            },
            canRespond
          });
        }
        if (!canRespond) throw invalid('RSVPs are closed. Please contact the host.', 409);
        const input = await bodyJson(req);
        const answer = input.answer;
        if (!['yes', 'no', 'maybe'].includes(answer)) throw invalid('Choose yes, no, or maybe.');
        if (!Number.isInteger(input.partySize) ||
            input.partySize < 0 || input.partySize > Number(record.partyLimit)) {
          throw invalid(`Party size must be from 0 to ${record.partyLimit}.`);
        }
        if (answer === 'yes' && input.partySize < 1) {
          throw invalid('A yes RSVP needs at least one attendee.');
        }
        if (answer === 'no' && input.partySize !== 0) {
          throw invalid('A no RSVP must have party size 0.');
        }
        if (record.guestMode === 'individual' && answer !== 'no' && input.partySize !== 1) {
          throw invalid('Individual RSVP party size must be 1.');
        }
        store.saveRsvp(record.guestId, answer, input.partySize, currentIso());
        return json(res, 200, { ok: true });
      }

      const hostRecord = requireHost(req);
      if (method === 'GET' && pathname === '/api/events') {
        const events = store.listEvents(hostRecord.id).map((event) => ({
          ...event,
          responsesOpen: effectiveOpen(event, currentDate().getTime())
        }));
        return json(res, 200, { events });
      }
      if (method === 'POST' && pathname === '/api/events') {
        const eventInput = validateEvent(await bodyJson(req));
        const id = Number(store.createEvent(hostRecord.id, eventInput, currentIso()));
        const event = store.getEventForHost(id, hostRecord.id);
        return json(res, 201, { event: publicEvent(event, hostRecord.id) });
      }
      if (method === 'GET' && pathname === '/api/outbox') {
        return json(res, 200, { messages: store.listOutbox(hostRecord.id) });
      }

      const eventMatch = pathname.match(/^\/api\/events\/(\d+)(?:\/(guests(?:\/bulk)?|dashboard|responses|publish|theme|invitation))?$/);
      if (eventMatch) {
        const eventId = Number(eventMatch[1]);
        if (!Number.isSafeInteger(eventId) || eventId < 1) throw invalid('Event not found.', 404);
        const action = eventMatch[2] || '';
        const event = store.getEventForHost(eventId, hostRecord.id);
        if (!event) throw invalid('Event not found.', 404);
        if (method === 'PUT' && action === 'theme') {
          const theme = validateTheme(await bodyJson(req, THEME_BODY_LIMIT));
          if (!store.updateEventTheme(eventId, hostRecord.id, theme)) {
            throw invalid('Event not found.', 404);
          }
          const updated = store.getEventForHost(eventId, hostRecord.id);
          return json(res, 200, { theme: updated.theme });
        }
        if (method === 'PUT' && action === 'invitation') {
          const settings = validateInvitationSettings(await bodyJson(req));
          if (!store.updateEventInvitationSettings(eventId, hostRecord.id, settings)) {
            throw invalid('Event not found.', 404);
          }
          const updated = store.getEventForHost(eventId, hostRecord.id);
          return json(res, 200, { invitationSettings: updated.invitationSettings });
        }
        if (method === 'GET' && (action === 'dashboard' || action === '')) {
          return json(res, 200, {
            event: eventDetail(event, hostRecord.id),
            guests: dashboardGuests(eventId, hostRecord.id)
          });
        }
        if (method === 'POST' && action === 'guests') {
          const input = await bodyJson(req);
          const name = typeof input.name === 'string' ? input.name.trim() : '';
          const email = typeof input.email === 'string' ? input.email.trim().toLowerCase() : '';
          if (!name || name.length > 100) {
            throw invalid('Guest or household name must be 1–100 characters.');
          }
          if (!validSyntheticEmail(email)) {
            throw invalid('Use a synthetic guest email at a reserved test domain, such as name@example.test.');
          }
          const partyLimit = event.guestMode === 'individual' ? 1 : input.partyLimit;
          if (!Number.isInteger(partyLimit) || partyLimit < 1 || partyLimit > 20) {
            throw invalid('Party limit must be a whole number from 1 to 20.');
          }
          const token = crypto.randomBytes(32).toString('base64url');
          const inviteUrl = `/rsvp/${token}`;
          const createdAt = currentIso();
          const guestId = Number(store.createGuestAndOutbox({
            eventId, name, email, partyLimit,
            groupName: typeof input.groupName === 'string' ? input.groupName.trim().slice(0, 100) : '',
            tokenHash: sha256(token)
          }, {
            recipient: email,
            subject: `Your invitation: ${event.title}`,
            body: `Hello ${name},\n\nYou are invited to ${event.title} on ${event.eventDate}.\nRSVP using your private local link: ${inviteUrl}\n\nLocal email capture only. No email was sent.`
          }, createdAt));
          return json(res, 201, {
            guest: { id: guestId, name, email, partyLimit },
            inviteUrl
          });
        }
        if (method === 'POST' && action === 'guests/bulk') {
          const input = await bodyJson(req, GUEST_BATCH_BODY_LIMIT);
          if (!Array.isArray(input.guests) || input.guests.length < 1 || input.guests.length > GUEST_BATCH_LIMIT) {
            throw invalid(`Provide between 1 and ${GUEST_BATCH_LIMIT} guest rows.`);
          }
          const entries = input.guests.map((row, index) => {
            const rowNumber = index + 1;
            if (!row || typeof row !== 'object' || Array.isArray(row)) {
              throw invalid(`Guest row ${rowNumber} must be an object.`);
            }
            const name = typeof row.name === 'string' ? row.name.trim() : '';
            const email = typeof row.email === 'string' ? row.email.trim().toLowerCase() : '';
            if (!name || name.length > 100) {
              throw invalid(`Guest row ${rowNumber}: name must be 1–100 characters.`);
            }
            if (!validSyntheticEmail(email)) {
              throw invalid(`Guest row ${rowNumber}: use a synthetic email at a reserved test domain, such as name@example.test.`);
            }
            const partyLimit = event.guestMode === 'individual' ? 1 : row.partyLimit;
            if (!Number.isInteger(partyLimit) || partyLimit < 1 || partyLimit > 20) {
              throw invalid(`Guest row ${rowNumber}: party limit must be a whole number from 1 to 20.`);
            }
            const token = crypto.randomBytes(32).toString('base64url');
            const inviteUrl = `/rsvp/${token}`;
            const guest = { eventId, name, email, partyLimit, tokenHash: sha256(token) };
            return {
              guest,
              inviteUrl,
              createdAt: currentIso(),
              message: {
                recipient: email,
                subject: `Your invitation: ${event.title}`,
                body: `Hello ${name},\n\nYou are invited to ${event.title} on ${event.eventDate}.\nRSVP using your private local link: ${inviteUrl}\n\nLocal email capture only. No email was sent.`
              }
            };
          });
          const ids = store.createGuestsAndOutbox(entries);
          return json(res, 201, {
            guests: entries.map(({ guest, inviteUrl }, index) => ({
              id: ids[index], name: guest.name, email: guest.email,
              partyLimit: guest.partyLimit, inviteUrl
            }))
          });
        }
        if (method === 'POST' && action === 'publish') {
          store.publishEvent(eventId, hostRecord.id);
          return json(res, 200, {
            event: publicEvent(store.getEventForHost(eventId, hostRecord.id), hostRecord.id)
          });
        }
        if (method === 'POST' && action === 'responses') {
          const input = await bodyJson(req);
          if (typeof input.open !== 'boolean') throw invalid('Set open to true or false.');
          store.setEventOpen(eventId, hostRecord.id, input.open, currentIso());
          const updated = store.getEventForHost(eventId, hostRecord.id);
          return json(res, 200, {
            ok: true,
            responsesOpen: effectiveOpen(updated, currentDate().getTime()),
            event: eventDetail(updated, hostRecord.id)
          });
        }
      }

      const inviteLinkMatch = pathname.match(/^\/api\/guests\/(\d+)\/invite-link$/);
      if (method === 'GET' && inviteLinkMatch) {
        const guestId = Number(inviteLinkMatch[1]);
        const record = Number.isSafeInteger(guestId) && guestId > 0
          ? store.guestInviteLink(guestId, hostRecord.id)
          : null;
        if (!record) throw invalid('Guest not found.', 404);
        if (record.revokedAt) throw invalid('Invite link has been revoked.', 410);
        const match = record.body.match(/RSVP using your private local link:\s*(\/rsvp\/[A-Za-z0-9_-]{30,60})/);
        if (!match) throw invalid('Invite link is unavailable.', 404);
        return json(res, 200, { inviteUrl: match[1] });
      }

      const revokeMatch = pathname.match(/^\/api\/guests\/(\d+)\/revoke$/);
      if (method === 'POST' && revokeMatch) {
        const guestId = Number(revokeMatch[1]);
        if (!Number.isSafeInteger(guestId) || guestId < 1 ||
            !store.revokeGuest(guestId, hostRecord.id, currentIso())) {
          throw invalid('Guest not found or already revoked.', 404);
        }
        return json(res, 200, { ok: true });
      }
      return json(res, 404, { error: 'API route not found.' });
    } catch (error) {
      if (res.headersSent) return res.destroy();
      const status = Number.isInteger(error.status) ? error.status : 500;
      if (status >= 500) console.error('Request failed:', error);
      return json(res, status, { error: status >= 500 ? 'Unexpected server error.' : error.message });
    }
  }

  const server = http.createServer((req, res) => { void handle(req, res); });
  server.on('close', () => {
    if (!closed && ownsStore) {
      closed = true;
      store.close();
    }
  });
  return { server, store, host };
}

if (require.main === module) {
  const app = createApp({
    dbPath: process.env.GATHERLY_DB_PATH || DEFAULT_DB,
    host: '127.0.0.1'
  });
  const port = Number(process.env.PORT || 3000);
  app.server.listen(port, app.host, () => {
    console.log(`Gatherly v0.1 local app: http://${app.host}:${port}`);
    console.log(`SQLite database: ${process.env.GATHERLY_DB_PATH || DEFAULT_DB}`);
    console.log('Synthetic data only. Invitations are captured locally, never emailed.');
  });
}

module.exports = {
  createApp, effectiveOpen, hashPassword, checkPassword, validateEvent, validateTheme,
  validateInvitationSettings
};
