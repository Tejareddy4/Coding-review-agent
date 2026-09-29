// Hermetic store tests: disabled-mode safety (no DATABASE_URL) + cache keys.
// Live Postgres behavior is verified separately against a real database.
import test from 'node:test';
import assert from 'node:assert/strict';
import { startMockUpstreams, configureTestEnv, closeServer } from './helpers/mocks.js';

const upstreams = await startMockUpstreams();
configureTestEnv(upstreams); // DATABASE_URL deliberately empty

const store = await import('../src/store.js');
const { processPR } = await import('../src/review.js');
const { resetDedupeCache } = await import('../src/review.js');

test.after(async () => {
  await closeServer(upstreams.github.server);
  await closeServer(upstreams.groq.server);
  await closeServer(upstreams.hindsight.server);
});

test('store disabled: isStoreEnabled() is false and all ops are safe no-ops', async () => {
  assert.equal(store.isStoreEnabled(), false);
  // dedupe claim fails OPEN (delivery is processed)
  assert.equal(await store.markDeliveryProcessed('x'), true);
  assert.equal(await store.getCachedMemories('k'), null);
  await store.putCachedMemories('k', [{ text: 't', type: 'convention', score: 1 }]);
  await store.recordReview({ repo: 'o/r', prNumber: 1, status: 'completed' });
  await store.recordLearning({ repo: 'o/r', prNumber: 1, type: 'convention', content: 'x', retained: true });
  await store.closeStore();
  assert.equal(store.isStoreEnabled(), false); // still fine after close
});

test('hashRecallQuery is deterministic and discriminating', () => {
  assert.equal(store.hashRecallQuery('query-a'), store.hashRecallQuery('query-a'));
  assert.notEqual(store.hashRecallQuery('query-a'), store.hashRecallQuery('query-b'));
  assert.match(store.hashRecallQuery('x'), /^[a-f0-9]{64}$/);
});

test('processPR works end-to-end with the store disabled (fallback dedupe)', async () => {
  resetDedupeCache();
  const payload = {
    action: 'opened',
    pull_request: { number: 77, title: 'T' },
    repository: { name: 'test-repo', owner: { login: 'test-owner' } },
  };
  const first = await processPR(payload, 'store-disabled-1');
  assert.equal(first.status, 'completed');
  const second = await processPR(payload, 'store-disabled-1'); // in-memory dedupe
  assert.equal(second.status, 'duplicate');
});
