'use strict';

const $ = (selector, root = document) => root.querySelector(selector);
const token = location.pathname.match(/^\/rsvp\/([^/]+)$/)?.[1];

let eventsCache = [];
let currentEventId = null;
let currentSection = 'overview';
let workspaceView = 'events';
// Tracks which guest panels are open across card rebuilds (e.g. after publishing).
let openGuestPanels = new Set();
// Tracks which theme panels are open across card rebuilds (e.g. after publishing).
let openThemePanels = new Set();

const THEME_PRESETS = {
  classic: { primaryColor: '#315a4c', backgroundColor: '#f8f6f1', textColor: '#262b2c', fontFamily: 'serif' },
  garden: { primaryColor: '#466b4d', backgroundColor: '#f4f6ed', textColor: '#26352a', fontFamily: 'serif' },
  midnight: { primaryColor: '#313a63', backgroundColor: '#f1f1f7', textColor: '#22243a', fontFamily: 'sans' }
};
const DEFAULT_THEME = { preset: 'classic', ...THEME_PRESETS.classic, fontSize: 'medium', coverImage: null };
const IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp']);
const MAX_COVER_BYTES = 1024 * 1024;
const COLOR_PATTERN = /^#[\da-f]{6}$/i;
const IMAGE_DATA_PATTERN = /^data:image\/(?:png|jpeg|webp);base64,([a-z\d+/]+={0,2})$/i;
const MIN_TEXT_CONTRAST = 4.5;
const FLOOR_PLAN_STORAGE_KEY = 'gatherly-floor-plans';
const MAX_FLOOR_PLAN_BYTES = 5 * 1024 * 1024;

function loadFloorPlans() {
  try {
    const saved = window.localStorage.getItem(FLOOR_PLAN_STORAGE_KEY);
    const parsed = saved ? JSON.parse(saved) : {};
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

function saveFloorPlan(eventId, floorPlan) {
  try {
    const plans = loadFloorPlans();
    plans[String(eventId)] = floorPlan;
    window.localStorage.setItem(FLOOR_PLAN_STORAGE_KEY, JSON.stringify(plans));
    return true;
  } catch {
    return false;
  }
}

function getFloorPlan(eventId) {
  return loadFloorPlans()[String(eventId)] || null;
}

function arrangeTablePositions(tables) {
  const positions = tables.map((table, index) => ({
    x: Number.isFinite(Number(table.positionX)) ? Number(table.positionX) : 18 + (index % 4) * 21,
    y: Number.isFinite(Number(table.positionY)) ? Number(table.positionY) : 24 + (Math.floor(index / 4) % 3) * 28
  }));
  const anchors = positions.map((position) => ({ x: position.x, y: position.y }));
  const minimumDistance = 18;
  for (let pass = 0; pass < 28; pass += 1) {
    for (let firstIndex = 0; firstIndex < positions.length; firstIndex += 1) {
      for (let secondIndex = firstIndex + 1; secondIndex < positions.length; secondIndex += 1) {
        const first = positions[firstIndex];
        const second = positions[secondIndex];
        const dx = second.x - first.x;
        const dy = second.y - first.y;
        const distance = Math.sqrt((dx * dx) + (dy * dy)) || .01;
        if (distance >= minimumDistance) continue;
        const push = (minimumDistance - distance) / distance * .42;
        const offsetX = dx * push;
        const offsetY = dy * push;
        first.x -= offsetX;
        first.y -= offsetY;
        second.x += offsetX;
        second.y += offsetY;
      }
    }
    positions.forEach((position, index) => {
      position.x += (anchors[index].x - position.x) * .07;
      position.y += (anchors[index].y - position.y) * .07;
      position.x = Math.max(9, Math.min(91, position.x));
      position.y = Math.max(11, Math.min(89, position.y));
    });
  }
  return positions;
}

function detectFloorPlanCandidates(image) {
  const canvas = document.createElement('canvas');
  const scale = Math.min(1, 900 / Math.max(image.naturalWidth || image.width, image.naturalHeight || image.height));
  canvas.width = Math.max(1, Math.round((image.naturalWidth || image.width) * scale));
  canvas.height = Math.max(1, Math.round((image.naturalHeight || image.height) * scale));
  const context = canvas.getContext('2d', { willReadFrequently: true });
  if (!context) throw new Error('Canvas analysis is unavailable.');
  context.drawImage(image, 0, 0, canvas.width, canvas.height);
  const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
  const visited = new Uint8Array(canvas.width * canvas.height);
  const candidates = [];
  for (let y = 0; y < canvas.height; y += 2) {
    for (let x = 0; x < canvas.width; x += 2) {
      const start = y * canvas.width + x;
      if (visited[start]) continue;
      const pixel = start * 4;
      const darkness = (pixels[pixel] + pixels[pixel + 1] + pixels[pixel + 2]) / 3;
      if (darkness > 170) continue;
      const queue = [[x, y]];
      visited[start] = 1;
      let minX = x, maxX = x, minY = y, maxY = y, count = 0;
      while (queue.length) {
        const [currentX, currentY] = queue.pop();
        count += 1;
        minX = Math.min(minX, currentX); maxX = Math.max(maxX, currentX);
        minY = Math.min(minY, currentY); maxY = Math.max(maxY, currentY);
        for (const [nextX, nextY] of [[currentX + 2, currentY], [currentX - 2, currentY], [currentX, currentY + 2], [currentX, currentY - 2]]) {
          if (nextX < 0 || nextY < 0 || nextX >= canvas.width || nextY >= canvas.height) continue;
          const nextIndex = nextY * canvas.width + nextX;
          if (visited[nextIndex]) continue;
          const nextPixel = nextIndex * 4;
          const nextDarkness = (pixels[nextPixel] + pixels[nextPixel + 1] + pixels[nextPixel + 2]) / 3;
          if (nextDarkness > 170) continue;
          visited[nextIndex] = 1;
          queue.push([nextX, nextY]);
        }
      }
      const width = maxX - minX + 1;
      const height = maxY - minY + 1;
      const area = width * height;
      if (count < 12 || area < 180 || area > canvas.width * canvas.height * .18 ||
          width < 18 || height < 18 || width / height > 4 || height / width > 4) continue;
      const ratio = Math.max(width / height, height / width);
      const compactness = count / area;
      const isTable = ratio <= 2.6 && compactness >= .08;
      const confidence = Math.round(Math.max(35, Math.min(94,
        (isTable ? 72 : 42) + (ratio <= 1.8 ? 12 : 0) + (compactness >= .18 ? 8 : 0))));
      candidates.push({
        positionX: Math.round(((minX + maxX) / 2 / canvas.width) * 100),
        positionY: Math.round(((minY + maxY) / 2 / canvas.height) * 100),
        shape: ratio > 1.45 ? 'rectangle' : 'round',
        capacity: ratio > 2.2 ? 10 : ratio > 1.45 ? 8 : 6,
        isTable,
        confidence
      });
    }
  }
  return candidates.slice(0, 40);
}

function relativeLuminance(color) {
  const channels = color.slice(1).match(/.{2}/g).map((value) => parseInt(value, 16) / 255);
  const linear = channels.map((channel) => channel <= 0.04045
    ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4);
  return 0.2126 * linear[0] + 0.7152 * linear[1] + 0.0722 * linear[2];
}

function contrastRatio(firstColor, secondColor) {
  const first = relativeLuminance(firstColor);
  const second = relativeLuminance(secondColor);
  return (Math.max(first, second) + 0.05) / (Math.min(first, second) + 0.05);
}

function bestContrastForeground(backgroundColor) {
  return contrastRatio('#000000', backgroundColor) >= contrastRatio('#ffffff', backgroundColor)
    ? '#000000' : '#ffffff';
}

function isSafeImageDataUrl(value) {
  const match = typeof value === 'string' && IMAGE_DATA_PATTERN.exec(value);
  return Boolean(match && match[1].length % 4 === 0);
}

function normalizeTheme(theme = {}) {
  const preset = ['classic', 'garden', 'midnight', 'custom'].includes(theme.preset)
    ? theme.preset : 'classic';
  const palette = THEME_PRESETS[preset] || THEME_PRESETS.classic;
  const backgroundColor = COLOR_PATTERN.test(theme.backgroundColor || '')
    ? theme.backgroundColor : palette.backgroundColor;
  const requestedTextColor = COLOR_PATTERN.test(theme.textColor || '')
    ? theme.textColor : palette.textColor;
  return {
    preset,
    primaryColor: COLOR_PATTERN.test(theme.primaryColor || '') ? theme.primaryColor : palette.primaryColor,
    backgroundColor,
    textColor: contrastRatio(requestedTextColor, backgroundColor) >= MIN_TEXT_CONTRAST
      ? requestedTextColor : bestContrastForeground(backgroundColor),
    fontFamily: theme.fontFamily === 'sans' || theme.fontFamily === 'serif'
      ? theme.fontFamily : palette.fontFamily,
    fontSize: ['small', 'medium', 'large'].includes(theme.fontSize) ? theme.fontSize : 'medium',
    coverImage: isSafeImageDataUrl(theme.coverImage)
      ? theme.coverImage : null
  };
}

function normalizeInvitationSettings(settings = {}) {
  return {
    revealMode: settings.revealMode === 'envelope' ? 'envelope' : 'direct',
    chimeEnabled: settings.chimeEnabled === true,
    revealMotion: ['fade', 'slide-up'].includes(settings.revealMotion) ? settings.revealMotion : 'none',
    celebration: ['sparkle', 'leaves'].includes(settings.celebration) ? settings.celebration : 'off'
  };
}

const DEFAULT_INVITATION_COPY = {
  greeting: '', title: '', intro: '', rsvpHeading: '', rsvpHelper: '', footerNote: '',
  image: null, imageShape: 'circle', imageAlt: ''
};

function normalizeInvitationCopy(copy = {}) {
  return {
    ...DEFAULT_INVITATION_COPY,
    ...Object.fromEntries(Object.keys(DEFAULT_INVITATION_COPY).map((key) => [
      key, typeof copy[key] === 'string' ? copy[key] : DEFAULT_INVITATION_COPY[key]
    ])),
    image: isSafeImageDataUrl(copy.image) ? copy.image : null,
    imageShape: ['circle', 'rounded-square', 'square', 'arch'].includes(copy.imageShape)
      ? copy.imageShape : 'circle'
  };
}

function setInvitationImage(image, copy) {
  if (!image) return;
  const safeCopy = normalizeInvitationCopy(copy);
  image.hidden = !safeCopy.image;
  image.classList.remove('invitation-image--circle', 'invitation-image--rounded-square', 'invitation-image--square', 'invitation-image--arch');
  image.classList.add(`invitation-image--${safeCopy.imageShape}`);
  if (safeCopy.image) image.src = safeCopy.image;
  else image.removeAttribute('src');
  image.alt = safeCopy.imageAlt;
  if (safeCopy.imageAlt) image.removeAttribute('aria-hidden');
  else image.setAttribute('aria-hidden', 'true');
}

function invitationCopyText(copy, event, guestName = 'Alex Morgan') {
  const safeCopy = normalizeInvitationCopy(copy);
  return {
    greeting: `An invitation for ${guestName}`,
    title: safeCopy.title || event.title,
    intro: safeCopy.intro || 'We’d be delighted if you can join us.',
    rsvpHeading: safeCopy.rsvpHeading || 'Will you be there?',
    rsvpHelper: safeCopy.rsvpHelper || 'Choose the response that works for you.',
    footerNote: safeCopy.footerNote || 'Your reply is saved with this invitation. No email is sent from here.'
  };
}

function syncInvitationPresentation(invitation, settings, isPreview = false) {
  const safeSettings = normalizeInvitationSettings(settings);
  const envelope = $('.reveal-envelope', invitation);
  const content = $('.guest-content', invitation);
  const audioControl = $('.guest-audio-control', invitation);
  const chime = $('.guest-chime-control', invitation);
  const audioStatus = $('.guest-audio-status', invitation);
  if (content) {
    content.classList.remove('reveal-motion-fade', 'reveal-motion-slide-up');
    if (safeSettings.revealMotion !== 'none') {
      content.classList.add(`reveal-motion-${safeSettings.revealMotion}`);
    }
  }
  invitation.classList.remove('has-celebration');
  invitation.classList.remove('has-falling-leaves');
  if (safeSettings.celebration === 'sparkle') invitation.classList.add('has-celebration');
  if (safeSettings.celebration === 'leaves') invitation.classList.add('has-falling-leaves');
  if (envelope) {
    envelope.hidden = safeSettings.revealMode !== 'envelope';
    envelope.disabled = isPreview;
    if (isPreview) envelope.removeAttribute('aria-controls');
    else envelope.setAttribute('aria-controls', 'guest-content');
  }
  if (content) content.hidden = safeSettings.revealMode === 'envelope';
  if (audioControl) audioControl.hidden = !safeSettings.chimeEnabled || !isPreview;
  if (chime) {
    chime.disabled = isPreview;
    chime.hidden = true;
    chime.textContent = 'Play gentle background music';
  }
  if (audioStatus) {
    audioStatus.textContent = isPreview && safeSettings.chimeEnabled
      ? 'Music starts when a guest opens this invitation; browser playback may require an extra click.' : '';
  }
}

function applyTheme(element, theme) {
  const safeTheme = normalizeTheme(theme);
  element.style.setProperty('--invite-primary', safeTheme.primaryColor);
  element.style.setProperty('--invite-background', safeTheme.backgroundColor);
  element.style.setProperty('--invite-text', safeTheme.textColor);
  element.style.setProperty('--invite-font', safeTheme.fontFamily === 'serif'
    ? 'Georgia, "Times New Roman", serif' : 'system-ui, -apple-system, "Segoe UI", sans-serif');
  element.style.setProperty('--invite-font-size', {
    small: '.9rem', medium: '1rem', large: '1.15rem'
  }[safeTheme.fontSize] || '1rem');
  element.style.setProperty('--invite-action-text', bestContrastForeground(safeTheme.primaryColor));
  return safeTheme;
}

function setThemePreview(preview, theme) {
  applyTheme(preview, theme);
}

function formatInvitationDate(value) {
  const [year, month, day] = value.split('-').map(Number);
  return new Intl.DateTimeFormat(undefined, {
    weekday: 'long', month: 'long', day: 'numeric', year: 'numeric'
  }).format(new Date(year, month - 1, day));
}

function formatEventSchedule(event) {
  const dateValue = event.status === 'postponed' && event.replacementEventDate
    ? event.replacementEventDate : event.eventDate;
  const startValue = event.status === 'postponed' && event.replacementEventStartTime
    ? event.replacementEventStartTime : event.eventStartTime;
  const endValue = event.status === 'postponed' && event.replacementEventEndTime
    ? event.replacementEventEndTime : event.eventEndTime;
  const timezoneValue = event.status === 'postponed' && event.replacementTimezone
    ? event.replacementTimezone : event.timezone;
  const date = formatInvitationDate(dateValue);
  if (!startValue) return date;
  const time = (value) => new Intl.DateTimeFormat(undefined, {
    hour: 'numeric', minute: '2-digit', ...(timezoneValue ? { timeZone: timezoneValue } : {})
  }).format(new Date(`${dateValue}T${value}:00Z`));
  const range = endValue ? `${time(startValue)}–${time(endValue)}` : time(startValue);
  return `${date} · ${range}${timezoneValue ? ` (${timezoneValue})` : ''}`;
}

function supportedTimezones() {
  const values = typeof Intl.supportedValuesOf === 'function' ? Intl.supportedValuesOf('timeZone') : [];
  return ['UTC', ...values.filter((value) => value !== 'UTC')];
}

function populateTimezoneSelect(select, selected, allowEmpty = false) {
  if (!select) return;
  select.replaceChildren();
  if (allowEmpty) {
    const option = document.createElement('option');
    option.value = '';
    option.textContent = 'No timezone';
    select.append(option);
  }
  for (const timezone of supportedTimezones()) {
    const option = document.createElement('option');
    option.value = timezone;
    option.textContent = timezone;
    select.append(option);
  }
  select.value = selected || (allowEmpty ? '' : Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC');
  if (!select.value) select.value = 'UTC';
}

function formatInvitationDeadline(value, timezone) {
  return new Intl.DateTimeFormat(undefined, {
    month: 'long', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit',
    timeZoneName: 'short', timeZone: timezone || 'UTC'
  }).format(new Date(value));
}

function mountInvitationPreview(preview, event) {
  const invitation = $('#guest').cloneNode(true);
  invitation.hidden = false;
  invitation.removeAttribute('id');
  invitation.setAttribute('aria-label', 'Invitation preview');
  syncInvitationPresentation(invitation, event.invitationSettings, true);
  const setText = (selector, value) => {
    const element = $(selector, invitation);
    if (element) element.textContent = value;
  };
  const copy = invitationCopyText(event.invitationCopy, event);
  setInvitationImage($('.invitation-image', invitation) || $('#guest-invitation-image', invitation), event.invitationCopy);
  setText('#guest-greeting', copy.greeting);
  setText('#guest-title', copy.title);
  setText('#guest-details', copy.intro);
  setText('#guest-rsvp-title', copy.rsvpHeading);
  setText('#guest-rsvp-helper', copy.rsvpHelper);
  setText('#guest-date', formatEventSchedule(event));
  const locationRow = $('#guest-location-row', invitation);
  locationRow.hidden = !event.location;
  if (event.location) setText('#guest-location', event.location);
  const deadlineRow = $('#guest-deadline-row', invitation);
  deadlineRow.hidden = !event.rsvpDeadline;
  if (event.rsvpDeadline) setText('#guest-deadline', formatInvitationDeadline(event.rsvpDeadline, event.timezone));
  const partyLimit = event.guestMode === 'individual' ? 1 : 4;
  setText('#guest-capacity', `You can include up to ${partyLimit} ${partyLimit === 1 ? 'person' : 'people'} in your reply.`);
  setText('.invitation-footnote', copy.footerNote);

  for (const element of invitation.querySelectorAll('[id]')) element.removeAttribute('id');
  for (const element of invitation.querySelectorAll('[aria-labelledby], [aria-describedby]')) {
    element.removeAttribute('aria-labelledby');
    element.removeAttribute('aria-describedby');
  }
  for (const element of invitation.querySelectorAll('input, button, select, textarea')) {
    element.disabled = true;
  }
  preview.replaceChildren(invitation);
  return invitation;
}

async function api(url, options = {}) {
  const response = await fetch(url, {
    credentials: 'same-origin',
    ...options,
    headers: { 'Content-Type': 'application/json', ...(options.headers || {}) }
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(result.error || `Request failed (${response.status})`);
    error.status = response.status;
    error.code = result.code;
    throw error;
  }
  return result;
}

function formValues(form) {
  return Object.fromEntries(new FormData(form).entries());
}

function showMessage(target, text, isError = false) {
  target.textContent = text;
  target.className = isError ? 'message error' : 'message success';
}

function showToast(text) {
  let toast = $('#invite-link-toast');
  if (!toast) {
    toast = document.createElement('div');
    toast.id = 'invite-link-toast';
    toast.className = 'invite-link-toast';
    toast.setAttribute('role', 'status');
    toast.setAttribute('aria-live', 'polite');
    document.body.append(toast);
  }
  toast.textContent = text;
  toast.hidden = false;
  window.clearTimeout(toast.hideTimer);
  toast.hideTimer = window.setTimeout(() => { toast.hidden = true; }, 2800);
}
async function copyText(value) {
  if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(value);
      return true;
    } catch {
      // Fall through when the browser blocks clipboard permission.
    }
  }
  const field = document.createElement('textarea');
  field.value = value;
  field.setAttribute('readonly', '');
  field.setAttribute('aria-hidden', 'true');
  field.style.position = 'fixed';
  field.style.opacity = '0';
  document.body.append(field);
  field.focus();
  field.select();
  const copied = typeof document.execCommand === 'function' && document.execCommand('copy');
  field.remove();
  if (!copied) throw new Error('Clipboard unavailable.');
  return true;
}

async function start() {
  if (token) return showGuest(token);
  const status = await api('/api/status');
  if (status.host) {
    $('#host').hidden = false;
    await loadEvents();
    return;
  }
  $('#auth').hidden = false;
  $('#auth-title').textContent = status.setupRequired ? 'Create local host account' : 'Host sign in';
  $('#auth-copy').textContent = status.setupRequired
    ? 'One host account is available for this local database. Use synthetic credentials.'
    : 'Sign in to your local Gatherly workspace.';
  $('#auth-submit').textContent = status.setupRequired ? 'Create account' : 'Sign in';
  $('#auth-form [name=password]').autocomplete = status.setupRequired ? 'new-password' : 'current-password';
  $('#auth-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    try {
      await api(status.setupRequired ? '/api/auth/register' : '/api/auth/login', {
        method: 'POST', body: JSON.stringify(formValues(event.currentTarget))
      });
      location.reload();
    } catch (error) { showMessage($('#global-message'), error.message, true); }
  });
}

