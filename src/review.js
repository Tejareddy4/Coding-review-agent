import { fetchPRDiff, postPRComment } from './github.js';
import { recallMemories } from './hindsight.js';
import { generateReview } from './groq.js';
import { processReviewLearnings } from './memory.js';
import { extractChangedFiles, sanitizeDiff } from './prompts.js';
import { config } from './config.js';
import { childLogger, logContext } from './logger.js';
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

/**
 * Orchestrate the full review flow for one PR event.
 * Never throws: all failures are logged.
 * @param {object} payload - GitHub webhook payload
 * @param {string} [deliveryId] - X-GitHub-Delivery header value
 */
export async function processPR(payload, deliveryId) {
  if (deliveryId) {
    // Persistent claim when the store is enabled; in-memory fallback otherwise.
    const isNew = isStoreEnabled()
      ? await markDeliveryProcessed(deliveryId)
      : !isDuplicateDelivery(deliveryId);
    if (!isNew) {
      log.info({ deliveryId }, 'skipping duplicate delivery');
      return { status: 'duplicate' };
    }
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
  const prNumber = pr.number;
  const prTitle = pr.title;

  // Repo allowlist: when both GITHUB_REPO_OWNER and GITHUB_REPO_NAME are set,
  // refuse anything else — an org-wide webhook must not make the agent review
  // (and comment in) repositories the operator never opted into.
  if (
    config.github.repoOwner &&
    config.github.repoName &&
    (owner !== config.github.repoOwner || repoName !== config.github.repoName)
  ) {
    log.warn(
      { repo: `${owner}/${repoName}`, allowlisted: `${config.github.repoOwner}/${config.github.repoName}` },
      'repository not in allowlist, skipping'
    );
    return { status: 'foreign_repo' };
  }

  const startedAt = Date.now();

  // Everything below runs with this PR attached to every log line.
  return logContext.run(
    { ...logContext.getStore(), pr: `${owner}/${repoName}#${prNumber}` },
    async () => {
      log.info({ action }, 'processing pull request');
      try {
        const diff = await fetchPRDiff(owner, repoName, prNumber);
        if (!diff.trim()) {
          log.info('no diff content; nothing to review');
          return { status: 'empty_diff' };
        }

        const recallStart = Date.now();
        const recallQuery = buildRecallQuery(prTitle, diff);
        const cacheKey = hashRecallQuery(recallQuery);
        let memories = await getCachedMemories(cacheKey);
        if (memories) {
          log.info({ memories: memories.length, cached: true }, 'memories recalled from cache');
        } else {
          memories = await recallMemories(recallQuery);
          await putCachedMemories(cacheKey, memories);
          log.info(
            { memories: memories.length, duration_ms: Date.now() - recallStart },
            'memories recalled'
          );
        }

        const reviewStart = Date.now();
        const review = await generateReview(diff, memories, prTitle);
        log.info({ duration_ms: Date.now() - reviewStart }, 'review generated');

        const commentBody = [
          '## 🤖 Code Review Agent (Hindsight Memory)',
          '',
          review,
          '',
          '---',
          `*Recalled ${memories.length} relevant team decision(s) from long-term memory.*`,
        ].join('\n');

        await postPRComment(owner, repoName, prNumber, commentBody);
        await processReviewLearnings(review, { prNumber, repo: `${owner}/${repoName}` });

        await recordReview({
          deliveryId,
          repo: `${owner}/${repoName}`,
          prNumber,
          status: 'completed',
          memoriesUsed: memories.length,
          durationMs: Date.now() - startedAt,
          reviewText: review,
        });

        log.info(
          {
            status: 'completed',
            memories: memories.length,
            duration_ms: Date.now() - startedAt,
          },
          'review completed'
        );
        return { status: 'completed', memories: memories.length };
      } catch (err) {
        log.error({ err, duration_ms: Date.now() - startedAt }, 'review failed');
        await recordReview({
          deliveryId,
          repo: `${owner}/${repoName}`,
          prNumber,
          status: 'error',
          error: err.message,
          durationMs: Date.now() - startedAt,
        });
        return { status: 'error', error: err.message };
      }
    }
  );
}
