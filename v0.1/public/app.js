'use strict';

const $ = (selector, root = document) => root.querySelector(selector);
const token = location.pathname.match(/^\/rsvp\/([^/]+)$/)?.[1];

let eventsCache = [];
let currentEventId = null;
// Tracks which guest panels are open across card rebuilds (e.g. after publishing).
let openGuestPanels = new Set();
// Tracks which theme panels are open across card rebuilds (e.g. after publishing).
let openThemePanels = new Set();

const THEME_PRESETS = {
  classic: { primaryColor: '#315a4c', backgroundColor: '#f8f6f1', textColor: '#262b2c', fontFamily: 'serif' },
  garden: { primaryColor: '#466b4d', backgroundColor: '#f4f6ed', textColor: '#26352a', fontFamily: 'serif' },
  midnight: { primaryColor: '#313a63', backgroundColor: '#f1f1f7', textColor: '#22243a', fontFamily: 'sans' }
};
const DEFAULT_THEME = { preset: 'classic', ...THEME_PRESETS.classic, coverImage: null };
const IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp']);
const MAX_COVER_BYTES = 1024 * 1024;
const COLOR_PATTERN = /^#[\da-f]{6}$/i;
const IMAGE_DATA_PATTERN = /^data:image\/(?:png|jpeg|webp);base64,([a-z\d+/]+={0,2})$/i;
const MIN_TEXT_CONTRAST = 4.5;

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
  element.style.setProperty('--invite-action-text', bestContrastForeground(safeTheme.primaryColor));
  return safeTheme;
}

function setThemePreview(preview, image, theme) {
  const safeTheme = applyTheme(preview, theme);
  setInvitationCover(image, safeTheme);
}

function setInvitationCover(image, theme) {
  image.hidden = !theme.coverImage;
  if (theme.coverImage) image.src = theme.coverImage;
  else image.removeAttribute('src');
}

function formatInvitationDate(value) {
  const [year, month, day] = value.split('-').map(Number);
  return new Intl.DateTimeFormat(undefined, {
    weekday: 'long', month: 'long', day: 'numeric', year: 'numeric'
  }).format(new Date(year, month - 1, day));
}