$('#logout').addEventListener('click', async () => {
  await api('/api/auth/logout', { method: 'POST', body: '{}' });
  location.reload();
});

function setWorkspaceView(view) {
  workspaceView = view === 'outbox' ? 'outbox' : 'events';
  const eventsSection = $('#events');
  const outboxSection = $('#outbox');
  if (eventsSection) eventsSection.hidden = workspaceView !== 'events';
  if (outboxSection) outboxSection.hidden = workspaceView !== 'outbox';
  const workspaceButtons = typeof document.querySelectorAll === 'function'
    ? document.querySelectorAll('[data-workspace-view]') : [];
  workspaceButtons.forEach((button) => {
    const active = button.dataset.workspaceView === workspaceView;
    button.classList.toggle('is-active', active);
    if (active) button.setAttribute('aria-current', 'page');
    else button.removeAttribute('aria-current');
  });
}

const workspaceButtons = typeof document.querySelectorAll === 'function'
  ? document.querySelectorAll('[data-workspace-view]') : [];
workspaceButtons.forEach((button) => {
  button.addEventListener('click', async () => {
    setWorkspaceView(button.dataset.workspaceView);
    if (workspaceView === 'outbox') {
      try { await loadOutbox(); }
      catch (error) { showMessage($('#global-message'), error.message, true); }
    }
  });
});

async function openOutbox() {
  setWorkspaceView('outbox');
  try { await loadOutbox(); }
  catch (error) { showMessage($('#global-message'), error.message, true); }
}

function openCreateEventForm() {
  setWorkspaceView('events');
  const section = $('#create-event');
  section.hidden = false;
  populateTimezoneSelect($('#event-form [name=timezone]'), null);
  const title = $('#event-form [name=title]');
  title.focus();
  if (typeof section.scrollIntoView === 'function') {
    section.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }
}

function closeCreateEventForm() {
  $('#create-event').hidden = true;
  $('#event-form').reset();
  $('#open-create-event').focus();
}

$('#open-create-event').addEventListener('click', openCreateEventForm);
  const legacyCreateToggle = $('#create-event-toggle');
  if (legacyCreateToggle) legacyCreateToggle.addEventListener('click', openCreateEventForm);
  $('#cancel-create-event').addEventListener('click', closeCreateEventForm);

$('#event-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const data = formValues(form);
  if (data.rsvpDeadline) data.rsvpDeadline = new Date(data.rsvpDeadline).toISOString();
  if (data.capacity) data.capacity = Number(data.capacity);
  else data.capacity = null;
  try {
    await api('/api/events', { method: 'POST', body: JSON.stringify(data) });
    form.reset();
    $('#create-event').hidden = true;
    setWorkspaceView('events');
    await loadEvents();
  } catch (error) { showMessage($('#global-message'), error.message, true); }
});

