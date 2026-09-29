import crypto from 'node:crypto';
import { startMockUpstreams, configureTestEnv, listen, closeServer } from './helpers/mocks.js';

const upstreams = await startMockUpstreams();
configureTestEnv(upstreams);

const { buildApp, verifySignature } = await import('../src/index.js');
const { config } = await import('../src/config.js');

const SECRET = config.github.webhookSecret;
const sign = (body) =>
  'sha256=' + crypto.createHmac('sha256', SECRET).update(body).digest('hex');

const prEvent = (overrides = {}) => ({
  action: 'opened',
  pull_request: { number: 1, title: 'Test PR', body: '' },
  repository: { name: 'test-repo', owner: { login: 'test-owner' } },
  ...overrides,
});

// Lightweight HTTP client for the app under test.
import http from 'node:http';

function request(server, body, headers) {
  return new Promise((resolve, reject) => {
    const { port } = server.address();
    const req = http.request(
      { host: '127.0.0.1', port, path: '/webhook', method: 'POST', headers },
      (res) => {
        let data = '';
        res.on('data', (c) => (data += c));
        res.on('end', () => resolve({ status: res.statusCode, body: data }));
      }
    );
    req.on('error', reject);
    req.end(body);
  });
}

// ---- verifySignature unit checks -----------------------------------------
import test from 'node:test';
import assert from 'node:assert/strict';

test.after(async () => {
  await closeServer(upstreams.github.server);
  await closeServer(upstreams.groq.server);
  await closeServer(upstreams.hindsight.server);
});

test('verifySignature accepts a valid HMAC over raw body', () => {
  const body = Buffer.from('{"hello":"world"}');
  assert.equal(verifySignature(body, sign('{"hello":"world"}')), true);
});

test('verifySignature rejects tampered body', () => {
  const body = Buffer.from('{"hello":"world"}');
  assert.equal(verifySignature(body, sign('{"hello":"tampered"}')), false);
});

test('verifySignature rejects missing/short/malformed signatures', () => {
  const body = Buffer.from('{}');
  assert.equal(verifySignature(body, undefined), false);
  assert.equal(verifySignature(body, 'sha256=short'), false);
  assert.equal(verifySignature(body, 'md5=abc'), false);
  assert.equal(verifySignature(body, sign('{}').toUpperCase()), false);
});

// ---- endpoint behavior ----------------------------------------------------

test('webhook: valid signature -> 202 Accepted', async () => {
  const app = buildApp();
  const server = await listen(app);
  try {
    const body = JSON.stringify({ action: 'assigned', pull_request: { number: 1 }, repository: { name: 'r', owner: { login: 'o' } } });
    const res = await request(server, body, {
      'content-type': 'application/json',
      'x-hub-signature-256': sign(body),
      'x-github-event': 'pull_request',
      'x-github-delivery': 'sec-1',
    });
    assert.equal(res.status, 202);
  } finally {
    await closeServer(server);
  }
});

test('webhook: missing signature -> 401', async () => {
  const app = buildApp();
  const server = await listen(app);
  try {
    const body = JSON.stringify(prEvent());
    const res = await request(server, body, {
      'content-type': 'application/json',
      'x-github-event': 'pull_request',
    });
    assert.equal(res.status, 401);
  } finally {
    await closeServer(server);
  }
});

test('webhook: invalid signature (tampered body) -> 401', async () => {
  const app = buildApp();
  const server = await listen(app);
  try {
    const body = JSON.stringify(prEvent());
    const res = await request(server, body, {
      'content-type': 'application/json',
      'x-hub-signature-256': sign(JSON.stringify(prEvent({ action: 'synchronize' }))),
      'x-github-event': 'pull_request',
    });
    assert.equal(res.status, 401);
  } finally {
    await closeServer(server);
  }
});

test('webhook: valid signature but invalid JSON -> 400', async () => {
  const app = buildApp();
  const server = await listen(app);
  try {
    const body = 'not json at all';
    const res = await request(server, body, {
      'content-type': 'application/json',
      'x-hub-signature-256': sign(body),
      'x-github-event': 'pull_request',
    });
    assert.equal(res.status, 400);
  } finally {
    await closeServer(server);
  }
});

test('webhook: ping event -> 200 without processing', async () => {
  const app = buildApp();
  const server = await listen(app);
  try {
    const body = JSON.stringify({ zen: 'Design for failure.' });
    const res = await request(server, body, {
      'content-type': 'application/json',
      'x-hub-signature-256': sign(body),
      'x-github-event': 'ping',
      'x-github-delivery': 'ping-1',
    });
    assert.equal(res.status, 200);
    assert.equal(upstreams.github.calls.length, 0);
  } finally {
    await closeServer(server);
  }
});

test('webhook: missing event header -> 400', async () => {
  const app = buildApp();
  const server = await listen(app);
  try {
    const body = JSON.stringify(prEvent());
    const res = await request(server, body, {
      'content-type': 'application/json',
      'x-hub-signature-256': sign(body),
    });
    assert.equal(res.status, 400);
  } finally {
    await closeServer(server);
  }
});

test('health endpoint returns ok', async () => {
  const app = buildApp();
  const server = await listen(app);
  try {
    const { port } = server.address();
    const res = await fetch(`http://127.0.0.1:${port}/health`);
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.status, 'ok');
  } finally {
    await closeServer(server);
  }
});
