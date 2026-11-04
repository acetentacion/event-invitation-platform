'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const publicDir = path.join(__dirname, '../public');
const html = fs.readFileSync(path.join(publicDir, 'index.html'), 'utf8');
const app = fs.readFileSync(path.join(publicDir, 'app.js'), 'utf8');
const css = fs.readFileSync(path.join(publicDir, 'styles.css'), 'utf8');

test('local UI carries the Gatherly brand and keeps its synthetic-data warning', () => {
  assert.match(html, /class="site-header"/);
  assert.match(html, /class="brand__mark" aria-hidden="true">g/);
  assert.match(html, /LOCAL RSVP/);
  assert.match(html, /Do not enter real personal data/);
  assert.match(css, /--paper:\s*#f8f6f1/i);
  assert.match(css, /--forest:\s*#43513e/i);
  assert.match(css, /--serif:\s*"Playfair Display", Georgia/i);
  assert.match(html, /id="create-event"[^>]*hidden/);
  assert.match(html, /id="open-create-event"[^>]*>Create event</);
  assert.match(html, /id="customize-invitation-toggle" class="workspace-link"/);
});

test('visual alignment retains visible focus, mobile layouts, and invitation theme contrast', () => {
  assert.match(css, /:focus-visible[\s\S]*outline:\s*3px solid/i);
  assert.match(css, /@media \(max-width:\s*440px\)/);
  assert.match(css, /@media \(prefers-reduced-motion:\s*reduce\)/);
  assert.match(css, /\.guest-content\.reveal-motion-fade/);
  assert.match(css, /\.guest-content\.reveal-motion-slide-up/);
  assert.match(css, /\.invitation-card\.has-celebration/);
  assert.match(app, /<select class="invitation-celebration"/);
  assert.match(html, /class="invitation-sparkle-overlay" aria-hidden="true"/);
  assert.match(css, /prefers-reduced-motion:\s*reduce\)[\s\S]*\.invitation-sparkle-overlay i\s*\{\s*animation:\s*none/i);
  assert.match(html, /class="invitation-leaves" aria-hidden="true"/);
  assert.match(css, /\.invitation-card\.has-falling-leaves[\s\S]*pointer-events:\s*none/);
  assert.match(css, /prefers-reduced-motion:\s*reduce\)[\s\S]*\.invitation-leaves i\s*\{\s*animation:\s*none/i);
  assert.match(css, /\.invitation-intro[\s\S]*color:\s*var\(--invite-text/i);
  assert.match(css, /\.rsvp-choices label[\s\S]*color:\s*var\(--invite-text/i);
  assert.match(css, /\.invitation-rsvp \.rsvp-submit[\s\S]*var\(--invite-action-text/i);
});
