import express from 'express';
import crypto from 'node:crypto';
import { config } from './config.js';
import { getActivity } from './activity.js';

/**
 * Live dashboard: GET /dashboard (page) + GET /api/activity (JSON feed).
 *
 * Access: when DASHBOARD_TOKEN is set it is required (?token= on first load,
 * then an Authorization: Bearer header from the page). Without a token the
 * dashboard is served only outside production — review text and team
 * memories must never be public by accident.
 */

const sha = (s) => crypto.createHash('sha256').update(String(s)).digest();

function presentedToken(req) {
  const auth = req.headers.authorization;
  if (typeof auth === 'string' && auth.startsWith('Bearer ')) return auth.slice(7);
  return typeof req.query.token === 'string' ? req.query.token : '';
}

function authorize(req, res, next) {
  const { token } = config.dashboard;
  if (!token) {
    if (config.nodeEnv === 'production') {
      return res.status(404).type('text').send('Dashboard disabled: set DASHBOARD_TOKEN to enable it.');
    }
    return next();
  }
  // Hash both sides: constant-length, timing-safe comparison.
  if (!crypto.timingSafeEqual(sha(presentedToken(req)), sha(token))) {
    return res.status(401).type('text').send('Unauthorized: open /dashboard?token=<DASHBOARD_TOKEN>');
  }
  next();
}

export function dashboardRouter() {
  const router = express.Router();

  router.get('/api/activity', authorize, (_req, res) => {
    res.set('Cache-Control', 'no-store').json(getActivity());
  });

  router.get('/dashboard', authorize, (_req, res) => {
    const nonce = crypto.randomBytes(16).toString('base64');
    res
      .set({
        'Cache-Control': 'no-store',
        'Referrer-Policy': 'no-referrer', // the ?token= URL must never leak via links
        'X-Content-Type-Options': 'nosniff',
        'Content-Security-Policy': [
          "default-src 'none'",
          `script-src 'nonce-${nonce}'`,
          "style-src 'unsafe-inline'",
          "connect-src 'self'",
          "img-src 'self' data:",
          "base-uri 'none'",
          "form-action 'none'",
          "frame-ancestors 'none'",
        ].join('; '),
      })
      .type('html')
      .send(PAGE.replace('__NONCE__', nonce));
  });

  return router;
}

