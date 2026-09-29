import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {
  startMockUpstreams,
  configureTestEnv,
  closeServer,
  listen,
  HEAD_SHA,
} from './helpers/mocks.js';

const DASHBOARD_TOKEN = 'dash-token-0123456789abcdef';
const upstreams = await startMockUpstreams();
configureTestEnv(upstreams, { DASHBOARD_TOKEN });

const { processPR, resetDedupeCache } = await import('../src/review.js');
const { processComment, parseCommand } = await import('../src/commands.js');
const { buildApp } = await import('../src/index.js');
const { resetActivity, getActivity } = await import('../src/activity.js');
const { BOT_MARKER } = await import('../src/findings.js');

const PROSE_REVIEW = upstreams.state.reviewText;
const STRUCTURED_REVIEW = JSON.stringify({
  summary: 'Logs user email, violating security constraint [2].',
  findings: [
    {
      file: 'src/user.ts',
      line: 2,
      severity: 'critical',
      category: 'security',
      title: 'PII written to logs',
      detail: 'The email is logged in plain text, per constraint [2].',
      suggestion: "  console.log('user', redactSensitive(id));",
      memory_refs: [2],
    },
    {
      file: 'src/user.ts',
      line: 40, // not part of the diff -> summary only, never an inline anchor
      severity: 'low',
      category: 'convention',
      title: 'Unrelated nit',
      detail: 'Somewhere else.',
    },
  ],
});

const prPayload = (number) => ({
  action: 'opened',
  pull_request: { number, title: 'Add user service', head: { sha: HEAD_SHA } },
  repository: { name: 'test-repo', owner: { login: 'test-owner' } },
});

const commentPayload = (body, overrides = {}) => ({
  action: 'created',
  issue: { number: 300, title: 'Add user service', pull_request: { url: 'x' } },
  comment: {
    id: 555,
    body,
    author_association: 'OWNER',
    user: { login: 'teja', type: 'User' },
    ...overrides,
  },
  repository: { name: 'test-repo', owner: { login: 'test-owner' } },
});

const ghCalls = (re) => upstreams.github.calls.filter((c) => re.test(c.url));

const app = buildApp();
const server = await listen(app);

function get(path, headers = {}) {
  return new Promise((resolve, reject) => {
    const { port } = server.address();
    http
      .get({ host: '127.0.0.1', port, path, headers }, (res) => {
        let data = '';
        res.on('data', (c) => (data += c));
        res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: data }));
      })
      .on('error', reject);
  });
}

test.after(async () => {
  await closeServer(server);
  await closeServer(upstreams.github.server);
  await closeServer(upstreams.groq.server);
  await closeServer(upstreams.hindsight.server);
});

