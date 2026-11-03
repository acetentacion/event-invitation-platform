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
    this.style = { setProperty() {} };
    this.attributes = {};
    this.classList = {
      add: (value) => { this.className = `${this.className} ${value}`.trim(); },
      contains: (value) => this.className.split(/\s+/).includes(value)
    };
  }

  addEventListener(name, callback) {
    this.listeners.set(name, callback);
  }

  querySelector(selector) {
    return this.parts && this.parts[selector];
  }

  querySelectorAll() { return []; }

  cloneNode() {
    const clone = new FakeElement();
    clone.className = 'invitation-card';
    clone.parts = {};
    for (const selector of [
      '#guest-greeting', '#guest-title', '#guest-details', '#guest-date',
      '#guest-location-row', '#guest-location', '#guest-deadline-row', '#guest-deadline',
      '#guest-capacity', '.invitation-footnote', '.invitation-cover',
      '.reveal-envelope', '.guest-content', '.guest-audio-control',
      '.guest-chime-control', '.guest-audio-status'
    ]) clone.parts[selector] = new FakeElement();
    return clone;
  }

  append(...elements) {
    this.children.push(...elements);
  }

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
  removeAttribute(name) { delete this.attributes[name]; }

  set innerHTML(value) {
    this.html = value;
    if (this.className === 'guest-form-slot') {
      const form = new FakeElement();
      const inviteResult = new FakeElement();
      this.parts = { '.guest-form': form, '.invite-result': inviteResult };
      form.parts = {
        'input[name="name"]': new FakeElement(),
        '.invite-result': inviteResult
      };
      return;
    }
    if (this.className !== 'card event-card') return;
    this.parts = {};
    for (const selector of [
      'h2', '.event-breadcrumb-title', '.response-state', '.publication-status',
      '.event-meta', '.stats', '.publish',
      '.add', '.toggle', '.refresh', '.guest-form-slot', '.guest-table',
      '.publish-next-steps', '.next-steps-add', '.next-steps-outbox',
      '.theme-toggle', '.theme-panel', '.theme-preset', '.theme-primary',
      '.theme-background', '.theme-text', '.theme-font', '.theme-image',
      '.invitation-preview', '.theme-status', '.save-theme',
      '.remove-cover', '.contrast-warning', '.invitation-reveal-mode',
      '.invitation-chime-enabled', '.save-invitation-settings',
      '.invitation-settings-status', '.invitation-settings-title',
      '.invitation-settings', '.preview-reveal-toggle'
    ]) {
      this.parts[selector] = new FakeElement();
      if (selector.startsWith('.')) this.parts[selector].className = selector.slice(1);
    }
    this.parts['.theme-panel'].hidden = true;
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
    createElement: () => new FakeElement()
  };
  getElement('#guest').className = 'invitation-card';
  getElement('#outbox').hidden = true;
  const calls = [];
  let published = false;
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
          invitationSettings: { revealMode: 'direct', chimeEnabled: false },
          published,
          responsesOpen: true
        }]
      };
    } else if (url === '/api/events/7/dashboard') {
      data = { guests: [] };
    } else if (url === '/api/outbox') {
      data = { messages: [] };
    } else if (url === '/api/events/7/guests' && options.method === 'POST') {
      data = { guest: { id: 8 }, inviteUrl: '/rsvp/synthetic-private-token' };
    } else if (url === '/api/events/7/publish' && options.method === 'POST') {
      published = true;
      data = { event: { id: 7, published: true } };
    } else if (url === '/api/events/7/invitation' && options.method === 'PUT') {
      data = { invitationSettings: JSON.parse(options.body) };
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
    FormData: class { entries() { return []; } },
    console
  });

  const events = getElement('#events');
  for (let attempt = 0; attempt < 20 && events.children.length === 0; attempt += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
  let card = events.children[0];
  const previewCard = card.parts['.invitation-preview'].querySelector('.invitation-card');
  assert.equal(previewCard.parts['#guest-capacity'].textContent, 'You can include up to 4 people in your reply.');
  assert.equal(previewCard.parts['.guest-content'].hidden, false);
  assert.equal(previewCard.parts['.reveal-envelope'].hidden, true);
  assert.equal(card.parts['.preview-reveal-toggle'].hidden, true);
  assert.equal(card.parts['.invitation-reveal-mode'].value, 'direct');
  assert.equal(card.parts['.invitation-chime-enabled'].checked, false);
  assert.equal(card.parts['.publication-status'].textContent, 'Draft');
  assert.equal(card.parts['.publish'].hidden, false);
  assert.match(card.html, /class="event-topbar"/);
  assert.match(card.html, /class="event-heading"/);
  assert.match(card.html, /class="guest-panel"/);
  assert.match(card.html, /class="event-actions"/);
  assert.equal(card.parts['.event-breadcrumb-title'].textContent, 'Sample gathering');
  assert.equal(card.parts['.response-state'].textContent, 'RSVPs open');
  assert.match(card.parts['.stats'].html, /INVITED UNITS/);
  assert.match(card.parts['.stats'].html, /ATTENDING PEOPLE/);
  assert.match(card.parts['.stats'].html, /AWAITING REPLY/);
  assert.match(card.parts['.stats'].html, /NOT SURE YET/);
  assert.match(card.parts['.stats'].html, /DECLINED/);
  const emptyState = card.parts['.guest-table'].children[0];
  assert.match(emptyState.children[0].textContent, /No guest units yet.*private RSVP link/i);
  assert.match(emptyState.children[0].textContent, /local outbox; no email is sent/i);
  assert.equal(emptyState.children[1].textContent, 'Add first guest unit');

  const revealMode = card.parts['.invitation-reveal-mode'];
  revealMode.value = 'envelope';
  revealMode.listeners.get('change')();
  const chimeEnabled = card.parts['.invitation-chime-enabled'];
  chimeEnabled.checked = true;
  chimeEnabled.listeners.get('change')();
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
    revealMode: 'envelope', chimeEnabled: true
  });

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
  assert.match(card.parts['.guest-form-slot'].html, /Create unit \+ capture invitation/);
  const guestForm = card.parts['.guest-form-slot'].parts['.guest-form'];
  assert.equal(guestForm.parts['input[name="name"]'].focused, true);
  await guestForm.listeners.get('submit')({ preventDefault() {}, currentTarget: guestForm });
  const invitationResult = guestForm.parts['.invite-result'].children[0];
  assert.equal(invitationResult.children[1].href, '/rsvp/synthetic-private-token');
  assert.match(invitationResult.children[1].textContent, /http:\/\/localhost\/rsvp\/synthetic-private-token/);
  await card.parts['.next-steps-outbox'].listeners.get('click')();
  assert.equal(getElement('#outbox').hidden, false);
  assert.ok(calls.some((call) => call.url === '/api/outbox'));
  assert.equal(calls.filter((call) => call.url === '/api/events').length, 2);
});

