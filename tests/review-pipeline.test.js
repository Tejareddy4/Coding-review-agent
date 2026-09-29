import test from 'node:test';
import assert from 'node:assert/strict';
import { startMockUpstreams, configureTestEnv, closeServer } from './helpers/mocks.js';

const upstreams = await startMockUpstreams();
configureTestEnv(upstreams); // allowlist env = test-owner/test-repo

const { processPR, resetDedupeCache } = await import('../src/review.js');

const payload = (overrides = {}) => ({
  action: 'opened',
  pull_request: { number: 90, title: 'T' },
  repository: { name: 'test-repo', owner: { login: 'test-owner' } },
  ...overrides,
});

test.after(async () => {
  await closeServer(upstreams.github.server);
  await closeServer(upstreams.groq.server);
  await closeServer(upstreams.hindsight.server);
});

test('draft PRs are skipped (reviewed later on ready_for_review)', async () => {
  resetDedupeCache();
  const before = upstreams.github.calls.length;
  const r = await processPR(
    payload({ pull_request: { number: 91, title: 'T', draft: true } }),
    'pipe-draft'
  );
  assert.equal(r.status, 'skipped_draft');
  assert.equal(upstreams.github.calls.length, before, 'no API calls for drafts');
});

test('ready_for_review action IS processed (regression: used to be skipped)', async () => {
  resetDedupeCache();
  const r = await processPR(
    payload({ action: 'ready_for_review', pull_request: { number: 92, title: 'T', draft: false } }),
    'pipe-ready'
  );
  assert.equal(r.status, 'completed');
  assert.ok(
    upstreams.github.calls.some((c) => c.url.includes('/issues/92/comments')),
    'comment posted for the now-ready PR'
  );
});

test('PR from a repo outside the allowlist is rejected', async () => {
  resetDedupeCache();
  const before = upstreams.github.calls.length;
  const r = await processPR(
    payload({ repository: { name: 'other-repo', owner: { login: 'stranger-org' } } }),
    'pipe-foreign'
  );
  assert.equal(r.status, 'foreign_repo');
  assert.equal(upstreams.github.calls.length, before, 'no diff fetch, no comment');
});

test('allowlisted repo still processes normally', async () => {
  resetDedupeCache();
  const r = await processPR(payload(), 'pipe-allow-ok');
  assert.equal(r.status, 'completed');
});