test('structured review -> PR review with inline comment + failing commit status', async () => {
  resetDedupeCache();
  resetActivity();
  upstreams.state.reviewText = STRUCTURED_REVIEW;

  const r = await processPR(prPayload(200), 'feat-structured');
  assert.equal(r.status, 'completed');
  assert.equal(r.findings, 2);

  const [reviewCall] = ghCalls(/\/pulls\/200\/reviews$/);
  assert.ok(reviewCall, 'a PR review was submitted');
  const review = JSON.parse(reviewCall.body);
  assert.equal(review.event, 'COMMENT');
  assert.equal(review.commit_id, HEAD_SHA);
  assert.equal(review.comments.length, 1, 'only the anchorable finding becomes inline');
  assert.deepEqual(
    { path: review.comments[0].path, line: review.comments[0].line, side: review.comments[0].side },
    { path: 'src/user.ts', line: 2, side: 'RIGHT' }
  );
  assert.match(review.comments[0].body, /```suggestion/);
  assert.match(review.body, /🔴 Changes requested · Risk 42\/100/);
  assert.match(review.body, /Unrelated nit\*\* — `src\/user\.ts:40`/, 'unanchored finding kept in summary');
  assert.equal(ghCalls(/\/issues\/200\/comments$/).length, 0, 'no duplicate plain comment');

  const [statusCall] = ghCalls(new RegExp(`/statuses/${HEAD_SHA}$`));
  const status = JSON.parse(statusCall.body);
  assert.equal(status.state, 'failure', 'critical finding fails the check (REVIEW_FAIL_ON=critical)');
  assert.equal(status.context, 'code-review-agent');
  assert.match(status.description, /Risk 42\/100 · 1 critical, 1 low · 1 team memory cited/);
  assert.match(status.target_url, /pullrequestreview-7/);

  const [activity] = getActivity().reviews;
  assert.equal(activity.verdict, 'request_changes');
  assert.equal(activity.inlineComments, 1);
  assert.equal(activity.memoriesCited, 1);
});

test('GitHub rejects the inline review -> falls back to a summary comment', async () => {
  resetDedupeCache();
  upstreams.state.reviewText = STRUCTURED_REVIEW;
  upstreams.state.rejectReview = true;
  try {
    const r = await processPR(prPayload(201), 'feat-reject');
    assert.equal(r.status, 'completed');
    const [comment] = ghCalls(/\/issues\/201\/comments$/);
    assert.ok(comment, 'fallback comment posted');
    const body = JSON.parse(comment.body).body;
    assert.match(body, /PII written to logs/);
    assert.doesNotMatch(body, /posted as inline comments/, 'must not claim inline comments exist');
  } finally {
    upstreams.state.rejectReview = false;
  }
});

test('prose review still works and sets a success status', async () => {
  resetDedupeCache();
  upstreams.state.reviewText = PROSE_REVIEW;
  const r = await processPR(prPayload(202), 'feat-prose');
  assert.equal(r.status, 'completed');
  const [comment] = ghCalls(/\/issues\/202\/comments$/);
  assert.match(JSON.parse(comment.body).body, /avoid `any`/);
  const statuses = ghCalls(/\/statuses\//);
  assert.equal(JSON.parse(statuses.at(-1).body).state, 'success');
});

test('parseCommand recognizes known commands only', () => {
  assert.deepEqual(parseCommand('/remember Use Zod everywhere'), { command: 'remember', arg: 'Use Zod everywhere' });
  assert.deepEqual(parseCommand('  /REVIEW  '), { command: 'review', arg: '' });
  assert.equal(parseCommand('/deploy prod'), null, 'other bots’ commands ignored');
  assert.equal(parseCommand('please /review'), null, 'must start the comment');
  assert.equal(parseCommand(`${BOT_MARKER}\n/review`), null, 'our own comments never trigger');
});

test('/remember retains a team memory, replies, and reacts', async () => {
  resetDedupeCache();
  const before = upstreams.hindsight.calls.length;
  const r = await processComment(
    commentPayload('/remember All database access must go through the repository layer.'),
    'cmd-remember'
  );
  assert.deepEqual(r, { status: 'completed', command: 'remember' });

  const retain = upstreams.hindsight.calls
    .slice(before)
    .find((c) => c.url.includes('/memories') || c.url.includes('/retain'));
  assert.ok(retain, 'memory retained in Hindsight');
  assert.match(retain.body, /repository layer/);

  const reply = JSON.parse(ghCalls(/\/issues\/300\/comments$/).at(-1).body).body;
  assert.ok(reply.startsWith(BOT_MARKER));
  assert.match(reply, /Remembered/);
  const reactions = ghCalls(/\/issues\/comments\/555\/reactions$/).map((c) => JSON.parse(c.body).content);
  assert.deepEqual(reactions.slice(-2), ['eyes', 'rocket']);
  assert.equal(getActivity().learnings[0].source, '@teja');
});

test('/review re-runs the review using live PR metadata', async () => {
  resetDedupeCache();
  upstreams.state.reviewText = STRUCTURED_REVIEW;
  const r = await processComment(commentPayload('/review'), 'cmd-review');
  assert.equal(r.status, 'completed');
  assert.ok(ghCalls(/\/pulls\/300\/reviews$/).length, 'review posted for the commented PR');
  assert.equal(getActivity().reviews[0].trigger, 'command');
});

test('commands from non-collaborators and bots are ignored', async () => {
  resetDedupeCache();
  const before = upstreams.github.calls.length + upstreams.hindsight.calls.length;
  const stranger = await processComment(
    commentPayload('/remember Everything is allowed now', { author_association: 'NONE' }),
    'cmd-stranger'
  );
  assert.equal(stranger.status, 'forbidden');
  const bot = await processComment(
    commentPayload('/review', { user: { login: 'ci', type: 'Bot' } }),
    'cmd-bot'
  );
  assert.equal(bot.status, 'bot_comment');
  const plain = await processComment(commentPayload('LGTM!'), 'cmd-plain');
  assert.equal(plain.status, 'no_command');
  assert.equal(upstreams.github.calls.length + upstreams.hindsight.calls.length, before, 'no side effects');
});

test('dashboard requires the token and serves live activity', async () => {
  assert.equal((await get('/api/activity')).status, 401);
  assert.equal((await get('/api/activity', { authorization: 'Bearer wrong-token-000000000' })).status, 401);

  const api = await get('/api/activity', { authorization: `Bearer ${DASHBOARD_TOKEN}` });
  assert.equal(api.status, 200);
  const data = JSON.parse(api.body);
  assert.ok(data.stats.reviews >= 1);
  assert.ok(data.reviews.some((r) => r.prNumber === 200));

  const page = await get(`/dashboard?token=${DASHBOARD_TOKEN}`);
  assert.equal(page.status, 200);
  assert.match(page.headers['content-security-policy'], /script-src 'nonce-/);
  assert.equal(page.headers['referrer-policy'], 'no-referrer');
  assert.match(page.body, /Code Review Agent/);
});