test('envelope guest flow reveals on activation and only plays chime on explicit activation', async () => {
  const source = fs.readFileSync(path.join(__dirname, '../public/app.js'), 'utf8');
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
  const audioContext = {
    currentTime: 0,
    destination: {},
    resume: async () => {},
    createOscillator: () => ({
      type: '',
      frequency: { setValueAtTime() {} },
      connect() {}, start() {}, stop() {}
    }),
    createGain: () => ({
      gain: { setValueAtTime() {}, exponentialRampToValueAtTime() {} },
      connect() {}
    }),
    close: async () => {}
  };
  class TestAudioContext {
    constructor() { audioContexts += 1; return audioContext; }
  }
  const fetch = async () => ({
    ok: true,
    json: async () => ({
      canRespond: true,
      event: {
        title: 'A garden gathering', eventDate: '2035-06-15',
        invitationSettings: { revealMode: 'envelope', chimeEnabled: true }
      },
      guest: { name: 'Sample Guest', partyLimit: 1 }
    })
  });
  vm.runInNewContext(source, {
    document: { querySelector: getElement, createElement: () => new FakeElement() },
    location: { pathname: '/rsvp/synthetic-token', origin: 'http://localhost' },
    fetch, FormData: class {}, console,
    window: { AudioContext: TestAudioContext, setTimeout: (callback) => callback() }
  });
  for (let attempt = 0; attempt < 20 &&
      getElement('#guest-title').textContent !== 'A garden gathering'; attempt += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }

  assert.equal(getElement('#guest-envelope').hidden, false);
  assert.equal(getElement('#guest-content').hidden, true);
  assert.equal(getElement('#guest-chime').hidden, false);
  assert.equal(audioContexts, 0, 'loading the invitation must not create or play audio');
  getElement('#guest-envelope').listeners.get('click')();
  assert.equal(getElement('#guest-envelope').hidden, true);
  assert.equal(getElement('#guest-content').hidden, false);
  assert.equal(getElement('#guest-title').focused, true);
  await getElement('#guest-chime').listeners.get('click')({ currentTarget: getElement('#guest-chime') });
  assert.equal(audioContexts, 1);
  assert.match(getElement('#guest-audio-status').textContent, /gentle chime is playing/i);
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
  assert.deepEqual(JSON.parse(firstSave.options.body), { answer: 'no', partySize: 0 });
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
  assert.deepEqual(JSON.parse(saves[1].options.body), { answer: 'yes', partySize: 3 });
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
