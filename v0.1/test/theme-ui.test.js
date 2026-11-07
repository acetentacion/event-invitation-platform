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
    this.styleValues = {};
    this.style = {
      setProperty: (name, value) => { this.styleValues[name] = value; }
    };
    this.hidden = false;
    this.disabled = false;
    this.textContent = '';
    this.className = '';
    this.dataset = {};
    this.attributes = {};
    this.classList = {
      contains: (value) => this.className.split(/\s+/).includes(value),
      add: (value) => {
        if (!this.classList.contains(value)) this.className = `${this.className} ${value}`.trim();
      },
      remove: (...values) => {
        this.className = this.className.split(/\s+/).filter((name) => !values.includes(name)).join(' ');
      }
    };
  }

  addEventListener(name, callback) { this.listeners.set(name, callback); }
  querySelector(selector) { return this.parts && this.parts[selector]; }
  append(...elements) {
    this.children.push(...elements);
    for (const element of elements) {
      if (element && element.className === 'invitation-card') this.parts = { '.invitation-card': element };
    }
  }
  after(...elements) { this.afterElements = elements; }
  replaceChildren(...elements) {
    this.children = elements;
    this.parts = {};
    for (const element of elements) {
      if (element && element.className === 'invitation-card') this.parts['.invitation-card'] = element;
    }
  }
  setAttribute(name, value) { this.attributes[name] = value; }
  removeAttribute(name) { delete this.attributes[name]; }
  querySelectorAll(selector) {
    if (!this.parts) return [];
    if (selector === '[id]') return Object.entries(this.parts)
      .filter(([name]) => name.startsWith('#')).map(([, element]) => element);
    if (selector === '[aria-labelledby], [aria-describedby]') return [];
    if (selector === 'input, button, select, textarea') return this.parts.controls || [];
    return [];
  }
  cloneNode() {
    const clone = new FakeElement();
    clone.className = 'invitation-card';
    clone.parts = {};
    for (const selector of [
      '#guest-greeting', '#guest-title', '#guest-details', '#guest-date',
      '#guest-rsvp-title', '#guest-rsvp-helper',
      '#guest-location-row', '#guest-location', '#guest-deadline-row', '#guest-deadline',
      '#guest-capacity', '.invitation-footnote', '.invitation-cover', '.preview-image',
      '.preview-title', '.invitation-paper', '.reveal-envelope', '.guest-content',
      '.guest-audio-control', '.guest-chime-control', '.guest-audio-status'
    ]) clone.parts[selector] = new FakeElement();
    clone.parts['.preview-title'] = clone.parts['#guest-title'];
    clone.parts['.preview-image'] = clone.parts['.invitation-cover'];
    clone.parts['.invitation-cover'].removeAttribute = function (name) { delete this.attributes[name]; };
    clone.parts.controls = [new FakeElementInput(), new FakeElement()];
    clone.querySelectorAll = FakeElement.prototype.querySelectorAll;
    return clone;
  }

  set innerHTML(value) {
    this.html = value;
    if (!this.className.split(/\s+/).includes('event-card')) return;
    this.parts = {};
    for (const selector of [
      'h2', '.event-breadcrumb-title', '.event-status', '.response-state', '.publication-status',
      '.event-meta', '.stats', '.event-actions', '.publish',
      '.add', '.toggle', '.refresh', '.export', '.print', '.guest-form-slot', '.guest-table', '.print-view',
      '.publish-next-steps', '.next-steps-add', '.next-steps-outbox',
      '.theme-toggle', '.theme-panel', '.theme-preset', '.theme-primary',
      '.theme-background', '.theme-text', '.theme-font', '.theme-image',
      '.invitation-preview', '.theme-status', '.save-theme',
      '.remove-cover', '.contrast-warning', '.preview-reveal-toggle', '.invitation-reveal-mode',
      '.invitation-reveal-motion', '.invitation-celebration',
      '.invitation-chime-enabled', '.save-invitation-settings',
      '.invitation-settings-status', '.invitation-settings-title',
      '.invitation-settings', '.invitation-copy-greeting', '.invitation-copy-title',
      '.invitation-copy-intro', '.invitation-copy-rsvp-heading', '.invitation-copy-rsvp-helper',
      '.invitation-copy-footer', '.save-invitation-copy', '.invitation-copy-status',
      '.invitation-copy-title-heading', '.invitation-copy-editor'
    ]) this.parts[selector] = new FakeElement();
    this.parts['.theme-panel'].hidden = true;
  }
}

class FakeElementInput extends FakeElement {
  constructor() {
    super();
    this.value = '';
    this.files = [];
  }
  setCustomValidity(message) { this.validationMessage = message; }
}

