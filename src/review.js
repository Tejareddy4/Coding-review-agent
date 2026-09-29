import { fetchPRDiff, postPRComment } from './github.js';
import { recallMemories } from './hindsight.js';
import { generateReview } from './groq.js';
import { processReviewLearnings } from './memory.js';
import { extractChangedFiles, sanitizeDiff } from './prompts.js';
import { logger } from './logger.js';

const PROCESSABLE_ACTIONS = new Set(['opened', 'synchronize', 'reopened']);

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
  if (deliveryId && isDuplicateDelivery(deliveryId)) {
    logger.info(`[REVIEW] Skipping duplicate delivery: ${deliveryId}`);
    return { status: 'duplicate' };
  }

  const shape = validatePRPayload(payload);
  if (!shape.ok) {
    logger.warn(`[REVIEW] Rejecting malformed payload: ${shape.reason}`);
    return { status: 'invalid_payload' };
  }

  const { action, pull_request: pr, repository: repo } = payload;

  if (!PROCESSABLE_ACTIONS.has(action)) {
    logger.info(`[REVIEW] Skipping action: ${action}`);
    return { status: 'skipped_action' };
  }

  const owner = repo.owner.login;
  const repoName = repo.name;
  const prNumber = pr.number;
  const prTitle = pr.title;

  logger.info(`[REVIEW] Processing ${owner}/${repoName}#${prNumber} (action=${action})`);

  try {
    const diff = await fetchPRDiff(owner, repoName, prNumber);
    if (!diff.trim()) {
      logger.info(`[REVIEW] No diff content for PR #${prNumber}; nothing to review`);
      return { status: 'empty_diff' };
    }

    const memories = await recallMemories(buildRecallQuery(prTitle, diff));
    logger.info(`[REVIEW] Recalled ${memories.length} memories for PR #${prNumber}`);

    const review = await generateReview(diff, memories, prTitle);

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

    logger.info(`[REVIEW] Completed for PR #${prNumber}`);
    return { status: 'completed', memories: memories.length };
  } catch (err) {
    logger.error({ err: err.message }, `[REVIEW] Failed for PR #${prNumber}`);
    return { status: 'error', error: err.message };
  }
}
