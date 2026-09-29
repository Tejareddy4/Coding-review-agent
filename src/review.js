import {
  fetchPRDiff,
  postPRComment,
  createPRReview,
  setCommitStatus,
} from './github.js';
import { recallMemories } from './hindsight.js';
import { generateReviewDetailed } from './groq.js';
import { processReviewLearnings } from './memory.js';
import { extractChangedFiles, sanitizeDiff } from './prompts.js';
import { commentableLines } from './diff.js';
import {
  BOT_MARKER,
  REVIEW_HEADER,
  SEVERITIES,
  citedMemories,
  footer,
  renderInlineComment,
  renderSummary,
  reviewAsText,
  riskScore,
  severityCounts,
  statusDescription,
  verdictFor,
} from './findings.js';
import { config } from './config.js';
import { childLogger, logContext } from './logger.js';
import { recordReviewActivity } from './activity.js';
import {
  isStoreEnabled,
  markDeliveryProcessed,
  getCachedMemories,
  putCachedMemories,
  hashRecallQuery,
  recordReview,
} from './store.js';

const log = childLogger('review');

const PROCESSABLE_ACTIONS = new Set([
  'opened',
  'synchronize',
  'reopened',
  'ready_for_review', // draft -> ready: this is the moment a draft becomes reviewable
]);

// ---------------------------------------------------------------------------
// Idempotency: bounded TTL cache of processed X-GitHub-Delivery IDs.
// GitHub redelivers events on timeout; re-processing would double-comment.
// Map preserves insertion order -> oldest entries evicted first.
// ---------------------------------------------------------------------------
const DEDUPE_TTL_MS = 10 * 60 * 1000;
const DEDUPE_MAX = 1000;
const processedDeliveries = new Map();

/** @returns {boolean} true if this delivery was already seen */
export function isDuplicateDelivery(deliveryId) {
  if (!deliveryId) return false;
  if (processedDeliveries.has(deliveryId)) return true;
  processedDeliveries.set(deliveryId, Date.now());

  if (processedDeliveries.size > DEDUPE_MAX) {
    const oldest = processedDeliveries.keys().next().value;
    processedDeliveries.delete(oldest);
  }
  const cutoff = Date.now() - DEDUPE_TTL_MS;
  for (const [id, ts] of processedDeliveries) {
    if (ts >= cutoff) break; // Map is insertion-ordered; first fresh entry stops scan
    processedDeliveries.delete(id);
  }
  return false;
}

/** Test helper: clear dedupe cache between tests. */
export function resetDedupeCache() {
  processedDeliveries.clear();
}

/**
 * Claim a webhook delivery for processing. Persistent claim when the store
 * is enabled; in-memory fallback otherwise.
 * @param {string} [deliveryId]
 * @returns {Promise<boolean>} true = caller owns it; false = duplicate
 */
export async function claimDelivery(deliveryId) {
  if (!deliveryId) return true;
  return isStoreEnabled()
    ? markDeliveryProcessed(deliveryId)
    : !isDuplicateDelivery(deliveryId);
}

/**
 * Repo allowlist: when both GITHUB_REPO_OWNER and GITHUB_REPO_NAME are set,
 * refuse anything else — an org-wide webhook must not make the agent review
 * (and comment in) repositories the operator never opted into.
 */
export function isAllowedRepo(owner, repoName) {
  const { repoOwner, repoName: allowedName } = config.github;
  if (!repoOwner || !allowedName) return true;
  return owner === repoOwner && repoName === allowedName;
}

/** A commit SHA safe to put in an API path, or undefined. */
export const validSha = (sha) =>
  typeof sha === 'string' && /^[0-9a-f]{40,64}$/i.test(sha) ? sha : undefined;

/**
 * Validate the minimum payload shape needed to process a PR event.
 * @param {any} payload
 * @returns {{ok:boolean, reason?:string}}
 */
export function validatePRPayload(payload) {
  if (!payload || typeof payload !== 'object') return { ok: false, reason: 'payload not an object' };
  if (typeof payload.action !== 'string') return { ok: false, reason: 'missing action' };
  const pr = payload.pull_request;
  const repo = payload.repository;
  if (!pr || typeof pr !== 'object') return { ok: false, reason: 'missing pull_request' };
  if (!Number.isInteger(pr.number)) return { ok: false, reason: 'invalid PR number' };
  if (typeof pr.title !== 'string') return { ok: false, reason: 'missing PR title' };
  if (!repo || !repo.name || !repo.owner?.login) {
    return { ok: false, reason: 'missing repository/owner info' };
  }
  return { ok: true };
}