async function loadEvents() {
  const { events } = await api('/api/events');
  eventsCache = events;
  const hashMatch = String(location.hash || '').match(/^#event-(\d+)(?:\/(overview|guests|seating|event-day|messages|invitation|settings))?$/);
  if (hashMatch && events.some((event) => String(event.id) === hashMatch[1])) {
    currentEventId = Number(hashMatch[1]);
    currentSection = hashMatch[2] || 'overview';
  } else if (currentEventId !== null && !events.some((event) => event.id === currentEventId)) {
    currentEventId = null;
    currentSection = 'overview';
  }
  const container = $('#events');
  container.replaceChildren();
  if (!events.length) {
    const empty = document.createElement('section');
    empty.className = 'card muted';
    const message = document.createElement('p');
    message.textContent = 'No events yet. Create one to get started.';
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = 'Create your first event';
    button.addEventListener('click', openCreateEventForm);
    empty.append(message, button);
    container.append(empty);
    renderEventSwitcher();
    return;
  }
  for (const event of events) {
    const card = document.createElement('section');
    card.className = 'card event-card';
    if (event.status === 'cancelled') card.classList.add('event-card--cancelled');
    card.dataset.eventId = String(event.id);
    card.innerHTML = `<div class="event-topbar"><p class="breadcrumb"><span class="event-breadcrumb-title"></span></p><span class="local-event-tag">LOCAL EVENT</span></div><div class="event-heading"><div class="event-heading__copy"><div class="event-status"><span class="publication-status" role="status"></span><span class="response-state"></span></div><h2></h2><p class="event-meta"></p></div><div class="event-actions"><button class="open-event">Open event</button><button class="publish">Publish event</button><button class="add secondary">Add guest unit</button><button class="guest-toggle secondary" aria-expanded="false">Show guests</button><button class="export secondary">Export CSV</button><button class="print secondary">Print list</button><button class="toggle secondary"></button><button class="refresh secondary">Refresh</button></div></div><div class="stats" aria-live="polite"></div><div class="event-workspace" hidden><div class="event-workspace__bar"><button type="button" class="back-events secondary">Back to events</button><nav class="event-section-nav" aria-label="Event workspace sections" role="tablist"><button type="button" role="tab" data-section="overview" aria-selected="true">Overview</button><button type="button" role="tab" data-section="guests" aria-selected="false">Guests</button><button type="button" role="tab" data-section="seating" aria-selected="false">Seating</button><button type="button" role="tab" data-section="event-day" aria-selected="false">Event day</button><button type="button" role="tab" data-section="messages" aria-selected="false">Messages</button><button type="button" role="tab" data-section="invitation" aria-selected="false">Invitation</button><button type="button" role="tab" data-section="settings" aria-selected="false">Settings</button></nav></div></div><section class="check-in-panel notice" data-event-section="event-day"><div class="check-in-panel__heading"><div><p class="section-kicker">EVENT DAY</p><h3>Check-in</h3><p class="help">Search a guest unit, email, or named attendee.</p></div><form class="walk-in-form"><input name="name" maxlength="100" placeholder="Walk-in name" aria-label="Walk-in name" required><input name="attendeeName" maxlength="100" placeholder="Attendee name" aria-label="Walk-in attendee name"><button type="submit">Add walk-in</button></form></div><label class="check-in-search-label">Find arrival<input class="check-in-search" type="search" placeholder="Name, email, or attendee" autocomplete="off"></label><div class="check-in-results" aria-live="polite"></div><p class="check-in-message message" role="status" aria-live="polite"></p></section><section class="event-status-panel notice" data-event-section="settings"><form class="event-status-form"><div class="columns"><label>Event status<select name="status"><option value="active">Active</option><option value="postponed">Postponed</option><option value="cancelled">Cancelled</option></select></label><label>Organizer note (optional)<input name="note" maxlength="500"></label></div><button type="submit" class="secondary">Save event status</button><p class="event-status-message message" role="status" aria-live="polite"></p></form></section><section class="local-message-panel notice" data-event-section="messages"><form class="local-message-form"><strong>Local message preview</strong><p class="help">Capture a message for selected guests in the local outbox. No email is sent.</p><div class="columns"><label>Recipients<select name="filter"><option value="all">All guests</option><option value="pending">Pending / no reply</option><option value="yes">Attending / yes</option><option value="maybe">Maybe</option><option value="no">Declined</option></select></label><label>Subject (optional)<input name="subject" maxlength="200"></label></div><label>Message (optional)<textarea name="message" rows="4" maxlength="10000"></textarea></label><button type="submit" class="secondary">Capture local preview</button><p class="local-message-result message" role="status" aria-live="polite"></p></form></section><section class="publish-next-steps notice" role="status" aria-labelledby="__publish_next_steps_title" data-event-section="overview" hidden><h3 id="__publish_next_steps_title">Published locally — what next?</h3><p>Your event is ready in this local workspace. Create a guest unit to generate a private RSVP link. Its invitation is captured in the local outbox; no email is sent.</p><div class="row"><button type="button" class="next-steps-add">Create a guest unit</button><button type="button" class="secondary next-steps-outbox">Open local email outbox</button></div></section><section class="guest-panel" data-event-section="guests" aria-labelledby="__guest_list_title" hidden><div class="guest-panel__head"><div><p class="section-kicker">INVITATIONS</p><h3 id="__guest_list_title">Your guest list</h3><p class="muted">Guest units and replies stored in this local workspace only.</p></div><button type="button" class="guest-panel-toggle secondary" aria-expanded="false" aria-controls="__guest_panel">Hide guest list</button></div><div class="guest-form-slot"></div><div class="guest-table"></div></section><section class="print-view" hidden></section><div class="theme-editor" data-event-section="invitation">
      <button type="button" class="secondary theme-toggle" aria-expanded="false">Customize invitation</button>
      <section class="theme-panel" hidden>
        <p class="help">Adjust how the invitation opens, its optional background music, colors, font, and cover. Preview changes before saving.</p>
        <section class="invitation-settings" aria-labelledby="invitation-settings-title">
          <div class="invitation-settings__heading">
            <p class="section-kicker">GUEST EXPERIENCE</p>
            <h3 class="invitation-settings-title">How the invitation opens</h3>
            <p class="help">Choose how the card appears and add an optional visual accent. Optional background music starts as guests open the invitation.</p>
          </div>
          <div class="columns invitation-settings-controls">
            <label>Presentation
              <select class="invitation-reveal-mode" aria-label="Invitation presentation">
                <option value="direct">Direct invitation</option>
                <option value="envelope">Animated envelope reveal</option>
              </select>
            </label>
            <label>Reveal motion
              <select class="invitation-reveal-motion" aria-label="Invitation reveal motion">
                <option value="none">None</option>
                <option value="fade">Fade</option>
                <option value="slide-up">Slide up</option>
              </select>
            </label>
            <label>Celebration accent
              <select class="invitation-celebration" aria-label="Invitation celebration accent">
                <option value="off">Off</option>
                <option value="sparkle">Soft sparkle</option>
                <option value="leaves">Falling leaves</option>
              </select>
            </label>
            <label class="invitation-chime-option">
              <input class="invitation-chime-enabled" type="checkbox">
              Play gentle background music when opened
            </label>
          </div>
          <button type="button" class="save-invitation-settings">Save invitation experience</button>
          <p class="invitation-settings-status message" role="status" aria-live="polite"></p>
        </section>
        <section class="invitation-copy-editor" aria-labelledby="invitation-copy-title">
          <div class="invitation-settings__heading">
            <p class="section-kicker">INVITATION COPY</p>
            <h3 class="invitation-copy-title-heading">Make the note yours</h3>
            <p class="help">Leave a field blank to use Gatherly's event-aware default. Copy is rendered as text.</p>
          </div>
          <div class="columns invitation-copy-controls">
            <label>Title override (optional)
              <input class="invitation-copy-title" maxlength="100">
            </label>
            <label class="invitation-copy-wide">Intro message
              <textarea class="invitation-copy-intro" maxlength="500" rows="3"></textarea>
            </label>
            <label>RSVP heading
              <input class="invitation-copy-rsvp-heading" maxlength="100">
            </label>
            <label>RSVP helper text
              <input class="invitation-copy-rsvp-helper" maxlength="200">
            </label>
            <label class="invitation-copy-wide">Footer note
              <textarea class="invitation-copy-footer" maxlength="300" rows="2"></textarea>
            </label>
            <label>Invitation image (PNG, JPEG, or WebP; max 1 MiB)
              <input class="invitation-image-upload" type="file" accept="image/png,image/jpeg,image/webp">
            </label>
            <label>Image shape
              <select class="invitation-image-shape" aria-label="Invitation image shape">
                <option value="circle">Circle</option><option value="rounded-square">Rounded square</option>
                <option value="square">Square</option><option value="arch">Arch</option>
              </select>
            </label>
            <label class="invitation-copy-wide">Image alt text (optional)
              <input class="invitation-image-alt" maxlength="200" placeholder="Describe the image for guests who use a screen reader">
            </label>
          </div>
          <button type="button" class="secondary remove-invitation-image">Remove invitation image</button>
          <button type="button" class="save-invitation-copy">Save invitation copy</button>
          <p class="invitation-copy-status message" role="status" aria-live="polite"></p>
        </section>
        <div class="columns theme-controls">
          <label>Theme preset
            <select class="theme-preset" aria-label="Theme preset">
              <option value="classic">Classic</option><option value="garden">Garden</option>
              <option value="midnight">Midnight</option><option value="custom">Custom</option>
            </select>
          </label>
          <label>Primary color <input class="theme-primary" type="color" aria-label="Primary color"></label>
          <label>Background color <input class="theme-background" type="color" aria-label="Background color"></label>
          <label>Text color <input class="theme-text" type="color" aria-label="Text color"></label>
          <label>Font
            <select class="theme-font" aria-label="Invitation font">
              <option value="serif">Serif</option><option value="sans">Sans serif</option>
            </select>
          </label>
          <label>Font size
            <select class="theme-font-size" aria-label="Invitation font size">
              <option value="small">Small</option><option value="medium">Medium</option><option value="large">Large</option>
            </select>
          </label>
        </div>
        <button type="button" class="secondary preview-reveal-toggle" aria-pressed="false" hidden>Preview opened invitation</button>
        <div class="invitation-preview" aria-label="Invitation preview"></div>
        <p class="help preview-disclosure">Draft preview only. Example guest details are illustrative; preview controls are intentionally inactive and never play sound or submit an RSVP.</p>
        <p class="contrast-warning" role="status" aria-live="polite" hidden></p>
        <p class="theme-status message" role="status" aria-live="polite"></p>
        <button type="button" class="save-theme">Save theme</button>
      </section>
    </div>`;
    const recipientFilter = card.querySelector('.local-message-form select[name="filter"]');
    if (recipientFilter) {
      const option = document.createElement('option');
      option.value = 'unrevoked';
      option.textContent = 'Unrevoked / active';
      recipientFilter.append(option);
    }
      const themeEditor = $('.theme-editor', card);
      const themeToggle = $('.theme-toggle', card);
      $('.event-actions', card).append(themeToggle);
      $('.stats', card).after(themeEditor);
    const editButton = document.createElement('button');
    editButton.type = 'button';
    editButton.className = 'edit secondary';
    editButton.textContent = 'Edit event';
    editButton.setAttribute('aria-expanded', 'false');
    $('.event-actions', card).append(editButton);
    const editPanel = document.createElement('section');
    editPanel.className = 'event-edit-panel notice';
    editPanel.dataset.eventSection = 'settings';
    editPanel.hidden = true;
    editPanel.innerHTML = `<form class="event-edit-form"><label>Event name <input name="title" maxlength="100" required></label><div class="columns"><label>Event date <input name="eventDate" type="date" required></label><label>Start time <input name="eventStartTime" type="time"></label><label>End time (optional) <input name="eventEndTime" type="time"></label><label>Timezone <select name="timezone"></select></label><label>RSVP deadline <input name="rsvpDeadline" type="datetime-local"></label></div><label>Location (optional) <input name="location" maxlength="200"></label><label>Event capacity (optional) <input name="capacity" type="number" min="1" max="100000" inputmode="numeric"></label><div class="row"><button type="submit">Save event details</button><button type="button" class="secondary event-edit-cancel">Cancel</button></div><p class="event-edit-status message" role="status" aria-live="polite"></p></form>`;
    const seatingPanel = document.createElement('section');
    seatingPanel.className = 'seating-panel card';
    seatingPanel.dataset.eventSection = 'seating';
    seatingPanel.hidden = true;
    seatingPanel.innerHTML = `<div class="seating-panel__heading"><div><p class="section-kicker">EXPERIMENTAL</p><h3>Seating draft</h3><p class="muted">Create a host-only draft from confirmed named attendees. This never changes RSVPs or check-in records.</p></div><div class="seating-panel__actions"><label class="floor-plan-file-label">Floor plan<input class="floor-plan-file" type="file" accept="image/png,image/jpeg,image/webp,application/pdf"></label><button type="button" class="secondary floor-plan-analyze" disabled>Analyze</button><button type="button" class="secondary floor-plan-clear" hidden>Remove plan</button><button type="button" class="secondary seating-refresh">Refresh</button></div></div><p class="floor-plan-status message" role="status" aria-live="polite"></p><div class="floor-plan-preview" hidden></div><div class="seating-seed-row"><button type="button" class="secondary seating-seed">Add synthetic confirmed attendees</button><label>Count<input class="seating-seed-count" type="number" min="1" max="20" value="12"></label></div><form class="seating-create-form"><div class="columns"><label>Plan name<input name="name" value="First seating draft" maxlength="100" required></label><label>Tables<input name="tables" type="number" min="1" max="40" value="6" required></label><label>Default seats per table<input name="capacity" type="number" min="1" max="100" value="8" required></label></div><p class="help seating-detection-note">Upload and analyze a floor plan to use its detected tables, shapes, seats, and positions automatically.</p><button type="submit">Create seating draft</button><p class="seating-message message" role="status" aria-live="polite"></p></form><div class="seating-plan-list"></div>`;
    card.append(seatingPanel);
    card.append(editPanel);
    const editForm = $('.event-edit-form', editPanel);
    if (editForm) {
      const editStatus = $('.event-edit-status', editPanel);
      const setEditValues = () => {
        editForm.querySelector('[name=title]').value = event.title;
        editForm.querySelector('[name=eventDate]').value = event.eventDate;
        editForm.querySelector('[name=eventStartTime]').value = event.eventStartTime || '';
        editForm.querySelector('[name=eventEndTime]').value = event.eventEndTime || '';
        populateTimezoneSelect(editForm.querySelector('[name=timezone]'), event.timezone, !event.eventStartTime);
        editForm.querySelector('[name=location]').value = event.location || '';
        editForm.querySelector('[name=capacity]').value = event.capacity ?? '';
        editForm.querySelector('[name=rsvpDeadline]').value = event.rsvpDeadline
          ? new Date(event.rsvpDeadline).toISOString().slice(0, 16) : '';
      };
      editButton.addEventListener('click', () => {
        setEditValues();
        editPanel.hidden = false;
        editButton.setAttribute('aria-expanded', 'true');
        editForm.querySelector('[name=title]').focus();
      });
      $('.event-edit-cancel', editPanel).addEventListener('click', () => {
        editPanel.hidden = true;
        editButton.setAttribute('aria-expanded', 'false');
      });
      editForm.addEventListener('submit', async (submitEvent) => {
        submitEvent.preventDefault();
        const data = formValues(editForm);
        if (data.rsvpDeadline) data.rsvpDeadline = new Date(data.rsvpDeadline).toISOString();
        data.capacity = data.capacity ? Number(data.capacity) : null;
        try {
          const result = await api(`/api/events/${event.id}`, { method: 'PUT', body: JSON.stringify(data) });
          Object.assign(event, result.event);
          editPanel.hidden = true;
          editButton.setAttribute('aria-expanded', 'false');
          await loadEvents();
        } catch (error) { showMessage(editStatus, error.message, true); }
      });
    }
    const guestActions = document.createElement('div');
    guestActions.className = 'guest-actions';
    guestActions.setAttribute('role', 'group');
    guestActions.setAttribute('aria-label', 'Add guests');
    const addButton = $('.add', card);
    addButton.setAttribute('aria-expanded', 'false');
    addButton.addEventListener('click', () => {
      if (event.status === 'cancelled') return;
      toggleGuestComposer(event, card, 'single');
    });
    guestActions.append(addButton);
    const bulkButton = document.createElement('button');
    bulkButton.type = 'button';
    bulkButton.className = 'bulk-add secondary';
    bulkButton.textContent = 'Bulk invite';
    bulkButton.setAttribute('aria-expanded', 'false');
    bulkButton.addEventListener('click', () => {
      if (event.status === 'cancelled') return;
      toggleGuestComposer(event, card, 'bulk');
    });
    guestActions.append(bulkButton);
    card.guestActionButtons = { single: addButton, bulk: bulkButton };
    $('.publish', card).after(guestActions);
    const openEvent = $('.open-event', card);
    if (openEvent) openEvent.addEventListener('click', () => switchEvent(String(event.id), card));
    const backEvents = $('.back-events', card);
    if (backEvents) backEvents.addEventListener('click', () => switchEvent(''));
    card.querySelectorAll('.event-section-nav [data-section]').forEach((button) => {
      button.addEventListener('click', () => setEventSection(event, card, button.dataset.section));
    });
    $('.guest-form-slot', card).hidden = true;
    $('.event-breadcrumb-title', card).textContent = event.title;
    $('h2', card).textContent = event.title;
    updatePublicationStatus(event, card);
    const statusLabels = { active: 'Active', postponed: 'Postponed', cancelled: 'Cancelled' };
    const lifecycleStatus = document.createElement('span');
    lifecycleStatus.className = 'lifecycle-status';
    lifecycleStatus.setAttribute('role', 'status');
    lifecycleStatus.hidden = event.status !== 'cancelled';
    lifecycleStatus.textContent = event.status === 'cancelled' ? statusLabels.cancelled : '';
    $('.event-status', card).append(lifecycleStatus);
    const statusForm = $('.event-status-form', card);
    const statusMessage = $('.event-status-message', card);
    if (statusForm) {
      const replacementFields = document.createElement('fieldset');
      replacementFields.className = 'replacement-schedule-fields';
      replacementFields.innerHTML = '<legend>Replacement schedule for postponement</legend><div class="columns"><label>New date <input name="replacementEventDate" type="date"></label><label>New start time <input name="replacementStartTime" type="time"></label><label>New end time (optional) <input name="replacementEndTime" type="time"></label><label>New timezone <select name="replacementTimezone"></select></label></div><p class="help">Required when saving a new postponed schedule. RSVPs remain open.</p>';
      statusForm.append(replacementFields);
      populateTimezoneSelect(statusForm.elements.replacementTimezone, event.replacementTimezone || event.timezone || null);
      statusForm.elements.status.value = event.status || 'active';
      statusForm.elements.note.value = event.statusNote || '';
      if (statusForm.elements.replacementEventDate) statusForm.elements.replacementEventDate.value = event.replacementEventDate || '';
      if (statusForm.elements.replacementStartTime) statusForm.elements.replacementStartTime.value = event.replacementEventStartTime || '';
      if (statusForm.elements.replacementEndTime) statusForm.elements.replacementEndTime.value = event.replacementEventEndTime || '';
      statusForm.addEventListener('submit', async (submitEvent) => {
        submitEvent.preventDefault();
        try {
          const replacement = {
            eventDate: statusForm.elements.replacementEventDate?.value || '',
            startTime: statusForm.elements.replacementStartTime?.value || '',
            endTime: statusForm.elements.replacementEndTime?.value || '',
            timezone: statusForm.elements.replacementTimezone?.value || ''
          };
          const result = await api(`/api/events/${event.id}/status`, {
            method: 'POST', body: JSON.stringify({ status: statusForm.elements.status.value, note: statusForm.elements.note.value, replacement })
          });
          Object.assign(event, result.event);
          statusMessage.textContent = 'Event status saved.';
          await loadEvents();
        } catch (error) { showMessage(statusMessage, error.message, true); }
      });
    }
    $('.response-state', card).textContent = event.responsesOpen ? 'RSVPs open' : 'RSVPs closed';
    $('.event-meta', card).textContent = `${formatEventSchedule(event)} · ${event.location || 'No location'} · ${event.guestMode} units${event.rsvpDeadline ? ` · deadline ${formatInvitationDeadline(event.rsvpDeadline, event.timezone)}` : ''}`;
    populateTimezoneSelect($('#event-form [name=timezone]'), null);
    $('.export', card).addEventListener('click', () => {
      if (event.status === 'cancelled') return;
      location.href = `/api/events/${event.id}/export`;
    });
    $('.print', card).addEventListener('click', async () => {
      if (event.status === 'cancelled') return;
      await renderDashboard(event, card);
      const printView = $('.print-view', card);
      printView.hidden = false;
      card.classList.add('is-printing');
      window.print();
      card.classList.remove('is-printing');
      printView.hidden = true;
    });
    if (event.capacity !== null && event.capacity !== undefined) {
      $('.event-meta', card).textContent += ` · capacity ${event.capacity}`;
    }
    const messageForm = $('.local-message-form', card);
    const messageResult = $('.local-message-result', card);
    if (messageForm) messageForm.addEventListener('submit', async (submitEvent) => {
      submitEvent.preventDefault();
      if (event.status === 'cancelled') return;
      try {
        const result = await api(`/api/events/${event.id}/messages`, {
          method: 'POST', body: JSON.stringify(formValues(messageForm))
        });
        messageResult.textContent = `${result.count} local preview${result.count === 1 ? '' : 's'} captured. No email was sent.`;
        messageForm.reset();
        await loadOutbox();
      } catch (error) { showMessage(messageResult, error.message, true); }
    });
    $('.publish', card).addEventListener('click', async () => {
      if (event.status === 'cancelled') return;
      if (event.published) return;
      const publishButton = $('.publish', card);
      publishButton.disabled = true;
      publishButton.textContent = 'Publishing…';
      try {
        const result = await api(`/api/events/${event.id}/publish`, {
          method: 'POST', body: '{}'
        });
        event.published = Boolean(result.event && result.event.published);
        if (!event.published) throw new Error('The event was not published. Please refresh and try again.');
        updatePublicationStatus(event, card);
        await loadEvents();
      } catch (error) {
        if (!event.published) {
          publishButton.disabled = false;
          publishButton.textContent = 'Publish event';
        }
        showMessage($('#global-message'), error.message, true);
      }
    });
    $('.next-steps-add', card).addEventListener('click', () => {
      if (event.status === 'cancelled') return;
      showGuestForm(event, card);
    });
    $('.next-steps-outbox', card).addEventListener('click', openOutbox);
    const toggle = $('.toggle', card);
    toggle.textContent = event.responsesOpen ? 'Close RSVPs' : 'Reopen RSVPs';
    toggle.addEventListener('click', async () => {
      if (event.status === 'cancelled') return;
      try {
        await api(`/api/events/${event.id}/responses`, {
          method: 'POST', body: JSON.stringify({ open: !event.responsesOpen })
        });
        await loadEvents();
      } catch (error) { showMessage($('#global-message'), error.message, true); }
    });
    $('.refresh', card).addEventListener('click', () => {
      if (event.status === 'cancelled') return;
      return renderDashboard(event, card);
    });

    // Unique IDs for this card's landmarks (avoids duplicate-id collisions across cards).
    const safeId = String(event.id).replace(/[^a-z0-9_-]/gi, '');
    const titleId = `guest-list-title-${safeId}`;
    const panelId = `guest-panel-${safeId}`;
    const publishTitleId = `publish-next-steps-title-${safeId}`;
    const titleEl = $('.guest-panel__head h3', card);
    if (titleEl) titleEl.id = titleId;
    const panel = $('.guest-panel', card);
    if (panel) panel.id = panelId;
    const publishTitle = $('#publish-next-steps-title', card);
    if (publishTitle) publishTitle.id = publishTitleId;
    const publishSection = $('.publish-next-steps', card);
    if (publishSection) publishSection.setAttribute('aria-labelledby', publishTitleId);
    if (panel) panel.setAttribute('aria-labelledby', titleId);

    // Guest list show/hide toggle (collapsed by default, restored across rebuilds).
    const guestToggle = $('.guest-toggle', card);
    const guestPanelToggle = $('.guest-panel-toggle', card);
    const togglePanel = (expanded) => {
      if (panel) panel.hidden = !expanded;
      if (guestToggle) {
        guestToggle.textContent = expanded ? 'Hide guests' : 'Show guests';
        guestToggle.setAttribute('aria-expanded', String(expanded));
      }
      if (guestPanelToggle) {
        guestPanelToggle.textContent = expanded ? 'Hide guest list' : 'Show guest list';
        guestPanelToggle.setAttribute('aria-expanded', String(expanded));
      }
      if (expanded) openGuestPanels.add(String(event.id));
      else openGuestPanels.delete(String(event.id));
    };
    togglePanel(openGuestPanels.has(String(event.id)));
    card.guestPanelToggleFn = togglePanel;
    const toggleHandler = () => {
      const expanded = guestToggle.getAttribute('aria-expanded') !== 'true';
      togglePanel(expanded);
    };
    if (guestToggle) guestToggle.addEventListener('click', toggleHandler);
    if (guestPanelToggle) guestPanelToggle.addEventListener('click', toggleHandler);

    setupSeating(event, card);
    setupThemeEditor(event, card);
    container.append(card);
    syncEventCardAvailability(event, card);
    await renderDashboard(event, card);
    syncEventCardAvailability(event, card);
    syncEventWorkspace(event, card);
  }
  renderEventSwitcher();
  applyEventFilter();
}

function renderEventSwitcher() {
  const select = $('#event-switch');
  if (!select) return;
  const previousValue = select.value;
  select.replaceChildren();
  const allOption = document.createElement('option');
  allOption.value = '';
  allOption.textContent = 'All events';
  select.appendChild(allOption);
  for (const event of eventsCache) {
    const option = document.createElement('option');
    option.value = String(event.id);
    option.textContent = event.title;
    select.appendChild(option);
  }
  select.value = previousValue !== '' && eventsCache.some((e) => String(e.id) === previousValue)
    ? previousValue
    : (currentEventId !== null ? String(currentEventId) : '');
}

function applyEventFilter() {
  const container = $('#events');
  if (currentEventId === null) {
    container.querySelectorAll('.event-card').forEach((card) => { card.hidden = false; });
    return;
  }
  container.querySelectorAll('.event-card').forEach((card) => {
    card.hidden = String(card.dataset.eventId) !== String(currentEventId);
  });
}

function switchEvent(eventId, selectedCard = null) {
  setWorkspaceView('events');
  currentEventId = eventId === '' || eventId === null ? null : Number(eventId);
  currentSection = 'overview';
  const selected = currentEventId === null ? null : eventsCache.find((event) => event.id === currentEventId);
  const nextHash = selected ? `#event-${selected.id}/overview` : '#events';
  if (location.hash !== nextHash && typeof history !== 'undefined') history.replaceState(null, '', nextHash);
  $('#event-switch').value = currentEventId !== null ? String(currentEventId) : '';
  applyEventFilter();
  const cards = document.querySelectorAll?.('.event-card') || [];
  cards.forEach((card) => {
    const event = eventsCache.find((item) => String(item.id) === String(card.dataset.eventId));
    if (event) syncEventWorkspace(event, card);
  });
  if (selected) {
    const activeCard = selectedCard || document.querySelector(`.event-card[data-event-id="${currentEventId}"]`);
    if (activeCard) syncEventWorkspace(selected, activeCard);
    if (activeCard && typeof activeCard.scrollIntoView === 'function') activeCard.scrollIntoView({ behavior: 'smooth', block: 'start' });
    if (activeCard) activeCard.querySelector('.event-section-nav button')?.focus();
    if (activeCard) renderDashboard(selected, activeCard).catch((error) => showMessage($('#global-message'), error.message, true));
  }
}

function setEventSection(event, card, section) {
  currentSection = section;
  const validSections = ['overview', 'guests', 'seating', 'event-day', 'messages', 'invitation', 'settings'];
  if (!validSections.includes(section)) currentSection = 'overview';
  if (typeof history !== 'undefined') history.replaceState(null, '', `#event-${event.id}/${currentSection}`);
  syncEventWorkspace(event, card);
  const target = card.querySelector(`.event-section-nav button[data-section="${currentSection}"]`);
  if (target) target.focus();
}

function syncEventWorkspace(event, card) {
  const selected = currentEventId !== null && String(currentEventId) === String(event.id);
  if (typeof card.classList.toggle === 'function') card.classList.toggle('is-selected', selected);
  else if (selected) card.classList.add('is-selected');
  else card.classList.remove('is-selected');
  const workspace = $('.event-workspace', card);
  if (workspace) workspace.hidden = !selected;
  const openButton = $('.open-event', card);
  if (openButton) openButton.textContent = selected ? 'Manage event' : 'Open event';
  const detailControls = ['.add', '.bulk-add', '.guest-toggle', '.export', '.print', '.toggle', '.refresh', '.edit', '.theme-toggle', '.back-events'];
  for (const selector of detailControls) {
    const control = $(selector, card);
    if (control) control.hidden = !selected;
  }
  card.querySelectorAll('[data-event-section]').forEach((panel) => {
    panel.hidden = !selected || panel.dataset.eventSection !== currentSection;
  });
  card.querySelectorAll('.event-section-nav [data-section]').forEach((button) => {
    const active = selected && button.dataset.section === currentSection;
    button.setAttribute('aria-selected', String(active));
    button.tabIndex = active ? 0 : -1;
  });
  if (!selected) {
    const guestPanel = $('.guest-panel', card);
    if (guestPanel) guestPanel.hidden = true;
  }
}

$('#event-switch').addEventListener('change', (event) => {
  switchEvent(event.target.value);
});

function setupSeating(event, card) {
  let seatingMapZoom = 1;
  const panel = $('.seating-panel', card);
  if (!panel) return;
  const form = $('.seating-create-form', panel);
  const list = $('.seating-plan-list', panel);
  const message = $('.seating-message', panel);
  if (!form || !list || !message) return;
  const tableCountInput = form.elements.tables;
  const floorPlanFile = $('.floor-plan-file', panel);
  const floorPlanAnalyze = $('.floor-plan-analyze', panel);
  const floorPlanClear = $('.floor-plan-clear', panel);
  const floorPlanStatus = $('.floor-plan-status', panel);
  const floorPlanPreview = $('.floor-plan-preview', panel);
  let selectedFloorPlan = getFloorPlan(event.id);
  const setFloorPlanStatus = (text, error = false) => {
    floorPlanStatus.textContent = text;
    floorPlanStatus.className = `floor-plan-status message${text ? (error ? ' error' : ' success') : ''}`;
  };
  const renderFloorPlanPreview = () => {
    floorPlanPreview.replaceChildren();
    if (!selectedFloorPlan) {
      floorPlanPreview.hidden = true;
      floorPlanClear.hidden = true;
      floorPlanAnalyze.disabled = true;
      return;
    }
    floorPlanPreview.hidden = false;
    floorPlanClear.hidden = false;
    floorPlanAnalyze.disabled = selectedFloorPlan.type === 'application/pdf';
    if (selectedFloorPlan.type === 'application/pdf') {
      const frame = document.createElement('iframe');
      frame.title = 'Uploaded floor plan preview';
      frame.src = selectedFloorPlan.dataUrl;
      floorPlanPreview.append(frame);
      setFloorPlanStatus('PDF preview loaded. Convert it to PNG or JPG to enable table analysis.');
    } else {
      const image = document.createElement('img');
      image.alt = 'Uploaded event floor plan';
      image.src = selectedFloorPlan.dataUrl;
      floorPlanPreview.append(image);
      setFloorPlanStatus('Floor plan loaded. Analyze it to find table candidates.');
    }
  };
  renderFloorPlanPreview();
  floorPlanFile.addEventListener('change', () => {
    const file = floorPlanFile.files?.[0];
    if (!file) return;
    if (file.size > MAX_FLOOR_PLAN_BYTES) {
      setFloorPlanStatus('Floor plan must be 5 MB or smaller.', true);
      floorPlanFile.value = '';
      return;
    }
    if (!IMAGE_TYPES.has(file.type) && file.type !== 'application/pdf') {
      setFloorPlanStatus('Use a PNG, JPG, WebP, or PDF floor plan.', true);
      floorPlanFile.value = '';
      return;
    }
    const reader = new FileReader();
    reader.addEventListener('load', () => {
      selectedFloorPlan = { name: file.name, type: file.type, dataUrl: String(reader.result) };
      if (!saveFloorPlan(event.id, selectedFloorPlan)) {
        setFloorPlanStatus('The floor plan could not be saved in this browser.', true);
        return;
      }
      renderFloorPlanPreview();
      setFloorPlanStatus(file.type === 'application/pdf'
        ? 'PDF preview loaded. Convert it to PNG or JPG to enable table analysis.'
        : 'Floor plan loaded. Analyze it to find table candidates.');
    });
    reader.addEventListener('error', () => setFloorPlanStatus('The floor plan could not be read.', true));
    reader.readAsDataURL(file);
  });
  floorPlanClear.addEventListener('click', () => {
    selectedFloorPlan = null;
    saveFloorPlan(event.id, null);
    floorPlanFile.value = '';
    renderFloorPlanPreview();
    setFloorPlanStatus('Floor plan removed.');
  });
  floorPlanAnalyze.addEventListener('click', async () => {
    if (!selectedFloorPlan || selectedFloorPlan.type === 'application/pdf') return;
    floorPlanAnalyze.disabled = true;
    setFloorPlanStatus('Analyzing floor plan…');
    try {
      const image = new Image();
      image.src = selectedFloorPlan.dataUrl;
      await new Promise((resolve, reject) => {
        image.addEventListener('load', resolve);
        image.addEventListener('error', reject);
      });
      const candidates = detectFloorPlanCandidates(image);
      if (!candidates.length) {
        setFloorPlanStatus('No distinct table candidates found. You can still create the plan manually.', true);
        return;
      }
      const tables = candidates.filter((candidate) => candidate.isTable);
      selectedFloorPlan.candidates = tables;
      saveFloorPlan(event.id, selectedFloorPlan);
      tableCountInput.value = String(tables.length);
      if (!tables.length) {
        setFloorPlanStatus('No table-like shapes were detected. You can still create the plan manually.', true);
        return;
      }
      selectedFloorPlan.candidates = tables;
      saveFloorPlan(event.id, selectedFloorPlan);
      setFloorPlanStatus(`${tables.length} table${tables.length === 1 ? '' : 's'} detected and placed according to the floor plan.`);
    } catch {
      setFloorPlanStatus('The image could not be analyzed. Try a clearer PNG or JPG.', true);
    } finally {
      floorPlanAnalyze.disabled = false;
    }
  });
  const showMessage = (text, error = false) => {
    message.textContent = text;
    message.className = `seating-message message${text ? (error ? ' error' : ' success') : ''}`;
  };
  const renderPlan = (plan, attendees) => {
    list.replaceChildren();
    const heading = document.createElement('div');
    heading.className = 'seating-plan-heading';
    const title = document.createElement('h4');
    title.textContent = `${plan.name} · ${plan.status}`;
    const summary = document.createElement('p');
    summary.className = 'help';
    const optimization = plan.payload?.optimization;
    const optimizationSummary = optimization
      ? ` · ${optimization.familiesKeptTogether}/${optimization.householdGroups} households together`
      : '';
    summary.textContent = `${plan.payload?.assignedCount || 0}/${attendees.length} assigned · ${plan.payload?.violations?.length || 0} issues${optimizationSummary}`;
    const planActions = document.createElement('div');
    planActions.className = 'seating-plan-actions';
    const printPlan = () => {
      card.classList.add('event-card--seating-printing');
      const cleanup = () => card.classList.remove('event-card--seating-printing');
      window.addEventListener?.('afterprint', cleanup, { once: true });
      window.print();
      setTimeout(cleanup, 1000);
    };
    [['Print plan', printPlan], ['Share plan', async () => {
      try { await copyText(`${location.origin}${location.pathname}#event-${event.id}/seating`); showMessage('Seating plan link copied.'); }
      catch (error) { showMessage(error.message, true); }
    }]].forEach(([text, action]) => {
      const button = document.createElement('button');
      button.type = 'button'; button.className = 'secondary'; button.textContent = text;
      button.addEventListener('click', action); planActions.append(button);
    });
    heading.append(title, summary, planActions);
    list.append(heading);
    const canvas = document.createElement('div');
    canvas.className = 'seating-canvas';
    canvas.setAttribute('role', 'group');
    canvas.setAttribute('aria-label', 'Top view seating map');
    let venuePlacementType = null;
    const floorPlan = getFloorPlan(event.id);
    const tablePositions = arrangeTablePositions(plan.tables || []);
    const mapLayer = document.createElement('div');
    mapLayer.className = 'seating-map-layer';
    const addVenueItem = (type, positionX, positionY) => {
      const item = document.createElement('span');
      item.className = 'seating-venue-item';
      item.textContent = type;
      item.style.left = `${positionX}%`; item.style.top = `${positionY}%`;
      item.draggable = true;
      item.addEventListener('dragend', (event) => {
        const bounds = canvas.getBoundingClientRect();
        item.style.left = `${Math.max(3, Math.min(97, ((event.clientX - bounds.left) / bounds.width) * 100))}%`;
        item.style.top = `${Math.max(3, Math.min(97, ((event.clientY - bounds.top) / bounds.height) * 100))}%`;
      });
      mapLayer.append(item);
    };
    const venueTools = document.createElement('div');
    venueTools.className = 'seating-venue-tools';
    const venueToolsLabel = document.createElement('strong');
    venueToolsLabel.textContent = 'Venue items';
    venueTools.append(venueToolsLabel);
    ['Dance floor', 'Bar', 'DJ booth'].forEach((type) => {
      const tool = document.createElement('button');
      tool.type = 'button';
      tool.className = 'secondary';
      tool.textContent = type;
      tool.addEventListener('click', () => {
        venuePlacementType = type;
        canvas.classList.add('is-placement-mode');
        showMessage(`Click the map to place a ${type}.`);
      });
      venueTools.append(tool);
    });
    canvas.append(venueTools);
    canvas.addEventListener('click', (clickEvent) => {
      if (!venuePlacementType || clickEvent.target.closest('button, .seating-map-table, .seating-venue-item, .seating-guest-sidebar')) return;
      const bounds = canvas.getBoundingClientRect();
      const positionX = Math.max(3, Math.min(97, 50 + ((clickEvent.clientX - (bounds.left + bounds.width / 2)) / seatingMapZoom / bounds.width) * 100));
      const positionY = Math.max(3, Math.min(97, 50 + ((clickEvent.clientY - (bounds.top + bounds.height / 2)) / seatingMapZoom / bounds.height) * 100));
      addVenueItem(venuePlacementType, positionX, positionY);
      venuePlacementType = null;
      canvas.classList.remove('is-placement-mode');
      showMessage('Venue item placed.');
    });
    const applyMapZoom = () => { mapLayer.style.transform = `scale(${seatingMapZoom})`; };
    const zoomControls = document.createElement('div');
    zoomControls.className = 'seating-zoom-controls';
    [['−', -0.15, 'Zoom out'], ['Fit', 0, 'Fit floor plan'], ['+', 0.15, 'Zoom in']].forEach(([text, amount, label]) => {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'secondary';
      button.textContent = text;
      button.setAttribute('aria-label', label);
      button.addEventListener('click', () => {
        seatingMapZoom = amount === 0 ? 1 : Math.max(.5, Math.min(2.5, seatingMapZoom + amount));
        applyMapZoom();
      });
      zoomControls.append(button);
    });
    canvas.append(zoomControls);
    if (floorPlan?.type?.startsWith('image/')) {
      const floorImage = document.createElement('img');
      floorImage.className = 'seating-floor-plan';
      floorImage.src = floorPlan.dataUrl;
      floorImage.alt = 'Uploaded floor plan behind seating map';
      mapLayer.append(floorImage);
    }
    const canvasHint = document.createElement('p');
    canvasHint.className = 'seating-canvas__hint';
    canvasHint.textContent = 'Drag a guest chair to another table to move them.';
    canvas.append(canvasHint);
    const assigned = new Map((plan.assignments || []).map((item) => [Number(item.attendeeId), Number(item.tableId)]));
    const unassigned = attendees.filter((attendee) => !assigned.has(Number(attendee.id)));
    const persistAssignment = async (attendeeId, fromTableId, toTableId) => {
      if (Number(fromTableId) === Number(toTableId)) return;
      const next = (plan.assignments || []).map((assignment) =>
        Number(assignment.attendeeId) === Number(attendeeId)
          ? { ...assignment, tableId: Number(toTableId) } : assignment);
      if (!next.some((assignment) => Number(assignment.attendeeId) === Number(attendeeId))) {
        next.push({ attendeeId: Number(attendeeId), tableId: Number(toTableId) });
      }
      try {
        const result = await api(`/api/events/${event.id}/seating/plans/${plan.id}/assignments`, {
          method: 'PUT', body: JSON.stringify({ assignments: next })
        });
        renderPlan(result.plan, attendees);
        showMessage('Guest moved to the new table.');
      } catch (error) {
        showMessage(error.message, true);
      }
    };
    plan.tables.forEach((table, tableIndex) => {
      const position = tablePositions[tableIndex];
      const tableMap = document.createElement('article');
      tableMap.className = `seating-map-table seating-map-table--${table.shape || 'round'}`;
      tableMap.style.left = `${position.x}%`;
      tableMap.style.top = `${position.y}%`;
      tableMap.setAttribute('aria-label', `${table.name}, ${table.capacity} seats`);
      tableMap.dataset.tableId = String(table.id);
      tableMap.draggable = true;
      tableMap.addEventListener('dragstart', (dragEvent) => {
        dragEvent.dataTransfer?.setData('text/gatherly-table', String(table.id));
      });
      tableMap.addEventListener('dragend', async (dragEvent) => {
        const bounds = canvas.getBoundingClientRect();
        const positionX = Math.max(3, Math.min(97, ((dragEvent.clientX - bounds.left) / bounds.width) * 100));
        const positionY = Math.max(3, Math.min(97, ((dragEvent.clientY - bounds.top) / bounds.height) * 100));
        try {
          const result = await api(`/api/events/${event.id}/seating/plans/${plan.id}/positions`, {
            method: 'PUT',
            body: JSON.stringify({ positions: [{ tableId: table.id, positionX, positionY }] })
          });
          renderPlan(result.plan, attendees);
        } catch (error) { showMessage(error.message, true); }
      });
      tableMap.addEventListener('dragover', (dragEvent) => {
        if (dragEvent.dataTransfer?.types.includes('text/gatherly-attendee')) {
          dragEvent.preventDefault();
          tableMap.classList.add('is-drop-target');
        }
      });
      tableMap.addEventListener('dragleave', () => tableMap.classList.remove('is-drop-target'));
      tableMap.addEventListener('drop', (dropEvent) => {
        dropEvent.preventDefault();
        tableMap.classList.remove('is-drop-target');
        const payload = dropEvent.dataTransfer?.getData('text/gatherly-attendee');
        if (!payload) return;
        const [attendeeId, fromTableId] = payload.split(':');
        persistAssignment(attendeeId, fromTableId, table.id);
      });
      const tableSurface = document.createElement('div');
      tableSurface.className = 'seating-map-table__surface';
      const tableLabel = document.createElement('strong');
      tableLabel.textContent = table.name;
      const tableCount = document.createElement('small');
      const tableGuests = attendees.filter((attendee) => assigned.get(Number(attendee.id)) === Number(table.id));
      tableCount.textContent = `${tableGuests.length}/${table.capacity}`;
      tableSurface.append(tableLabel, tableCount);
      tableMap.append(tableSurface);
      for (let index = 0; index < table.capacity; index += 1) {
        const seat = document.createElement('span');
        const attendee = tableGuests[index];
        seat.className = `seating-map-seat${attendee ? '' : ' seating-map-seat--empty'}`;
        seat.style.setProperty('--seat-index', index);
        seat.style.setProperty('--seat-count', Math.max(Number(table.capacity), 1));
        seat.style.setProperty('--seat-angle', `${(index * 360) / Math.max(Number(table.capacity), 1)}deg`);
        seat.textContent = attendee ? attendee.name : 'Empty';
        seat.title = attendee ? `Drag ${attendee.name} to another table` : 'Empty chair';
        if (attendee) {
          seat.draggable = true;
          seat.dataset.attendeeId = String(attendee.id);
          seat.addEventListener('dragstart', (dragEvent) => {
            dragEvent.dataTransfer?.setData('text/gatherly-attendee', `${attendee.id}:${table.id}`);
            dragEvent.dataTransfer?.setData('text/plain', attendee.name);
            seat.classList.add('is-dragging');
          });
          seat.addEventListener('dragend', () => seat.classList.remove('is-dragging'));
        }
        tableMap.append(seat);
      }
      mapLayer.append(tableMap);
    });
    canvas.append(mapLayer);
    applyMapZoom();
    const sidebar = document.createElement('aside');
    sidebar.className = 'seating-guest-sidebar';
    sidebar.innerHTML = `<strong>Guest placement</strong><span>${unassigned.length} unseated · ${plan.assignments?.length || 0} seated</span>`;
    unassigned.forEach((attendee) => {
      const guest = document.createElement('button');
      guest.type = 'button';
      guest.className = 'seating-unassigned-guest';
      guest.textContent = attendee.name;
      guest.draggable = true;
      guest.addEventListener('dragstart', (dragEvent) => {
        dragEvent.dataTransfer?.setData('text/gatherly-attendee', `${attendee.id}:`);
      });
      sidebar.append(guest);
    });
    canvas.append(sidebar);
    list.append(canvas);
    const grid = document.createElement('div');
    grid.className = 'seating-table-grid';
    for (const table of plan.tables) {
      const box = document.createElement('article');
      box.className = 'seating-table-card';
      const tableTitle = document.createElement('h4');
      tableTitle.textContent = `${table.name} · ${[...assigned.values()].filter((id) => id === Number(table.id)).length}/${table.capacity}`;
      box.append(tableTitle);
      attendees.filter((attendee) => assigned.get(Number(attendee.id)) === Number(table.id))
        .forEach((attendee) => {
          const row = document.createElement('label');
          row.className = 'seating-attendee';
          row.textContent = attendee.name;
          const select = document.createElement('select');
          select.setAttribute('aria-label', `Move ${attendee.name}`);
          plan.tables.forEach((optionTable) => {
            const option = new Option(optionTable.name, optionTable.id, false, Number(optionTable.id) === Number(table.id));
            select.add(option);
          });
          select.addEventListener('change', async () => {
            await persistAssignment(attendee.id, table.id, select.value);
          });
          row.append(select);
          box.append(row);
        });
      grid.append(box);
    }
    const details = document.createElement('details');
    details.className = 'seating-details';
    const detailsSummary = document.createElement('summary');
    detailsSummary.textContent = 'Detailed assignments';
    details.append(detailsSummary, grid);
    list.append(details);
    const actions = document.createElement('div');
    actions.className = 'row seating-plan-actions';
    const rerun = document.createElement('button');
    rerun.type = 'button';
    rerun.textContent = 'Regenerate draft';
    const resetDraft = document.createElement('button');
    resetDraft.type = 'button';
    resetDraft.className = 'secondary';
    resetDraft.textContent = 'Reset draft';
    const rerunDraft = async (button, messageText, reset = false) => {
      button.disabled = true;
      try {
        const result = await api(`/api/events/${event.id}/seating/plans/${plan.id}/run`, {
          method: 'POST', body: JSON.stringify({ reset })
        });
        if (reset) {
          await load();
        } else {
          renderPlan(result.plan, attendees);
        }
        showMessage(messageText);
      } catch (error) { showMessage(error.message, true); }
      finally { button.disabled = false; }
    };
    rerun.addEventListener('click', () => rerunDraft(rerun, 'Draft regenerated.'));
    resetDraft.addEventListener('click', () => rerunDraft(
      resetDraft, 'Draft reset: guest placements cleared and table positions restored.', true
    ));
    const publish = document.createElement('button');
    publish.type = 'button';
    publish.className = 'secondary';
    publish.textContent = 'Publish plan';
    publish.disabled = plan.status === 'published';
    publish.addEventListener('click', async () => {
      try {
        const result = await api(`/api/events/${event.id}/seating/plans/${plan.id}/publish`, { method: 'POST', body: '{}' });
        renderPlan(result.plan, attendees);
        showMessage('Seating plan published.');
      } catch (error) { showMessage(error.message, true); }
    });
    actions.append(rerun, resetDraft, publish);
    list.append(actions);
    if (plan.payload?.unassigned?.length) {
      const unassigned = document.createElement('p');
      unassigned.className = 'notice';
      unassigned.textContent = `Unassigned: ${plan.payload.unassigned.map((item) => item.name).join(', ')}`;
      list.append(unassigned);
    }
  };
  const load = async () => {
    try {
      const result = await api(`/api/events/${event.id}/seating`);
      list.replaceChildren();
      if (!result.attendees.length) {
        showMessage('Add confirmed named attendees before creating a seating draft.', true);
        return;
      }
      showMessage(`${result.attendees.length} confirmed named attendees ready.`);
      const plan = result.plans[0];
      if (plan) {
        const detail = await api(`/api/events/${event.id}/seating/plans/${plan.id}`);
        renderPlan(detail.plan, result.attendees);
      }
    } catch (error) { showMessage(error.message, true); }
  };
  form.addEventListener('submit', async (submitEvent) => {
    submitEvent.preventDefault();
    const tables = Number(form.elements.tables.value);
    const capacity = Number(form.elements.capacity.value);
    try {
      const created = await api(`/api/events/${event.id}/seating/plans`, {
        method: 'POST',
        body: JSON.stringify({
          name: form.elements.name.value,
          tables: Array.from({ length: tables }, (_, index) => {
            const candidate = selectedFloorPlan?.candidates?.[index];
            return {
              name: `Table ${index + 1}`,
              shape: candidate?.shape || 'round',
              capacity: candidate?.capacity || capacity,
              positionX: candidate?.positionX || 18 + (index % 4) * 21,
              positionY: candidate?.positionY || 24 + (Math.floor(index / 4) % 3) * 28
            };
          }),
          constraints: []
        })
      });
      const run = await api(`/api/events/${event.id}/seating/plans/${created.plan.id}/run`, { method: 'POST', body: '{}' });
      const data = await api(`/api/events/${event.id}/seating`);
      renderPlan(run.plan, data.attendees);
      showMessage('Draft generated. Review it before publishing.');
    } catch (error) { showMessage(error.message, true); }
  });
  const refresh = $('.seating-refresh', panel);
  if (refresh) refresh.addEventListener('click', load);
  $('.seating-seed', panel).addEventListener('click', async () => {
    try {
      const count = Number($('.seating-seed-count', panel).value);
      const result = await api(`/api/events/${event.id}/seating/seed`, {
        method: 'POST', body: JSON.stringify({ count })
      });
      showMessage(`Added ${result.created} synthetic confirmed attendees.`);
      await load();
    } catch (error) { showMessage(error.message, true); }
  });
  load();
}

function setupThemeEditor(event, card) {
  const toggle = $('.theme-toggle', card);
  const panel = $('.theme-panel', card);
  const preset = $('.theme-preset', card);
  const primary = $('.theme-primary', card);
  const background = $('.theme-background', card);
  const text = $('.theme-text', card);
  const font = $('.theme-font', card);
  const fontSize = $('.theme-font-size', card);
  const preview = $('.invitation-preview', card);
  const contrastWarning = $('.contrast-warning', card);
  const status = $('.theme-status', card);
  const save = $('.save-theme', card);
  const revealMode = $('.invitation-reveal-mode', card);
  const revealMotion = $('.invitation-reveal-motion', card);
  const celebration = $('.invitation-celebration', card);
  const chimeEnabled = $('.invitation-chime-enabled', card);
  const saveInvitation = $('.save-invitation-settings', card);
  const invitationStatus = $('.invitation-settings-status', card);
  const copyTitle = $('.invitation-copy-title', card);
  const copyIntro = $('.invitation-copy-intro', card);
  const copyRsvpHeading = $('.invitation-copy-rsvp-heading', card);
  const copyRsvpHelper = $('.invitation-copy-rsvp-helper', card);
  const copyFooter = $('.invitation-copy-footer', card);
  const imageUpload = $('.invitation-image-upload', card);
  const imageShape = $('.invitation-image-shape', card);
  const imageAlt = $('.invitation-image-alt', card);
  const removeInvitationImage = $('.remove-invitation-image', card);
  const saveInvitationCopy = $('.save-invitation-copy', card);
  const invitationCopyStatus = $('.invitation-copy-status', card);
  const invitationSettingsTitle = $('.invitation-settings-title', card);
  const invitationCopyTitle = $('.invitation-copy-title-heading', card);
  const previewReveal = $('.preview-reveal-toggle', card);
  const initialTheme = normalizeTheme(event.theme || DEFAULT_THEME);
  let draftInvitationSettings = normalizeInvitationSettings(event.invitationSettings);
  let draftInvitationCopy = normalizeInvitationCopy(event.invitationCopy);
  let draftTheme = { ...initialTheme };
  let previewRevealed = false;
  let isSaving = false;
  let isSavingInvitation = false;

panel.id = `theme-panel-${String(event.id).replace(/[^a-z\d_-]/gi, '')}`;
    invitationSettingsTitle.id = `invitation-settings-title-${String(event.id).replace(/[^a-z\d_-]/gi, '')}`;
    $('.invitation-settings', card).setAttribute('aria-labelledby', invitationSettingsTitle.id);
  invitationCopyTitle.id = `invitation-copy-title-${String(event.id).replace(/[^a-z\d_-]/gi, '')}`;
  $('.invitation-copy-editor', card).setAttribute('aria-labelledby', invitationCopyTitle.id);
    toggle.setAttribute('aria-controls', panel.id);
    // Restore open state across card rebuilds (e.g. after publishing), matching the guest-toggle pattern.
    const themeExpanded = openThemePanels.has(String(event.id));
    panel.hidden = !themeExpanded;
    toggle.setAttribute('aria-expanded', String(themeExpanded));
    if (themeExpanded && typeof panel.scrollIntoView === 'function') {
      panel.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
    const invitation = mountInvitationPreview(preview, event);
  const syncInvitationFields = () => {
    revealMode.value = draftInvitationSettings.revealMode;
    revealMotion.value = draftInvitationSettings.revealMotion;
    celebration.value = draftInvitationSettings.celebration;
    chimeEnabled.checked = draftInvitationSettings.chimeEnabled;
    syncInvitationPresentation(invitation, draftInvitationSettings, true);
    previewRevealed = false;
    previewReveal.hidden = draftInvitationSettings.revealMode !== 'envelope';
    previewReveal.textContent = 'Preview opened invitation';
    previewReveal.setAttribute('aria-pressed', 'false');
  };
  const setInvitationStatus = (message, isError = false) => {
    invitationStatus.textContent = message;
    invitationStatus.className = `invitation-settings-status message${message ? (isError ? ' error' : ' success') : ''}`;
  };
  const setInvitationCopyStatus = (message, isError = false) => {
    invitationCopyStatus.textContent = message;
    invitationCopyStatus.className = `invitation-copy-status message${message ? (isError ? ' error' : ' success') : ''}`;
  };
  const syncInvitationCopyFields = () => {
    const values = invitationCopyText(draftInvitationCopy, event);
    copyTitle.value = draftInvitationCopy.title;
    copyTitle.placeholder = values.title;
    copyIntro.value = draftInvitationCopy.intro;
    copyIntro.placeholder = values.intro;
    copyRsvpHeading.value = draftInvitationCopy.rsvpHeading;
    copyRsvpHeading.placeholder = values.rsvpHeading;
    copyRsvpHelper.value = draftInvitationCopy.rsvpHelper;
    copyRsvpHelper.placeholder = values.rsvpHelper;
    copyFooter.value = draftInvitationCopy.footerNote;
    copyFooter.placeholder = values.footerNote;
    imageShape.value = draftInvitationCopy.imageShape;
    imageAlt.value = draftInvitationCopy.imageAlt;
    setInvitationImage($('.invitation-image', invitation) || $('#guest-invitation-image', invitation), draftInvitationCopy);
    const setText = (selector, fallbackSelector, value) => {
      const element = $(selector, invitation) || $(fallbackSelector, invitation);
      if (element) element.textContent = value;
    };
    setText('.invitation-overline', '#guest-greeting', values.greeting);
    setText('.preview-title', '#guest-title', values.title);
    setText('.invitation-intro', '#guest-details', values.intro);
    setText('.invitation-rsvp__heading h2', '#guest-rsvp-title', values.rsvpHeading);
    setText('.invitation-rsvp__heading > p:last-child', '#guest-rsvp-helper', values.rsvpHelper);
    setText('.invitation-footnote', '#guest-footnote', values.footerNote);
  };
  const syncFields = () => {
    preset.value = draftTheme.preset;
    primary.value = draftTheme.primaryColor;
    background.value = draftTheme.backgroundColor;
    text.value = draftTheme.textColor;
    font.value = draftTheme.fontFamily;
    if (fontSize) fontSize.value = draftTheme.fontSize;
    setThemePreview(invitation, draftTheme);
  };
  const setStatus = (message, isError = false) => {
    status.textContent = message;
    status.className = `theme-status message${message ? (isError ? ' error' : ' success') : ''}`;
  };
  const validateContrast = () => {
    const ratio = contrastRatio(draftTheme.textColor, draftTheme.backgroundColor);
    const isReadable = ratio >= MIN_TEXT_CONTRAST;
    contrastWarning.hidden = isReadable;
    contrastWarning.textContent = isReadable
      ? '' : `Text/background contrast is ${ratio.toFixed(2)}:1. WCAG AA requires at least 4.5:1.`;
    save.disabled = isSaving || !isReadable;
    return isReadable;
  };
  const markCustom = () => {
    draftTheme.preset = 'custom';
    preset.value = 'custom';
    setThemePreview(invitation, draftTheme);
    validateContrast();
    setStatus('');
  };
  syncFields();
  syncInvitationFields();
  syncInvitationCopyFields();
  validateContrast();
  previewReveal.addEventListener('click', () => {
    if (event.status === 'cancelled') return;
    previewRevealed = !previewRevealed;
    $('.reveal-envelope', invitation).hidden = previewRevealed;
    $('.guest-content', invitation).hidden = !previewRevealed;
    previewReveal.textContent = previewRevealed
      ? 'Show envelope preview' : 'Preview opened invitation';
    previewReveal.setAttribute('aria-pressed', String(previewRevealed));
  });
  toggle.addEventListener('click', () => {
      if (event.status === 'cancelled') return;
      if (currentEventId === event.id && currentSection !== 'invitation') {
        setEventSection(event, card, 'invitation');
      }
      panel.hidden = !panel.hidden;
      const expanded = !panel.hidden;
      toggle.setAttribute('aria-expanded', String(expanded));
      if (expanded) openThemePanels.add(String(event.id));
      else openThemePanels.delete(String(event.id));
      if (expanded && typeof panel.scrollIntoView === 'function') {
        panel.scrollIntoView({ behavior: 'smooth', block: 'start' });
      }
    });
  revealMode.addEventListener('change', () => {
    draftInvitationSettings.revealMode = revealMode.value === 'envelope' ? 'envelope' : 'direct';
    syncInvitationFields();
    setInvitationStatus('');
  });
  revealMotion.addEventListener('change', () => {
    draftInvitationSettings.revealMotion = revealMotion.value;
    syncInvitationPresentation(invitation, draftInvitationSettings, true);
    setInvitationStatus('');
  });
  celebration.addEventListener('change', () => {
    draftInvitationSettings.celebration = celebration.value;
    syncInvitationPresentation(invitation, draftInvitationSettings, true);
    setInvitationStatus('');
  });
  chimeEnabled.addEventListener('change', () => {
    draftInvitationSettings.chimeEnabled = Boolean(chimeEnabled.checked);
    syncInvitationPresentation(invitation, draftInvitationSettings, true);
    setInvitationStatus('');
  });
  const copyFields = [
    [copyTitle, 'title'], [copyIntro, 'intro'],
    [copyRsvpHeading, 'rsvpHeading'], [copyRsvpHelper, 'rsvpHelper'], [copyFooter, 'footerNote']
  ];
  for (const [control, key] of copyFields) {
    control.addEventListener('input', () => {
      draftInvitationCopy[key] = control.value;
      syncInvitationCopyFields();
      setInvitationCopyStatus('');
    });
    control.addEventListener('change', () => {
      draftInvitationCopy[key] = control.value;
      syncInvitationCopyFields();
      setInvitationCopyStatus('');
    });
  }
  imageShape.addEventListener('change', () => {
    draftInvitationCopy.imageShape = imageShape.value;
    syncInvitationCopyFields();
    setInvitationCopyStatus('');
  });
  imageAlt.addEventListener('input', () => {
    draftInvitationCopy.imageAlt = imageAlt.value;
    syncInvitationCopyFields();
    setInvitationCopyStatus('');
  });
  imageUpload.addEventListener('change', async () => {
    const file = imageUpload.files && imageUpload.files[0];
    if (!file) return;
    if (!IMAGE_TYPES.has(file.type)) {
      imageUpload.value = '';
      setInvitationCopyStatus('Choose a PNG, JPEG, or WebP image.', true);
      return;
    }
    if (file.size > MAX_COVER_BYTES) {
      imageUpload.value = '';
      setInvitationCopyStatus('Image must be 1 MiB or smaller.', true);
      return;
    }
    try {
      const dataUrl = await new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.addEventListener('load', () => resolve(reader.result));
        reader.addEventListener('error', () => reject(new Error('Could not read the selected image.')));
        reader.readAsDataURL(file);
      });
      if (!isSafeImageDataUrl(dataUrl)) throw new Error('The selected file did not produce a supported image.');
      draftInvitationCopy.image = dataUrl;
      syncInvitationCopyFields();
      setInvitationCopyStatus('');
    } catch (error) { setInvitationCopyStatus(error.message, true); }
  });
  removeInvitationImage.addEventListener('click', () => {
    if (event.status === 'cancelled') return;
    draftInvitationCopy.image = null;
    imageUpload.value = '';
    syncInvitationCopyFields();
    setInvitationCopyStatus('Invitation image removed from this draft.');
  });
  saveInvitationCopy.addEventListener('click', async () => {
    if (event.status === 'cancelled') return;
    saveInvitationCopy.disabled = true;
    saveInvitationCopy.textContent = 'Saving…';
    setInvitationCopyStatus('');
    try {
      const copy = normalizeInvitationCopy(draftInvitationCopy);
      const payload = {
        title: copy.title,
        intro: copy.intro,
        rsvpHeading: copy.rsvpHeading,
        rsvpHelper: copy.rsvpHelper,
        footerNote: copy.footerNote,
        image: copy.image,
        imageShape: copy.imageShape,
        imageAlt: copy.imageAlt
      };
      const result = await api(`/api/events/${event.id}/invitation-copy`, {
        method: 'PUT', body: JSON.stringify(payload)
      });
      event.invitationCopy = result.invitationCopy;
      draftInvitationCopy = normalizeInvitationCopy(result.invitationCopy);
      syncInvitationCopyFields();
      setInvitationCopyStatus('Invitation copy saved.');
    } catch (error) {
      setInvitationCopyStatus(error.message, true);
    } finally {
      saveInvitationCopy.disabled = false;
      saveInvitationCopy.textContent = 'Save invitation copy';
    }
  });
  saveInvitation.addEventListener('click', async () => {
    if (event.status === 'cancelled') return;
    isSavingInvitation = true;
    saveInvitation.disabled = true;
    saveInvitation.textContent = 'Saving…';
    setInvitationStatus('');
    try {
      const settings = normalizeInvitationSettings(draftInvitationSettings);
      await api(`/api/events/${event.id}/invitation`, {
        method: 'PUT',
        body: JSON.stringify(settings)
      });
      event.invitationSettings = settings;
      draftInvitationSettings = { ...settings };
      syncInvitationPresentation(invitation, draftInvitationSettings, true);
      setInvitationStatus('Invitation experience saved.');
    } catch (error) {
      setInvitationStatus(error.message, true);
    } finally {
      isSavingInvitation = false;
      saveInvitation.disabled = false;
      saveInvitation.textContent = 'Save invitation experience';
    }
  });
  preset.addEventListener('change', () => {
    if (THEME_PRESETS[preset.value]) {
      draftTheme = { ...draftTheme, preset: preset.value, ...THEME_PRESETS[preset.value] };
      syncFields();
    } else {
      draftTheme.preset = 'custom';
      preset.value = 'custom';
    }
    validateContrast();
    setStatus('');
  });
  for (const [control, key] of [[primary, 'primaryColor'], [background, 'backgroundColor'], [text, 'textColor']]) {
    control.addEventListener('input', () => {
      if (COLOR_PATTERN.test(control.value)) {
        draftTheme[key] = control.value;
        markCustom();
      }
    });
    control.addEventListener('change', () => {
      if (COLOR_PATTERN.test(control.value)) {
        draftTheme[key] = control.value;
        markCustom();
      }
    });
  }
  font.addEventListener('change', () => {
    if (font.value === 'serif' || font.value === 'sans') {
      draftTheme.fontFamily = font.value;
      markCustom();
    }
  });
  fontSize?.addEventListener('change', () => {
    if (['small', 'medium', 'large'].includes(fontSize.value)) {
      draftTheme.fontSize = fontSize.value;
      markCustom();
    }
  });
  save.addEventListener('click', async () => {
    if (event.status === 'cancelled') return;
    if (!validateContrast()) return;
    isSaving = true;
    save.disabled = true;
    save.textContent = 'Saving…';
    setStatus('');
    try {
      const theme = normalizeTheme(draftTheme);
      if (!fontSize) delete theme.fontSize;
      await api(`/api/events/${event.id}/theme`, {
        method: 'PUT',
        body: JSON.stringify(theme)
      });
      event.theme = theme;
      draftTheme = { ...theme };
      setThemePreview(invitation, draftTheme);
      setStatus('Theme saved.');
    } catch (error) {
      setStatus(error.message, true);
    } finally {
      isSaving = false;
      validateContrast();
      save.textContent = 'Save theme';
    }
  });
}