function formatInvitationDeadline(value) {
  return new Intl.DateTimeFormat(undefined, {
    month: 'long', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit',
    timeZoneName: 'short'
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
  setText('#guest-greeting', 'An invitation for Alex Morgan');
  setText('#guest-title', event.title);
  setText('#guest-details', 'We’d be delighted if you can join us.');
  setText('#guest-date', formatInvitationDate(event.eventDate));
  const locationRow = $('#guest-location-row', invitation);
  locationRow.hidden = !event.location;
  if (event.location) setText('#guest-location', event.location);
  const deadlineRow = $('#guest-deadline-row', invitation);
  deadlineRow.hidden = !event.rsvpDeadline;
  if (event.rsvpDeadline) setText('#guest-deadline', formatInvitationDeadline(event.rsvpDeadline));
  const partyLimit = event.guestMode === 'individual' ? 1 : 4;
  setText('#guest-capacity', `You can include up to ${partyLimit} ${partyLimit === 1 ? 'person' : 'people'} in your reply.`);
  setText('.invitation-footnote', 'Example only — guest name and party size are illustrative; each guest invitation uses its own party limit.');

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
  if (!response.ok) throw new Error(result.error || `Request failed (${response.status})`);
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

$('#outbox-toggle').addEventListener('click', async () => {
  const section = $('#outbox');
  section.hidden = !section.hidden;
  if (!section.hidden) {
    try { await loadOutbox(); }
    catch (error) { showMessage($('#global-message'), error.message, true); }
  }
});

async function openOutbox() {
  $('#outbox').hidden = false;
  try { await loadOutbox(); }
  catch (error) { showMessage($('#global-message'), error.message, true); }
}

function openCreateEventForm() {
  const section = $('#create-event');
  section.hidden = false;
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
  try {
    await api('/api/events', { method: 'POST', body: JSON.stringify(data) });
    form.reset();
    $('#create-event').hidden = true;
    await loadEvents();
  } catch (error) { showMessage($('#global-message'), error.message, true); }
});

async function loadEvents() {
  const { events } = await api('/api/events');
  eventsCache = events;
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
    card.dataset.eventId = String(event.id);
    card.innerHTML = `<div class="event-topbar"><p class="breadcrumb"><span class="event-breadcrumb-title"></span></p><span class="local-event-tag">LOCAL EVENT</span></div><div class="event-heading"><div class="event-heading__copy"><div class="event-status"><span class="publication-status" role="status"></span><span class="response-state"></span></div><h2></h2><p class="event-meta"></p></div><div class="event-actions"><button class="publish">Publish event</button><button class="add secondary">Add guest unit</button><button class="guest-toggle secondary" aria-expanded="false">Show guests</button><button class="toggle secondary"></button><button class="refresh secondary">Refresh</button></div></div><div class="stats" aria-live="polite"></div><section class="publish-next-steps notice" role="status" aria-labelledby="__publish_next_steps_title" hidden><h3 id="__publish_next_steps_title">Published locally — what next?</h3><p>Your event is ready in this local workspace. Create a guest unit to generate a private RSVP link. Its invitation is captured in the local outbox; no email is sent.</p><div class="row"><button type="button" class="next-steps-add">Create a guest unit</button><button type="button" class="secondary next-steps-outbox">Open local email outbox</button></div></section><section class="guest-panel" aria-labelledby="__guest_list_title" hidden><div class="guest-panel__head"><div><p class="section-kicker">INVITATIONS</p><h3 id="__guest_list_title">Your guest list</h3><p class="muted">Guest units and replies stored in this local workspace only.</p></div><button type="button" class="guest-panel-toggle secondary" aria-expanded="false" aria-controls="__guest_panel">Hide guest list</button></div><div class="guest-form-slot"></div><div class="guest-table"></div></section><div class="theme-editor">
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
          <label>Cover image (PNG, JPEG, or WebP; max 1 MiB)
            <input class="theme-image" type="file" accept="image/png,image/jpeg,image/webp">
          </label>
        </div>
        <p class="help image-help">Images are stored with this event theme. Maximum file size: 1 MiB.</p>
        <button type="button" class="secondary remove-cover">Remove cover image</button>
        <button type="button" class="secondary preview-reveal-toggle" aria-pressed="false" hidden>Preview opened invitation</button>
        <div class="invitation-preview" aria-label="Invitation preview"></div>
        <p class="help preview-disclosure">Draft preview only. Example guest details are illustrative; preview controls are intentionally inactive and never play sound or submit an RSVP.</p>
        <p class="contrast-warning" role="status" aria-live="polite" hidden></p>
        <p class="theme-status message" role="status" aria-live="polite"></p>
        <button type="button" class="save-theme">Save theme</button>
      </section>
    </div>`;
      const themeEditor = $('.theme-editor', card);
      const themeToggle = $('.theme-toggle', card);
      $('.event-actions', card).append(themeToggle);
      $('.stats', card).after(themeEditor);
    const guestActions = document.createElement('div');
    guestActions.className = 'guest-actions';
    guestActions.setAttribute('role', 'group');
    guestActions.setAttribute('aria-label', 'Add guests');
    const addButton = $('.add', card);
    addButton.setAttribute('aria-expanded', 'false');
    addButton.addEventListener('click', () => toggleGuestComposer(event, card, 'single'));
    guestActions.append(addButton);
    const bulkButton = document.createElement('button');
    bulkButton.type = 'button';
    bulkButton.className = 'bulk-add secondary';
    bulkButton.textContent = 'Bulk invite';
    bulkButton.setAttribute('aria-expanded', 'false');
    bulkButton.addEventListener('click', () => toggleGuestComposer(event, card, 'bulk'));
    guestActions.append(bulkButton);
    card.guestActionButtons = { single: addButton, bulk: bulkButton };
    $('.publish', card).after(guestActions);
    $('.guest-form-slot', card).hidden = true;
    $('.event-breadcrumb-title', card).textContent = event.title;
    $('h2', card).textContent = event.title;
    updatePublicationStatus(event, card);
    $('.response-state', card).textContent = event.responsesOpen ? 'RSVPs open' : 'RSVPs closed';
    $('.event-meta', card).textContent = `${event.eventDate} · ${event.location || 'No location'} · ${event.guestMode} units${event.rsvpDeadline ? ` · deadline ${new Date(event.rsvpDeadline).toLocaleString()}` : ''}`;
    $('.publish', card).addEventListener('click', async () => {
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
    $('.next-steps-add', card).addEventListener('click', () => showGuestForm(event, card));
    $('.next-steps-outbox', card).addEventListener('click', openOutbox);
    const toggle = $('.toggle', card);
    toggle.textContent = event.responsesOpen ? 'Close RSVPs' : 'Reopen RSVPs';
    toggle.addEventListener('click', async () => {
      try {
        await api(`/api/events/${event.id}/responses`, {
          method: 'POST', body: JSON.stringify({ open: !event.responsesOpen })
        });
        await loadEvents();
      } catch (error) { showMessage($('#global-message'), error.message, true); }
    });
    $('.refresh', card).addEventListener('click', () => renderDashboard(event, card));

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

    setupThemeEditor(event, card);
    container.append(card);
    await renderDashboard(event, card);
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

function switchEvent(eventId) {
  currentEventId = eventId === '' || eventId === null ? null : Number(eventId);
  $('#event-switch').value = currentEventId !== null ? String(currentEventId) : '';
  applyEventFilter();
  if (currentEventId === null) {
    // Returning to the full list: collapse every guest panel so the grid stays tidy.
    document.querySelectorAll('.event-card').forEach((card) => {
      if (typeof card.guestPanelToggleFn === 'function') card.guestPanelToggleFn(false);
    });
    return;
  }
  const selected = document.querySelector(`.event-card[data-event-id="${currentEventId}"]`);
  if (selected && typeof selected.guestPanelToggleFn === 'function') {
    selected.guestPanelToggleFn(true);
  }
  if (selected && typeof selected.scrollIntoView === 'function') {
    selected.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }
}

$('#event-switch').addEventListener('change', (event) => {
  switchEvent(event.target.value);
});

function setupThemeEditor(event, card) {
  const toggle = $('.theme-toggle', card);
  const panel = $('.theme-panel', card);
  const preset = $('.theme-preset', card);
  const primary = $('.theme-primary', card);
  const background = $('.theme-background', card);
  const text = $('.theme-text', card);
  const font = $('.theme-font', card);
  const fileInput = $('.theme-image', card);
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
  const invitationSettingsTitle = $('.invitation-settings-title', card);
  const previewReveal = $('.preview-reveal-toggle', card);
  const initialTheme = normalizeTheme(event.theme || DEFAULT_THEME);
  let draftInvitationSettings = normalizeInvitationSettings(event.invitationSettings);
  let draftTheme = { ...initialTheme };
  let previewRevealed = false;
  let isSaving = false;
  let isSavingInvitation = false;

panel.id = `theme-panel-${String(event.id).replace(/[^a-z\d_-]/gi, '')}`;
    invitationSettingsTitle.id = `invitation-settings-title-${String(event.id).replace(/[^a-z\d_-]/gi, '')}`;
    $('.invitation-settings', card).setAttribute('aria-labelledby', invitationSettingsTitle.id);
    toggle.setAttribute('aria-controls', panel.id);
    // Restore open state across card rebuilds (e.g. after publishing), matching the guest-toggle pattern.
    const themeExpanded = openThemePanels.has(String(event.id));
    panel.hidden = !themeExpanded;
    toggle.setAttribute('aria-expanded', String(themeExpanded));
    if (themeExpanded && typeof panel.scrollIntoView === 'function') {
      panel.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
    const invitation = mountInvitationPreview(preview, event);
  const image = $('.invitation-cover', invitation);
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
  const syncFields = () => {
    preset.value = draftTheme.preset;
    primary.value = draftTheme.primaryColor;
    background.value = draftTheme.backgroundColor;
    text.value = draftTheme.textColor;
    font.value = draftTheme.fontFamily;
    setThemePreview(invitation, image, draftTheme);
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
    setThemePreview(invitation, image, draftTheme);
    validateContrast();
    setStatus('');
  };
  syncFields();
  syncInvitationFields();
  validateContrast();
  previewReveal.addEventListener('click', () => {
    previewRevealed = !previewRevealed;
    $('.reveal-envelope', invitation).hidden = previewRevealed;
    $('.guest-content', invitation).hidden = !previewRevealed;
    previewReveal.textContent = previewRevealed
      ? 'Show envelope preview' : 'Preview opened invitation';
    previewReveal.setAttribute('aria-pressed', String(previewRevealed));
  });
  toggle.addEventListener('click', () => {
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
  saveInvitation.addEventListener('click', async () => {
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
  fileInput.addEventListener('change', async () => {
    const file = fileInput.files && fileInput.files[0];
    if (!file) return;
    if (!IMAGE_TYPES.has(file.type)) {
      fileInput.value = '';
      setStatus('Choose a PNG, JPEG, or WebP image.', true);
      return;
    }
    if (file.size > MAX_COVER_BYTES) {
      fileInput.value = '';
      setStatus('Image must be 1 MiB or smaller.', true);
      return;
    }
    try {
      const dataUrl = await new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.addEventListener('load', () => resolve(reader.result));
        reader.addEventListener('error', () => reject(new Error('Could not read the selected image.')));
        reader.readAsDataURL(file);
      });
      if (!isSafeImageDataUrl(dataUrl)) {
        throw new Error('The selected file did not produce a supported image.');
      }
      draftTheme.coverImage = dataUrl;
      setThemePreview(invitation, image, draftTheme);
      setStatus('');
    } catch (error) {
      setStatus(error.message, true);
    }
  });
  $('.remove-cover', card).addEventListener('click', () => {
    draftTheme.coverImage = null;
    fileInput.value = '';
    setThemePreview(invitation, image, draftTheme);
    setStatus('Cover image removed from this draft.');
  });
  save.addEventListener('click', async () => {
    if (!validateContrast()) return;
    isSaving = true;
    save.disabled = true;
    save.textContent = 'Saving…';
    setStatus('');
    try {
      const theme = normalizeTheme(draftTheme);
      await api(`/api/events/${event.id}/theme`, {
        method: 'PUT',
        body: JSON.stringify(theme)
      });
      event.theme = theme;
      draftTheme = { ...theme };
      setThemePreview(invitation, image, draftTheme);
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

async function renderDashboard(event, card) {
  const { guests } = await api(`/api/events/${event.id}/dashboard`);
  const counts = {
    invited: guests.length,
    yes: guests.filter((guest) => guest.answer === 'yes').length,
    no: guests.filter((guest) => guest.answer === 'no').length,
    maybe: guests.filter((guest) => guest.answer === 'maybe').length,
    pending: guests.filter((guest) => !guest.revokedAt && !guest.answer).length,
    people: guests.filter((guest) => guest.answer === 'yes').reduce((sum, guest) => sum + guest.partySize, 0)
  };
  $('.stats', card).innerHTML = `<div class="stat"><span>INVITED UNITS</span><b>${counts.invited}</b><small>all guest units</small></div><div class="stat"><span>ATTENDING PEOPLE</span><b>${counts.people}</b><small>${counts.yes} attending ${counts.yes === 1 ? 'unit' : 'units'}</small></div><div class="stat"><span>AWAITING REPLY</span><b>${counts.pending}</b><small>no reply yet</small></div><div class="stat"><span>NOT SURE YET</span><b>${counts.maybe}</b><small>maybe replies</small></div><div class="stat"><span>DECLINED</span><b>${counts.no}</b><small>can't attend</small></div>`;
  const target = $('.guest-table', card);
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
      cell.setAttribute('data-label', label);
      cell.textContent = value;
      row.append(cell);
    }
    const action = document.createElement('td');
    action.setAttribute('data-label', 'Actions');
    if (!guest.revokedAt) {
      const linkButton = document.createElement('button');
      linkButton.type = 'button';
      linkButton.className = 'secondary guest-link-retention';
      linkButton.textContent = 'Link';
      linkButton.setAttribute('aria-label', `Copy invitation link for ${guest.name}`);
      linkButton.addEventListener('click', async () => {
        linkButton.disabled = true;
        try {
          const { inviteUrl } = await api(`/api/guests/${guest.id}/invite-link`);
          const absoluteUrl = `${location.origin}${inviteUrl}`;
          if (typeof navigator === 'undefined' || !navigator.clipboard || !navigator.clipboard.writeText) {
            throw new Error('Clipboard unavailable.');
          }
          await navigator.clipboard.writeText(absoluteUrl);
          showToast(`${guest.name}'s invitation link copied.`);
        } catch {
          showToast(`Could not copy ${guest.name}'s link. Retrieve it from the local outbox.`);
        } finally {
          linkButton.disabled = false;
        }
      });
      action.append(linkButton);
      const button = document.createElement('button');
      button.className = 'danger'; button.textContent = 'Revoke';
      button.addEventListener('click', async () => {
        try {
          await api(`/api/guests/${guest.id}/revoke`, { method: 'POST', body: '{}' });
          await renderDashboard(event, card);
        } catch (error) { showMessage($('#global-message'), error.message, true); }
      });
      action.append(button);
    } else action.textContent = '—';
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
        if (!navigator.clipboard || !navigator.clipboard.writeText) throw new Error('Clipboard unavailable.');
        await navigator.clipboard.writeText(link.href);
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
    setInvitationCover($('#guest-cover'), guestTheme);
    syncInvitationPresentation($('#guest'), invitationSettings);
    let musicContext;
    let musicTimer;
    let musicStarting = false;
    const stopInvitationMusic = () => {
      if (musicTimer !== undefined) window.clearInterval(musicTimer);
      musicTimer = undefined;
      if (musicContext && typeof musicContext.close === 'function') {
        musicContext.close().catch(() => {});
      }
      musicContext = undefined;
    };
    const startInvitationMusic = async (hasUserGesture = false) => {
      if (!invitationSettings.chimeEnabled || musicStarting || musicContext) return;
      const audioControl = $('.guest-audio-control');
      const button = $('#guest-chime');
      const status = $('#guest-audio-status');
      const AudioContextClass = window.AudioContext || window.webkitAudioContext;
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
      } catch {
        stopInvitationMusic();
        status.textContent = 'Background music could not start automatically. Use the button below to try again.';
        button.textContent = 'Play gentle background music';
        button.hidden = false;
        button.disabled = false;
        audioControl.hidden = false;
      } finally {
        musicStarting = false;
      }
    };
    $('#guest-chime').addEventListener('click', () => startInvitationMusic(true));
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
    if (invitationSettings.revealMode !== 'envelope') void startInvitationMusic();
    $('#guest-greeting').textContent = `An invitation for ${data.guest.name}`;
    $('#guest-title').textContent = data.event.title;
    $('#guest-details').textContent = 'We’d be delighted if you can join us.';
    $('#guest-date').textContent = formatInvitationDate(data.event.eventDate);
    const locationRow = $('#guest-location-row');
    locationRow.hidden = !data.event.location;
    if (data.event.location) $('#guest-location').textContent = data.event.location;
    const deadlineRow = $('#guest-deadline-row');
    deadlineRow.hidden = !data.event.rsvpDeadline;
    if (data.event.rsvpDeadline) {
      $('#guest-deadline').textContent = formatInvitationDeadline(data.event.rsvpDeadline);
    }
    const form = $('#rsvp-form');
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
      const rows = form.querySelectorAll('.attendee-row');
      for (const row of rows) {
        const name = row.querySelector('input[name$="-name"]')?.value || '';
        const dietary = row.querySelector('input[name$="-dietary"]')?.value || '';
        const accessibility = row.querySelector('input[name$="-accessibility"]')?.value || '';
        const ageBand = row.querySelector('select[name$="-ageBand"]')?.value || 'adult';
        attendees.push({ name, dietary, accessibility, ageBand });
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