const PAGE = /* html */ `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="no-referrer">
<link rel="icon" href="data:,">
<title>Review Agent Live</title>
<style>
  :root {
    --bg: #f6f7f9; --panel: #ffffff; --ink: #151a23; --muted: #5d6675; --line: #e3e6eb;
    --accent: #6d4aff; --accent-soft: #efeaff;
    --crit: #d92d20; --high: #e8590c; --med: #d4a106; --low: #2f6fdb; --ok: #16a34a;
    --shadow: 0 1px 2px rgba(16,24,40,.06), 0 1px 3px rgba(16,24,40,.08);
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --bg: #0d1017; --panel: #151a23; --ink: #e8ebf1; --muted: #9099a8; --line: #252c38;
      --accent: #9b85ff; --accent-soft: #231d3d;
      --crit: #f0605a; --high: #fb8a3c; --med: #f2c94c; --low: #63a0ff; --ok: #3fcf73;
      --shadow: none;
    }
  }
  * { box-sizing: border-box; }
  body { margin: 0; background: var(--bg); color: var(--ink);
    font: 15px/1.5 ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; }
  .wrap { max-width: 1200px; margin: 0 auto; padding: 24px 16px 48px; }
  header { display: flex; flex-wrap: wrap; align-items: center; gap: 12px 16px; margin-bottom: 24px; }
  h1 { font-size: 22px; margin: 0; letter-spacing: -.01em; }
  .sub { color: var(--muted); font-size: 14px; }
  .live { display: inline-flex; align-items: center; gap: 8px; padding: 4px 10px; border-radius: 999px;
    background: var(--accent-soft); color: var(--accent); font-size: 13px; font-weight: 600; }
  .dot { width: 8px; height: 8px; border-radius: 50%; background: var(--ok); animation: pulse 2s infinite; }
  .dot.off { background: var(--crit); animation: none; }
  @keyframes pulse { 0% { box-shadow: 0 0 0 0 rgba(22,163,74,.5); } 70% { box-shadow: 0 0 0 8px rgba(22,163,74,0); } 100% { box-shadow: 0 0 0 0 rgba(22,163,74,0); } }
  @media (prefers-reduced-motion: reduce) { .dot { animation: none; } }
  .spacer { flex: 1; }
  .kpis { display: grid; grid-template-columns: repeat(auto-fit, minmax(160px, 1fr)); gap: 12px; margin-bottom: 16px; }
  .card { background: var(--panel); border: 1px solid var(--line); border-radius: 12px; box-shadow: var(--shadow); }
  .kpi { padding: 14px 16px; }
  .kpi .label { color: var(--muted); font-size: 13px; }
  .kpi .value { font-size: 28px; font-weight: 700; letter-spacing: -.02em; font-variant-numeric: tabular-nums; }
  .kpi .hint { color: var(--muted); font-size: 12px; min-height: 18px; }
  .sev { padding: 16px; margin-bottom: 16px; }
  .sev h2, .panel h2 { font-size: 15px; margin: 0 0 12px; }
  .bar { display: flex; height: 12px; border-radius: 999px; overflow: hidden; background: var(--line); }
  .bar span { display: block; height: 100%; transition: width .4s ease; }
  .legend { display: flex; flex-wrap: wrap; gap: 8px 20px; margin-top: 10px; font-size: 13px; color: var(--muted); }
  .legend b { color: var(--ink); font-variant-numeric: tabular-nums; }
  .sw { display: inline-block; width: 10px; height: 10px; border-radius: 3px; margin-right: 6px; vertical-align: -1px; }
  .grid { display: grid; grid-template-columns: minmax(0, 3fr) minmax(0, 2fr); gap: 16px; }
  @media (max-width: 860px) { .grid { grid-template-columns: minmax(0, 1fr); } }
  .panel { padding: 16px; }
  .review { padding: 12px 0; border-top: 1px solid var(--line); }
  .review:first-of-type { border-top: 0; padding-top: 0; }
  .rtop { display: flex; gap: 10px; align-items: baseline; flex-wrap: wrap; }
  .rtitle { font-weight: 600; overflow-wrap: anywhere; }
  .rtitle a { color: inherit; text-decoration: none; }
  .rtitle a:hover { text-decoration: underline; }
  .badge { font-size: 12px; font-weight: 600; padding: 2px 8px; border-radius: 999px; white-space: nowrap; border: 1px solid transparent; }
  .b-request_changes { color: var(--crit); border-color: var(--crit); }
  .b-comment { color: var(--med); border-color: var(--med); }
  .b-approve { color: var(--ok); border-color: var(--ok); }
  .b-none { color: var(--muted); border-color: var(--line); }
  .b-error { color: #fff; background: var(--crit); }
  .chips { display: flex; flex-wrap: wrap; gap: 6px 12px; margin-top: 6px; color: var(--muted); font-size: 13px; }
  .chips .c { font-variant-numeric: tabular-nums; }
  .feed-item { display: grid; grid-template-columns: 28px minmax(0, 1fr); gap: 8px; padding: 10px 0; border-top: 1px solid var(--line); }
  .feed-item:first-of-type { border-top: 0; padding-top: 0; }
  .feed-icon { font-size: 18px; line-height: 1.3; }
  .feed-text { overflow-wrap: anywhere; }
  .meta { color: var(--muted); font-size: 12px; }
  .type { font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: .04em; color: var(--accent); }
  .empty { color: var(--muted); padding: 24px 0; text-align: center; }
  code { font: 12px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; background: var(--accent-soft); padding: 1px 5px; border-radius: 4px; }
</style>
</head>
<body>
<div class="wrap">
  <header>
    <div>
      <h1>🤖 Code Review Agent</h1>
      <div class="sub">Reviews that remember your team's decisions — powered by Hindsight memory</div>
    </div>
    <div class="spacer"></div>
    <span class="live"><span class="dot" id="dot"></span><span id="status">connecting…</span></span>
  </header>

  <section class="kpis" id="kpis"></section>

  <section class="card sev">
    <h2>Findings by severity</h2>
    <div class="bar" id="bar"></div>
    <div class="legend" id="legend"></div>
  </section>

  <section class="grid">
    <div class="card panel">
      <h2>Recent reviews</h2>
      <div id="reviews"></div>
    </div>
    <div class="card panel">
      <h2>🧠 Memory feed</h2>
      <div id="feed"></div>
    </div>
  </section>
</div>

<script nonce="__NONCE__">
(() => {
  // Move the token out of the URL (history, screenshots) into this tab's session.
  const params = new URLSearchParams(location.search);
  let token = params.get('token') || '';
  try {
    if (token) sessionStorage.setItem('dash-token', token);
    else token = sessionStorage.getItem('dash-token') || '';
  } catch {}
  if (params.has('token')) history.replaceState(null, '', location.pathname);

  const SEV = [
    ['critical', 'Critical', 'var(--crit)'],
    ['high', 'High', 'var(--high)'],
    ['medium', 'Medium', 'var(--med)'],
    ['low', 'Low', 'var(--low)'],
  ];
  const VERDICT = { request_changes: '🔴 Changes requested', comment: '🟡 Needs attention', approve: '🟢 Looks good' };

  const el = (tag, props = {}, ...kids) => {
    const n = document.createElement(tag);
    for (const [k, v] of Object.entries(props)) {
      if (k === 'style') n.style.cssText = v; else if (k in n) n[k] = v; else n.setAttribute(k, v);
    }
    for (const k of kids.flat()) if (k != null && k !== false) n.append(k instanceof Node ? k : String(k));
    return n;
  };
  const ago = (iso) => {
    const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
    if (s < 60) return Math.floor(s) + 's ago';
    if (s < 3600) return Math.floor(s / 60) + 'm ago';
    if (s < 86400) return Math.floor(s / 3600) + 'h ago';
    return Math.floor(s / 86400) + 'd ago';
  };
  const secs = (ms) => (ms ? (ms / 1000).toFixed(1) + 's' : '—');
  const safeUrl = (u) => (typeof u === 'string' && u.startsWith('https://') ? u : null);

  function kpi(label, value, hint) {
    return el('div', { className: 'card kpi' },
      el('div', { className: 'label' }, label),
      el('div', { className: 'value' }, value),
      el('div', { className: 'hint' }, hint || ''));
  }

  function renderKpis(s) {
    const rate = s.memoriesUsed ? Math.round((s.memoriesCited / s.memoriesUsed) * 100) + '% cited in reviews' : 'no recalls yet';
    document.getElementById('kpis').replaceChildren(
      kpi('PRs reviewed', s.reviews, s.failedReviews ? s.failedReviews + ' failed' : 'all succeeded'),
      kpi('Findings', s.findingsTotal, s.findings.critical ? s.findings.critical + ' critical' : 'no critical issues'),
      kpi('Memories recalled', s.memoriesUsed, rate),
      kpi('Learnings retained', s.learnings, 'the team memory keeps growing'),
      kpi('Chat commands', s.commands, '/remember · /ask · /review'),
      kpi('Avg review time', secs(s.avgDurationMs), 'webhook → posted review'),
    );
  }

  function renderSeverity(f) {
    const total = SEV.reduce((a, [k]) => a + (f[k] || 0), 0);
    document.getElementById('bar').replaceChildren(...SEV.map(([k, , color]) =>
      el('span', { style: 'width:' + (total ? (f[k] / total) * 100 : 0) + '%;background:' + color, title: k })));
    document.getElementById('legend').replaceChildren(...SEV.map(([k, label, color]) =>
      el('span', {}, el('span', { className: 'sw', style: 'background:' + color }), label + ' ', el('b', {}, f[k] || 0))));
  }

  function renderReviews(list) {
    const root = document.getElementById('reviews');
    if (!list.length) return root.replaceChildren(el('div', { className: 'empty' }, 'No reviews yet — open a pull request to see the agent at work.'));
    root.replaceChildren(...list.slice(0, 15).map((r) => {
      const url = safeUrl(r.url);
      const name = r.repo + ' #' + r.prNumber + (r.prTitle ? ' — ' + r.prTitle : '');
      const badge = r.status !== 'completed'
        ? el('span', { className: 'badge b-error' }, 'error')
        : el('span', { className: 'badge b-' + (r.verdict || 'none') }, VERDICT[r.verdict] || 'reviewed');
      const c = r.counts || {};
      const sevText = SEV.filter(([k]) => c[k]).map(([k]) => c[k] + ' ' + k).join(' · ');
      return el('div', { className: 'review' },
        el('div', { className: 'rtop' },
          badge,
          el('span', { className: 'rtitle' }, url ? el('a', { href: url, target: '_blank', rel: 'noopener noreferrer' }, name) : name)),
        el('div', { className: 'chips' },
          r.risk != null ? el('span', { className: 'c' }, 'Risk ' + r.risk + '/100') : null,
          sevText ? el('span', { className: 'c' }, sevText) : null,
          el('span', { className: 'c' }, '🧠 ' + (r.memoriesCited || 0) + '/' + (r.memoriesUsed || 0) + ' memories cited'),
          r.inlineComments ? el('span', { className: 'c' }, '💬 ' + r.inlineComments + ' inline') : null,
          r.trigger === 'command' ? el('span', { className: 'c' }, '↻ via /review') : null,
          el('span', { className: 'c' }, secs(r.durationMs)),
          r.model ? el('code', {}, r.model) : null,
          el('span', { className: 'c' }, ago(r.at))));
    }));
  }

  function renderFeed(learnings, commands) {
    const items = [
      ...learnings.map((l) => ({ at: l.at, kind: 'learning', l })),
      ...commands.map((c) => ({ at: c.at, kind: 'command', c })),
    ].sort((a, b) => (a.at < b.at ? 1 : -1)).slice(0, 25);
    const root = document.getElementById('feed');
    if (!items.length) return root.replaceChildren(el('div', { className: 'empty' }, 'Memory is empty — seed it, or teach it with /remember in a PR.'));
    root.replaceChildren(...items.map((it) => {
      if (it.kind === 'command') {
        const c = it.c;
        return el('div', { className: 'feed-item' },
          el('div', { className: 'feed-icon' }, c.ok ? '💬' : '⚠️'),
          el('div', {},
            el('div', { className: 'feed-text' }, '@' + c.user + ' ran ', el('code', {}, '/' + c.command)),
            el('div', { className: 'meta' }, c.repo + ' #' + c.prNumber + ' · ' + ago(c.at))));
      }
      const l = it.l;
      const taught = l.source && l.source !== 'review';
      return el('div', { className: 'feed-item' },
        el('div', { className: 'feed-icon' }, taught ? '🗣️' : '🧠'),
        el('div', {},
          el('div', { className: 'type' }, (l.type || 'memory').replace('_', ' ') + (l.retained ? '' : ' · not retained')),
          el('div', { className: 'feed-text' }, l.content),
          el('div', { className: 'meta' }, (taught ? 'taught by ' + l.source : 'learned from review') + ' · ' + l.repo + ' #' + l.prNumber + ' · ' + ago(l.at))));
    }));
  }

  async function refresh() {
    const dot = document.getElementById('dot');
    const status = document.getElementById('status');
    try {
      const res = await fetch('/api/activity', { headers: token ? { Authorization: 'Bearer ' + token } : {}, cache: 'no-store' });
      if (!res.ok) throw new Error(res.status === 401 ? 'unauthorized — add ?token=' : 'HTTP ' + res.status);
      const data = await res.json();
      renderKpis(data.stats);
      renderSeverity(data.stats.findings);
      renderReviews(data.reviews);
      renderFeed(data.learnings, data.commands);
      dot.className = 'dot';
      status.textContent = 'live · updated ' + new Date().toLocaleTimeString();
    } catch (err) {
      dot.className = 'dot off';
      status.textContent = 'offline · ' + err.message;
    }
  }

  refresh();
  setInterval(refresh, 5000);
})();
</script>
</body>
</html>`;
