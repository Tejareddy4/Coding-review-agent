/**
 * Structured review model: parse the LLM's JSON review, score it, and render
 * it as GitHub markdown (summary comment + inline line comments).
 *
 * Everything the LLM wrote is untrusted: it is length-capped, stripped of
 * @-mentions (no pinging random users) and of fence runs that could break
 * out of a ```suggestion block.
 */

/** Hidden marker on every comment we post; comments containing it are never parsed as commands. */
export const BOT_MARKER = '<!-- code-review-agent -->';
export const REVIEW_HEADER = '## 🤖 Code Review Agent (Hindsight Memory)';

export const SEVERITIES = ['critical', 'high', 'medium', 'low'];
const SEVERITY_ICON = { critical: '🔴', high: '🟠', medium: '🟡', low: '🔵' };
const SEVERITY_WEIGHT = { critical: 40, high: 20, medium: 8, low: 2 };
const CATEGORIES = new Set(['security', 'bug', 'performance', 'convention', 'maintainability']);
const MAX_FINDINGS = 10;

const VERDICTS = {
  request_changes: { icon: '🔴', label: 'Changes requested' },
  comment: { icon: '🟡', label: 'Needs attention' },
  approve: { icon: '🟢', label: 'Looks good to merge' },
};

/**
 * Parse a JSON object out of an LLM response string.
 * Tolerates ```json fences and trailing prose.
 * @param {string} raw
 * @returns {object|null}
 */
export function parseLooseJson(raw) {
  const block = String(raw).match(/\{[\s\S]*\}/); // outermost {...} block
  const candidate = block ? block[0] : raw;
  try {
    return JSON.parse(candidate);
  } catch {
    return null;
  }
}

/** Neutralize untrusted LLM text before it lands in a GitHub comment. */
function clean(text, max) {
  return String(text ?? '')
    .replace(/`{3,}/g, '``') // cannot open/close a fence
    .replace(/@(?=[A-Za-z0-9-])/g, '@​') // no accidental @-mentions
    .trim()
    .slice(0, max);
}

/** Single-line variant for table cells / headlines. */
const cleanInline = (text, max) =>
  clean(text, max).replace(/\s*\n\s*/g, ' ').replace(/\|/g, '\\|');

const capitalize = (s) => s.charAt(0).toUpperCase() + s.slice(1);

function normalizeFinding(f) {
  if (!f || typeof f !== 'object') return null;
  const title = cleanInline(f.title, 120);
  const detail = clean(f.detail, 800);
  if (!title && !detail) return null;
  const line = Number.parseInt(f.line, 10);
  const severity = String(f.severity).toLowerCase();
  const category = String(f.category).toLowerCase();
  return {
    file: typeof f.file === 'string' ? f.file.trim().replace(/^(?:b\/|\.\/)/, '') : null,
    line: Number.isInteger(line) && line > 0 ? line : null,
    severity: SEVERITIES.includes(severity) ? severity : 'medium',
    category: CATEGORIES.has(category) ? category : 'maintainability',
    title: title || cleanInline(detail, 80),
    detail,
    suggestion:
      typeof f.suggestion === 'string' && f.suggestion.trim()
        ? f.suggestion.replace(/`{3,}/g, '``').replace(/\r/g, '').replace(/\n+$/, '').slice(0, 1000)
        : null,
    memoryRefs: Array.isArray(f.memory_refs)
      ? [...new Set(f.memory_refs.map(Number).filter((n) => Number.isInteger(n) && n > 0))]
      : [],
  };
}

/**
 * Parse the model's structured review. Returns null when the output is not
 * the expected JSON shape (caller then falls back to a prose review).
 * @param {string} raw
 * @returns {{summary:string, findings:Array<object>}|null}
 */
export function parseStructuredReview(raw) {
  const obj = parseLooseJson(raw);
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return null;
  if (typeof obj.summary !== 'string' && !Array.isArray(obj.findings)) return null;
  const findings = (Array.isArray(obj.findings) ? obj.findings : [])
    .map(normalizeFinding)
    .filter(Boolean)
    .sort((a, b) => SEVERITIES.indexOf(a.severity) - SEVERITIES.indexOf(b.severity))
    .slice(0, MAX_FINDINGS);
  return { summary: clean(obj.summary, 1500), findings };
}

/** Count findings per severity. */
export function severityCounts(findings) {
  const counts = { critical: 0, high: 0, medium: 0, low: 0 };
  for (const f of findings) counts[f.severity]++;
  return counts;
}

/** 0-100 risk score: severity-weighted, capped. */
export function riskScore(findings) {
  return Math.min(100, findings.reduce((sum, f) => sum + SEVERITY_WEIGHT[f.severity], 0));
}

/**
 * Deterministic verdict from the findings (never trust a model "approve"
 * that also reported a critical issue).
 * @returns {'request_changes'|'comment'|'approve'}
 */
export function verdictFor(findings) {
  const c = severityCounts(findings);
  if (c.critical || c.high) return 'request_changes';
  if (c.medium || c.low) return 'comment';
  return 'approve';
}

/**
 * Memory numbers (1-based) the review actually cited, via memory_refs or
 * inline "[n]" references in the text.
 * @param {{summary:string, findings:Array<object>}} review
 * @param {number} memoryCount
 * @returns {Set<number>}
 */