const source = fs.readFileSync(path.join(__dirname, '../public/app.js'), 'utf8');
const markup = fs.readFileSync(path.join(__dirname, '../public/index.html'), 'utf8');

test('theme preview clones the guest invitation card structure', () => {
  assert.match(source, /const invitation = \$\('#guest'\)\.cloneNode\(true\)/);
  for (const className of [
    'invitation-brand', 'invitation-paper', 'invitation-botanical',
    'invitation-copy', 'invitation-details', 'invitation-rsvp', 'rsvp-choices'
  ]) {
    assert.match(markup, new RegExp(`class="[^"]*\\b${className}\\b`));
  }
});

function waitFor(predicate) {
  return new Promise((resolve, reject) => {
    let attempts = 0;
    const check = () => {
      if (predicate()) return resolve();
      if (++attempts > 30) return reject(new Error('UI did not finish loading'));
      setImmediate(check);
    };
    check();
  });
}

test('host theme editor previews preset changes and saves the full theme object', async () => {
  const elements = new Map();
  const getElement = (selector) => {
    if (!elements.has(selector)) elements.set(selector, new FakeElement());
    return elements.get(selector);
  };
  const document = { querySelector: getElement, createElement: () => new FakeElement() };
  getElement('#guest').className = 'invitation-card';
  const calls = [];
  class FileReaderStub {
    constructor() {
      this.result = 'data:image/png;base64,aGVsbG8=';
      this.listeners = new Map();
    }
    addEventListener(name, callback) { this.listeners.set(name, callback); }
    readAsDataURL() { this.listeners.get('load')(); }
  }
  const fetch = async (url, options = {}) => {
    calls.push({ url, options });
    let data;
    if (url === '/api/status') data = { host: { id: 1 } };
    else if (url === '/api/events') data = { events: [{
      id: 42, title: 'Garden party', eventDate: '2035-06-15', guestMode: 'individual',
      location: 'Sample Park', rsvpDeadline: '2035-06-01T18:30:00.000Z',
      responsesOpen: true, theme: {
        preset: 'classic', primaryColor: '#315a4c', backgroundColor: '#f8f6f1',
        textColor: '#262b2c', fontFamily: 'serif', coverImage: null
      }
    }] };
    else if (url === '/api/events/42/dashboard') data = { guests: [] };
    else if (url === '/api/events/42/theme' && options.method === 'PUT') data = { ok: true };
    else throw new Error(`Unexpected request: ${url}`);
    return { ok: true, json: async () => data };
  };

  vm.runInNewContext(source, {
    document, location: { pathname: '/', origin: 'http://localhost' },
    fetch, FormData: class {}, FileReader: FileReaderStub, console
  });
  await waitFor(() => getElement('#events').children.length === 1);
  const card = getElement('#events').children[0];
  const parts = card.parts;

  parts['.theme-toggle'].listeners.get('click')();
  assert.equal(parts['.theme-panel'].hidden, false);
  const invitation = parts['.invitation-preview'].querySelector('.invitation-card');
  assert.ok(invitation, 'preview mounts a clone of the guest invitation card');
  assert.equal(invitation.className, 'invitation-card');
  assert.equal(invitation.parts['#guest-title'].textContent, 'Garden party');
  assert.equal(invitation.parts['#guest-greeting'].textContent, 'An invitation for Alex Morgan');
  assert.notEqual(invitation.parts['#guest-date'].textContent, '2035-06-15');
  assert.equal(invitation.parts['#guest-location'].textContent, 'Sample Park');
  assert.equal(invitation.parts['#guest-location-row'].hidden, false);
  assert.equal(invitation.parts['#guest-deadline-row'].hidden, false);
  assert.equal(invitation.parts['#guest-capacity'].textContent, 'You can include up to 1 person in your reply.');
  assert.equal(invitation.parts.controls[0].disabled, true, 'preview controls are non-interactive');
  assert.match(card.html, /Draft preview only.*preview controls are intentionally inactive/);
  parts['.theme-preset'].value = 'garden';
  parts['.theme-preset'].listeners.get('change')();
  assert.equal(parts['.theme-primary'].value, '#466b4d');
  assert.equal(invitation.styleValues['--invite-background'], '#f4f6ed');
  assert.equal(invitation.styleValues['--invite-font'], 'Georgia, "Times New Roman", serif');
  assert.equal(invitation.parts['.preview-title'].textContent, 'Garden party');
  parts['.theme-font'].value = 'sans';
  parts['.theme-font'].listeners.get('change')();
  assert.equal(invitation.styleValues['--invite-font'], 'system-ui, -apple-system, "Segoe UI", sans-serif');
  parts['.theme-font'].value = 'serif';
  parts['.theme-font'].listeners.get('change')();
  parts['.theme-background'].value = '#ffffff';
  parts['.theme-background'].listeners.get('input')();
  parts['.theme-text'].value = '#ffffff';
  parts['.theme-text'].listeners.get('input')();
  assert.equal(parts['.save-theme'].disabled, true);
  assert.equal(parts['.contrast-warning'].hidden, false);
  assert.match(parts['.contrast-warning'].textContent, /WCAG AA requires at least 4\.5:1/);
  await parts['.save-theme'].listeners.get('click')();
  assert.equal(calls.some((call) => call.url === '/api/events/42/theme'), false);
  parts['.theme-text'].value = '#000000';
  parts['.theme-text'].listeners.get('input')();
  assert.equal(parts['.save-theme'].disabled, false);
  assert.equal(parts['.contrast-warning'].hidden, true);
  parts['.theme-primary'].value = '#fefefe';
  parts['.theme-primary'].listeners.get('input')();
  assert.equal(parts['.theme-preset'].value, 'custom');
  assert.equal(invitation.styleValues['--invite-primary'], '#fefefe');
  parts['.theme-image'].files = [{ type: 'image/gif', size: 12 }];
  await parts['.theme-image'].listeners.get('change')();
  assert.match(parts['.theme-status'].textContent, /PNG, JPEG, or WebP/);
  parts['.theme-image'].files = [{ type: 'image/png', size: 1024 * 1024 + 1 }];
  await parts['.theme-image'].listeners.get('change')();
  assert.match(parts['.theme-status'].textContent, /1 MiB or smaller/);
  parts['.theme-image'].files = [{ type: 'image/png', size: 5 }];
  await parts['.theme-image'].listeners.get('change')();
  assert.equal(invitation.parts['.invitation-cover'].src, 'data:image/png;base64,aGVsbG8=');

  await parts['.save-theme'].listeners.get('click')();
  const save = calls.find((call) => call.url === '/api/events/42/theme');
  assert.ok(save);
  assert.equal(save.options.method, 'PUT');
  assert.deepEqual(JSON.parse(save.options.body), {
    preset: 'custom', primaryColor: '#fefefe', backgroundColor: '#ffffff',
    textColor: '#000000', fontFamily: 'serif', coverImage: 'data:image/png;base64,aGVsbG8='
  });
  assert.equal(parts['.theme-status'].textContent, 'Theme saved.');
  parts['.remove-cover'].listeners.get('click')();
  assert.equal(invitation.parts['.invitation-cover'].hidden, true);
});