function updatePublicationStatus(event, card) {
  const published = Boolean(event.published);
  const status = $('.publication-status', card);
  status.textContent = published ? 'Published' : 'Draft';
  status.className = `publication-status ${published ? 'is-published' : 'is-draft'}`;
  const button = $('.publish', card);
  button.hidden = published;
  button.disabled = published;
  button.textContent = 'Publish event';
  $('.publish-next-steps', card).hidden = !published;
}

function syncEventCardAvailability(event, card) {
  if (event.status !== 'cancelled') return;
  for (const selector of [
    '.publish', '.add', '.bulk-add', '.guest-toggle', '.guest-panel-toggle',
    '.export', '.print', '.refresh', '.theme-toggle', '.next-steps-add',
    '.guest-empty-state button',
    '.check-in-panel button', '.check-in-panel input',
    '.save-theme', '.save-invitation-settings', '.save-invitation-copy',
    '.remove-invitation-image', '.invitation-image-upload', '.invitation-image-shape', '.invitation-image-alt', '.preview-reveal-toggle',
    '.local-message-form button', '.toggle'
  ]) {
    const control = card.querySelector(selector);
    if (control) {
      control.disabled = true;
      control.setAttribute('aria-disabled', 'true');
    }
  }
}

function renderCheckInPanel(event, card, guests) {
  const panel = $('.check-in-panel', card);
  if (!panel) return;
  const search = $('.check-in-search', panel);
  const results = $('.check-in-results', panel);
  const message = $('.check-in-message', panel);
  const query = String(search?.value || '').trim().toLowerCase();
  const matches = guests.filter((guest) => {
    const values = [guest.name, guest.email, ...(guest.attendees || []).map((attendee) => attendee.name)];
    return !query || values.some((value) => String(value || '').toLowerCase().includes(query));
  });
  results.replaceChildren();
  if (!matches.length) {
    results.textContent = query ? 'No matching guest or attendee.' : 'No guest units yet.';
  }
  const update = async (target, reverse = false) => {
    try {
      await api(`/api/events/${event.id}/check-in${reverse ? '/reverse' : ''}`, {
        method: 'POST', body: JSON.stringify(target)
      });
      await renderDashboard(event, card);
    } catch (error) { showMessage(message, error.message, true); }
  };
  for (const guest of matches) {
    const item = document.createElement('article');
    item.className = 'check-in-result';
    const identity = document.createElement('div');
    const title = document.createElement('strong');
    title.textContent = guest.name;
    const detail = document.createElement('small');
    detail.textContent = guest.email || (guest.walkIn ? 'Synthetic walk-in' : 'No email');
    identity.append(title, detail);
    const actions = document.createElement('div');
    actions.className = 'check-in-result__actions';
    const unitButton = document.createElement('button');
    unitButton.type = 'button';
    unitButton.className = guest.checkedInAt ? 'secondary' : '';
    unitButton.textContent = guest.checkedInAt ? 'Reverse unit' : 'Check in unit';
    unitButton.addEventListener('click', () => update({ guestId: guest.id }, Boolean(guest.checkedInAt)));
    actions.append(unitButton);
    item.append(identity, actions);
    for (const attendee of guest.attendees || []) {
      if (!attendee.name) continue;
      const attendeeRow = document.createElement('div');
      attendeeRow.className = 'check-in-attendee';
      const attendeeLabel = document.createElement('span');
      attendeeLabel.textContent = attendee.name;
      const attendeeButton = document.createElement('button');
      attendeeButton.type = 'button';
      attendeeButton.className = attendee.checkedInAt ? 'secondary' : '';
      attendeeButton.textContent = attendee.checkedInAt ? 'Reverse' : 'Check in';
      attendeeButton.disabled = Boolean(guest.checkedInAt);
      attendeeButton.addEventListener('click', () => update({ attendeeId: attendee.id }, Boolean(attendee.checkedInAt)));
      attendeeRow.append(attendeeLabel, attendeeButton);
      item.append(attendeeRow);
    }
    results.append(item);
  }
  if (search && !search.checkInBound) {
    search.checkInBound = true;
    search.addEventListener('input', () => renderCheckInPanel(event, card, guests));
  }
  const walkInForm = $('.walk-in-form', panel);
  if (walkInForm && !walkInForm.checkInBound) {
    walkInForm.checkInBound = true;
    walkInForm.addEventListener('submit', async (submitEvent) => {
      submitEvent.preventDefault();
      const payload = formValues(walkInForm);
      try {
        await api(`/api/events/${event.id}/check-in/walk-in`, {
          method: 'POST', body: JSON.stringify(payload)
        });
        walkInForm.reset();
        await renderDashboard(event, card);
      } catch (error) {
        if (/no walk-in place remains/i.test(error.message) && typeof window.confirm === 'function' &&
            window.confirm('Capacity is full. Record this walk-in with a host override?')) {
          const reason = typeof window.prompt === 'function'
            ? window.prompt('Reason for the capacity override:') : '';
          if (!reason || reason.trim().length < 3) {
            showMessage(message, 'A capacity override needs a reason.', true);
            return;
          }
          try {
            await api(`/api/events/${event.id}/check-in/walk-in`, {
              method: 'POST', body: JSON.stringify({ ...payload, override: true, reason: reason.trim() })
            });
            walkInForm.reset();
            await renderDashboard(event, card);
          } catch (overrideError) { showMessage(message, overrideError.message, true); }
          return;
        }
        showMessage(message, error.message, true);
      }
    });
  }
}