/**
 * Build the recall query: PR title + changed files + leading diff context.
 * Files carry the strongest signal for convention recall.
 * @param {string} prTitle
 * @param {string} diff
 * @returns {string}
 */
function buildRecallQuery(prTitle, diff) {
  const files = extractChangedFiles(diff);
  const fileBlock = files.length ? `\nChanged files: ${files.join(', ')}` : '';
  return `${prTitle}${fileBlock}\n${sanitizeDiff(diff, 1500)}`;
}

/** Recall memories through the Postgres cache (unless bypassed). */
async function recallWithCache(query, bypassCache) {
  const start = Date.now();
  const cacheKey = hashRecallQuery(query);
  if (!bypassCache) {
    const cached = await getCachedMemories(cacheKey);
    if (cached) {
      log.info({ memories: cached.length, cached: true }, 'memories recalled from cache');
      return cached;
    }
  }
  const memories = await recallMemories(query);
  await putCachedMemories(cacheKey, memories);
  log.info({ memories: memories.length, duration_ms: Date.now() - start }, 'memories recalled');
  return memories;
}

/** Does any finding reach the configured REVIEW_FAIL_ON severity? */
function breachesFailThreshold(findings) {
  const threshold = SEVERITIES.indexOf(config.review.failOn);
  if (threshold === -1) return false; // 'never'
  return findings.some((f) => SEVERITIES.indexOf(f.severity) <= threshold);
}

/**
 * Turn the LLM output into what gets posted: summary body, inline comments
 * (only for findings anchored on lines GitHub accepts) and review metadata.
 */
function composeReview(gen, diff, memories) {
  if (!gen.structured) {
    return {
      body: [BOT_MARKER, REVIEW_HEADER, '', gen.text, '', '---', footer(memories.length, gen.model)].join('\n'),
      inline: [],
      learnText: gen.text,
      meta: { verdict: null, risk: null, counts: null, cited: 0, findings: [] },
    };
  }
  const review = gen.structured;
  const anchors = commentableLines(diff);
  const inline = config.review.inlineComments
    ? review.findings
        .filter((f) => f.file && f.line && anchors.get(f.file)?.has(f.line))
        .map((f) => ({ path: f.file, line: f.line, body: renderInlineComment(f, memories) }))
    : [];
  return {
    body: renderSummary({ review, memories, inlineCount: inline.length, model: gen.model }),
    fallbackBody: renderSummary({ review, memories, inlineCount: 0, model: gen.model }),
    inline,
    learnText: reviewAsText(review),
    meta: {
      verdict: verdictFor(review.findings),
      risk: riskScore(review.findings),
      counts: severityCounts(review.findings),
      cited: citedMemories(review, memories.length).size,
      findings: review.findings,
    },
  };
}

/**
 * Post the review: a PR review with inline comments when there are anchored
 * findings, otherwise (or if GitHub rejects the review) a plain PR comment.
 * @returns {Promise<{url:string, inlineCount:number}>}
 */
async function publishReview(owner, repoName, prNumber, headSha, composed) {
  const prUrl = `https://github.com/${owner}/${repoName}/pull/${prNumber}`;
  if (composed.inline.length) {
    try {
      const { url } = await createPRReview(owner, repoName, prNumber, {
        body: composed.body,
        comments: composed.inline,
        commitId: headSha,
      });
      return { url: url || prUrl, inlineCount: composed.inline.length };
    } catch (err) {
      log.warn({ err }, 'inline review rejected; falling back to a summary comment');
    }
  }
  const commentId = await postPRComment(
    owner,
    repoName,
    prNumber,
    composed.inline.length ? composed.fallbackBody : composed.body
  );
  return { url: commentId ? `${prUrl}#issuecomment-${commentId}` : prUrl, inlineCount: 0 };
}

/**
 * Run the full review pipeline for one PR: diff -> recall -> LLM review ->
 * post (summary + inline comments) -> commit status -> learn -> audit.
 * Never throws: failures are logged and returned as { status: 'error' }.
 * @param {object} args
 * @param {string} args.owner
 * @param {string} args.repoName
 * @param {number} args.prNumber
 * @param {string} args.prTitle
 * @param {string} [args.headSha] - enables the commit status + pins inline comments to this commit
 * @param {string} [args.deliveryId]
 * @param {'webhook'|'command'|'cli'} [args.trigger]
 * @param {boolean} [args.dryRun] - generate but post/persist nothing (CLI preview)
 * @param {boolean} [args.bypassCache] - skip the recall cache (explicit re-review)
 */
