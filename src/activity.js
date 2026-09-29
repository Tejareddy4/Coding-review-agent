/**
 * In-memory activity feed behind the live dashboard: the most recent
 * reviews, learnings and chat commands. Bounded ring buffers — never grows.
 * When Postgres is enabled the feed is hydrated from it at boot, so the
 * dashboard survives restarts (e.g. a free-tier instance waking up).
 */

const MAX_ITEMS = 50;

const feed = {
  reviews: [],
  learnings: [],
  commands: [],
};

const push = (list, item) => {
  list.unshift({ at: new Date().toISOString(), ...item });
  if (list.length > MAX_ITEMS) list.length = MAX_ITEMS;
};

/**
 * @param {{repo:string, prNumber:number, prTitle?:string, status:string, verdict?:string|null,
 *   risk?:number|null, counts?:object|null, memoriesUsed?:number, memoriesCited?:number,
 *   inlineComments?:number, model?:string|null, durationMs?:number, url?:string|null, trigger?:string}} entry
 */
export function recordReviewActivity(entry) {
  push(feed.reviews, entry);
}

/** @param {{repo:string, prNumber:number, type:string, content:string, retained:boolean, source:string}} entry */
export function recordLearningActivity(entry) {
  push(feed.learnings, entry);
}

/** @param {{repo:string, prNumber:number, user:string, command:string, ok:boolean}} entry */
export function recordCommandActivity(entry) {
  push(feed.commands, entry);
}

/** Seed the feed from persisted rows (newest first). Existing entries win. */
export function hydrateActivity({ reviews = [], learnings = [] } = {}) {
  if (!feed.reviews.length) feed.reviews.push(...reviews.slice(0, MAX_ITEMS));
  if (!feed.learnings.length) feed.learnings.push(...learnings.slice(0, MAX_ITEMS));
}

/** Snapshot + aggregate stats for the dashboard API. */
export function getActivity() {
  const completed = feed.reviews.filter((r) => r.status === 'completed');
  const findings = { critical: 0, high: 0, medium: 0, low: 0 };
  let memoriesUsed = 0;
  let memoriesCited = 0;
  let durationTotal = 0;
  for (const r of completed) {
    for (const k of Object.keys(findings)) findings[k] += r.counts?.[k] ?? 0;
    memoriesUsed += r.memoriesUsed ?? 0;
    memoriesCited += r.memoriesCited ?? 0;
    durationTotal += r.durationMs ?? 0;
  }
  return {
    generatedAt: new Date().toISOString(),
    stats: {
      reviews: completed.length,
      failedReviews: feed.reviews.length - completed.length,
      findings,
      findingsTotal: Object.values(findings).reduce((a, b) => a + b, 0),
      memoriesUsed,
      memoriesCited,
      learnings: feed.learnings.filter((l) => l.retained).length,
      commands: feed.commands.length,
      avgDurationMs: completed.length ? Math.round(durationTotal / completed.length) : 0,
    },
    reviews: feed.reviews,
    learnings: feed.learnings,
    commands: feed.commands,
  };
}

/** Test helper. */
export function resetActivity() {
  feed.reviews.length = 0;
  feed.learnings.length = 0;
  feed.commands.length = 0;
}
