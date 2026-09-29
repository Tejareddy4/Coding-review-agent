import test from 'node:test';
import assert from 'node:assert/strict';
import { startMockUpstreams, configureTestEnv, waitFor, closeServer } from './helpers/mocks.js';

const upstreams = await startMockUpstreams({
  extractedMemories: [
    { type: 'convention', content: 'Valid high-confidence memory.', confidence: 0.95 },
    { type: 'convention', content: 'Low confidence, must be dropped.', confidence: 0.5 },
    { type: 'bogus_type', content: 'Invalid type, must be dropped.', confidence: 0.95 },
    { type: 'decision', content: '', confidence: 0.95 },
    { type: 'decision', content: 'x'.repeat(600), confidence: 0.95 },
    { type: 'decision', content: 12345, confidence: 0.95 },
  ],
});
configureTestEnv(upstreams);

const { processReviewLearnings } = await import('../src/memory.js');
const { isDuplicateDelivery, resetDedupeCache, validatePRPayload } = await import('../src/review.js');

test.after(async () => {
  await closeServer(upstreams.github.server);
  await closeServer(upstreams.groq.server);
  await closeServer(upstreams.hindsight.server);
});

test('processReviewLearnings filters invalid candidates and retains valid ones', async () => {
  const retained = await processReviewLearnings('some review text', {
    prNumber: 1,
    repo: 'o/r',
  });
  assert.equal(retained.length, 1);
  assert.equal(retained[0].content, 'Valid high-confidence memory.');

  const retainCalls = upstreams.hindsight.calls.filter(
    (c) => c.url.includes('/memories') || c.url.includes('/retain')
  );
  assert.equal(retainCalls.length, 1);
  const sent = JSON.parse(retainCalls[0].body);
  assert.match(
    sent.items?.[0]?.content ?? sent.content ?? '',
    /Valid high-confidence/
  );
});

test('processReviewLearnings caps at 5 memories per review', async () => {
  upstreams.state.extractedMemories = Array.from({ length: 8 }, (_, i) => ({
    type: 'convention',
    content: `Memory ${i}`,
    confidence: 0.9,
  }));
  const retained = await processReviewLearnings('some review text', {
    prNumber: 2,
    repo: 'o/r',
  });
  assert.equal(retained.length, 5);
});

// ---- validatePRPayload ------------------------------------------------------

test('validatePRPayload accepts a well-formed payload', () => {
  const ok = validatePRPayload({
    action: 'opened',
    pull_request: { number: 1, title: 't' },
    repository: { name: 'r', owner: { login: 'o' } },
  });
  assert.equal(ok.ok, true);
});

test('validatePRPayload rejects malformed payloads', () => {
  assert.equal(validatePRPayload(null).ok, false);
  assert.equal(validatePRPayload({}).ok, false);
  assert.equal(
    validatePRPayload({ action: 'opened', pull_request: { title: 'no number' }, repository: { name: 'r', owner: { login: 'o' } } }).ok,
    false
  );
  assert.equal(
    validatePRPayload({ action: 'opened', pull_request: { number: 'x', title: 't' }, repository: { name: 'r', owner: { login: 'o' } } }).ok,
    false
  );
  assert.equal(
    validatePRPayload({ action: 'opened', pull_request: { number: 1, title: 't' }, repository: { name: 'r' } }).ok,
    false
  );
});

// ---- dedupe ------------------------------------------------------------------

test('isDuplicateDelivery: second sighting returns true', () => {
  resetDedupeCache();
  assert.equal(isDuplicateDelivery('d-1'), false);
  assert.equal(isDuplicateDelivery('d-1'), true);
  assert.equal(isDuplicateDelivery('d-2'), false);
});

test('isDuplicateDelivery: undefined id never dedupes', () => {
  resetDedupeCache();
  assert.equal(isDuplicateDelivery(undefined), false);
  assert.equal(isDuplicateDelivery(undefined), false);
});

test('dedupe cache is bounded (evicts oldest beyond 1000)', () => {
  resetDedupeCache();
  for (let i = 0; i < 1001; i++) isDuplicateDelivery(`bulk-${i}`);
  // bulk-1000's insert evicted bulk-0 (oldest) — it is no longer known
  assert.equal(isDuplicateDelivery('bulk-0'), false);
  // re-adding bulk-0 appended it at the end and evicted bulk-1 (new oldest);
  // bulk-2 must still be known
  assert.equal(isDuplicateDelivery('bulk-2'), true);
});