export function citedMemories(review, memoryCount) {
  const cited = new Set();
  for (const f of review.findings) f.memoryRefs.forEach((n) => cited.add(n));
  const texts = [review.summary, ...review.findings.flatMap((f) => [f.title, f.detail])];
  for (const t of texts) {
    for (const m of String(t).matchAll(/\[(\d{1,2})\]/g)) cited.add(Number(m[1]));
  }
  return new Set([...cited].filter((n) => n >= 1 && n <= memoryCount));
}

/** `src/a.ts:12` location label. */
const location = (f) => (f.file ? `\`${f.file}${f.line ? `:${f.line}` : ''}\`` : '');

/**
 * Body for one inline (line-anchored) review comment.
 * @param {object} f - normalized finding
 * @param {Array<{text:string,type:string}>} memories - recalled memories (1-based refs)
 * @returns {string}
 */
export function renderInlineComment(f, memories = []) {
  const parts = [
    `${SEVERITY_ICON[f.severity]} **${capitalize(f.severity)}** · ${f.category} — **${f.title}**`,
  ];
  if (f.detail) parts.push('', f.detail);
  if (f.suggestion !== null) parts.push('', '```suggestion', f.suggestion, '```');
  const refs = f.memoryRefs.filter((n) => memories[n - 1]);
  if (refs.length) parts.push('');
  for (const n of refs) {
    const m = memories[n - 1];
    parts.push(`> 🧠 **Team memory [${n}]** (${cleanInline(m.type, 40)}): ${cleanInline(m.text, 200)}`);
  }
  return parts.join('\n');
}

/** Shared footer line (also used by the prose fallback). */
export function footer(memoryCount, model) {
  const parts = [`*Recalled ${memoryCount} relevant team decision(s) from long-term memory.*`];
  if (model) parts.push(`\`${model}\``);
  parts.push('Reply `/help` for commands');
  return parts.join(' · ');
}

/**
 * The summary comment / review body.
 * @param {object} args
 * @param {{summary:string, findings:Array<object>}} args.review
 * @param {Array<{text:string,type:string}>} args.memories
 * @param {number} [args.inlineCount] - findings posted as inline comments
 * @param {string} [args.model]
 * @returns {string}
 */
export function renderSummary({ review, memories, inlineCount = 0, model }) {
  const { findings } = review;
  const verdict = VERDICTS[verdictFor(findings)];
  const counts = severityCounts(findings);
  const cited = citedMemories(review, memories.length);

  const lines = [
    BOT_MARKER,
    REVIEW_HEADER,
    '',
    `### ${verdict.icon} ${verdict.label} · Risk ${riskScore(findings)}/100`,
    '',
  ];
  if (review.summary) lines.push(review.summary, '');

  if (findings.length) {
    lines.push(
      '| 🔴 Critical | 🟠 High | 🟡 Medium | 🔵 Low |',
      '|:-:|:-:|:-:|:-:|',
      `| ${counts.critical} | ${counts.high} | ${counts.medium} | ${counts.low} |`,
      '',
      '**Findings**',
      ''
    );
    findings.forEach((f, i) => {
      const where = location(f);
      const mem = f.memoryRefs.length ? ` · 🧠 ${f.memoryRefs.map((n) => `[${n}]`).join('')}` : '';
      lines.push(
        `${i + 1}. ${SEVERITY_ICON[f.severity]} **${f.title}**${where ? ` — ${where}` : ''} · _${f.category}_${mem}`
      );
    });
    lines.push('');
    if (inlineCount) {
      lines.push(
        `💬 ${inlineCount} finding(s) posted as inline comments on the diff — suggested fixes can be applied in one click.`,
        ''
      );
    }
  } else {
    lines.push('✅ No issues found in this change.', '');
  }

  if (memories.length) {
    lines.push(
      '<details>',
      `<summary>🧠 Team memory — recalled ${memories.length}, cited ${cited.size}</summary>`,
      '',
      '| # | Type | Memory | Cited |',
      '|:-:|---|---|:-:|'
    );
    memories.forEach((m, i) => {
      lines.push(
        `| ${i + 1} | ${cleanInline(m.type, 40)} | ${cleanInline(m.text, 220)} | ${cited.has(i + 1) ? '✅' : '—'} |`
      );
    });
    lines.push('', '</details>', '');
  }

  lines.push('---', footer(memories.length, model));
  return lines.join('\n');
}

/**
 * Plain-text rendering fed to the learning extractor (it should learn from
 * the reasoning, not from JSON syntax).
 */
export function reviewAsText(review) {
  return [
    review.summary,
    ...review.findings.map(
      (f) => `- [${f.severity}/${f.category}] ${f.title}${f.file ? ` (${f.file})` : ''}: ${f.detail}`
    ),
  ].join('\n');
}

/** One-line commit-status description (GitHub caps it at 140 chars). */
export function statusDescription(findings, citedCount) {
  const counts = severityCounts(findings);
  const parts = SEVERITIES.filter((s) => counts[s]).map((s) => `${counts[s]} ${s}`);
  const summary = parts.length ? parts.join(', ') : 'no issues';
  return `Risk ${riskScore(findings)}/100 · ${summary} · ${citedCount} team memory cited`.slice(0, 140);
}