async function renderDashboard(event, card) {
  const dashboard = await api(`/api/events/${event.id}/dashboard`);
  const guests = dashboard.guests || [];
  const totals = dashboard.totals || {
    invitedPeople: guests.filter((guest) => !guest.walkIn).reduce((sum, guest) => sum + Number(guest.partyLimit || 0), 0),
    confirmedPeople: guests.filter((guest) => guest.answer === 'yes').reduce((sum, guest) => sum + Number(guest.partySize || 0), 0),
    checkedInPeople: guests.reduce((sum, guest) => sum + (guest.checkedInAt ? Number(guest.partySize || 0) : (guest.attendees || []).filter((attendee) => attendee.checkedInAt).length), 0),
    walkIns: guests.filter((guest) => guest.walkIn).length
  };
  const counts = {
    invited: guests.length,
    revoked: guests.filter((guest) => guest.revokedAt !== null).length,
    yes: guests.filter((guest) => guest.answer === 'yes').length,
    no: guests.filter((guest) => guest.answer === 'no').length,
    maybe: guests.filter((guest) => guest.answer === 'maybe').length,
    pending: guests.filter((guest) => !guest.revokedAt && !guest.answer).length,
    people: guests.filter((guest) => guest.answer === 'yes').reduce((sum, guest) => sum + guest.partySize, 0)
  };
  const hasCapacity = event.capacity !== null && event.capacity !== undefined;
  $('.stats', card).innerHTML = `<div class="stats__grid"><div class="stat stat--invited"><span>INVITED UNITS</span><b>${counts.invited}</b><small>${totals.invitedPeople} invited people</small></div><div class="stat stat--attending"><span>ATTENDING PEOPLE</span><b>${totals.confirmedPeople}</b><small>${counts.yes} accepting unit${counts.yes === 1 ? '' : 's'}</small></div><div class="stat stat--pending"><span>AWAITING REPLY</span><b>${counts.pending}</b><small>no response yet</small></div><div class="stat stat--maybe"><span>MAYBE</span><b>${counts.maybe}</b><small>tentative unit${counts.maybe === 1 ? '' : 's'}</small></div><div class="stat stat--declined"><span>DECLINED</span><b>${counts.no}</b><small>not attending</small></div><div class="stat stat--revoked"><span>REVOKED</span><b>${counts.revoked}</b><small>links disabled</small></div></div>${hasCapacity ? `<div class="capacity-summary" aria-label="Event capacity"><span>CAPACITY</span><b>${counts.people}/${event.capacity}</b><small>${Math.max(0, event.capacity - counts.people)} remaining</small></div>` : ''}`;
  if (currentEventId === null || String(currentEventId) !== String(event.id)) return;
  renderCheckInPanel(event, card, guests);
  const target = $('.guest-table', card);
  const printView = $('.print-view', card);
  if (printView) {
    printView.replaceChildren();
    const heading = document.createElement('h1'); heading.textContent = event.title; printView.append(heading);
    const schedule = document.createElement('p'); schedule.textContent = `${formatEventSchedule(event)} · ${event.location || 'No location'}`; printView.append(schedule);
    const table = document.createElement('table');
    table.innerHTML = '<thead><tr><th>Guest unit</th><th>Party</th><th>RSVP</th><th>Check-in</th><th>Walk-in</th><th>Attendees / needs</th></tr></thead><tbody></tbody>';
    const body = $('tbody', table);
    for (const guest of guests) {
      const row = document.createElement('tr');
      const attendees = (guest.attendees || []).map((item) => [item.name, item.dietary, item.accessibility, item.ageBand].filter(Boolean).join(' / ')).join('; ');
      for (const value of [guest.name, guest.partySize ?? '—', guest.revokedAt ? 'Revoked' : guest.answer || 'No reply',
        guest.checkedInAt || 'Not checked in', guest.walkIn ? 'Yes' : 'No', attendees || '—']) {
        const cell = document.createElement('td'); cell.textContent = value; row.append(cell);
      }
      body.append(row);
    }
    printView.append(table);
  }
  if (!guests.length) {
    const emptyState = document.createElement('div');
    emptyState.className = 'notice guest-empty-state';
    const message = document.createElement('p');
    message.textContent = 'No guest units yet. Add one to create a private RSVP link. The invitation is captured in this local outbox; no email is sent.';
    const addButton = document.createElement('button');
    addButton.type = 'button';
    addButton.textContent = 'Add first guest unit';
    addButton.addEventListener('click', () => showGuestForm(event, card));
    emptyState.append(message, addButton);
    target.replaceChildren(emptyState);
    return;
  }
  const table = document.createElement('table');
  table.innerHTML = '<thead><tr><th scope="col">GUEST UNIT</th><th scope="col">EMAIL</th><th scope="col">RESPONSE</th><th scope="col">PARTY SIZE</th><th scope="col">ATTENDEES</th><th scope="col">ACTION</th></tr></thead><tbody></tbody>';
  const tbody = $('tbody', table);
  for (const guest of guests) {
    const attendeeCount = Array.isArray(guest.attendees) ? guest.attendees.filter((a) => a.name.trim()).length : 0;
    const row = document.createElement('tr');
    for (const [label, value] of [
      ['Guest unit', guest.name],
      ['Email', guest.email],
      ['Response', guest.revokedAt ? 'Revoked' : guest.answer || 'No reply'],
      ['Party size', guest.partySize ?? '—'],
      ['Attendees', attendeeCount > 0 ? `${attendeeCount} named` : '—']
    ]) {
      const cell = document.createElement('td');
      if (label === 'Attendees') cell.className = 'guest-table__attendees';
      cell.setAttribute('data-label', label);
      const valueElement = document.createElement('span');
      valueElement.className = 'guest-table__value';
      valueElement.textContent = value;
      cell.append(valueElement);
      row.append(cell);
    }
    const action = document.createElement('td');
    action.className = 'guest-table__action';
    action.setAttribute('data-label', 'Action');
    if (!guest.revokedAt) {
      const actionGroup = document.createElement('div');
      actionGroup.className = 'guest-table__action-group';
      const linkButton = document.createElement('button');
      linkButton.type = 'button';
      linkButton.className = 'secondary guest-link-retention';
      linkButton.textContent = 'Link';
      linkButton.setAttribute('aria-label', `Copy invitation link for ${guest.name}`);
      linkButton.addEventListener('click', async () => {
        linkButton.disabled = true;
        let inviteUrl;
        try {
          ({ inviteUrl } = await api(`/api/guests/${guest.id}/invite-link`));
        } catch (error) {
          if (error.code === 'LEGACY_INVITE_UNRECOVERABLE') {
            showToast(`${guest.name}'s invitation link could not be safely recovered from the local outbox.`);
          } else if (error.code === 'INVITE_LINK_MISSING') {
            showToast(`${guest.name}'s invitation link is unavailable in the local outbox.`);
          } else if (error.code === 'INVITE_REVOKED' || error.status === 410) {
            showToast(`${guest.name}'s invitation link has been revoked.`);
          } else {
            showToast(`Could not retrieve ${guest.name}'s invitation link. Try again.`);
          }
          linkButton.disabled = false;
          return;
        }
        try {
          await copyText(`${location.origin}${inviteUrl}`);
          showToast(`${guest.name}'s invitation link copied.`);
        } catch {
          showToast(`Could not copy ${guest.name}'s link. Check clipboard permissions and try again.`);
        } finally {
          linkButton.disabled = false;
        }
      });
      actionGroup.append(linkButton);
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'danger'; button.textContent = 'Revoke';
      button.addEventListener('click', async () => {
        try {
          await api(`/api/guests/${guest.id}/revoke`, { method: 'POST', body: '{}' });
          await renderDashboard(event, card);
        } catch (error) { showMessage($('#global-message'), error.message, true); }
      });
      actionGroup.append(button);
      action.append(actionGroup);
    } else {
      const revokedState = document.createElement('span');
      revokedState.className = 'guest-table__revoked-state';
      revokedState.textContent = 'Revoked';
      action.append(revokedState);
    }
    row.append(action); tbody.append(row);
  }
  target.replaceChildren(table);
}

