import test from 'node:test';
import assert from 'node:assert/strict';
import { startMockUpstreams, configureTestEnv, closeServer } from './helpers/mocks.js';

const upstreams = await startMockUpstreams();
configureTestEnv(upstreams, { GROQ_MODELS: 'model-a,model-b' });

const { generateReview, resetRateLimitState } = await import('../src/groq.js');

const chatCalls = () => upstreams.groq.calls.filter((c) => c.url.endsWith('/chat/completions'));
const modelOf = (call) => JSON.parse(call.body).model;

test.after(async () => {
  await closeServer(upstreams.github.server);
  await closeServer(upstreams.groq.server);
  await closeServer(upstreams.hindsight.server);
});

test('429 on primary -> shifts to next model immediately (no wait)', async () => {
  resetRateLimitState();
  upstreams.state.rateLimitedModels = ['model-a'];
  upstreams.state.rateLimitRetryAfterSecs = 60; // would be a 60s wait if it waited — it must NOT
  upstreams.state.always429 = false;

  const start = Date.now();
  const review = await generateReview('+ code', [], 'T');
  const took = Date.now() - start;

  assert.match(review, /avoid `any`/);
  assert.ok(took < 1000, `model shift must be immediate, took ${took}ms`);
  const calls = chatCalls();
  assert.equal(calls.length, 2, 'exactly two LLM calls: 429 on a, success on b');
  assert.equal(modelOf(calls[0]), 'model-a');
  assert.equal(modelOf(calls[1]), 'model-b');
});

test('all models 429 -> waits Retry-After once, final pass succeeds', async () => {
  resetRateLimitState();
  upstreams.state.always429 = false;
  upstreams.state.rateLimitedModels = ['model-a', 'model-b']; // each 429s exactly once
  upstreams.state.rateLimitRetryAfterSecs = 1;

  const start = Date.now();
  const review = await generateReview('+ code', [], 'T');
  const took = Date.now() - start;

  assert.match(review, /avoid `any`/);
  assert.ok(took >= 900, `expected ~1s rate-window wait, took ${took}ms`);
  const calls = chatCalls().slice(-3); // last three calls belong to this test
  assert.deepEqual(calls.map(modelOf), ['model-a', 'model-b', 'model-a']);
});

test('permanent 429 -> bounded wait, then fallback review message', async () => {
  resetRateLimitState();
  upstreams.state.always429 = true;
  upstreams.state.rateLimitRetryAfterSecs = 1;

  const review = await generateReview('+ code', [], 'T');

  assert.match(review, /could not generate a review/);
  assert.ok(upstreams.state.rateLimited429s >= 3, 'chain was walked more than once');
  upstreams.state.always429 = false;
});

test('cooldown persists across calls: second request skips the cooling model', async () => {
  resetRateLimitState();
  upstreams.state.always429 = false;
  // model-a still cooling from the previous test (retry-after 1s may have
  // expired) — re-arm deterministically with a long cooldown
  upstreams.state.rateLimitedModels = ['model-a'];
  upstreams.state.rateLimitRetryAfterSecs = 60;
  await generateReview('+ code', [], 'T'); // a 429s once (60s cooldown), b serves

  const callsBefore = chatCalls().length;
  const review = await generateReview('+ code', [], 'T'); // a must be skipped now

  assert.match(review, /avoid `any`/);
  const newCalls = chatCalls().slice(callsBefore);
  assert.equal(newCalls.length, 1, 'cooling model skipped, served directly by model-b');
  assert.equal(modelOf(newCalls[0]), 'model-b');
});
