'use strict';

const $ = (selector, root = document) => root.querySelector(selector);
const token = location.pathname.match(/^\/rsvp\/([^/]+)$/)?.[1];

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
    chimeEnabled: settings.chimeEnabled === true
  };
}

function syncInvitationPresentation(invitation, settings, isPreview = false) {
  const safeSettings = normalizeInvitationSettings(settings);
  const envelope = $('.reveal-envelope', invitation);
  const content = $('.guest-content', invitation);
  const audioControl = $('.guest-audio-control', invitation);
  const chime = $('.guest-chime-control', invitation);
  const audioStatus = $('.guest-audio-status', invitation);
  if (envelope) {
    envelope.hidden = safeSettings.revealMode !== 'envelope';
    envelope.disabled = isPreview;
    if (isPreview) envelope.removeAttribute('aria-controls');
    else envelope.setAttribute('aria-controls', 'guest-content');
  }
  if (content) content.hidden = safeSettings.revealMode === 'envelope';
  if (audioControl) audioControl.hidden = !safeSettings.chimeEnabled;
  if (chime) {
    chime.disabled = isPreview;
    chime.textContent = isPreview ? 'Play a gentle chime (guest only)' : 'Play a gentle chime';
  }
  if (audioStatus) {
    audioStatus.textContent = isPreview && safeSettings.chimeEnabled
      ? 'Sound is only available to guests on their invitation.' : '';
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

$('#event-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const data = formValues(form);
  if (data.rsvpDeadline) data.rsvpDeadline = new Date(data.rsvpDeadline).toISOString();
  try {
    await api('/api/events', { method: 'POST', body: JSON.stringify(data) });
    form.reset();
    await loadEvents();
  } catch (error) { showMessage($('#global-message'), error.message, true); }
});

async function loadEvents() {
  const { events } = await api('/api/events');
  const container = $('#events');
  container.replaceChildren();
  if (!events.length) {
    const empty = document.createElement('section');
    empty.className = 'card muted';
    empty.textContent = 'No events yet. Create one above to get started.';
    container.append(empty);
    return;
  }
  for (const event of events) {
    const card = document.createElement('section');
    card.className = 'card event-card';
    card.innerHTML = `<div class="event-topbar"><p class="breadcrumb"><a href="#events">My events</a><span aria-hidden="true">/</span><span class="event-breadcrumb-title"></span></p><span class="local-event-tag">LOCAL EVENT</span></div><div class="event-heading"><div class="event-heading__copy"><div class="event-status"><span class="publication-status" role="status"></span><span class="response-state"></span></div><h2></h2><p class="event-meta"></p></div><div class="event-actions"><button class="publish">Publish event</button><button class="add secondary">Add guest unit</button><button class="toggle secondary"></button><button class="refresh secondary">Refresh</button></div></div><div class="stats" aria-live="polite"></div><section class="publish-next-steps notice" role="status" aria-labelledby="publish-next-steps-title" hidden><h3 id="publish-next-steps-title">Published locally — what next?</h3><p>Your event is ready in this local workspace. Create a guest unit to generate a private RSVP link. Its invitation is captured in the local outbox; no email is sent.</p><div class="row"><button type="button" class="next-steps-add">Create a guest unit</button><button type="button" class="secondary next-steps-outbox">Open local email outbox</button></div></section><section class="guest-panel" aria-labelledby="guest-list-title"><div class="guest-panel__head"><div><p class="section-kicker">INVITATIONS</p><h3 id="guest-list-title">Your guest list</h3><p class="muted">Guest units and replies stored in this local workspace only.</p></div></div><div class="guest-form-slot"></div><div class="guest-table"></div></section><div class="theme-editor">
      <button type="button" class="secondary theme-toggle" aria-expanded="false">Customize invitation</button>
      <section class="theme-panel" hidden>
        <p class="help">Adjust how the invitation opens, its optional guest-activated chime, colors, font, and cover. Preview changes before saving.</p>
        <section class="invitation-settings" aria-labelledby="invitation-settings-title">
          <div class="invitation-settings__heading">
            <p class="section-kicker">GUEST EXPERIENCE</p>
            <h3 class="invitation-settings-title">How the invitation opens</h3>
            <p class="help">Choose a direct card or a small envelope reveal. Guests can play the optional chime only when they choose.</p>
          </div>
          <div class="columns invitation-settings-controls">
            <label>Presentation
              <select class="invitation-reveal-mode" aria-label="Invitation presentation">
                <option value="direct">Direct invitation</option>
                <option value="envelope">Animated envelope reveal</option>
              </select>
            </label>
            <label class="invitation-chime-option">
              <input class="invitation-chime-enabled" type="checkbox">
              Offer a gentle chime (guest-activated)
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
    $('.add', card).addEventListener('click', () => showGuestForm(event, card));
    setupThemeEditor(event, card);
    container.append(card);
    await renderDashboard(event, card);
  }
}

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
  const invitation = mountInvitationPreview(preview, event);
  const image = $('.invitation-cover', invitation);
  const syncInvitationFields = () => {
    revealMode.value = draftInvitationSettings.revealMode;
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
    toggle.setAttribute('aria-expanded', String(!panel.hidden));
  });
  revealMode.addEventListener('change', () => {
    draftInvitationSettings.revealMode = revealMode.value === 'envelope' ? 'envelope' : 'direct';
    syncInvitationFields();
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
  table.innerHTML = '<thead><tr><th scope="col">GUEST UNIT</th><th scope="col">EMAIL</th><th scope="col">RESPONSE</th><th scope="col">PARTY SIZE</th><th scope="col">ACTION</th></tr></thead><tbody></tbody>';
  const tbody = $('tbody', table);
  for (const guest of guests) {
    const row = document.createElement('tr');
    for (const value of [
      guest.name, guest.email, guest.revokedAt ? 'Revoked' : guest.answer || 'No reply',
      guest.partySize ?? '—'
    ]) {
      const cell = document.createElement('td'); cell.textContent = value; row.append(cell);
    }
    const action = document.createElement('td');
    if (!guest.revokedAt) {
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

function showGuestForm(event, card) {
  const slot = $('.guest-form-slot', card);
  slot.innerHTML = `<form class="guest-form notice"><label>${event.guestMode === 'household' ? 'Household / group name' : 'Guest name'}<input name="name" maxlength="100" required></label><label>Guest email (synthetic only)<input name="email" type="email" maxlength="254" required></label>${event.guestMode === 'household' ? '<label>Maximum party size<input name="partyLimit" type="number" min="1" max="20" required></label>' : ''}<button>Create unit + capture invitation</button><div class="invite-result"></div></form>`;
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
      const link = document.createElement('a');
      link.href = created.inviteUrl;
      link.textContent = `${location.origin}${created.inviteUrl}`;
      const result = document.createElement('p');
      result.className = 'notice success';
      result.append('Copy this private link for local testing: ', link);
      $('.invite-result', slot).replaceChildren(result);
      form.reset();
      await renderDashboard(event, card);
      await loadOutbox();
    } catch (error) {
      showMessage($('.invite-result', slot), error.message, true);
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
    $('#guest-envelope').addEventListener('click', () => {
      const envelope = $('#guest-envelope');
      const reveal = () => {
        envelope.hidden = true;
        $('#guest-content').hidden = false;
        $('#guest-content').classList.add('is-revealing');
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
    });
    $('#guest-chime').addEventListener('click', async (event) => {
      const button = event.currentTarget;
      const status = $('#guest-audio-status');
      const AudioContextClass = window.AudioContext || window.webkitAudioContext;
      if (!AudioContextClass) {
        status.textContent = 'Audio playback is not available in this browser.';
        return;
      }
      button.disabled = true;
      status.textContent = '';
      let context;
      try {
        context = new AudioContextClass();
        await context.resume();
        const now = context.currentTime;
        const notes = [{ at: 0, frequency: 659.25 }, { at: 0.2, frequency: 783.99 }];
        for (const note of notes) {
          const oscillator = context.createOscillator();
          const gain = context.createGain();
          oscillator.type = 'sine';
          oscillator.frequency.setValueAtTime(note.frequency, now + note.at);
          gain.gain.setValueAtTime(0.0001, now + note.at);
          gain.gain.exponentialRampToValueAtTime(0.075, now + note.at + 0.035);
          gain.gain.exponentialRampToValueAtTime(0.0001, now + note.at + 0.58);
          oscillator.connect(gain);
          gain.connect(context.destination);
          oscillator.start(now + note.at);
          oscillator.stop(now + note.at + 0.6);
        }
        status.textContent = 'A gentle chime is playing.';
        window.setTimeout(() => {
          button.disabled = false;
          if (context && typeof context.close === 'function') context.close().catch(() => {});
        }, 700);
      } catch {
        status.textContent = 'The chime could not be played. Please check your browser audio settings.';
        button.disabled = false;
        if (context && typeof context.close === 'function') context.close().catch(() => {});
      }
    });
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
    const updatePartySize = () => {
      const answer = form.elements.answer.value;
      partySize.min = answer === 'yes' ? '1' : '0';
      if (answer === 'no') partySize.value = '0';
      else if (Number(partySize.value) === 0) partySize.value = '1';
      partySize.disabled = answer === 'no';
      partySize.setCustomValidity('');
      $('#guest-message').textContent = '';
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
          ? `Your reply is saved for ${data.guest.partySize} ${data.guest.partySize === 1 ? 'person' : 'people'}.`
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
      const submit = form.querySelector('button[type="submit"]');
      if (submit) submit.disabled = true;
      try {
        await api(`/api/guest/${rsvpToken}/rsvp`, { method: 'PUT', body: JSON.stringify(values) });
        $('#rsvp-confirmation-title').textContent = `Thank you, ${data.guest.name}.`;
        $('#rsvp-confirmation-copy').textContent = values.answer === 'yes'
          ? `Your reply is saved for ${values.partySize} ${values.partySize === 1 ? 'person' : 'people'}.`
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