function createInviteLinkCollection(guests) {
  const collection = document.createElement('div');
  collection.className = 'invite-link-collection';
  const message = document.createElement('p');
  message.className = 'invite-link-collection__message';
  message.textContent = guests.length === 1
    ? 'Invitation created. The link is retained in the guest list.'
    : `${guests.length} invitations created. Links are retained in the guest list.`;
  const details = document.createElement('details');
  details.className = 'invite-link-collection__details';
  const summary = document.createElement('summary');
  summary.textContent = guests.length === 1 ? 'View RSVP link' : `View ${guests.length} RSVP links`;
  const list = document.createElement('ul');
  list.className = 'invite-link-collection__list';
  for (const guest of guests) {
    const item = document.createElement('li');
    const identity = document.createElement('span');
    identity.className = 'invite-link-collection__identity';
    const name = document.createElement('strong');
    name.textContent = guest.name;
    const email = document.createElement('span');
    email.className = 'invite-link-collection__email';
    email.textContent = guest.email;
    identity.append(name, email);
    const link = document.createElement('a');
    link.href = `${location.origin}${guest.inviteUrl}`;
    link.textContent = 'Open link';
    link.className = 'invite-link-collection__url';
    const copy = document.createElement('button');
    copy.type = 'button';
    copy.className = 'secondary';
    copy.textContent = 'Copy';
    copy.setAttribute('aria-label', `Copy RSVP link for ${guest.name}`);
    const status = document.createElement('span');
    status.className = 'invite-link-collection__status';
    status.setAttribute('role', 'status');
    copy.addEventListener('click', async () => {
      try {
        await copyText(link.href);
        status.textContent = 'Copied.';
      } catch {
        status.textContent = 'Select the link and copy it manually.';
      }
    });
    item.append(identity, link, copy, status);
    list.append(item);
  }
  details.append(summary, list);
  collection.append(message, details);
  return collection;
}