export async function runReview({
  owner,
  repoName,
  prNumber,
  prTitle,
  headSha,
  deliveryId,
  trigger = 'webhook',
  dryRun = false,
  bypassCache = false,
}) {
  const startedAt = Date.now();
  const repo = `${owner}/${repoName}`;

  // Everything below runs with this PR attached to every log line.
  return logContext.run({ ...logContext.getStore(), pr: `${repo}#${prNumber}` }, async () => {
    log.info({ trigger }, 'processing pull request');
    try {
      const diff = await fetchPRDiff(owner, repoName, prNumber);
      if (!diff.trim()) {
        log.info('no diff content; nothing to review');
        return { status: 'empty_diff' };
      }

      const memories = await recallWithCache(buildRecallQuery(prTitle, diff), bypassCache);

      const reviewStart = Date.now();
      const gen = await generateReviewDetailed(diff, memories, prTitle);
      log.info({ duration_ms: Date.now() - reviewStart, structured: !!gen.structured }, 'review generated');

      const composed = composeReview(gen, diff, memories);
      const { meta } = composed;

      if (dryRun) {
        return { status: 'dry_run', body: composed.body, inline: composed.inline, memories: memories.length };
      }

      const { url, inlineCount } = await publishReview(owner, repoName, prNumber, headSha, composed);

      if (config.review.commitStatus && headSha) {
        let state = 'success';
        let description = 'Review posted';
        if (gen.failed) {
          state = 'error';
          description = 'Review could not be generated — review manually';
        } else if (gen.structured) {
          state = breachesFailThreshold(meta.findings) ? 'failure' : 'success';
          description = statusDescription(meta.findings, meta.cited);
        }
        await setCommitStatus(owner, repoName, headSha, { state, description, targetUrl: url });
      }

      if (!gen.failed) {
        await processReviewLearnings(composed.learnText, { prNumber, repo });
      }

      const record = {
        repo,
        prNumber,
        prTitle,
        status: 'completed',
        verdict: meta.verdict,
        risk: meta.risk,
        counts: meta.counts,
        memoriesUsed: memories.length,
        memoriesCited: meta.cited,
        inlineComments: inlineCount,
        model: gen.model,
        durationMs: Date.now() - startedAt,
        url,
        trigger,
      };
      await recordReview({ ...record, deliveryId, reviewText: gen.text });
      recordReviewActivity(record);

      log.info(
        {
          status: 'completed',
          memories: memories.length,
          findings: meta.findings.length,
          inline_comments: inlineCount,
          duration_ms: record.durationMs,
        },
        'review completed'
      );
      return { status: 'completed', memories: memories.length, findings: meta.findings.length, url };
    } catch (err) {
      log.error({ err, duration_ms: Date.now() - startedAt }, 'review failed');
      const record = {
        repo,
        prNumber,
        prTitle,
        status: 'error',
        durationMs: Date.now() - startedAt,
        trigger,
      };
      await recordReview({ ...record, deliveryId, error: err.message });
      recordReviewActivity(record);
      return { status: 'error', error: err.message };
    }
  });
}

/**
 * Handle one pull_request webhook event: dedupe, validate, filter, allowlist,
 * then run the review. Never throws: all failures are logged.
 * @param {object} payload - GitHub webhook payload
 * @param {string} [deliveryId] - X-GitHub-Delivery header value
 */
export async function processPR(payload, deliveryId) {
  if (!(await claimDelivery(deliveryId))) {
    log.info({ deliveryId }, 'skipping duplicate delivery');
    return { status: 'duplicate' };
  }

  const shape = validatePRPayload(payload);
  if (!shape.ok) {
    log.warn({ reason: shape.reason }, 'rejecting malformed payload');
    return { status: 'invalid_payload' };
  }

  const { action, pull_request: pr, repository: repo } = payload;

  if (!PROCESSABLE_ACTIONS.has(action)) {
    log.info({ action }, 'skipping action');
    return { status: 'skipped_action' };
  }

  // Drafts are work-in-progress; review when they are marked ready
  // (GitHub then sends the ready_for_review action).
  if (pr.draft === true) {
    log.info({ action }, 'skipping draft PR until ready_for_review');
    return { status: 'skipped_draft' };
  }

  const owner = repo.owner.login;
  const repoName = repo.name;

  if (!isAllowedRepo(owner, repoName)) {
    log.warn(
      { repo: `${owner}/${repoName}`, allowlisted: `${config.github.repoOwner}/${config.github.repoName}` },
      'repository not in allowlist, skipping'
    );
    return { status: 'foreign_repo' };
  }

  return runReview({
    owner,
    repoName,
    prNumber: pr.number,
    prTitle: pr.title,
    headSha: validSha(pr.head?.sha),
    deliveryId,
    trigger: 'webhook',
  });
}
