'use strict';

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const {
  Store, DEFAULT_THEME, DEFAULT_INVITATION_SETTINGS, DEFAULT_INVITATION_COPY
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
const CSP = "default-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'";
const DUMMY_PASSWORD_HASH = 'scrypt$00000000000000000000000000000000$' + '00'.repeat(64);
const SYNTHETIC_NAMES = [
  'Alex Morgan', 'Jordan Lee', 'Taylor Smith', 'Riley Chen', 'Casey Rivera',
  'Avery Patel', 'Morgan Brooks', 'Jamie Nguyen', 'Cameron Davis', 'Quinn Wilson',
  'Harper Kim', 'Drew Martin', 'Emerson Clark', 'Rowan Garcia', 'Sage Thompson',
  'Parker Lewis', 'Reese Walker', 'Skyler Adams', 'Finley Moore', 'Blair Cooper'
];
const SUPPORTED_TIMEZONES = new Set(['UTC', ...(
  typeof Intl.supportedValuesOf === 'function' ? Intl.supportedValuesOf('timeZone') : []
)]);

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

function invalid(message, status = 400, code) {
  return Object.assign(new Error(message), { status, code });
}

function dateOnly(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

function timeOnly(value) {
  return typeof value === 'string' && /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(value);
}

function zonedDateTimeToIso(value, timezone) {
  const match = typeof value === 'string' && /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/.exec(value);
  if (!match || !SUPPORTED_TIMEZONES.has(timezone)) return null;
  const year = Number(match[1].slice(0, 4));
  const month = Number(match[1].slice(5, 7));
  const day = Number(match[1].slice(8, 10));
  const hour = Number(match[2]);
  const minute = Number(match[3]);
  const second = Number(match[4] || 0);
  const localKey = `${match[1]}T${match[2]}:${match[3]}:${String(second).padStart(2, '0')}`;
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23'
  });
  const candidates = [];
  const base = Date.UTC(year, month - 1, day, hour, minute, second);
  for (let offset = -26 * 60; offset <= 26 * 60; offset += 15) {
    const candidate = new Date(base - offset * 60 * 1000);
    const parts = Object.fromEntries(formatter.formatToParts(candidate)
      .filter(({ type }) => type !== 'literal').map(({ type, value: part }) => [type, part]));
    if (`${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}:${parts.second}` === localKey) {
      candidates.push(candidate);
    }
  }
  return candidates.length === 1 ? candidates[0].toISOString() : null;
}

function validSyntheticEmail(email) {
  if (!EMAIL_RE.test(email) || email.length > 254) return false;
  return RESERVED_EMAIL_DOMAIN_RE.test(email.slice(email.lastIndexOf('@') + 1));
}

// Kept at module scope because seating routes validate these payloads too.
function validateVenueItems(value) {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 100) throw invalid('Venue items are invalid.');
  return value.map((item) => {
    const type = typeof item?.type === 'string' ? item.type.trim() : '';
    const label = typeof item?.label === 'string' ? item.label.trim() : type;
    const positionX = Number(item?.positionX);
    const positionY = Number(item?.positionY);
    const width = item?.width === undefined ? null : Number(item.width);
    const height = item?.height === undefined ? null : Number(item.height);
    if (!type || type.length > 50 || !label || label.length > 100 ||
        !Number.isFinite(positionX) || positionX < 3 || positionX > 97 ||
        !Number.isFinite(positionY) || positionY < 3 || positionY > 97 ||
        (width !== null && (!Number.isFinite(width) || width <= 0 || width > 100)) ||
        (height !== null && (!Number.isFinite(height) || height <= 0 || height > 100))) {
      throw invalid('Venue items must have a label and valid map position.');
    }
    return { type, label, positionX, positionY, ...(width === null ? {} : { width }),
      ...(height === null ? {} : { height }) };
  });
}

function validateFloorPlanMetadata(value) {
  if (value === undefined) return {};
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw invalid('Floor plan metadata is invalid.');
  }
  const name = typeof value.name === 'string' ? value.name.trim() : '';
  const type = typeof value.type === 'string' ? value.type.trim() : '';
  if ((name && name.length > 255) || (type && type.length > 100)) {
    throw invalid('Floor plan metadata is invalid.');
  }
  return { name, type, availableLocally: value.availableLocally !== false,
    candidateCount: Number.isSafeInteger(Number(value.candidateCount)) ? Number(value.candidateCount) : 0 };
}

function validateSeatingTables(value) {
  if (!Array.isArray(value) || value.length < 1 || value.length > 40) {
    throw invalid('Add between 1 and 40 seating tables.');
  }

  const names = new Set();
  return value.map((table, index) => {
    const name = typeof table?.name === 'string' ? table.name.trim() : `Table ${index + 1}`;
    const capacity = Number(table?.capacity);
    const shape = ['round', 'rectangle', 'square', 'banquet'].includes(table?.shape)
      ? table.shape : 'round';
    const positionX = Number.isFinite(Number(table?.positionX))
      ? Number(table.positionX) : 18 + (index % 4) * 21;
    const positionY = Number.isFinite(Number(table?.positionY))
      ? Number(table.positionY) : 24 + (Math.floor(index / 4) % 3) * 28;
    if (!name || name.length > 100 || names.has(name.toLowerCase())) {
      throw invalid('Table names must be unique and 1–100 characters.');
    }

    function validateVenueItems(value) {
      if (value === undefined) return [];
      if (!Array.isArray(value) || value.length > 100) throw invalid('Venue items are invalid.');
      return value.map((item) => {
        const type = typeof item?.type === 'string' ? item.type.trim() : '';
        const label = typeof item?.label === 'string' ? item.label.trim() : type;
        const positionX = Number(item?.positionX);
        const positionY = Number(item?.positionY);
        const width = item?.width === undefined ? null : Number(item.width);
        const height = item?.height === undefined ? null : Number(item.height);
        if (!type || type.length > 50 || !label || label.length > 100 ||
            !Number.isFinite(positionX) || positionX < 3 || positionX > 97 ||
            !Number.isFinite(positionY) || positionY < 3 || positionY > 97 ||
            (width !== null && (!Number.isFinite(width) || width <= 0 || width > 100)) ||
            (height !== null && (!Number.isFinite(height) || height <= 0 || height > 100))) {
          throw invalid('Venue items must have a label and valid map position.');
        }
        return { type, label, positionX, positionY, ...(width === null ? {} : { width }),
          ...(height === null ? {} : { height }) };
      });
    }

    function validateFloorPlanMetadata(value) {
      if (value === undefined) return {};
      if (!value || typeof value !== 'object' || Array.isArray(value)) {
        throw invalid('Floor plan metadata is invalid.');
      }
      const name = typeof value.name === 'string' ? value.name.trim() : '';
      const type = typeof value.type === 'string' ? value.type.trim() : '';
      if ((name && name.length > 255) || (type && type.length > 100)) {
        throw invalid('Floor plan metadata is invalid.');
      }
      return {
        name, type, availableLocally: value.availableLocally !== false,
        candidateCount: Number.isSafeInteger(Number(value.candidateCount)) ? Number(value.candidateCount) : 0
      };
    }
    if (!Number.isSafeInteger(capacity) || capacity < 1 || capacity > 100) {
      throw invalid('Table capacity must be a whole number between 1 and 100.');
    }
    if (!Number.isFinite(positionX) || positionX < 5 || positionX > 95 ||
        !Number.isFinite(positionY) || positionY < 8 || positionY > 92) {
      throw invalid('Table positions must stay within the seating map.');
    }
    names.add(name.toLowerCase());
    return { name, capacity, shape, positionX, positionY };
  });
}