function closeGuestComposer(card) {
  const slot = $('.guest-form-slot', card);
  const { single, bulk } = card.guestActionButtons;
  const focusTarget = slot.composerMode === 'bulk' ? bulk : single;
  slot.hidden = true;
  slot.composerMode = null;
  single.setAttribute('aria-expanded', 'false');
  bulk.setAttribute('aria-expanded', 'false');
  if (focusTarget) focusTarget.focus();
}

function toggleGuestComposer(event, card, mode) {
  const slot = $('.guest-form-slot', card);
  if (!slot.hidden && slot.composerMode === mode) {
    closeGuestComposer(card);
  } else if (mode === 'bulk') {
    showBulkGuestForm(event, card);
  } else {
    showGuestForm(event, card);
  }
}

// Ensure the guest panel is visible when a composer is opened (it starts collapsed).
function revealGuestPanel(card) {
  const panel = $('.guest-panel', card);
  const guestToggle = $('.guest-toggle', card);
  const guestPanelToggle = $('.guest-panel-toggle', card);
  if (panel) panel.hidden = false;
  if (guestToggle) { guestToggle.textContent = 'Hide guests'; guestToggle.setAttribute('aria-expanded', 'true'); }
  if (guestPanelToggle) { guestPanelToggle.textContent = 'Hide guest list'; guestPanelToggle.setAttribute('aria-expanded', 'true'); }
}

function showGuestForm(event, card) {
  const slot = $('.guest-form-slot', card);
  const { single, bulk } = card.guestActionButtons;
  revealGuestPanel(card);
  slot.hidden = false;
  slot.composerMode = 'single';
  single.setAttribute('aria-expanded', 'true');
  bulk.setAttribute('aria-expanded', 'false');
  slot.innerHTML = `<form class="guest-form notice"><div class="guest-composer__heading"><strong>Single invite</strong><button type="button" class="secondary guest-composer-close">Close</button></div><label>${event.guestMode === 'household' ? 'Household / group name' : 'Guest name'}<input name="name" maxlength="100" required></label><label>Guest email (synthetic only)<input name="email" type="email" maxlength="254" required></label>${event.guestMode === 'household' ? '<label>Maximum party size<input name="partyLimit" type="number" min="1" max="20" required></label>' : ''}<button>Create unit + capture invitation</button><div class="invite-result" role="status" aria-live="polite"></div></form>`;
  $('.guest-composer-close', slot).addEventListener('click', () => closeGuestComposer(card));
  const form = $('.guest-form', slot);
  form.querySelector('input[name="name"]').focus();
  form.addEventListener('submit', async (submitEvent) => {
    submitEvent.preventDefault();
    const form = submitEvent.currentTarget;
    const data = formValues(form);
    if (data.partyLimit) data.partyLimit = Number(data.partyLimit);
    try {
      const created = await api(`/api/events/${event.id}/guests`, {
        method: 'POST', body: JSON.stringify(data)
      });
      $('.invite-result', slot).replaceChildren(createInviteLinkCollection([{
        name: data.name, email: data.email, inviteUrl: created.inviteUrl
      }]));
      form.reset();
      await renderDashboard(event, card);
      await loadOutbox();
    } catch (error) {
      showMessage($('.invite-result', slot), error.message, true);
    }
  });
}

function parseBulkGuestRows(value, guestMode) {
  const lines = String(value || '').split(/\r?\n/).filter((line) => line.trim());
  if (!lines.length) return { rows: [], error: 'Paste at least one guest row.' };
  if (lines.length > 100) return { rows: [], error: 'Bulk invites are limited to 100 rows at a time.' };
  const expectedColumns = guestMode === 'household' ? 3 : 2;
  const rows = lines.map((line, index) => {
    const columns = line.split('\t').map((column) => column.trim());
    const name = columns[0] || '';
    const email = (columns[1] || '').toLowerCase();
    const partyLimit = guestMode === 'household' ? Number(columns[2]) : 1;
    const errors = [];
    if (columns.length !== expectedColumns) {
      errors.push(`Use ${expectedColumns} tab-separated columns.`);
    }
    if (!name || name.length > 100) errors.push('Name must be 1–100 characters.');
    const domain = email.slice(email.lastIndexOf('@') + 1);
    const reservedDomain = /^(?:[a-z0-9-]+\.)*(?:test|example|invalid|localhost)$|^(?:[a-z0-9-]+\.)?example\.(?:com|net|org)$/i.test(domain);
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254 || !reservedDomain) {
      errors.push('Use a synthetic email at a reserved test domain, such as name@example.test.');
    }
    if (guestMode === 'household' && (!Number.isInteger(partyLimit) || partyLimit < 1 || partyLimit > 20)) {
      errors.push('Party limit must be a whole number from 1 to 20.');
    }
    return { rowNumber: index + 1, name, email, partyLimit, error: errors.join(' ') };
  });
  return { rows };
}

function showBulkGuestForm(event, card) {
  const slot = $('.guest-form-slot', card);
  const { single, bulk } = card.guestActionButtons;
  revealGuestPanel(card);
  slot.hidden = false;
  slot.composerMode = 'bulk';
  single.setAttribute('aria-expanded', 'false');
  bulk.setAttribute('aria-expanded', 'true');
  const isHousehold = event.guestMode === 'household';
  const example = isHousehold
    ? 'Sample Household\thousehold@example.test\t4'
    : 'Sample Guest\tguest@example.test';
  const columns = isHousehold ? 'name, synthetic email, party limit' : 'name, synthetic email';
  slot.innerHTML = `<form class="bulk-guest-form notice"><div class="guest-composer__heading"><strong>Bulk invite</strong><button type="button" class="secondary guest-composer-close">Close</button></div><label>Paste guest list<textarea class="bulk-guest-rows" rows="7" spellcheck="false" placeholder="${example}" aria-describedby="bulk-guest-help"></textarea></label><p id="bulk-guest-help" class="help">Paste tab-separated rows copied from a spreadsheet, with no header: ${columns}. Up to 100 rows. Invitations are captured locally; no email is sent.</p><button type="button" class="secondary bulk-review">Review rows</button><ol class="bulk-preview" aria-live="polite"></ol><div class="bulk-result" role="status" aria-live="polite"></div><button type="submit" class="bulk-create" disabled>Create invitations</button></form>`;
  $('.guest-composer-close', slot).addEventListener('click', () => closeGuestComposer(card));
  const form = $('.bulk-guest-form', slot);
  const textarea = $('.bulk-guest-rows', form);
  const review = $('.bulk-review', form);
  const preview = $('.bulk-preview', form);
  const result = $('.bulk-result', form);
  const submit = $('.bulk-create', form);
  let reviewedRows = [];
  textarea.focus();
  textarea.addEventListener('input', () => {
    reviewedRows = [];
    preview.replaceChildren();
    result.textContent = 'Review the updated list before creating invitations.';
    submit.disabled = true;
  });
  review.addEventListener('click', () => {
    const parsed = parseBulkGuestRows(textarea.value, event.guestMode);
    preview.replaceChildren();
    reviewedRows = [];
    if (parsed.error) {
      result.textContent = parsed.error;
      submit.disabled = true;
      return;
    }
    let invalidCount = 0;
    for (const row of parsed.rows) {
      const item = document.createElement('li');
      item.className = row.error ? 'invalid' : 'valid';
      item.textContent = `Row ${row.rowNumber}: ${row.name || '(missing name)'} — ${row.email || '(missing email)'} — ${row.error || 'Ready'}`;
      preview.append(item);
      if (row.error) invalidCount += 1;
    }
    if (!invalidCount) reviewedRows = parsed.rows.map(({ name, email, partyLimit }) => ({ name, email, partyLimit }));
    result.textContent = invalidCount
      ? `${invalidCount} row${invalidCount === 1 ? '' : 's'} need correction before invitations can be created.`
      : `${parsed.rows.length} guest row${parsed.rows.length === 1 ? '' : 's'} ready to create.`;
    submit.disabled = invalidCount > 0;
    submit.textContent = `Create ${parsed.rows.length} invitation${parsed.rows.length === 1 ? '' : 's'}`;
  });
  form.addEventListener('submit', async (submitEvent) => {
    submitEvent.preventDefault();
    if (!reviewedRows.length) return;
    submit.disabled = true;
    try {
      const created = await api(`/api/events/${event.id}/guests/bulk`, {
        method: 'POST', body: JSON.stringify({ guests: reviewedRows })
      });
      result.replaceChildren(createInviteLinkCollection(created.guests));
      form.reset();
      reviewedRows = [];
      preview.replaceChildren();
      await renderDashboard(event, card);
      await loadOutbox();
    } catch (error) {
      result.textContent = error.message;
      submit.disabled = false;
    }
  });
}

async function loadOutbox() {
  const { messages } = await api('/api/outbox');
  const target = $('#outbox-list');
  target.replaceChildren();
  if (!messages.length) { target.textContent = 'No captured invitations.'; return; }
  for (const item of messages) {
    const block = document.createElement('div');
    block.className = 'notice';
    const subject = document.createElement('strong');
    subject.textContent = `${item.recipient} — ${item.subject}`;
    const body = document.createElement('pre');
    body.textContent = item.body;
    block.append(subject, body); target.append(block);
  }
}