test('guest invitation applies the API theme without interpreting theme values as HTML', async () => {
  const elements = new Map();
  const document = {
    querySelector(selector) {
      if (!elements.has(selector)) elements.set(selector, new FakeElement());
      return elements.get(selector);
    },
    createElement: () => new FakeElement()
  };
  document.querySelector('#rsvp-form').elements = {
    partySize: new FakeElementInput(),
    answer: new FakeElementInput()
  };
  document.querySelector('#rsvp-form').elements.answer.value = 'yes';
  const fetch = async (url) => {
    assert.equal(url, '/api/guest/synthetic-token');
    return {
      ok: true,
      json: async () => ({
        canRespond: true,
        event: {
          title: '<script>not markup</script>', eventDate: '2035-06-15', location: 'Sample Park',
          theme: {
            preset: 'midnight', primaryColor: '#313a63', backgroundColor: '#f1f1f7',
            textColor: '#777777', fontFamily: 'sans',
            coverImage: 'data:image/webp;base64,UklGRg=='
          }
        },
        guest: { name: 'Sample guest', partyLimit: 2, partySize: 1 }
      })
    };
  };

  vm.runInNewContext(source, {
    document, location: { pathname: '/rsvp/synthetic-token', origin: 'http://localhost' },
    fetch, FormData: class {}, console
  });
  await waitFor(() => document.querySelector('#guest-title').textContent !== '');

  const guest = document.querySelector('#guest');
  const cover = document.querySelector('#guest-cover');
  assert.equal(guest.styleValues['--invite-primary'], '#313a63');
  assert.equal(guest.styleValues['--invite-background'], '#f1f1f7');
  assert.equal(guest.styleValues['--invite-text'], '#000000');
  assert.equal(guest.styleValues['--invite-font'], 'system-ui, -apple-system, "Segoe UI", sans-serif');
  assert.equal(document.querySelector('#guest-title').textContent, '<script>not markup</script>');
  assert.equal(cover.hidden, false);
  assert.equal(cover.src, 'data:image/webp;base64,UklGRg==');
});