function validateSeatingConstraints(value) {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 200) throw invalid('Seating constraints are invalid.');
  return value.map((constraint) => {
    const relationshipType = constraint?.relationshipType ||
      (constraint?.type === 'together' ? 'keep-together' :
        constraint?.type === 'apart' ? 'keep-apart' : constraint?.type);
    if (!['keep-together', 'keep-apart'].includes(relationshipType) ||
        !Array.isArray(constraint.attendeeIds) || constraint.attendeeIds.length < 2 ||
        constraint.attendeeIds.length > 20 ||
        constraint.attendeeIds.some((id) => !Number.isSafeInteger(Number(id)) || Number(id) < 1)) {
      throw invalid('Each seating constraint needs a type and at least two attendee IDs.');
    }
    if (constraint.priority !== undefined &&
        !['required', 'preferred'].includes(constraint.priority)) {
      throw invalid('Seating constraint priority must be required or preferred.');
    }
    const priority = constraint.priority === 'required' ? 'required' : 'preferred';
    const attendeeIds = [...new Set(constraint.attendeeIds.map(Number))];
    if (attendeeIds.length < 2) throw invalid('Each seating constraint needs two distinct attendee IDs.');
    return {
      type: relationshipType === 'keep-together' ? 'together' : 'apart',
      relationshipType,
      relationship: typeof constraint.relationship === 'string'
        ? constraint.relationship.trim().slice(0, 60) : '',
      attendeeIds,
      priority
    };
  });
}

function generateSeatingDraft(attendees, tables, constraints, seed = 1) {
  const attendeeById = new Map(attendees.map((attendee) => [Number(attendee.id), attendee]));
  const parent = new Map(attendees.map((attendee) => [Number(attendee.id), Number(attendee.id)]));
  const find = (id) => {
    let root = id;
    while (parent.get(root) !== root) root = parent.get(root);
    while (parent.get(id) !== id) {
      const next = parent.get(id);
      parent.set(id, root);
      id = next;
    }
    return root;
  };
  const union = (first, second) => {
    const left = find(first);
    const right = find(second);
    if (left !== right) parent.set(right, left);
  };
  const violations = [];
  for (const constraint of constraints) {
    const validIds = constraint.attendeeIds.filter((id) => attendeeById.has(id));
    if (validIds.length !== constraint.attendeeIds.length) {
      violations.push({ type: 'invalid', message: 'A constraint references an attendee who is not eligible.' });
    }
    const relationshipType = constraint.relationshipType ||
      (constraint.type === 'together' ? 'keep-together' : 'keep-apart');
    if (relationshipType === 'keep-together') {
      for (let index = 1; index < validIds.length; index += 1) union(validIds[0], validIds[index]);
    }
  }
  const maxTableCapacity = Math.max(...tables.map((table) => Number(table.capacity)), 0);
  const householdMembers = new Map();
  for (const attendee of attendees) {
    const householdId = Number(attendee.guestUnitId);
    if (!Number.isSafeInteger(householdId)) continue;
    if (!householdMembers.has(householdId)) householdMembers.set(householdId, []);
    householdMembers.get(householdId).push(Number(attendee.id));
  }
  for (const memberIds of householdMembers.values()) {
    if (memberIds.length <= maxTableCapacity) {
      for (let index = 1; index < memberIds.length; index += 1) {
        union(memberIds[0], memberIds[index]);
      }
    }
  }
  const groups = new Map();
  for (const attendee of attendees) {
    const key = find(Number(attendee.id));
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(attendee);
  }
  const orderedGroups = [...groups.values()].sort((left, right) => {
    const size = right.length - left.length;
    return size || Number(left[0].id) - Number(right[0].id);
  });
  const assigned = new Map();
  const remaining = new Map(tables.map((table) => [Number(table.id), Number(table.capacity)]));
  for (const group of orderedGroups) {
    const candidates = tables.filter((table) => (remaining.get(Number(table.id)) || 0) >= group.length);
    if (!candidates.length) {
      group.forEach((attendee) => violations.push({
        type: 'capacity', attendeeId: Number(attendee.id),
        message: `${attendee.name} could not be assigned within table capacity.`
      }));
      continue;
    }
    const table = candidates.sort((left, right) => {
      const remainingDifference = remaining.get(Number(right.id)) - remaining.get(Number(left.id));
      return remainingDifference || Number(left.id) - Number(right.id);
    })[0];
    const tableId = Number(table.id);
    group.forEach((attendee) => assigned.set(Number(attendee.id), tableId));
    remaining.set(tableId, remaining.get(tableId) - group.length);
  }
  for (const constraint of constraints) {
    const relationshipType = constraint.relationshipType ||
      (constraint.type === 'together' ? 'keep-together' : 'keep-apart');
    const tableIds = constraint.attendeeIds.map((id) => assigned.get(id)).filter(Boolean);
    const violated = relationshipType === 'keep-apart'
      ? tableIds.length > 1 && new Set(tableIds).size !== tableIds.length
      : tableIds.length > 1 && new Set(tableIds).size > 1;
    if (violated) {
      violations.push({
        type: 'preference', relationshipType, priority: constraint.priority || 'preferred',
        attendeeIds: constraint.attendeeIds,
        message: relationshipType === 'keep-apart'
          ? 'Some guests marked “keep apart” share a table.'
          : 'Some guests marked “keep together” are split across tables.'
      });
    }
  }
  const assignments = [...assigned.entries()]
    .sort(([left], [right]) => left - right)
    .map(([attendeeId, tableId]) => ({ attendeeId, tableId }));
  const unassigned = attendees.filter((attendee) => !assigned.has(Number(attendee.id)))
    .map((attendee) => ({ attendeeId: Number(attendee.id), name: attendee.name }));
  const householdGroups = [...new Map(
    attendees
      .filter((attendee) => Number.isSafeInteger(Number(attendee.guestUnitId)))
      .map((attendee) => [Number(attendee.guestUnitId), attendees.filter(
        (member) => Number(member.guestUnitId) === Number(attendee.guestUnitId)
      )])
  ).values()];
  const familiesKeptTogether = householdGroups.filter((group) => {
    const tableIds = new Set(group.map((attendee) => assigned.get(Number(attendee.id))).filter(Boolean));
    return tableIds.size === 1 && group.every((attendee) => assigned.has(Number(attendee.id)));
  }).length;
  const familiesSplit = householdGroups.length - familiesKeptTogether;
  const normalized = JSON.stringify({
    attendees: attendees.map(({ id, name, guestUnitId }) => [Number(id), name, Number(guestUnitId)]),
    tables: tables.map(({ id, capacity }) => [Number(id), Number(capacity)]),
    constraints, seed
  });
  return {
    assignments,
    unassigned,
    score: Math.max(0, 100 - violations.reduce((total, violation) =>
      total + (violation.priority === 'required' ? 40 : 10), 0) -
      unassigned.length * 20 - familiesSplit * 15),
    inputHash: sha256(normalized),
    payload: {
      constraints, violations, unassigned,
      attendeeCount: attendees.length,
      assignedCount: assignments.length,
      remainingCapacity: [...remaining.values()].reduce((total, value) => total + value, 0),
      optimization: {
        householdGroups: householdGroups.length,
        familiesKeptTogether,
        familiesSplit,
        familyOptimizationScore: householdGroups.length
          ? Math.round((familiesKeptTogether / householdGroups.length) * 100) : 100
      }
    }
  };
}