async function showGuest(rsvpToken) {
  $('#site-header').hidden = true;
  $('#development-warning').hidden = true;
  const main = $('main');
  main.className = `${main.className} guest-main`.trim();
  $('#guest').hidden = false;
  try {
    const data = await api(`/api/guest/${rsvpToken}`);
    const invitationSettings = normalizeInvitationSettings(data.event.invitationSettings);
    const guestTheme = applyTheme($('#guest'), normalizeTheme(data.event.theme || DEFAULT_THEME));
    setInvitationImage($('#guest-invitation-image'), data.event.invitationCopy);
    syncInvitationPresentation($('#guest'), invitationSettings);
    let musicContext;
    let musicTimer;
    let musicStarting = false;
    let musicAttempt = 0;
    let musicInteractionRetryArmed = false;
    let musicGestureRetryInProgress = false;
    const stopInvitationMusic = () => {
      if (musicTimer !== undefined) window.clearInterval(musicTimer);
      musicTimer = undefined;
      if (musicContext && typeof musicContext.close === 'function') {
        musicContext.close().catch(() => {});
      }
      musicContext = undefined;
    };
    const removeMusicInteractionRetry = () => {
      if (!musicInteractionRetryArmed || typeof $('#guest').removeEventListener !== 'function') return;
      for (const eventName of ['pointerdown', 'keydown', 'click']) {
        $('#guest').removeEventListener(eventName, retryFromInteraction);
      }
      musicInteractionRetryArmed = false;
    };
    const armMusicInteractionRetry = () => {
      if (musicInteractionRetryArmed || typeof $('#guest').addEventListener !== 'function') return;
      for (const eventName of ['pointerdown', 'keydown', 'click']) {
        $('#guest').addEventListener(eventName, retryFromInteraction);
      }
      musicInteractionRetryArmed = true;
    };
    const retryFromInteraction = () => {
      removeMusicInteractionRetry();
      if (musicStarting) {
        musicAttempt += 1;
        stopInvitationMusic();
      }
      musicGestureRetryInProgress = true;
      void startInvitationMusic(true);
    };
    const startInvitationMusic = async (hasUserGesture = false) => {
      if (!invitationSettings.chimeEnabled) return;
      if (musicContext && musicContext.state === 'running') return;
      if (musicStarting) {
        if (!hasUserGesture) return;
        if (musicGestureRetryInProgress) return;
        musicAttempt += 1;
        stopInvitationMusic();
      }
      const audioControl = $('.guest-audio-control');
      const button = $('#guest-chime');
      const status = $('#guest-audio-status');
      const AudioContextClass = window.AudioContext || window.webkitAudioContext;
      const attempt = ++musicAttempt;
      button.disabled = true;
      status.textContent = '';
      musicStarting = true;
      try {
        if (!AudioContextClass) throw new Error('Audio is unavailable.');
        const context = new AudioContextClass();
        musicContext = context;
        const resume = context.resume();
        let resumeTimer;
        const resumed = hasUserGesture ? await resume : await Promise.race([
          resume.then(() => true),
          new Promise((resolve) => {
            resumeTimer = window.setTimeout(() => resolve(false), 800);
          })
        ]);
        if (resumeTimer !== undefined) window.clearTimeout(resumeTimer);
        if (attempt !== musicAttempt) return;
        if (resumed === false) throw new Error('Audio playback is blocked.');
        if (context.state && context.state !== 'running') throw new Error('Audio is blocked.');
        const chords = [
          [261.63, 329.63, 392], [220, 261.63, 329.63],
          [174.61, 220, 261.63], [196, 246.94, 293.66]
        ];
        let chordIndex = 0;
        const playChord = () => {
          const now = context.currentTime;
          for (const frequency of chords[chordIndex]) {
            const oscillator = context.createOscillator();
            const gain = context.createGain();
            oscillator.type = 'sine';
            oscillator.frequency.setValueAtTime(frequency, now);
            gain.gain.setValueAtTime(0.0001, now);
            gain.gain.exponentialRampToValueAtTime(0.012, now + 0.4);
            gain.gain.exponentialRampToValueAtTime(0.0001, now + 3.6);
            oscillator.connect(gain);
            gain.connect(context.destination);
            oscillator.start(now);
            oscillator.stop(now + 3.8);
          }
          chordIndex = (chordIndex + 1) % chords.length;
        };
        playChord();
        musicTimer = window.setInterval(playChord, 3800);
        status.textContent = 'Background music is playing.';
        audioControl.hidden = true;
        removeMusicInteractionRetry();
      } catch {
        if (attempt !== musicAttempt) return;
        stopInvitationMusic();
        status.textContent = 'Your browser blocked automatic playback. Tap or click inside the invitation, or use the button below to start the music.';
        button.textContent = 'Start background music';
        button.hidden = false;
        button.disabled = false;
        audioControl.hidden = false;
        armMusicInteractionRetry();
      } finally {
        if (attempt === musicAttempt) {
          musicStarting = false;
          musicGestureRetryInProgress = false;
        }
      }
    };
    $('#guest-chime').addEventListener('click', () => {
      removeMusicInteractionRetry();
      void startInvitationMusic(true);
    });
    if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
      window.addEventListener('pagehide', stopInvitationMusic, { once: true });
    }
    $('#guest-envelope').addEventListener('click', () => {
      const musicAttempt = startInvitationMusic(true);
      const envelope = $('#guest-envelope');
      const reveal = () => {
        envelope.hidden = true;
        $('#guest-content').hidden = false;
        if (typeof $('#guest-title').focus === 'function') {
          $('#guest-title').setAttribute('tabindex', '-1');
          $('#guest-title').focus();
        }
      };
      const reducedMotion = window.matchMedia
        && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
      if (reducedMotion) reveal();
      else {
        envelope.disabled = true;
        envelope.classList.add('is-opening');
        window.setTimeout(reveal, 300);
      }
      return musicAttempt;
    });
    armMusicInteractionRetry();
    void startInvitationMusic();
    const guestCopy = invitationCopyText(data.event.invitationCopy, data.event, data.guest.name);
    $('#guest-greeting').textContent = guestCopy.greeting;
    $('#guest-title').textContent = guestCopy.title;
    $('#guest-details').textContent = guestCopy.intro;
    $('#guest-rsvp-title').textContent = guestCopy.rsvpHeading;
    $('#guest-rsvp-helper').textContent = guestCopy.rsvpHelper;
    $('.invitation-footnote').textContent = guestCopy.footerNote;
    const eventStatus = data.event.status || 'active';
    const statusCopy = eventStatus === 'cancelled'
      ? `This event has been cancelled.${data.event.statusNote ? ` ${data.event.statusNote}` : ''}`
      : eventStatus === 'postponed'
        ? `This event has been postponed.${data.event.statusNote ? ` ${data.event.statusNote}` : ''}${data.event.replacementEventDate ? ` New schedule: ${formatEventSchedule(data.event)}.` : ''}` : '';
    const statusElement = $('#guest-event-status');
    statusElement.textContent = statusCopy;
    statusElement.hidden = !statusCopy;
    $('#guest-date').textContent = formatEventSchedule(data.event);
    const locationRow = $('#guest-location-row');
    locationRow.hidden = !data.event.location;
    if (data.event.location) $('#guest-location').textContent = data.event.location;
    const deadlineRow = $('#guest-deadline-row');
    deadlineRow.hidden = !data.event.rsvpDeadline;
    if (data.event.rsvpDeadline) {
      $('#guest-deadline').textContent = formatInvitationDeadline(data.event.rsvpDeadline, data.event.timezone);
    }
    const form = $('#rsvp-form');
    form.hidden = eventStatus === 'cancelled';
    $('#guest-closed').textContent = eventStatus === 'cancelled' ? 'RSVP is unavailable for a cancelled event.' : '';
    $('#guest-closed').hidden = eventStatus !== 'cancelled' && data.canRespond;
    const partySize = form.elements.partySize;
    const partyLimit = Number(data.guest.partyLimit);
    partySize.max = partyLimit;
    partySize.value = data.guest.partySize ?? 1;
    $('#guest-capacity').textContent = `You can include up to ${partyLimit} ${partyLimit === 1 ? 'person' : 'people'} in your reply.`;
    $('#party-limit-hint').textContent = `Up to ${partyLimit} ${partyLimit === 1 ? 'person' : 'people'} on this invitation.`;
    if (data.guest.answer) form.elements.answer.value = data.guest.answer;
    // Pre-populate attendee rows from saved data.
    const savedAttendees = Array.isArray(data.guest.attendees) ? data.guest.attendees : [];
    if (savedAttendees.length > 0) {
      const firstRow = $('#attendee-rows').querySelector('.attendee-row');
      savedAttendees.forEach((attendee, i) => {
        if (i > 0) {
          const addBtn = $('#add-attendee');
          if (addBtn) addBtn.click();
        }
        const row = $('#attendee-rows').querySelectorAll('.attendee-row')[i];
        if (!row) return;
        const nameInput = row.querySelector('input[name$="-name"]');
        const dietaryInput = row.querySelector('input[name$="-dietary"]');
        const accessibilityInput = row.querySelector('input[name$="-accessibility"]');
        const ageBandSelect = row.querySelector('select[name$="-ageBand"]');
        if (nameInput) nameInput.value = attendee.name || '';
        if (dietaryInput) dietaryInput.value = attendee.dietary || '';
        if (accessibilityInput) accessibilityInput.value = attendee.accessibility || '';
        if (ageBandSelect) ageBandSelect.value = attendee.ageBand || 'adult';
      });
    }
    const updatePartySize = () => {
      const answer = form.elements.answer.value;
      partySize.min = answer === 'yes' ? '1' : '0';
      if (answer === 'no') partySize.value = '0';
      else if (Number(partySize.value) === 0) partySize.value = '1';
      partySize.disabled = answer === 'no';
      partySize.setCustomValidity('');
      $('#guest-message').textContent = '';
      const attendees = $('#rsvp-attendees');
      if (attendees) {
        attendees.hidden = answer !== 'yes' || Number(partySize.value) < 2;
      }
    };
    const validatePartySize = () => {
      partySize.setCustomValidity('');
      if (!partySize.disabled && Number(partySize.value) > partyLimit) {
        const message = `Party size cannot exceed ${partyLimit} for this invitation.`;
        partySize.setCustomValidity(message);
        showMessage($('#guest-message'), message, true);
      } else {
        const guestMessage = $('#guest-message');
        if (guestMessage.classList.contains('error')) showMessage(guestMessage, '');
      }
    };
    $('#guest-response-options').addEventListener('change', updatePartySize);
    partySize.addEventListener('input', validatePartySize);
    partySize.addEventListener('change', updatePartySize);
    const addAttendee = $('#add-attendee');
    const attendeeRows = $('#attendee-rows');
    if (addAttendee && attendeeRows) {
      addAttendee.addEventListener('click', () => {
        const index = attendeeRows.querySelectorAll('.attendee-row').length;
        const row = document.createElement('div');
        row.className = 'attendee-row';
        row.innerHTML = `
          <label class="form-field">Name<input name="attendee-${index}-name" type="text" maxlength="100" placeholder="Person ${index + 1}"></label>
          <label class="form-field">Dietary needs<input name="attendee-${index}-dietary" type="text" maxlength="200" placeholder="e.g. none, vegetarian, nut allergy"></label>
          <label class="form-field">Accessibility needs<input name="attendee-${index}-accessibility" type="text" maxlength="200" placeholder="e.g. wheelchair access"></label>
          <label class="form-field">Age band<select name="attendee-${index}-ageBand"><option value="adult">Adult</option><option value="child">Child (under 12)</option></select></label>
          <button type="button" class="secondary remove-attendee" title="Remove this person">Remove</button>
        `;
        attendeeRows.appendChild(row);
        row.querySelector('.remove-attendee').addEventListener('click', () => {
          row.remove();
          attendeeRows.querySelectorAll('.attendee-row').forEach((r, i) => {
            r.querySelectorAll('input, select').forEach((el) => {
              el.name = el.name.replace(/_\d+-/, `_${i}-`);
            });
          });
        });
      });
    }
    $('#edit-rsvp').addEventListener('click', () => {
      $('#rsvp-confirmation').hidden = true;
      form.hidden = false;
      const options = $('#guest-response-options');
      if (typeof options.focus === 'function') options.focus();
    });
    updatePartySize();
    const closedMessage = $('#guest-closed');
    closedMessage.hidden = data.canRespond;
    if (!data.canRespond) {
      closedMessage.textContent = 'RSVPs are closed for this invitation. Your invitation details are here for reference.';
      form.hidden = true;
      if (data.guest.answer) {
        $('#rsvp-confirmation').hidden = false;
        $('#rsvp-confirmation-title').textContent = 'Your reply is recorded';
        $('#rsvp-confirmation-copy').textContent = data.guest.answer === 'yes'
          ? (() => {
            const savedAttendees = Array.isArray(data.guest.attendees) ? data.guest.attendees.filter((a) => a.name.trim()).length : 0;
            return savedAttendees > 0
              ? `Your reply is saved for ${data.guest.partySize} ${data.guest.partySize === 1 ? 'person' : 'people'} (${savedAttendees} named).`
              : `Your reply is saved for ${data.guest.partySize} ${data.guest.partySize === 1 ? 'person' : 'people'}.`;
          })()
          : `Your reply is saved as ${data.guest.answer === 'no' ? 'regretfully declines' : 'not sure yet'}.`;
        $('#edit-rsvp').hidden = true;
      }
    } else {
      form.hidden = false;
      $('#rsvp-confirmation').hidden = true;
      $('#edit-rsvp').hidden = false;
    }
    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      const values = formValues(event.currentTarget);
      values.partySize = values.answer === 'no' ? 0 : Number(values.partySize);
      // Collect attendee details.
      const attendees = [];
      if (values.answer !== 'no') {
        const rows = form.querySelectorAll('.attendee-row');
        for (const row of rows) {
          const name = row.querySelector('input[name$="-name"]')?.value.trim() || '';
          if (!name) continue;
          const dietary = row.querySelector('input[name$="-dietary"]')?.value || '';
          const accessibility = row.querySelector('input[name$="-accessibility"]')?.value || '';
          const ageBand = row.querySelector('select[name$="-ageBand"]')?.value || 'adult';
          attendees.push({ name, dietary, accessibility, ageBand });
        }
      }
      values.attendees = attendees;
      const submit = form.querySelector('button[type="submit"]');
      if (submit) submit.disabled = true;
      try {
        await api(`/api/guest/${rsvpToken}/rsvp`, { method: 'PUT', body: JSON.stringify(values) });
        $('#rsvp-confirmation-title').textContent = `Thank you, ${data.guest.name}.`;
        const attendeeCount = values.attendees.filter((a) => a.name.trim()).length;
        $('#rsvp-confirmation-copy').textContent = values.answer === 'yes'
          ? attendeeCount > 0
            ? `Your reply is saved for ${values.partySize} ${values.partySize === 1 ? 'person' : 'people'} (${attendeeCount} named).`
            : `Your reply is saved for ${values.partySize} ${values.partySize === 1 ? 'person' : 'people'}.`
          : values.answer === 'no'
            ? 'Your reply has been saved. Thank you for letting us know.'
            : 'Your reply is saved as not sure yet. Thank you for letting us know.';
        $('#edit-rsvp').hidden = false;
        form.hidden = true;
        $('#rsvp-confirmation').hidden = false;
        $('#guest-message').textContent = '';
      } catch (error) {
        showMessage($('#guest-message'), error.message, true);
      } finally {
        if (submit) submit.disabled = false;
      }
    });
  } catch (error) {
    $('#guest-content').hidden = false;
    $('#guest-envelope').hidden = true;
    $('#guest-title').textContent = 'Invitation unavailable';
    $('#guest-greeting').hidden = true;
    $('#guest-details').textContent = error.message;
    $('#guest-details').hidden = true;
    $('.invitation-details').hidden = true;
    $('#guest-rsvp').hidden = true;
    $('#guest-unavailable-copy').textContent = error.message;
    $('#guest-unavailable').hidden = false;
    $('#rsvp-form').hidden = true;
  }
}

start().catch((error) => showMessage($('#global-message'), error.message, true));
