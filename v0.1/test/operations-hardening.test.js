'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createApp, startupConfig } = require('../server');
const { Store } = require('../persistence');

test('startup configuration stays loopback and validates the port', () => {
  assert.deepEqual(startupConfig({ PORT: '0', GATHERLY_DB_PATH: 'local.sqlite' }), {
    host: '127.0.0.1', port: 0, dbPath: 'local.sqlite'
  });
  assert.throws(() => startupConfig({ PORT: '70000' }), /PORT/);
  assert.throws(() => startupConfig({ PORT: 'not-a-port' }), /PORT/);
  assert.throws(() => startupConfig({ PORT: '3000', GATHERLY_DB_PATH: ':memory:' }), /GATHERLY_DB_PATH/);
});

test('health and readiness endpoints work and shutdown closes the app', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'gatherly-hardening-'));
  const app = createApp({ dbPath: path.join(directory, 'test.sqlite') });
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  await new Promise((resolve) => app.server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const health = await fetch(`${base}/healthz`);
  assert.equal(health.status, 200);
  assert.deepEqual(await health.json(), { status: 'ok' });
  const ready = await fetch(`${base}/readyz`);
  assert.equal(ready.status, 200);
  assert.deepEqual(await ready.json(), { status: 'ready' });
  await new Promise((resolve, reject) => app.shutdown((error) => error ? reject(error) : resolve()));
  assert.equal(app.server.listening, false);
});

test('expired sessions are deleted during cleanup', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'gatherly-session-cleanup-'));
  const store = new Store(path.join(directory, 'test.sqlite'));
  try {
    const hostId = store.createHost('host@example.test', 'hash', '2020-01-01T00:00:00.000Z');
    store.createSession('expired', hostId, '2020-01-01T00:00:00.000Z');
    store.createSession('active', hostId, '2099-01-01T00:00:00.000Z');
    assert.equal(store.cleanupExpiredSessions('2025-01-01T00:00:00.000Z'), 1);
    assert.equal(store.getSession('expired', '2025-01-01T00:00:00.000Z'), undefined);
  } finally {
    store.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
