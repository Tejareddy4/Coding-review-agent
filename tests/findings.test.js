import test from 'node:test';
import assert from 'node:assert/strict';
import { commentableLines, annotateDiff } from '../src/diff.js';
import {
  parseStructuredReview,
  renderSummary,
  renderInlineComment,
  riskScore,
  verdictFor,
  citedMemories,
  statusDescription,
  BOT_MARKER,
} from '../src/findings.js';

const DIFF = [
  'diff --git a/src/user.ts b/src/user.ts',
  'index 111..222 100644',
  '--- a/src/user.ts',
  '+++ b/src/user.ts',
  '@@ -10,3 +10,4 @@ export class Users {',
  ' export function getUser(id: any) {',
  "-  console.log('user', id);",
  "+  console.log('user email', id?.email);",
  '+  const x: any = null;',
  ' }',
  'diff --git a/old.js b/old.js',
  'deleted file mode 100644',
  '--- a/old.js',
  '+++ /dev/null',
  '@@ -1,2 +0,0 @@',
  '-a',
  '-b',
  'diff --git a/src/b.js b/src/b.js',
  '--- a/src/b.js',
  '+++ b/src/b.js',
  '@@ -1 +1 @@',
  '-old',
  '+new',
  '\\ No newline at end of file',
].join('\n');

test('commentableLines maps new-side added + context lines per file', () => {
  const map = commentableLines(DIFF);
  assert.deepEqual([...map.get('src/user.ts')].sort((a, b) => a - b), [10, 11, 12, 13]);
  assert.deepEqual([...map.get('src/b.js')], [1]);
  assert.ok(!map.has('old.js'), 'deleted files have no commentable lines');
  assert.ok(!map.has('/dev/null'));
});

test('annotateDiff prefixes hunk lines with new-file line numbers', () => {
  const out = annotateDiff(DIFF);
  assert.match(out, /^\s+11 \+ {2}console\.log\('user email'/m);
  assert.match(out, /^\s+12 \+ {2}const x: any = null;/m);
  assert.match(out, /^\s+- {2}console\.log\('user', id\);/m, 'deleted line has no number');
  assert.match(out, /^\+\+\+ b\/src\/user\.ts$/m, 'headers untouched');
});

const RAW = JSON.stringify({
  summary: 'Logs PII, per security constraint [2]. Ping @octocat.',
  findings: [
    { file: 'src/user.ts', line: 12, severity: 'low', category: 'convention', title: 'any type', detail: 'Avoid any [1]', memory_refs: [1] },
    {
      file: 'b/src/user.ts',
      line: '11',
      severity: 'CRITICAL',
      category: 'security',
      title: 'PII in logs',
      detail: 'Email is logged.',
      suggestion: "  console.log('user', redactSensitive(id));\n```\nbreakout",
      memory_refs: [2, 99],
    },
    { title: '', detail: '' }, // dropped
    { file: 'src/user.ts', line: 3, severity: 'bogus', category: 'nope', title: 'x' },
  ],
});

test('parseStructuredReview normalizes, sorts by severity and sanitizes', () => {
  const r = parseStructuredReview('```json\n' + RAW + '\n```');
  assert.equal(r.findings.length, 3);
  assert.equal(r.findings[0].severity, 'critical', 'most severe first');
  assert.equal(r.findings[0].file, 'src/user.ts', 'b/ prefix stripped');
  assert.equal(r.findings[0].line, 11, 'string line coerced');
  assert.ok(!/`{3,}/.test(r.findings[0].suggestion), 'suggestion cannot break its fence');
  assert.equal(r.findings[1].severity, 'medium', 'unknown severity -> medium');
  assert.equal(r.findings[1].category, 'maintainability');
  assert.ok(!r.summary.includes('@octocat'), 'mentions neutralized');
});

test('parseStructuredReview returns null for prose / wrong shapes', () => {
  assert.equal(parseStructuredReview('## Review\nLooks fine'), null);
  assert.equal(parseStructuredReview('{"foo": 1}'), null);
  assert.equal(parseStructuredReview('{"summary": "cut off'), null);
});

test('risk score, verdict and citations are deterministic', () => {
  const r = parseStructuredReview(RAW);
  assert.equal(riskScore(r.findings), 40 + 8 + 2);
  assert.equal(verdictFor(r.findings), 'request_changes');
  assert.equal(verdictFor([]), 'approve');
  assert.equal(verdictFor([{ severity: 'low' }]), 'comment');
  assert.deepEqual([...citedMemories(r, 2)].sort(), [1, 2], 'out-of-range [99] ignored');
  assert.match(statusDescription(r.findings, 2), /^Risk 50\/100 · 1 critical, 1 medium, 1 low · 2 team memory cited$/);
});

test('renderSummary shows verdict, severity table, findings and memory table', () => {
  const r = parseStructuredReview(RAW);
  const memories = [
    { text: 'Never use `any`.', type: 'convention' },
    { text: 'Never log PII | ever', type: 'security_constraint' },
    { text: 'Unrelated', type: 'decision' },
  ];
  const body = renderSummary({ review: r, memories, inlineCount: 2, model: 'm' });
  assert.ok(body.startsWith(BOT_MARKER));
  assert.match(body, /Code Review Agent \(Hindsight Memory\)/);
  assert.match(body, /🔴 Changes requested · Risk 50\/100/);
  assert.match(body, /\| 1 \| 0 \| 1 \| 1 \|/);
  assert.match(body, /PII in logs\*\* — `src\/user\.ts:11`/);
  assert.match(body, /recalled 3, cited 2/);
  assert.match(body, /Never log PII \\\| ever/, 'pipes escaped in table cells');
  assert.match(body, /2 finding\(s\) posted as inline comments/);
  assert.match(body, /Recalled 3 relevant team decision/);
});

test('renderInlineComment includes suggestion block and memory citation', () => {
  const r = parseStructuredReview(RAW);
  const body = renderInlineComment(r.findings[0], [
    { text: 'a', type: 'convention' },
    { text: 'Never log PII', type: 'security_constraint' },
  ]);
  assert.match(body, /🔴 \*\*Critical\*\* · security — \*\*PII in logs\*\*/);
  assert.match(body, /```suggestion\n {2}console\.log\('user', redactSensitive\(id\)\);/);
  assert.match(body, /Team memory \[2\]\*\* \(security_constraint\): Never log PII/);
  assert.ok(!body.includes('[99]'), 'unknown memory refs not rendered');
});