function validateEvent(input) {
  const title = typeof input.title === 'string' ? input.title.trim() : '';
  const eventDate = typeof input.eventDate === 'string' ? input.eventDate.trim() : '';
  const eventStartTime = input.eventStartTime === '' || input.eventStartTime === null || input.eventStartTime === undefined
    ? null : input.eventStartTime;
  const eventEndTime = input.eventEndTime === '' || input.eventEndTime === null || input.eventEndTime === undefined
    ? null : input.eventEndTime;
  const timezone = input.timezone === '' || input.timezone === null || input.timezone === undefined
    ? null : input.timezone;
  const location = typeof input.location === 'string' ? input.location.trim() : '';
  const deadlineValue = input.rsvpDeadline === '' || input.rsvpDeadline === null ||
    input.rsvpDeadline === undefined ? null : input.rsvpDeadline;
  const capacityValue = input.capacity === '' || input.capacity === null ||
    input.capacity === undefined ? null : input.capacity;

  if (!title || title.length > 100) throw invalid('Event name must be 1–100 characters.');
  if (!dateOnly(eventDate)) throw invalid('Event date must use a real YYYY-MM-DD date.');
  if (eventStartTime !== null && !timeOnly(eventStartTime)) throw invalid('Event start time must use HH:MM.');
  if (eventEndTime !== null && !timeOnly(eventEndTime)) throw invalid('Event end time must use HH:MM.');
  if (eventEndTime !== null && eventStartTime === null) throw invalid('An end time requires an event start time.');
  if (eventStartTime !== null && eventEndTime !== null && eventEndTime <= eventStartTime) {
    throw invalid('Event end time must be after the start time.');
  }
  if (timezone !== null && (typeof timezone !== 'string' || !SUPPORTED_TIMEZONES.has(timezone))) {
    throw invalid('Choose a supported IANA timezone.');
  }
  if (location.length > 200) throw invalid('Location must be 200 characters or fewer.');
  if (!['individual', 'household'].includes(input.guestMode)) {
    throw invalid('Choose individual or household guest units.');
  }

  let rsvpDeadline = null;
  if (deadlineValue !== null) {
    if (typeof deadlineValue !== 'string') {
      throw invalid('Enter a valid RSVP deadline date and time.');
    }
    const hasOffset = /(?:Z|[+-]\d{2}:?\d{2})$/i.test(deadlineValue);
    if (hasOffset) {
      if (Number.isNaN(Date.parse(deadlineValue))) throw invalid('Enter a valid RSVP deadline date and time.');
      rsvpDeadline = new Date(deadlineValue).toISOString();
    } else {
      if (!timezone) throw invalid('Choose an event timezone when using a local RSVP deadline.');
      rsvpDeadline = zonedDateTimeToIso(deadlineValue, timezone);
      if (!rsvpDeadline) throw invalid('RSVP deadline is invalid or falls in a timezone transition.');
    }
  }
  let capacity = null;
  if (capacityValue !== null) {
    if (!Number.isInteger(capacityValue) || capacityValue < 1 || capacityValue > 100000) {
      throw invalid('Event capacity must be a whole number from 1 to 100000.');
    }
    capacity = capacityValue;
  }
  return { title, eventDate, eventStartTime, eventEndTime, timezone,
    location, guestMode: input.guestMode, rsvpDeadline, capacity };
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
    'textColor', 'fontFamily', 'fontSize', 'coverImage'
  ];
  if (!input || typeof input !== 'object' || Array.isArray(input) ||
      !keys.filter((key) => key !== 'fontSize').every((key) => Object.hasOwn(input, key)) ||
      Object.keys(input).some((key) => !keys.includes(key))) {
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
  if (input.fontSize !== undefined && !['small', 'medium', 'large'].includes(input.fontSize)) {
    throw invalid('Choose small, medium, or large for the invitation font size.');
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

  const theme = {
    preset: input.preset,
    primaryColor: input.primaryColor,
    backgroundColor: input.backgroundColor,
    textColor: input.textColor,
    fontFamily: input.fontFamily,
    coverImage
  };
  if (input.fontSize !== undefined) theme.fontSize = input.fontSize;
  return theme;
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

function validateInvitationCopy(input) {
  const limits = {
    greeting: 120,
    title: 100,
    intro: 500,
    rsvpHeading: 100,
    rsvpHelper: 200,
    footerNote: 300
  };
  const imageKeys = ['image', 'imageShape', 'imageAlt'];
  const legacyKeys = Object.keys(limits);
  const editableKeys = legacyKeys.filter((key) => key !== 'greeting');
  const keys = [...legacyKeys, ...imageKeys];
  const inputKeys = Object.keys(input || {});
  const isLegacy = inputKeys.length === legacyKeys.length && legacyKeys.every((key) => Object.hasOwn(input, key));
  const isCurrent = inputKeys.length === keys.length && keys.every((key) => Object.hasOwn(input, key));
  const isEditable = inputKeys.length === editableKeys.length && editableKeys.every((key) => Object.hasOwn(input, key));
  const isEditableCurrent = inputKeys.length === editableKeys.length + imageKeys.length &&
    [...editableKeys, ...imageKeys].every((key) => Object.hasOwn(input, key));
  if (!input || typeof input !== 'object' || Array.isArray(input) ||
      (!isLegacy && !isCurrent && !isEditable && !isEditableCurrent)) {
    throw invalid('Invitation copy must contain the existing copy fields and optional image, imageShape, and imageAlt fields.');
  }
  const copy = {};
  for (const key of keys) {
    if (!Object.hasOwn(input, key)) {
      copy[key] = DEFAULT_INVITATION_COPY[key];
      continue;
    }
    if (!Object.hasOwn(limits, key)) continue;
    if (typeof input[key] !== 'string') throw invalid(`${key} must be text.`);
    copy[key] = input[key].trim();
    if (copy[key].length > limits[key]) {
      throw invalid(`${key} must be ${limits[key]} characters or fewer.`);
    }
  }
  const image = Object.hasOwn(input, 'image') ? input.image : null;
  if (image !== null) {
    if (typeof image !== 'string') throw invalid('Invitation image must be null or a PNG, JPEG, or WebP data URL.');
    const match = /^data:image\/(?:png|jpeg|webp);base64,([A-Za-z0-9+/]+={0,2})$/.exec(image);
    if (!match || match[1].length % 4 !== 0) {
      throw invalid('Invitation image must be a well-formed PNG, JPEG, or WebP base64 data URL.');
    }
    const decoded = Buffer.from(match[1], 'base64');
    if (!decoded.length || decoded.toString('base64') !== match[1]) {
      throw invalid('Invitation image base64 data is malformed.');
    }
    if (decoded.length > THEME_IMAGE_LIMIT) throw invalid('Invitation image must be 1 MiB or smaller.');
  }
  const imageShape = Object.hasOwn(input, 'imageShape') ? input.imageShape : 'circle';
  if (!['circle', 'rounded-square', 'square', 'arch'].includes(imageShape)) {
    throw invalid('Choose circle, rounded-square, square, or arch for imageShape.');
  }
  const imageAlt = Object.hasOwn(input, 'imageAlt') ? input.imageAlt : '';
  if (typeof imageAlt !== 'string' || imageAlt.trim().length > 200) {
    throw invalid('imageAlt must be 200 characters or fewer.');
  }
  return { ...copy, image, imageShape, imageAlt: imageAlt.trim() };
}

function effectiveOpen(event, currentTime = Date.now()) {
  const deadline = event.rsvpDeadline ? Date.parse(event.rsvpDeadline) : null;
  const beforeDeadline = deadline === null || deadline > currentTime;
  return event.status !== 'cancelled' && Boolean(event.responsesOpen) &&
    (beforeDeadline || Boolean(event.reopenedAt));
}

function validateEventStatus(input) {
  if (!input || !['active', 'postponed', 'cancelled'].includes(input.status)) {
    throw invalid('Choose active, postponed, or cancelled event status.');
  }
  const note = input.note === undefined || input.note === null ? '' : input.note;
  if (typeof note !== 'string' || note.trim().length > 500) {
    throw invalid('Organizer note must be 500 characters or fewer.');
  }
  if (input.replacement !== undefined &&
      (!input.replacement || typeof input.replacement !== 'object' || Array.isArray(input.replacement))) {
    throw invalid('Replacement schedule must be an object.');
  }
  const replacement = input.replacement || {};
  const hasReplacement = Object.values(replacement).some((value) => value !== '' && value !== null && value !== undefined);
  if (input.status === 'postponed' &&
      (!dateOnly(replacement.eventDate) || !timeOnly(replacement.startTime) ||
       !timeOnly(replacement.endTime) || replacement.endTime <= replacement.startTime ||
       !SUPPORTED_TIMEZONES.has(replacement.timezone))) {
    throw invalid('A postponed event needs a replacement date, start time, end time, and IANA timezone.');
  }
  if (hasReplacement && input.status !== 'postponed') throw invalid('Replacement schedule is only valid for postponed events.');
  if (replacement.endTime && (!timeOnly(replacement.endTime) || replacement.endTime <= replacement.startTime)) {
    throw invalid('Replacement end time must be after the replacement start time.');
  }
  return { status: input.status, note: note.trim() || null, replacement: input.status === 'postponed'
    ? { eventDate: replacement.eventDate, startTime: replacement.startTime,
      endTime: replacement.endTime || null, timezone: replacement.timezone }
    : {} };
}

function validateCheckInTarget(input) {
  const guestId = input?.guestId;
  const attendeeId = input?.attendeeId;
  const hasGuest = Number.isSafeInteger(guestId) && guestId > 0;
  const hasAttendee = Number.isSafeInteger(attendeeId) && attendeeId > 0;
  if (hasGuest === hasAttendee) throw invalid('Provide exactly one guestId or attendeeId.');
  return hasGuest ? { guestUnitId: guestId } : { attendeeId };
}

function validateWalkIn(input) {
  const name = typeof input?.name === 'string' ? input.name.trim() : '';
  const attendeeName = typeof input?.attendeeName === 'string' ? input.attendeeName.trim() : name;
  if (!name || name.length > 100) throw invalid('Walk-in name must be 1–100 characters.');
  if (!attendeeName || attendeeName.length > 100) throw invalid('Attendee name must be 1–100 characters.');
  return { name, attendeeName };
}

function validateMessagePreview(input) {
  const filters = ['all', 'unrevoked', 'pending', 'yes', 'maybe', 'no'];
  if (!input || !filters.includes(input.filter || 'all')) {
    throw invalid('Choose a supported recipient group.');
  }
  const subject = input.subject === undefined || input.subject === '' ? null : input.subject;
  const body = input.message === undefined || input.message === '' ? null : input.message;
  if (subject !== null && (typeof subject !== 'string' || subject.trim().length > 200)) {
    throw invalid('Message subject must be 200 characters or fewer.');
  }
  if (body !== null && (typeof body !== 'string' || body.trim().length > 10000)) {
    throw invalid('Message must be 10000 characters or fewer.');
  }
  return { filter: input.filter || 'all', subject: subject?.trim() || null, body: body?.trim() || null };
}

function startupConfig(env = process.env) {
  const host = '127.0.0.1';
  const rawPort = env.PORT === undefined || env.PORT === '' ? '3000' : env.PORT;
  if (!/^\d+$/.test(String(rawPort))) throw new Error('PORT must be a whole number between 0 and 65535.');
  const port = Number(rawPort);
  if (!Number.isSafeInteger(port) || port < 0 || port > 65535) {
    throw new Error('PORT must be a whole number between 0 and 65535.');
  }
  const dbPath = env.GATHERLY_DB_PATH || DEFAULT_DB;
  if (typeof dbPath !== 'string' || !dbPath.trim() || dbPath === ':memory:') {
    throw new Error('GATHERLY_DB_PATH must be a writable SQLite file path.');
  }
  return { host, port, dbPath };
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
  const cleanupInterval = setInterval(() => {
    if (!closed) {
      try { store.cleanupExpiredSessions(currentIso()); } catch (error) {
        console.error('Session cleanup failed:', error.message);
      }
    }
  }, options.sessionCleanupIntervalMs || 15 * 60 * 1000);
  cleanupInterval.unref();
  store.cleanupExpiredSessions(currentIso());

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
      eventStartTime: event.eventStartTime || null,
      eventEndTime: event.eventEndTime || null,
      timezone: event.timezone || null,
      replacementEventDate: event.replacementEventDate || null,
      replacementEventStartTime: event.replacementEventStartTime || null,
      replacementEventEndTime: event.replacementEventEndTime || null,
      replacementTimezone: event.replacementTimezone || null,
      location: event.location,
      guestMode: event.guestMode,
      rsvpDeadline: event.rsvpDeadline || null,
      responsesOpen: effectiveOpen(event, currentDate().getTime()),
      invitedUnits: stored ? stored.invitedUnits : 0,
      revokedUnits: stored ? stored.revokedUnits : 0,
      yesUnits: stored ? stored.yesUnits : 0,
      noUnits: stored ? stored.noUnits : 0,
      maybeUnits: stored ? stored.maybeUnits : 0,
      attendingPeople: stored ? stored.attendingPeople : 0,
      capacity: event.capacity === null || event.capacity === undefined ? null : Number(event.capacity),
      remainingCapacity: stored ? stored.remainingCapacity : (event.capacity === null ? null : Number(event.capacity)),
      published: Boolean(event.published),
      status: event.status || 'active',
      statusNote: event.statusNote || null,
      theme: event.theme || { ...DEFAULT_THEME },
      invitationSettings: event.invitationSettings || { ...DEFAULT_INVITATION_SETTINGS },
      invitationCopy: event.invitationCopy || { ...DEFAULT_INVITATION_COPY }
    };
  }

  function dashboardGuests(eventId, hostId) {
    const checkIns = store.checkInState(eventId, hostId);
    const activeUnitCheckIns = new Map(checkIns.filter((item) => item.guestUnitId && !item.reversedAt)
      .map((item) => [Number(item.guestUnitId), item.checkedInAt]));
    const activeAttendeeCheckIns = new Map(checkIns.filter((item) => item.attendeeId && !item.reversedAt)
      .map((item) => [Number(item.attendeeId), item.checkedInAt]));
    return store.dashboardGuests(eventId, hostId).map((guest) => ({
      id: Number(guest.id),
      name: guest.name,
      email: guest.email,
      groupName: guest.groupName,
      partyLimit: Number(guest.partyLimit),
      revokedAt: guest.revokedAt,
      walkIn: Boolean(guest.walkIn),
      answer: guest.answer || null,
      partySize: guest.partySize === null ? null : Number(guest.partySize),
      updatedAt: guest.updatedAt || null,
      checkedInAt: activeUnitCheckIns.get(Number(guest.id)) || null,
      attendees: store.attendeesForGuest(Number(guest.id)).map((attendee) => ({
        ...attendee,
        checkedInAt: activeAttendeeCheckIns.get(Number(attendee.id)) || null
      }))
    }));
  }

  function checkInTotals(guests) {
    return guests.reduce((totals, guest) => {
      const partySize = guest.answer === 'yes' ? Number(guest.partySize || 0) : 0;
      const activeAttendees = guest.attendees.filter((attendee) => attendee.checkedInAt).length;
      const checkedInPeople = guest.checkedInAt ? partySize : activeAttendees;
      totals.invitedPeople += guest.walkIn ? 0 : Number(guest.partyLimit);
      totals.confirmedPeople += partySize;
      totals.checkedInPeople += checkedInPeople;
      totals.walkIns += guest.walkIn ? 1 : 0;
      totals.walkInPeople += guest.walkIn && checkedInPeople ? checkedInPeople : 0;
      return totals;
    }, { invitedPeople: 0, confirmedPeople: 0, checkedInPeople: 0, walkIns: 0, walkInPeople: 0 });
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

      if (method === 'GET' && pathname === '/healthz') {
        return json(res, 200, { status: 'ok' });
      }
      if (method === 'GET' && pathname === '/readyz') {
        if (closed) return json(res, 503, { status: 'not_ready' });
        try {
          store.db.prepare('SELECT 1').get();
        } catch {
          return json(res, 503, { status: 'not_ready' });
        }
        return json(res, 200, { status: 'ready' });
      }
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
        if (!record.published) throw invalid('This invitation is not available until the event is published.', 404);
        const canRespond = effectiveOpen(record, currentDate().getTime());
        if (method === 'GET') {
          return json(res, 200, {
            event: {
              title: record.title,
              eventDate: record.eventDate,
              eventStartTime: record.eventStartTime || null,
              eventEndTime: record.eventEndTime || null,
              timezone: record.timezone || null,
              replacementEventDate: record.replacementEventDate || null,
              replacementEventStartTime: record.replacementEventStartTime || null,
              replacementEventEndTime: record.replacementEventEndTime || null,
              replacementTimezone: record.replacementTimezone || null,
              location: record.location,
              rsvpDeadline: record.rsvpDeadline,
              status: record.status || 'active',
              statusNote: record.statusNote || null,
              theme: record.theme,
              invitationSettings: record.invitationSettings,
              invitationCopy: record.invitationCopy
            },
            guest: {
              name: record.name,
              partyLimit: Number(record.partyLimit),
              answer: record.answer || null,
               partySize: record.partySize === null ? null : Number(record.partySize),
               attendees: Array.isArray(record.attendees) ? record.attendees : []
             },
             canRespond
          });
        }
        if (record.status === 'cancelled') throw invalid('This event has been cancelled. RSVP is unavailable.', 409);
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
        if (answer === 'yes' && record.capacity !== null) {
          const currentAttending = store.attendingPeopleForEvent(record.eventId);
          const replacementAttending = record.answer === 'yes' ? Number(record.partySize) : 0;
          if (currentAttending - replacementAttending + input.partySize > Number(record.capacity)) {
            throw invalid(`This event has a capacity of ${record.capacity}; there are not enough remaining places.`, 409);
          }
        }
         const attendees = Array.isArray(input.attendees) ? input.attendees : [];
         if (input.attendees !== undefined && !Array.isArray(input.attendees)) throw invalid('Attendees must be an array.');
         if (attendees.length > 20) throw invalid('Too many attendees.');
         for (const attendee of attendees) {
           if (!attendee || typeof attendee !== 'object' || Array.isArray(attendee)) throw invalid('Each attendee must be an object.');
           if (Object.keys(attendee).some((key) => !['name', 'dietary', 'accessibility', 'ageBand'].includes(key))) {
             throw invalid('Attendee fields are invalid.');
           }
           if (attendee.name !== undefined &&
               (typeof attendee.name !== 'string' || attendee.name.trim().length > 100)) {
             throw invalid('Attendee name must be 100 characters or fewer.');
           }
           if (attendee.dietary !== undefined &&
               (typeof attendee.dietary !== 'string' || attendee.dietary.trim().length > 200)) {
             throw invalid('Attendee dietary must be 200 characters or fewer.');
           }
           if (attendee.accessibility !== undefined &&
               (typeof attendee.accessibility !== 'string' || attendee.accessibility.trim().length > 200)) {
             throw invalid('Attendee accessibility must be 200 characters or fewer.');
           }
           if (attendee.ageBand !== undefined && !['adult', 'child'].includes(attendee.ageBand)) throw invalid('Attendee age band must be adult or child.');
         }
         if (answer === 'no' && attendees.length !== 0) throw invalid('A no RSVP cannot include attendees.');
         if (attendees.length > input.partySize) throw invalid('Attendees cannot exceed party size.');
         if (answer === 'yes' && record.guestMode === 'individual' && attendees.length === 0) {
           attendees.push({ name: record.name });
         }
         store.saveRsvp(record.guestId, answer, input.partySize, currentIso(), attendees);
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

      const eventMatch = pathname.match(/^\/api\/events\/(\d+)(?:\/(guests(?:\/bulk)?|dashboard|responses|publish|status|messages|theme|invitation|invitation-copy|export|seating(?:\/seed|\/plans(?:\/\d+(?:\/(?:run|assignments|positions|venue-items|constraints|publish))?)?)?|check-in(?:\/reverse|\/walk-in)?))?$/);
      if (eventMatch) {
        const eventId = Number(eventMatch[1]);
        if (!Number.isSafeInteger(eventId) || eventId < 1) throw invalid('Event not found.', 404);
        const action = eventMatch[2] || '';
        const event = store.getEventForHost(eventId, hostRecord.id);
        if (!event) throw invalid('Event not found.', 404);
        if (method === 'PUT' && !action) {
          const updatedInput = validateEvent({ ...await bodyJson(req), guestMode: event.guestMode });
          const attendingPeople = store.attendingPeopleForEvent(eventId);
          if (updatedInput.capacity !== null && updatedInput.capacity < attendingPeople) {
            throw invalid(`Event capacity cannot be below the ${attendingPeople} people already attending.`, 409);
          }
          if (!store.updateEvent(eventId, hostRecord.id, updatedInput)) throw invalid('Event not found.', 404);
          return json(res, 200, {
            event: publicEvent(store.getEventForHost(eventId, hostRecord.id), hostRecord.id)
          });
        }
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
        if (method === 'PUT' && action === 'invitation-copy') {
          const input = await bodyJson(req, THEME_BODY_LIMIT);
          const copy = validateInvitationCopy(input);
          if (!Object.hasOwn(input, 'greeting')) {
            copy.greeting = store.getEventForHost(eventId, hostRecord.id).invitationCopy.greeting;
          }
          if (!store.updateEventInvitationCopy(eventId, hostRecord.id, copy)) {
            throw invalid('Event not found.', 404);
          }
          const updated = store.getEventForHost(eventId, hostRecord.id);
          return json(res, 200, { invitationCopy: updated.invitationCopy });
        }
        if (action === 'seating' || action.startsWith('seating/')) {
          const planMatch = action.match(/^seating\/plans(?:\/(\d+)(?:\/(run|assignments|positions|venue-items|constraints|publish))?)?$/);
          const planId = planMatch && planMatch[1] ? Number(planMatch[1]) : null;
          const planAction = planMatch ? planMatch[2] : null;
          if (method === 'GET' && action === 'seating') {
            return json(res, 200, {
              attendees: store.seatingAttendees(eventId, hostRecord.id),
              plans: store.listSeatingPlans(eventId, hostRecord.id)
            });
          }
          if (method === 'POST' && action === 'seating/seed') {
            const input = await bodyJson(req);
            const count = Number(input.count ?? 12);
            if (!Number.isSafeInteger(count) || count < 1 || count > SYNTHETIC_NAMES.length) {
              throw invalid(`Choose between 1 and ${SYNTHETIC_NAMES.length} synthetic attendees.`);
            }
            const existing = new Set(store.seatingAttendees(eventId, hostRecord.id).map((attendee) => attendee.name));
            const names = SYNTHETIC_NAMES.filter((name) => !existing.has(name)).slice(0, count);
            if (names.length < count) throw invalid('There are not enough unused synthetic names for this event.', 409);
            const createdAt = currentIso();
            const entries = names.map((name, index) => {
              const token = crypto.randomBytes(32).toString('base64url');
              const inviteUrl = `/rsvp/${token}`;
              const email = `synthetic-${Date.now()}-${index}@example.test`;
              return {
                eventId, name, email, partyLimit: 1, tokenHash: sha256(token), inviteUrl, createdAt,
                attendees: [{ name, dietary: '', accessibility: '', ageBand: 'adult' }],
                message: {
                  recipient: email, subject: `Synthetic invitation: ${event.title}`,
                  body: `Synthetic confirmed attendee for local testing: ${name}. No email was sent.`
                }
              };
            });
            store.createSyntheticConfirmedGuests(eventId, hostRecord.id, entries, createdAt);
            return json(res, 201, { created: names.length, names });
          }
          if (method === 'POST' && action === 'seating/plans') {
            const input = await bodyJson(req);
            const name = typeof input.name === 'string' ? input.name.trim() : 'Draft seating plan';
            if (!name || name.length > 100) throw invalid('Seating plan name must be 1–100 characters.');
            const tables = validateSeatingTables(input.tables);
            const constraints = validateSeatingConstraints(input.constraints);
            const venueItems = validateVenueItems(input.venueItems);
            const floorPlan = validateFloorPlanMetadata(input.floorPlan);
            const seed = Number.isSafeInteger(Number(input.seed)) ? Number(input.seed) : 1;
            const attendees = store.seatingAttendees(eventId, hostRecord.id);
            const createdId = store.createSeatingPlan(eventId, hostRecord.id, {
              name, tables, constraints, venueItems, floorPlan, seed, algorithmVersion: 'heuristic-1',
              seed,
              inputHash: sha256(JSON.stringify({ attendees, tables, constraints, seed }))
            }, currentIso());
            return json(res, 201, { plan: store.getSeatingPlan(createdId, eventId, hostRecord.id) });
          }
          if (!planId) throw invalid('Seating plan not found.', 404);
          const plan = store.getSeatingPlan(planId, eventId, hostRecord.id);
          if (!plan) throw invalid('Seating plan not found.', 404);
          if (method === 'GET' && !planAction) return json(res, 200, { plan });
          if (method === 'POST' && planAction === 'run') {
            const input = await bodyJson(req);
            const attendees = store.seatingAttendees(eventId, hostRecord.id);
            const generated = generateSeatingDraft(attendees, plan.tables, plan.constraints || [], plan.seed);
            const result = input.reset === true ? {
              ...generated,
              assignments: [],
              score: 0,
              payload: {
                ...generated.payload,
                assignedCount: 0,
                unassigned: attendees.map((attendee) => ({
                  attendeeId: Number(attendee.id), name: attendee.name
                }))
              }
            } : generated;
            const expectedInputHash = plan.status === 'draft' ? null : plan.inputHash;
            if (!store.saveSeatingResult(
              planId, eventId, hostRecord.id, result, currentIso(), 'saved', expectedInputHash
            )) {
              throw invalid('Seating plan changed while it was being generated. Refresh and try again.', 409);
            }
            if (input.reset === true &&
                !store.resetSeatingTablePositions(planId, eventId, hostRecord.id, currentIso())) {
              throw invalid('Seating plan positions could not be reset.', 409);
            }
            return json(res, 200, { plan: store.getSeatingPlan(planId, eventId, hostRecord.id) });
          }
          if (method === 'PUT' && planAction === 'assignments') {
            const input = await bodyJson(req);
            if (!Array.isArray(input.assignments)) throw invalid('Assignments must be an array.');
            if (input.assignments.length === 0) throw invalid('Assignments update cannot be empty.', 409);
            const attendees = store.seatingAttendees(eventId, hostRecord.id);
            const currentInputHash = generateSeatingDraft(attendees, plan.tables, plan.constraints || [], plan.seed).inputHash;
            if (currentInputHash !== plan.inputHash || plan.status === 'stale') {
              throw invalid('Refresh this stale seating plan before editing assignments.', 409);
            }
            const attendeeIds = new Set(attendees.map((attendee) => Number(attendee.id)));
            const tableIds = new Set(plan.tables.map((table) => Number(table.id)));
            const seen = new Set();
            const counts = new Map();
            const assignments = input.assignments.map((assignment) => {
              const attendeeId = Number(assignment?.attendeeId);
              const tableId = Number(assignment?.tableId);
              if (!attendeeIds.has(attendeeId) || !tableIds.has(tableId) || seen.has(attendeeId)) {
                throw invalid('Assignments must reference each eligible attendee once at most.');
              }
              seen.add(attendeeId);
              counts.set(tableId, (counts.get(tableId) || 0) + 1);
              return { attendeeId, tableId };
            });
            for (const table of plan.tables) {
              if ((counts.get(Number(table.id)) || 0) > Number(table.capacity)) {
                throw invalid(`${table.name} exceeds its capacity.`, 409);
              }
            }
            const result = {
              assignments, score: 100, inputHash: plan.inputHash,
              payload: {
                ...(plan.payload || {}), assignedCount: assignments.length,
                unassigned: attendees.filter((attendee) => !seen.has(Number(attendee.id)))
                  .map((attendee) => ({ attendeeId: Number(attendee.id), name: attendee.name }))
              }
            };
            if (!store.saveSeatingResult(
              planId, eventId, hostRecord.id, result, currentIso(), 'saved', plan.inputHash
            )) {
              throw invalid('Seating plan changed while it was being updated. Refresh and try again.', 409);
            }
            return json(res, 200, { plan: store.getSeatingPlan(planId, eventId, hostRecord.id) });
          }
          if (method === 'PUT' && planAction === 'positions') {
            const input = await bodyJson(req);
            if (!Array.isArray(input.positions)) throw invalid('Positions must be an array.');
            const positions = input.positions.map((position) => ({
              tableId: Number(position?.tableId),
              positionX: Number(position?.positionX),
              positionY: Number(position?.positionY)
            }));
            if (positions.some((position) => !Number.isSafeInteger(position.tableId) ||
                !Number.isFinite(position.positionX) || position.positionX < 3 || position.positionX > 97 ||
                !Number.isFinite(position.positionY) || position.positionY < 3 || position.positionY > 97)) {
              throw invalid('Table positions must stay within the seating map.');
            }
            const knownTableIds = new Set(plan.tables.map((table) => Number(table.id)));
            if (!positions.length ||
                positions.some((position) => !knownTableIds.has(position.tableId)) ||
                new Set(positions.map((position) => position.tableId)).size !== positions.length) {
              throw invalid('Table positions must reference each table at most once.');
            }
            if (!store.updateSeatingTablePositions(planId, eventId, hostRecord.id, positions, currentIso())) {
              throw invalid('Seating plan could not be updated.', 409);
            }
            return json(res, 200, { plan: store.getSeatingPlan(planId, eventId, hostRecord.id) });
          }
          if (method === 'PUT' && planAction === 'venue-items') {
            const input = await bodyJson(req);
            const venueItems = validateVenueItems(input.venueItems);
            if (!store.updateSeatingVenueItems(planId, eventId, hostRecord.id, venueItems, currentIso())) {
              throw invalid('Seating plan could not be updated.', 409);
            }
            return json(res, 200, { plan: store.getSeatingPlan(planId, eventId, hostRecord.id) });
          }
          if (method === 'PUT' && planAction === 'constraints') {
            const input = await bodyJson(req);
            const constraints = validateSeatingConstraints(input.constraints);
            const attendees = store.seatingAttendees(eventId, hostRecord.id);
            const generated = generateSeatingDraft(attendees, plan.tables, constraints, plan.seed);
            if (!store.updateSeatingConstraints(
              planId, eventId, hostRecord.id, constraints, generated.inputHash, currentIso()
            )) {
              throw invalid('Seating plan could not be updated.', 409);
            }
            return json(res, 200, { plan: store.getSeatingPlan(planId, eventId, hostRecord.id) });
          }
          if (method === 'POST' && planAction === 'publish') {
            if (plan.status === 'stale') throw invalid('Refresh this stale seating plan before publishing.', 409);
            const result = store.publishSeatingPlan(planId, eventId, hostRecord.id, currentIso());
            if (!result) throw invalid('Seating plan could not be published.', 409);
            return json(res, 200, { plan: store.getSeatingPlan(planId, eventId, hostRecord.id) });
          }
        }
        if (method === 'GET' && (action === 'dashboard' || action === '')) {
          const guests = dashboardGuests(eventId, hostRecord.id);
          const seatingPlans = store.listSeatingPlans(eventId, hostRecord.id);
          return json(res, 200, {
            event: eventDetail(event, hostRecord.id),
            guests,
            totals: checkInTotals(guests),
            seating: seatingPlans[0] || null,
            seatingPublished: seatingPlans.some((plan) => plan.status === 'published')
          });
        }
        if (action === 'check-in' || action === 'check-in/reverse' || action === 'check-in/walk-in') {
          if (method === 'GET' && action === 'check-in') {
            const guests = dashboardGuests(eventId, hostRecord.id);
            return json(res, 200, { guests, totals: checkInTotals(guests) });
          }
          if (event.status === 'cancelled') {
            throw invalid('Cancelled events cannot record attendance changes.', 409);
          }
          if (method === 'POST' && action === 'check-in/walk-in') {
            const input = await bodyJson(req);
            const walkIn = validateWalkIn(input);
            const override = input.override === true;
            const reason = typeof input.reason === 'string' ? input.reason.trim() : '';
            if (override && reason.length < 3) throw invalid('A capacity override needs a reason.');
            if (!override && reason) throw invalid('A walk-in reason requires an explicit capacity override.');
            const created = store.createWalkInWithOptions(eventId, hostRecord.id,
              walkIn.name, walkIn.attendeeName, currentIso(), { override, reason });
            if (!created) throw invalid('Event not found.', 404);
            if (created.overCapacity) {
              throw invalid(`Event capacity is ${created.capacity}; no walk-in place remains. Confirm a host override with a reason to continue.`, 409);
            }
            const checkedIn = store.checkInTarget(eventId, hostRecord.id,
              { attendeeId: created.attendeeId }, currentIso(), currentIso());
            if (!checkedIn || checkedIn.duplicate || checkedIn.conflict) {
              throw invalid('Walk-in could not be checked in.', 409);
            }
            const guests = dashboardGuests(eventId, hostRecord.id);
            return json(res, 201, { guestId: created.guestId, attendeeId: created.attendeeId, totals: checkInTotals(guests) });
          }
          const target = validateCheckInTarget(await bodyJson(req));
          if (method !== 'POST') throw invalid('Check-in route not found.', 404);
          if (action === 'check-in/reverse') {
            if (!store.reverseCheckIn(eventId, hostRecord.id, target, currentIso())) {
              throw invalid('Active check-in not found.', 404);
            }
          } else {
            const result = store.checkInTarget(eventId, hostRecord.id, target, currentIso(), currentIso());
            if (!result) throw invalid('Guest or attendee not found.', 404);
            if (result.duplicate) throw invalid('This guest or attendee is already checked in.', 409);
            if (result.conflict) throw invalid('Reverse the existing household check-in before checking in individuals.', 409);
          }
          const guests = dashboardGuests(eventId, hostRecord.id);
          return json(res, 200, { guests, totals: checkInTotals(guests) });
        }
        if (method === 'GET' && action === 'export') {
          const csvCell = (value) => `"${String(value ?? '').replaceAll('"', '""')}"`;
          const checkIns = store.checkInState(eventId, hostRecord.id);
          const activeUnitCheckIns = new Map(checkIns.filter((item) => item.guestUnitId && !item.reversedAt)
            .map((item) => [Number(item.guestUnitId), item.checkedInAt]));
          const activeAttendeeCheckIns = new Map(checkIns.filter((item) => item.attendeeId && !item.reversedAt)
            .map((item) => [Number(item.attendeeId), item.checkedInAt]));
          const rows = store.exportGuests(eventId, hostRecord.id).map((guest) => {
            const attendees = store.attendeesForGuest(Number(guest.id)).map((item) => ({
              ...item, checkedInAt: activeAttendeeCheckIns.get(Number(item.id)) || ''
            }));
            guest.checkedInAt = activeUnitCheckIns.get(Number(guest.id)) || '';
            return [guest.name, guest.email, guest.answer || '', guest.partySize ?? '',
              attendees.map((item) => item.name).filter(Boolean).join('; '),
              attendees.map((item) => item.dietary).filter(Boolean).join('; '),
              attendees.map((item) => item.accessibility).filter(Boolean).join('; '),
              attendees.map((item) => item.ageBand).join('; '), guest.revokedAt ? 'yes' : 'no',
              guest.updatedAt || '', guest.walkIn ? 'yes' : 'no', guest.checkedInAt || '',
              attendees.map((item) => item.checkedInAt || '').join('; ')].map(csvCell).join(',');
          });
          const csv = [
            ['Guest unit name', 'Email', 'RSVP answer', 'Party size', 'Attendee names',
              'Dietary needs', 'Accessibility needs', 'Age bands', 'Revoked state', 'Update time',
              'Walk-in', 'Checked-in time', 'Attendee check-in times'].map(csvCell).join(','),
            ...rows
          ].join('\r\n') + '\r\n';
          res.writeHead(200, {
            'Content-Type': 'text/csv; charset=utf-8',
            'Content-Disposition': `attachment; filename="gatherly-event-${eventId}-guests.csv"`,
            'Cache-Control': 'no-store'
          });
          return res.end(csv);
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
          if (store.emailExists(eventId, email)) {
            throw invalid('A guest unit with that email is already invited to this event.');
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
            tokenHash: sha256(token),
            inviteUrl
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
            const guest = { eventId, name, email, partyLimit, tokenHash: sha256(token), inviteUrl };
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
          const seen = new Set();
          for (const { guest } of entries) {
            if (store.emailExists(eventId, guest.email)) {
              throw invalid(`A guest unit with that email is already invited to this event.`);
            }
            if (seen.has(guest.email)) {
              throw invalid(`Duplicate email in guest list: ${guest.email}.`);
            }
            seen.add(guest.email);
          }
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
        if (method === 'POST' && action === 'status') {
          const status = validateEventStatus(await bodyJson(req));
          store.updateEventStatus(eventId, hostRecord.id, status.status, status.note, status.replacement);
          const updateMessage = status.status === 'postponed'
            ? `Hello,\n\n${event.title} has been postponed. The new schedule is ${status.replacement.eventDate} at ${status.replacement.startTime} (${status.replacement.timezone}).\n\nLocal message preview only. No email was sent.`
            : null;
          if (updateMessage) {
            const recipients = store.eventRecipients(eventId, hostRecord.id, 'all');
            store.captureEventMessages(eventId, hostRecord.id,
              recipients.map(({ recipient, name }) => ({ recipient, subject: `Update about ${event.title}`, body: `Hello ${name},\n\n${updateMessage}` })), currentIso());
          }
          return json(res, 200, {
            event: publicEvent(store.getEventForHost(eventId, hostRecord.id), hostRecord.id),
            updateMessage
          });
        }
        if (method === 'POST' && action === 'messages') {
          const preview = validateMessagePreview(await bodyJson(req));
          const recipients = store.eventRecipients(eventId, hostRecord.id, preview.filter);
          const subject = preview.subject || `${event.status === 'cancelled' ? 'Update' : 'A note'} about ${event.title}`;
          const body = preview.body || (event.status === 'cancelled'
            ? `Hello,\n\n${event.title} has been cancelled.\n\nLocal message preview only. No email was sent.`
            : `Hello,\n\nHere is an update about ${event.title}.\n\nLocal message preview only. No email was sent.`);
          const count = store.captureEventMessages(eventId, hostRecord.id,
            recipients.map(({ recipient, name }) => ({
              recipient, subject, body: `Hello ${name},\n\n${body}`
            })), currentIso());
          return json(res, 201, { count, filter: preview.filter, subject, message: body });
        }
      }

      const inviteLinkMatch = pathname.match(/^\/api\/guests\/(\d+)\/invite-link$/);
      if (method === 'GET' && inviteLinkMatch) {
        const guestId = Number(inviteLinkMatch[1]);
        const record = Number.isSafeInteger(guestId) && guestId > 0
          ? store.guestInviteLink(guestId, hostRecord.id)
          : null;
        if (!record) throw invalid('Guest not found.', 404);
        if (record.revokedAt) throw invalid('Invite link has been revoked.', 410, 'INVITE_REVOKED');
        if (!record.inviteUrl) {
          if (record.inviteStatus === 'unrecoverable') {
            throw invalid('Legacy invite link could not be safely recovered from its captured invitation.', 422, 'LEGACY_INVITE_UNRECOVERABLE');
          }
          throw invalid('Invite link is unavailable.', 404, 'INVITE_LINK_MISSING');
        }
        return json(res, 200, { inviteUrl: record.inviteUrl });
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
      const payload = { error: status >= 500 ? 'Unexpected server error.' : error.message };
      if (error.code) payload.code = error.code;
      return json(res, status, payload);
    }
  }

  const server = http.createServer((req, res) => { void handle(req, res); });
  server.on('close', () => {
    if (closed) return;
    closed = true;
    clearInterval(cleanupInterval);
    if (ownsStore) store.close();
  });
  function shutdown(callback) {
    if (closed) return callback?.();
    server.close(callback);
  }
  return { server, store, host, shutdown };
}

if (require.main === module) {
  try {
    const config = startupConfig();
    const app = createApp(config);
    const stop = (signal) => {
      console.log(`${signal} received; shutting down.`);
      app.shutdown((error) => {
        if (error) console.error('Shutdown failed:', error.message);
        process.exitCode = error ? 1 : 0;
      });
    };
    process.once('SIGINT', () => stop('SIGINT'));
    process.once('SIGTERM', () => stop('SIGTERM'));
    app.server.on('error', (error) => {
      console.error(`Unable to start local server: ${error.message}`);
      process.exitCode = 1;
    });
    app.server.listen(config.port, config.host, () => {
      const actualPort = app.server.address().port;
      console.log(`Gatherly v0.1 local app: http://${config.host}:${actualPort}`);
      console.log(`SQLite database: ${config.dbPath}`);
      console.log('Synthetic data only. Invitations are captured locally, never emailed.');
    });
  } catch (error) {
    console.error(`Unable to start Gatherly v0.1: ${error.message}`);
    process.exitCode = 1;
  }
}

module.exports = {
  createApp, effectiveOpen, hashPassword, checkPassword, validateEvent, validateTheme,
  validateInvitationSettings, startupConfig
};
