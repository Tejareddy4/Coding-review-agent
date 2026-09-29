import test from 'node:test';
import assert from 'node:assert/strict';
import { startMockUpstreams, configureTestEnv, closeServer } from './helpers/mocks.js';

const upstreams = await startMockUpstreams();
configureTestEnv(upstreams);

const { fetchPRDiff, postPRComment } = await import('../src/github.js');

test.after(async () => {
  await closeServer(upstreams.github.server);
  await closeServer(upstreams.groq.server);
  await closeServer(upstreams.hindsight.server);
});

test('fetchPRDiff returns raw diff text', async () => {
  const diff = await fetchPRDiff('test-owner', 'test-repo', 1);
  assert.equal(typeof diff, 'string');
  assert.match(diff, /diff --git/);
});

test('postPRComment returns the numeric comment id (regression: transformResponse killed JSON parsing)', async () => {
  const id = await postPRComment('test-owner', 'test-repo', 1, 'hello');
  assert.equal(id, 42, 'mock returns { id: 42 } — id must come back as a number');
});
