'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

class FakeElement {
  constructor() {
    this.listeners = new Map();
    this.children = [];
    this.hidden = false;
    this.disabled = false;
    this.textContent = '';
    this.className = '';
    this.dataset = {};
    this.style = { setProperty() {} };
    this.attributes = {};
    this.classList = {
      add: (value) => {
        if (!this.classList.contains(value)) this.className = `${this.className} ${value}`.trim();
      },
      remove: (...values) => {
        this.className = this.className.split(/\s+/).filter((name) => !values.includes(name)).join(' ');
      },
      contains: (value) => this.className.split(/\s+/).includes(value)
    };
  }

  addEventListener(name, callback) {
    this.listeners.set(name, callback);
  }

  removeEventListener(name, callback) {
    if (this.listeners.get(name) === callback) this.listeners.delete(name);
  }

  click() { this.listeners.get('click')?.(); }

  querySelector(selector) {
    if (selector === '.guest-composer-close' && this.className === 'guest-form-slot') {
      const activeForm = this.composerMode === 'bulk' ? this.parts['.bulk-guest-form'] : this.parts['.guest-form'];
      return activeForm && activeForm.parts[selector];
    }
    if (this.parts && this.parts[selector]) return this.parts[selector];
    if (selector.startsWith('.')) {
      const className = selector.slice(1);
      return this.children.find((child) => child.className.split(/\s+/).includes(className));
    }
    return undefined;
  }

  querySelectorAll() { return []; }

  cloneNode() {
    const clone = new FakeElement();
    clone.className = 'invitation-card';
    clone.parts = {};
    for (const selector of [
      '#guest-greeting', '#guest-title', '#guest-details', '#guest-date',
      '#guest-rsvp-title', '#guest-rsvp-helper',
      '#guest-location-row', '#guest-location', '#guest-deadline-row', '#guest-deadline',
      '#guest-capacity', '.invitation-footnote',
      '#guest-invitation-image',
      '.reveal-envelope', '.guest-content', '.guest-audio-control',
      '.guest-chime-control', '.guest-audio-status'
    ]) clone.parts[selector] = new FakeElement();
    return clone;
  }

  append(...elements) {
    this.children.push(...elements);
  }

  after(...elements) { this.afterElements = elements; }
  scrollIntoView() { this.scrolledIntoView = true; }

  replaceChildren(...elements) {
    this.children = elements;
    this.parts = {};
    for (const element of elements) {
      if (element && element.className === 'invitation-card') this.parts['.invitation-card'] = element;
    }
  }

  reset() {}

  focus() { this.focused = true; }
  setCustomValidity(message) { this.validationMessage = message; }

  setAttribute(name, value) { this.attributes[name] = value; }
  getAttribute(name) { return this.attributes[name]; }
  removeAttribute(name) { delete this.attributes[name]; }

  set innerHTML(value) {
    this.html = value;
    if (this.tagName === 'table') {
      this.parts = { tbody: new FakeElement() };
      return;
    }
    if (this.className === 'guest-form-slot') {
      const form = new FakeElement();
      const inviteResult = new FakeElement();
      const bulkForm = new FakeElement();
      bulkForm.parts = {
        '.bulk-guest-rows': new FakeElement(),
        '.bulk-review': new FakeElement(),
        '.bulk-preview': new FakeElement(),
        '.bulk-result': new FakeElement(),
        '.bulk-create': new FakeElement(),
        '.guest-composer-close': new FakeElement()
      };
      this.parts = {
        '.guest-form': form,
        '.invite-result': inviteResult,
        '.bulk-guest-form': bulkForm
      };
      form.parts = {
        'input[name="name"]': new FakeElement(),
        '.invite-result': inviteResult,
        '.guest-composer-close': new FakeElement()
      };
      return;
    }
    if (!this.className.split(/\s+/).includes('event-card')) return;
    this.parts = {};
    for (const selector of [
      'h2', '.event-breadcrumb-title', '.event-status', '.response-state', '.publication-status',
      '.event-meta', '.stats', '.event-actions', '.event-status-panel', '.event-status-form', '.event-status-message', '.local-message-panel', '.local-message-form', '.publish',
      '.open-event', '.event-workspace', '.back-events', '.add', '.bulk-add', '.guest-actions', '.guest-toggle', '.toggle', '.refresh', '.export', '.print', '.guest-form-slot', '.guest-table', '.print-view',
      '.publish-next-steps', '.next-steps-add', '.next-steps-outbox',
      '.theme-toggle', '.theme-panel', '.theme-preset', '.theme-primary',
      '.theme-background', '.theme-text', '.theme-font',
      '.invitation-preview', '.theme-status', '.save-theme',
      '.contrast-warning', '.invitation-reveal-mode',
      '.invitation-reveal-motion', '.invitation-celebration',
      '.invitation-chime-enabled', '.save-invitation-settings',
      '.invitation-settings-status', '.invitation-settings-title', '.theme-editor',
      '.invitation-settings', '.preview-reveal-toggle',
      '.invitation-copy-title', '.invitation-copy-intro', '.invitation-copy-rsvp-heading',
      '.invitation-copy-rsvp-helper', '.invitation-copy-footer', '.save-invitation-copy',
      '.invitation-copy-status', '.invitation-copy-title-heading', '.invitation-copy-editor',
      '.invitation-image-upload', '.invitation-image-shape', '.invitation-image-alt',
      '.remove-invitation-image'
    ]) {
      this.parts[selector] = new FakeElement();
      if (selector.startsWith('.')) this.parts[selector].className = selector.slice(1);
    }
    this.parts['.theme-panel'].hidden = true;
    this.parts['.event-status-form'].elements = {
      status: Object.assign(new FakeElement(), { value: 'cancelled' }),
      note: Object.assign(new FakeElement(), { value: '' })
    };
  }
}

