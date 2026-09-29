import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import crypto from 'node:crypto';
import { startMockUpstreams, configureTestEnv, waitFor, listen, closeServer } from './helpers/mocks.js';

const upstreams = await startMockUpstreams();
configureTestEnv(upstreams);

const { buildApp } = await import('../src/index.js');
const { resetDedupeCache } = await import('../src/review.js');
const { config } = await import('../src/config.js');

const sign = (body) =>
  'sha256=' +
  crypto
    .createHmac('sha256', config.github.webhookSecret)
    .update(body)
    .digest('hex');

const prPayload = {
  action: 'opened',
  pull_request: { number: 1, title: 'Add user service', body: '' },
  repository: { name: 'test-repo', owner: { login: 'test-owner' } },
};

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

const app = buildApp();
const server = await listen(app);

test.after(async () => {
  await closeServer(server);
  await closeServer(upstreams.github.server);
  await closeServer(upstreams.groq.server);
  await closeServer(upstreams.hindsight.server);
});

test('full pipeline: webhook -> diff -> recall -> review -> comment -> retain', async () => {
  resetDedupeCache();
  const body = JSON.stringify(prPayload);
  const res = await request(server, body, {
    'content-type': 'application/json',
    'x-hub-signature-256': sign(body),
    'x-github-event': 'pull_request',
    'x-github-delivery': 'integration-1',
  });
  assert.equal(res.status, 202);

  // Comment posted on GitHub
  await waitFor(
    () => upstreams.github.calls.some((c) => c.url.includes('/comments'))
  );
  const commentCall = upstreams.github.calls.find((c) =>
    c.url.includes('/comments')
  );
  const posted = JSON.parse(commentCall.body);
  assert.match(posted.body, /Code Review Agent \(Hindsight Memory\)/);
  assert.match(posted.body, /avoid `any`/); // the mock review text
  assert.match(posted.body, /Recalled 2 relevant team decision/);

  // Memory recalled from Hindsight with a query containing PR title + files
  const recallCall = upstreams.hindsight.calls.find((c) => c.url.includes('/recall'));
  assert.ok(recallCall, 'recall must have been called');
  const recallBody = JSON.parse(recallCall.body);
  const q = recallBody.query ?? '';
  assert.match(q, /Add user service/);
  assert.match(q, /src\/user\.ts/);

  // Learning retained back into Hindsight
  await waitFor(() =>
    upstreams.hindsight.calls.some(
      (c) =>
        (c.url.includes('/memories') || c.url.includes('/retain')) &&
        c.at > recallCall.at
    )
  );
  const retainCall = upstreams.hindsight.calls.find(
    (c) => (c.url.includes('/memories') || c.url.includes('/retain')) && c.at > recallCall.at
  );
  const retained = JSON.parse(retainCall.body);
  assert.match(
    retained.items?.[0]?.content ?? retained.content ?? '',
    /User service must validate input with Zod/
  );

  // Review prompt carried the recalled memories
  const reviewCall = upstreams.groq.calls.find(
    (c) => !JSON.parse(c.body).messages?.[0]?.content?.includes('Extract durable')
  );
  assert.ok(reviewCall);
  const prompt = JSON.parse(reviewCall.body).messages?.[1]?.content ?? '';
  assert.match(prompt, /Never use the `any` type in TypeScript\./);
  assert.match(prompt, /Never log PII/);
});

test('duplicate delivery is deduped: no second comment', async () => {
  const before = upstreams.github.calls.filter((c) =>
    c.url.includes('/comments')
  ).length;
  const body = JSON.stringify(prPayload);
  const res = await request(server, body, {
    'content-type': 'application/json',
    'x-hub-signature-256': sign(body),
    'x-github-event': 'pull_request',
    'x-github-delivery': 'integration-1', // SAME delivery id
  });
  assert.equal(res.status, 202);
  await new Promise((r) => setTimeout(r, 250));
  const after = upstreams.github.calls.filter((c) =>
    c.url.includes('/comments')
  ).length;
  assert.equal(after, before, 'duplicate must not produce a second comment');
});

test('unprocessable action (closed) triggers no pipeline calls', async () => {
  const githubBefore = upstreams.github.calls.length;
  const body = JSON.stringify({ ...prPayload, action: 'closed' });
  const res = await request(server, body, {
    'content-type': 'application/json',
    'x-hub-signature-256': sign(body),
    'x-github-event': 'pull_request',
    'x-github-delivery': 'integration-closed',
  });
  assert.equal(res.status, 202);
  await new Promise((r) => setTimeout(r, 150));
  assert.equal(upstreams.github.calls.length, githubBefore);
});

test('GitHub diff failure: no comment, no crash, still 202', async () => {
  // Flip the GitHub mock into a failing state (same port — no server swap).
  upstreams.state.failDiff = true;
  const githubCallsBefore = upstreams.github.calls.length;
  const commentsBefore = upstreams.github.calls.filter((c) =>
    c.url.includes('/comments')
  ).length;

  const body = JSON.stringify({ ...prPayload, pull_request: { number: 3, title: 't' } });
  const res = await request(server, body, {
    'content-type': 'application/json',
    'x-hub-signature-256': sign(body),
    'x-github-event': 'pull_request',
    'x-github-delivery': 'integration-err',
  });
  assert.equal(res.status, 202);
  await new Promise((r) => setTimeout(r, 300));

  assert.ok(
    upstreams.github.calls.some((c) => c.url.includes('/pulls/3')),
    'diff fetch was attempted against the (failing) mock'
  );
  const commentsAfter = upstreams.github.calls.filter((c) =>
    c.url.includes('/comments')
  ).length;
  assert.equal(commentsAfter, commentsBefore, 'no comment may be posted when diff fetch fails');
  assert.ok(upstreams.github.calls.length > githubCallsBefore);
});