test('event cards publish drafts and refresh to published state', async () => {
  const elements = new Map();
  const getElement = (selector) => {
    if (!elements.has(selector)) elements.set(selector, new FakeElement());
    return elements.get(selector);
  };
  const document = {
    querySelector: getElement,
    createElement: (tagName) => Object.assign(new FakeElement(), { tagName })
  };
  getElement('#guest').className = 'invitation-card';
  getElement('#outbox').hidden = true;
  getElement('#create-event').hidden = true;
  const calls = [];
  let copiedInviteLink = '';
  let dashboardGuests = [];
  let published = false;
  let eventStatus = 'cancelled';
  const fetch = async (url, options = {}) => {
    calls.push({ url, options });
    let data;
    if (url === '/api/status') {
      data = { host: { id: 1 } };
    } else if (url === '/api/events') {
      data = {
        events: [{
          id: 7,
          title: 'Sample gathering',
          eventDate: '2035-06-15',
          location: 'Sample Park',
          guestMode: 'household',
          capacity: 100,
          invitationSettings: { revealMode: 'direct', chimeEnabled: false },
          invitationCopy: { greeting: '', title: '', intro: '', rsvpHeading: '', rsvpHelper: '', footerNote: '' },
          status: eventStatus,
          published,
          responsesOpen: true
        }]
      };
    } else if (url === '/api/events/7/dashboard') {
      data = { guests: dashboardGuests };
    } else if (url === '/api/outbox') {
      data = { messages: [] };
    } else if (url === '/api/events/7/guests' && options.method === 'POST') {
      data = { guest: { id: 8 }, inviteUrl: '/rsvp/synthetic-private-token' };
    } else if (url === '/api/events/7/guests/bulk' && options.method === 'POST') {
      const guests = JSON.parse(options.body).guests.map((guest, index) => ({
          ...guest,
          id: index + 10,
          inviteUrl: `/rsvp/synthetic-bulk-token-${index + 1}`
        }));
      dashboardGuests = guests.map((guest) => ({
        ...guest, revokedAt: null, answer: null, partySize: null, updatedAt: null
      }));
      data = { guests };
    } else if (/^\/api\/guests\/\d+\/invite-link$/.test(url)) {
      data = { inviteUrl: '/rsvp/synthetic-bulk-token-1' };
    } else if (/^\/api\/guests\/\d+\/revoke$/.test(url) && options.method === 'POST') {
      dashboardGuests[0].revokedAt = '2035-01-01T00:00:00.000Z';
      data = { guest: dashboardGuests[0] };
    } else if (url === '/api/events/7/publish' && options.method === 'POST') {
      published = true;
      data = { event: { id: 7, published: true } };
    } else if (url === '/api/events/7/status' && options.method === 'POST') {
      eventStatus = JSON.parse(options.body).status;
      data = { event: { id: 7, status: eventStatus, statusNote: '' } };
    } else if (url === '/api/events/7/invitation' && options.method === 'PUT') {
      data = { invitationSettings: JSON.parse(options.body) };
    } else if (url === '/api/events/7/invitation-copy' && options.method === 'PUT') {
      data = { invitationCopy: JSON.parse(options.body) };
    } else {
      throw new Error(`Unexpected request: ${url}`);
    }
    return { ok: true, json: async () => data };
  };

  const source = fs.readFileSync(path.join(__dirname, '../public/app.js'), 'utf8');
  vm.runInNewContext(source, {
    document,
    location: { pathname: '/', origin: 'http://localhost' },
    fetch,
    navigator: { clipboard: { writeText: async (value) => { copiedInviteLink = value; } } },
    window: { clearTimeout() {}, setTimeout: () => 1 },
    FormData: class { entries() { return []; } },
    console
  });

  assert.equal(getElement('#create-event').hidden, true, 'create form starts hidden');
  getElement('#open-create-event').listeners.get('click')();
  assert.equal(getElement('#create-event').hidden, false, 'header action opens the form');
  assert.equal(getElement('#event-form [name=title]').focused, true, 'opening focuses the event name');
  getElement('#cancel-create-event').listeners.get('click')();
  assert.equal(getElement('#create-event').hidden, true, 'cancel closes the form');

  const events = getElement('#events');
  for (let attempt = 0; attempt < 20 && events.children.length === 0; attempt += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
  let card = events.children[0];
  assert.ok(card.classList.contains('event-card--cancelled'));
  assert.equal(card.parts['.guest-table'].children.length, 0, 'event list does not render guest details before selection');
  card.parts['.open-event'].listeners.get('click')();
  for (let attempt = 0; attempt < 20 && card.parts['.guest-table'].children.length === 0; attempt += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.equal(card.parts['.open-event'].textContent, 'Manage event');
  assert.ok(card.parts['.event-actions'].children.includes(card.parts['.theme-toggle']), 'customize action is in the event header');
  assert.deepEqual(card.parts['.stats'].afterElements, [card.parts['.theme-editor']], 'editor is before the guest list');
  const guestActions = card.parts['.publish'].afterElements[0];
  assert.equal(guestActions.attributes['aria-label'], 'Add guests');
  assert.deepEqual(guestActions.children, [card.guestActionButtons.single, card.guestActionButtons.bulk]);
  let previewCard = card.parts['.invitation-preview'].querySelector('.invitation-card');
  assert.equal(previewCard.parts['#guest-capacity'].textContent, 'You can include up to 4 people in your reply.');
  assert.equal(previewCard.parts['.guest-content'].hidden, false);
  assert.equal(previewCard.parts['.reveal-envelope'].hidden, true);
  assert.equal(card.parts['.preview-reveal-toggle'].hidden, true);
  assert.equal(card.parts['.invitation-reveal-mode'].value, 'direct');
  assert.equal(card.parts['.invitation-chime-enabled'].checked, false);
  assert.equal(card.parts['.invitation-copy-greeting'], undefined, 'greeting is not an editable host field');
  assert.equal(previewCard.parts['#guest-greeting'].textContent, 'An invitation for Alex Morgan');
  assert.equal(card.parts['.invitation-copy-title'].value, '');
  assert.equal(card.parts['.invitation-copy-title'].placeholder, 'Sample gathering');
  assert.equal(card.parts['.invitation-copy-intro'].value, '');
  assert.equal(card.parts['.invitation-copy-intro'].placeholder, 'We’d be delighted if you can join us.');
  assert.equal(card.parts['.invitation-copy-rsvp-heading'].value, '');
  assert.equal(card.parts['.invitation-copy-rsvp-heading'].placeholder, 'Will you be there?');
  assert.equal(card.parts['.invitation-copy-rsvp-helper'].value, '');
  assert.equal(card.parts['.invitation-copy-rsvp-helper'].placeholder, 'Choose the response that works for you.');
  assert.equal(card.parts['.invitation-copy-footer'].value, '');
  assert.equal(card.parts['.invitation-copy-footer'].placeholder, 'Your reply is saved with this invitation. No email is sent from here.');
  assert.equal(card.parts['.publication-status'].textContent, 'Draft');
  const lifecycleStatus = card.parts['.event-status'].children[0];
  assert.equal(lifecycleStatus.textContent, 'Cancelled');
  assert.equal(lifecycleStatus.hidden, false);
  for (const selector of ['.publish', '.add', '.bulk-add', '.export', '.print', '.guest-toggle', '.refresh', '.toggle', '.theme-toggle', '.event-status-panel', '.local-message-panel']) {
    assert.ok(card.parts[selector], `cancelled cards retain the ${selector} control`);
  }
  for (const selector of ['.publish', '.add', '.bulk-add', '.export', '.print', '.guest-toggle', '.refresh', '.toggle', '.theme-toggle']) {
    assert.equal(card.parts[selector].disabled, true, `cancelled ${selector} control is disabled`);
  }
  assert.equal(card.parts['.event-status-form'].elements.status.disabled, false, 'status recovery remains available');
  assert.ok(card.parts['.event-actions'].children.some((control) => control.className === 'edit secondary'), 'cancelled cards retain the edit control');
  assert.equal(card.parts['.publish'].hidden, false);
  assert.match(card.html, /class="event-topbar"/);
  assert.match(card.html, /class="event-heading"/);
  assert.match(card.html, /class="guest-panel"/);
  assert.match(card.html, /class="event-actions"/);
  assert.equal(card.parts['.event-breadcrumb-title'].textContent, 'Sample gathering');
  assert.equal(card.parts['.response-state'].textContent, 'RSVPs open');
  assert.match(card.parts['.stats'].html, /class="stats__grid"/);
  for (const label of ['INVITED UNITS', 'ATTENDING PEOPLE', 'AWAITING REPLY', 'MAYBE', 'DECLINED', 'REVOKED']) {
    assert.match(card.parts['.stats'].html, new RegExp(`<span>${label}</span>`));
  }
  assert.match(card.parts['.stats'].html, /class="capacity-summary"/);
  const emptyState = card.parts['.guest-table'].children[0];
  assert.match(emptyState.children[0].textContent, /No guest units yet.*private RSVP link/i);
  assert.match(emptyState.children[0].textContent, /local outbox; no email is sent/i);
  assert.equal(emptyState.children[1].textContent, 'Add first guest unit');

  card.parts['.event-status-form'].elements.status.value = 'active';
  await card.parts['.event-status-form'].listeners.get('submit')({
    preventDefault() {}, currentTarget: card.parts['.event-status-form']
  });
  card = events.children[0];
  previewCard = card.parts['.invitation-preview'].querySelector('.invitation-card');
  assert.equal(card.classList.contains('event-card--cancelled'), false, 'reactivated card is no longer muted');
  for (const selector of ['.publish', '.add', '.bulk-add', '.export', '.print', '.guest-toggle', '.refresh', '.toggle', '.theme-toggle']) {
    assert.equal(card.parts[selector].disabled, false, `reactivated ${selector} control is enabled`);
  }
  card.parts['.theme-toggle'].listeners.get('click')();
  assert.equal(card.parts['.theme-panel'].hidden, false, 'theme toggle opens the editor');
  assert.equal(card.parts['.theme-panel'].scrolledIntoView, true, 'opened settings are brought into view');
  card.parts['.theme-toggle'].listeners.get('click')();
  assert.equal(card.parts['.theme-panel'].hidden, true, 'event-header action closes the editor');

  const revealMode = card.parts['.invitation-reveal-mode'];
  revealMode.value = 'envelope';
  revealMode.listeners.get('change')();
  const chimeEnabled = card.parts['.invitation-chime-enabled'];
  chimeEnabled.checked = true;
  chimeEnabled.listeners.get('change')();
  const revealMotion = card.parts['.invitation-reveal-motion'];
  revealMotion.value = 'slide-up';
  revealMotion.listeners.get('change')();
  const celebration = card.parts['.invitation-celebration'];
  celebration.value = 'sparkle';
  celebration.listeners.get('change')();
  assert.ok(previewCard.parts['.guest-content'].classList.contains('reveal-motion-slide-up'));
  assert.ok(previewCard.classList.contains('has-celebration'));
  celebration.value = 'leaves';
  celebration.listeners.get('change')();
  assert.ok(previewCard.classList.contains('has-falling-leaves'));
  assert.equal(previewCard.classList.contains('has-celebration'), false);
  assert.equal(previewCard.parts['.guest-content'].hidden, true);
  assert.equal(previewCard.parts['.reveal-envelope'].hidden, false);
  assert.equal(previewCard.parts['.guest-audio-control'].hidden, false);
  assert.equal(card.parts['.preview-reveal-toggle'].hidden, false);
  card.parts['.preview-reveal-toggle'].listeners.get('click')();
  assert.equal(previewCard.parts['.guest-content'].hidden, false, 'host can inspect the opened card');
  assert.equal(previewCard.parts['.reveal-envelope'].hidden, true);
  assert.equal(previewCard.parts['.guest-chime-control'].disabled, true, 'preview cannot play audio');
  card.parts['.preview-reveal-toggle'].listeners.get('click')();
  assert.equal(previewCard.parts['.guest-content'].hidden, true);
  assert.equal(previewCard.parts['.reveal-envelope'].hidden, false);
  await card.parts['.save-invitation-settings'].listeners.get('click')();
  const invitationCall = calls.find((call) => call.url === '/api/events/7/invitation');
  assert.equal(invitationCall.options.method, 'PUT');
  assert.deepEqual(JSON.parse(invitationCall.options.body), {
    revealMode: 'envelope', chimeEnabled: true, revealMotion: 'slide-up', celebration: 'leaves'
  });
  card.parts['.invitation-copy-title'].value = '<A special evening>';
  card.parts['.invitation-copy-title'].listeners.get('input')();
  assert.equal(card.parts['.invitation-copy-title'].value, '<A special evening>');
  assert.equal(card.parts['.invitation-copy-title'].placeholder, '<A special evening>');
  assert.equal(previewCard.parts['#guest-title'].textContent, '<A special evening>');
  assert.equal(card.parts['.invitation-copy-intro'].value, '');
  assert.equal(card.parts['.invitation-copy-intro'].placeholder, 'We’d be delighted if you can join us.');
  assert.equal(previewCard.parts['#guest-greeting'].textContent, 'An invitation for Alex Morgan');
  await card.parts['.save-invitation-copy'].listeners.get('click')();
  const copyCall = calls.find((call) => call.url === '/api/events/7/invitation-copy');
  assert.equal(copyCall.options.method, 'PUT');
  const savedCopy = JSON.parse(copyCall.options.body);
  assert.equal(savedCopy.title, '<A special evening>');
  assert.equal(Object.hasOwn(savedCopy, 'greeting'), false);

  await card.parts['.publish'].listeners.get('click')();

  const publishCall = calls.find((call) => call.url === '/api/events/7/publish');
  assert.ok(publishCall, 'publish endpoint should be called');
  assert.equal(publishCall.options.method, 'POST');
  assert.equal(publishCall.options.body, '{}');
  card = events.children[0];
  assert.equal(card.parts['.publication-status'].textContent, 'Published');
  assert.equal(card.parts['.publish'].hidden, true);
  assert.equal(card.parts['.publish-next-steps'].hidden, false);
  assert.match(card.html, /Published locally — what next\?/);
  assert.match(card.html, /private RSVP link/);
  assert.match(card.html, /local outbox; no email is sent/i);
  await card.parts['.next-steps-add'].listeners.get('click')();
  const guestSlot = card.parts['.guest-form-slot'];
  assert.equal(guestSlot.hidden, false);
  assert.equal(card.guestActionButtons.single.attributes['aria-expanded'], 'true');
  assert.match(card.parts['.guest-form-slot'].html, /Create unit \+ capture invitation/);
  card.guestActionButtons.single.listeners.get('click')();
  assert.equal(guestSlot.hidden, true, 'single invite toggle closes its form');
  card.guestActionButtons.single.listeners.get('click')();
  assert.equal(guestSlot.hidden, false, 'single invite toggle reopens its form');
  let guestForm = card.parts['.guest-form-slot'].parts['.guest-form'];
  assert.equal(guestForm.parts['input[name="name"]'].focused, true);
  guestForm.parts['.guest-composer-close'].listeners.get('click')();
  assert.equal(guestSlot.hidden, true, 'single invite form can be closed');
  await card.parts['.next-steps-add'].listeners.get('click')();
  guestForm = card.parts['.guest-form-slot'].parts['.guest-form'];
  await guestForm.listeners.get('submit')({ preventDefault() {}, currentTarget: guestForm });
  const invitationResult = guestForm.parts['.invite-result'].children[0];
  const singleLinks = invitationResult.children[1];
  assert.match(invitationResult.children[0].textContent, /Invitation created/);
  assert.equal(singleLinks.children[0].textContent, 'View RSVP link');
  assert.notEqual(singleLinks.open, true, 'single invite link starts collapsed');
  const singleLink = singleLinks.children[1].children[0].children[1];
  assert.equal(singleLink.href, 'http://localhost/rsvp/synthetic-private-token');
  assert.equal(singleLink.textContent, 'Open link');
  await card.parts['.next-steps-outbox'].listeners.get('click')();
  assert.equal(getElement('#outbox').hidden, false);
  assert.ok(calls.some((call) => call.url === '/api/outbox'));
  assert.equal(calls.filter((call) => call.url === '/api/events').length, 3);

  const bulkButton = card.guestActionButtons.bulk;
  assert.ok(bulkButton, 'host can open the bulk invite form');
  bulkButton.listeners.get('click')();
  assert.equal(guestSlot.hidden, false, 'bulk invite opens the shared composer');
  assert.equal(card.guestActionButtons.bulk.attributes['aria-expanded'], 'true');
  assert.equal(card.guestActionButtons.single.attributes['aria-expanded'], 'false');
  const bulkForm = card.parts['.guest-form-slot'].parts['.bulk-guest-form'];
  bulkButton.listeners.get('click')();
  assert.equal(guestSlot.hidden, true, 'bulk invite toggle closes its form');
  bulkButton.listeners.get('click')();
  assert.equal(guestSlot.hidden, false, 'bulk invite toggle reopens its form');
  const reopenedBulkFormFromToggle = card.parts['.guest-form-slot'].parts['.bulk-guest-form'];
  assert.notEqual(reopenedBulkFormFromToggle, bulkForm);
  const activeFormForClose = reopenedBulkFormFromToggle;
  activeFormForClose.parts['.guest-composer-close'].listeners.get('click')();
  assert.equal(guestSlot.hidden, true, 'bulk invite form can be closed');
  bulkButton.listeners.get('click')();
  const activeBulkForm = card.parts['.guest-form-slot'].parts['.bulk-guest-form'];
  assert.notEqual(activeBulkForm, activeFormForClose, 'reopening prepares a fresh bulk form');
  const bulkRows = activeBulkForm.parts['.bulk-guest-rows'];
  const bulkReview = activeBulkForm.parts['.bulk-review'];
  const bulkPreview = activeBulkForm.parts['.bulk-preview'];
  const bulkResult = activeBulkForm.parts['.bulk-result'];
  const bulkSubmit = activeBulkForm.parts['.bulk-create'];
  bulkRows.value = 'Invalid Household\tperson@gmail.com\t3';
  bulkReview.listeners.get('click')();
  assert.equal(bulkSubmit.disabled, true, 'invalid rows cannot be submitted');
  assert.match(bulkPreview.children[0].textContent, /reserved test domain/);
  bulkRows.value = 'North Household\tnorth@example.test\t3\nSouth Household\tsouth@example.test\t4';
  bulkReview.listeners.get('click')();
  assert.equal(bulkSubmit.disabled, false);
  assert.equal(bulkPreview.children.length, 2);
  await activeBulkForm.listeners.get('submit')({ preventDefault() {}, currentTarget: activeBulkForm });
  const bulkCall = calls.find((call) => call.url === '/api/events/7/guests/bulk');
  assert.deepEqual(JSON.parse(bulkCall.options.body), {
    guests: [
      { name: 'North Household', email: 'north@example.test', partyLimit: 3 },
      { name: 'South Household', email: 'south@example.test', partyLimit: 4 }
    ]
  });
  const bulkCollection = bulkResult.children[0];
  const bulkLinks = bulkCollection.children[1];
  assert.match(bulkCollection.children[0].textContent, /2 invitations created/);
  assert.equal(bulkLinks.children[0].textContent, 'View 2 RSVP links');
  assert.notEqual(bulkLinks.open, true, 'bulk invite links start collapsed');
  assert.equal(bulkLinks.children[1].children.length, 2, 'every guest receives a retained private link');
  assert.ok(bulkLinks.children[1].children.every((item) => item.children[1].href.startsWith('http://localhost/rsvp/')));
  const firstGuestRow = card.parts['.guest-table'].children[0].parts.tbody.children[0];
  const actionCell = firstGuestRow.children[5];
  assert.equal(actionCell.children.length, 1, 'active actions share one action group');
  assert.equal(actionCell.children[0].className, 'guest-table__action-group');
  assert.equal(firstGuestRow.children[2].children[0].className, 'guest-table__value');
  assert.equal(firstGuestRow.children[4].getAttribute('data-label'), 'Attendees');
  assert.equal(actionCell.getAttribute('data-label'), 'Action');
  const retainedLink = actionCell.children[0];
  const linkButton = retainedLink.children[0];
  await linkButton.listeners.get('click')();
  assert.equal(copiedInviteLink, 'http://localhost/rsvp/synthetic-bulk-token-1');
  assert.equal(linkButton.textContent, 'Link');
  assert.equal(retainedLink.children.length, 2, 'link button and revoke action remain compact');
  assert.equal(getElement('#invite-link-toast').textContent, 'North Household\'s invitation link copied.');
  assert.equal(actionCell.children.some((element) => element.tagName === 'a'), false, 'the URL is not shown in the guest list');
  await retainedLink.children[1].listeners.get('click')();
  for (let attempt = 0; attempt < 20 && card.parts['.guest-table'].children[0].parts.tbody.children[0] === firstGuestRow; attempt += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
  const revokedActionCell = card.parts['.guest-table'].children[0].parts.tbody.children[0].children[5];
  assert.equal(revokedActionCell.children.length, 1, 'revoked rows keep a single status element');
  assert.equal(revokedActionCell.children[0].className, 'guest-table__revoked-state');
  assert.equal(revokedActionCell.children[0].textContent, 'Revoked');
  assert.equal(revokedActionCell.querySelector('.guest-table__action-group'), undefined, 'revoked rows have no action group');
});

test('guest invitation starts configured music on open and offers retry only when blocked', async () => {
  const source = fs.readFileSync(path.join(__dirname, '../public/app.js'), 'utf8');
  async function loadGuest(revealMode, blockedInitially = false) {
    let blocked = blockedInitially;
    const elements = new Map();
    const getElement = (selector) => {
      if (!elements.has(selector)) elements.set(selector, new FakeElement());
      return elements.get(selector);
    };
    getElement('#guest').parts = {
      '.reveal-envelope': getElement('#guest-envelope'),
      '.guest-content': getElement('#guest-content'),
      '.guest-audio-control': getElement('.guest-audio-control'),
      '.guest-chime-control': getElement('#guest-chime'),
      '.guest-audio-status': getElement('#guest-audio-status')
    };
    getElement('#rsvp-form').elements = {
      answer: Object.assign(new FakeElement(), { value: '' }),
      partySize: Object.assign(new FakeElement(), { value: '' })
    };
    let audioContexts = 0;
    let oscillatorStarts = 0;
    class TestAudioContext {
      constructor() {
        audioContexts += 1;
        this.currentTime = 0;
        this.destination = {};
        this.state = 'suspended';
      }
      async resume() {
        if (blocked && revealMode === 'direct') return new Promise(() => {});
        if (blocked) throw new Error('Playback blocked');
        this.state = 'running';
      }
      createOscillator() {
        return {
          type: '',
          frequency: { setValueAtTime() {} },
          connect() {}, start() { oscillatorStarts += 1; }, stop() {}
        };
      }
      createGain() {
        return {
          gain: { setValueAtTime() {}, exponentialRampToValueAtTime() {} },
          connect() {}
        };
      }
      async close() {}
    }
    const fetch = async () => ({
      ok: true,
      json: async () => ({
        canRespond: true,
        event: {
          title: 'A garden gathering', eventDate: '2035-06-15',
          invitationSettings: {
            revealMode, chimeEnabled: true, revealMotion: 'slide-up', celebration: 'leaves'
          }
        },
        guest: { name: 'Sample Guest', partyLimit: 1 }
      })
    });
    vm.runInNewContext(source, {
      document: { querySelector: getElement, createElement: () => new FakeElement() },
      location: { pathname: '/rsvp/synthetic-token', origin: 'http://localhost' },
      fetch, FormData: class {}, console,
      window: {
        AudioContext: TestAudioContext,
        setTimeout: (callback, delay) => {
          if (delay !== 800 || (blocked && revealMode === 'direct')) callback();
          return 1;
        },
        clearTimeout() {},
        setInterval: () => 1,
        clearInterval() {}
      }
    });
    for (let attempt = 0; attempt < 20 &&
        getElement('#guest-title').textContent !== 'A garden gathering'; attempt += 1) {
      await new Promise((resolve) => setImmediate(resolve));
    }
    return {
      getElement,
      get audioContexts() { return audioContexts; },
      get oscillatorStarts() { return oscillatorStarts; },
      setBlocked(value) { blocked = value; }
    };
  }

  const guest = await loadGuest('envelope');
  assert.ok(guest.getElement('#guest-content').classList.contains('reveal-motion-slide-up'));
  assert.ok(guest.getElement('#guest').classList.contains('has-falling-leaves'));
  assert.equal(guest.getElement('#guest-envelope').hidden, false);
  assert.equal(guest.getElement('#guest-content').hidden, true);
  assert.equal(guest.audioContexts, 1, 'envelope invitations attempt music as they load');
  await guest.getElement('#guest-envelope').listeners.get('click')();
  assert.equal(guest.getElement('#guest-envelope').hidden, true);
  assert.equal(guest.getElement('#guest-content').hidden, false);
  assert.equal(guest.getElement('#guest-title').focused, true);
  assert.equal(guest.oscillatorStarts, 3, 'the opening gesture starts the music chord');
  assert.equal(guest.getElement('.guest-audio-control').hidden, true);
  assert.match(guest.getElement('#guest-audio-status').textContent, /background music is playing/i);

  const blockedGuest = await loadGuest('envelope', true);
  blockedGuest.setBlocked(false);
  blockedGuest.getElement('#guest').listeners.get('pointerdown')();
  await blockedGuest.getElement('#guest-envelope').listeners.get('click')();
  assert.equal(blockedGuest.getElement('.guest-audio-control').hidden, true, 'first invitation interaction starts previously blocked music');
  assert.equal(blockedGuest.audioContexts, 2, 'pointerdown and the following click share one retry');
  assert.equal(blockedGuest.oscillatorStarts, 3);
  assert.match(blockedGuest.getElement('#guest-audio-status').textContent, /background music is playing/i);

  const directGuest = await loadGuest('direct');
  assert.equal(directGuest.audioContexts, 1, 'direct invitations attempt music as they load');
  assert.equal(directGuest.oscillatorStarts, 3);

  const blockedDirectGuest = await loadGuest('direct', true);
  assert.equal(blockedDirectGuest.getElement('.guest-audio-control').hidden, false);
  assert.equal(blockedDirectGuest.getElement('#guest-chime').hidden, false);
  blockedDirectGuest.setBlocked(false);
  blockedDirectGuest.getElement('#guest-chime').listeners.get('click')();
  for (let attempt = 0; attempt < 20 && !blockedDirectGuest.getElement('.guest-audio-control').hidden; attempt += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.equal(blockedDirectGuest.getElement('.guest-audio-control').hidden, true, 'manual retry hides the control after starting music');
  assert.equal(blockedDirectGuest.oscillatorStarts, 3, 'manual retry starts the music chord');
});

test('invalid or revoked guest links hide the RSVP form', async () => {
  const elements = new Map();
  const document = {
    querySelector(selector) {
      if (!elements.has(selector)) elements.set(selector, new FakeElement());
      return elements.get(selector);
    },
    createElement: () => new FakeElement()
  };
  const fetch = async () => ({
    ok: false,
    json: async () => ({ error: 'This invitation link is invalid or has been revoked.' })
  });

  const source = fs.readFileSync(path.join(__dirname, '../public/app.js'), 'utf8');
  vm.runInNewContext(source, {
    document,
    location: { pathname: '/rsvp/synthetic-token', origin: 'http://localhost' },
    fetch,
    FormData: class {},
    console
  });
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(document.querySelector('#guest-title').textContent, 'Invitation unavailable');
  assert.equal(document.querySelector('#guest-envelope').hidden, true);
  assert.equal(document.querySelector('#guest-content').hidden, false);
  assert.equal(document.querySelector('#rsvp-form').hidden, true);
  assert.match(document.querySelector('#guest-details').textContent, /revoked/);
  assert.equal(document.querySelector('#guest-unavailable').hidden, false);
});

test('guest RSVP renders API details and persists selected answer and party size for updates', async () => {
  const source = fs.readFileSync(path.join(__dirname, '../public/app.js'), 'utf8');
  const elements = new Map();
  const getElement = (selector) => {
    if (!elements.has(selector)) elements.set(selector, new FakeElement());
    return elements.get(selector);
  };
  const form = getElement('#rsvp-form');
  const responseOptions = getElement('#guest-response-options');
  form.elements = {
    answer: Object.assign(new FakeElement(), { value: '' }),
    partySize: Object.assign(new FakeElement(), { value: '' })
  };
  const calls = [];
  const fetch = async (url, options = {}) => {
    calls.push({ url, options });
    if (url === '/api/guest/synthetic-token') {
      return {
        ok: true,
        json: async () => ({
          canRespond: true,
          event: {
            title: 'A garden gathering', eventDate: '2035-06-15',
            location: 'Sample Park', rsvpDeadline: '2035-06-01T12:30:00.000Z',
            invitationCopy: { greeting: 'Legacy custom greeting' },
            theme: {
              preset: 'garden', primaryColor: '#466b4d',
              backgroundColor: '#f4f6ed', textColor: '#26352a',
              fontFamily: 'serif', coverImage: null
            }
          },
          guest: { name: 'Sample Household', partyLimit: 4, answer: 'yes', partySize: 2 }
        })
      };
    }
    if (url === '/api/guest/synthetic-token/rsvp' && options.method === 'PUT') {
      return { ok: true, json: async () => ({ ok: true }) };
    }
    throw new Error(`Unexpected request: ${url}`);
  };
  class GuestFormData {
    constructor(target) { this.target = target; }
    entries() {
      return [
        ['answer', this.target.elements.answer.value],
        ['partySize', this.target.elements.partySize.value]
      ];
    }
  }

  vm.runInNewContext(source, {
    document: { querySelector: getElement, createElement: () => new FakeElement() },
    location: { pathname: '/rsvp/synthetic-token', origin: 'http://localhost' },
    fetch, FormData: GuestFormData, console
  });
  for (let attempt = 0; attempt < 20 &&
      getElement('#guest-title').textContent !== 'A garden gathering'; attempt += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.equal(getElement('#guest-title').textContent, 'A garden gathering');

  assert.equal(getElement('#site-header').hidden, true);
  assert.equal(getElement('#development-warning').hidden, true);
  assert.equal(getElement('#guest-greeting').textContent, 'An invitation for Sample Household');
  assert.match(getElement('#guest-date').textContent, /June 15, 2035/);
  assert.equal(getElement('#guest-location').textContent, 'Sample Park');
  assert.match(getElement('#guest-deadline').textContent, /June 1, 2035/);
  assert.match(getElement('#guest-capacity').textContent, /up to 4 people/);
  assert.equal(form.elements.answer.value, 'yes');
  assert.equal(form.elements.partySize.value, 2);

  form.elements.answer.value = 'no';
  await responseOptions.listeners.get('change')();
  assert.equal(form.elements.partySize.value, '0');
  assert.equal(form.elements.partySize.disabled, true);
  await form.listeners.get('submit')({ preventDefault() {}, currentTarget: form });
  const firstSave = calls.find((call) => call.options.method === 'PUT');
  assert.deepEqual(JSON.parse(firstSave.options.body), { answer: 'no', partySize: 0, attendees: [] });
  assert.equal(form.hidden, true);
  assert.equal(getElement('#rsvp-confirmation').hidden, false);
  assert.match(getElement('#rsvp-confirmation-copy').textContent, /saved/);

  getElement('#edit-rsvp').listeners.get('click')();
  assert.equal(form.hidden, false);
  assert.equal(getElement('#rsvp-confirmation').hidden, true);
  form.elements.answer.value = 'yes';
  await responseOptions.listeners.get('change')();
  form.elements.partySize.value = '3';
  await form.listeners.get('submit')({ preventDefault() {}, currentTarget: form });
  const saves = calls.filter((call) => call.options.method === 'PUT');
  assert.equal(saves.length, 2);
  assert.deepEqual(JSON.parse(saves[1].options.body), { answer: 'yes', partySize: 3, attendees: [] });
  assert.equal(form.hidden, true);
  assert.equal(getElement('#edit-rsvp').hidden, false);
});

test('closed invitations show any saved reply without offering another submission', async () => {
  const source = fs.readFileSync(path.join(__dirname, '../public/app.js'), 'utf8');
  const elements = new Map();
  const getElement = (selector) => {
    if (!elements.has(selector)) elements.set(selector, new FakeElement());
    return elements.get(selector);
  };
  getElement('#rsvp-form').elements = {
    answer: Object.assign(new FakeElement(), { value: '' }),
    partySize: Object.assign(new FakeElement(), { value: '' })
  };
  const fetch = async () => ({
    ok: true,
    json: async () => ({
      canRespond: false,
      event: { title: 'Sample gathering', eventDate: '2035-06-15', location: '' },
      guest: { name: 'Sample Guest', partyLimit: 1, answer: 'yes', partySize: 1 }
    })
  });
  vm.runInNewContext(source, {
    document: { querySelector: getElement, createElement: () => new FakeElement() },
    location: { pathname: '/rsvp/synthetic-token', origin: 'http://localhost' },
    fetch, FormData: class {}, console
  });
  for (let attempt = 0; attempt < 20 &&
      getElement('#guest-title').textContent !== 'Sample gathering'; attempt += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }

  assert.equal(getElement('#guest-closed').hidden, false);
  assert.match(getElement('#guest-closed').textContent, /RSVPs are closed/);
  assert.equal(getElement('#rsvp-form').hidden, true);
  assert.equal(getElement('#rsvp-confirmation').hidden, false);
  assert.equal(getElement('#edit-rsvp').hidden, true);
  assert.match(getElement('#guest-capacity').textContent, /up to 1 person/);
});
