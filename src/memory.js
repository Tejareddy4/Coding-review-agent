import { extractMemories } from './groq.js';
import { retainMemory } from './hindsight.js';
import { config } from './config.js';
import { childLogger } from './logger.js';
import { recordLearning } from './store.js';
import { recordLearningActivity } from './activity.js';

const log = childLogger('memory');

const VALID_TYPES = new Set([
  'decision',
  'convention',
  'incident',
  'security_constraint',
  'failed_approach',
  'observation', // default when the extractor omits the type (must be valid)
]);

const MAX_MEMORIES_PER_REVIEW = 5;

/**
 * Validate one extracted memory candidate against the schema/threshold.
 * @param {any} mem
 * @returns {boolean}
 */
function isValidMemory(mem) {
  return (
    mem &&
    typeof mem === 'object' &&
    typeof mem.content === 'string' &&
    mem.content.trim().length > 0 &&
    mem.content.length <= 500 &&
    typeof mem.confidence === 'number' &&
    Number.isFinite(mem.confidence) &&
    mem.confidence > config.review.memoryConfidenceThreshold &&
    (!mem.type || VALID_TYPES.has(mem.type))
  );
}

/**
 * Extract learnings from a completed review and retain them in Hindsight.
 * Never throws: memory retention is best-effort by design.
 * @param {string} reviewText
 * @param {{prNumber:number, repo:string}} prContext
 * @returns {Promise<Array<{type:string,content:string,confidence:number}>>}
 */
export async function processReviewLearnings(reviewText, prContext) {
  log.info('extracting learnings from review');
  const candidates = await extractMemories(reviewText, prContext);
  const retained = [];

  for (const mem of candidates.slice(0, MAX_MEMORIES_PER_REVIEW)) {
    if (!isValidMemory(mem)) continue;
    const content = mem.content.trim();
    const type = mem.type || 'observation';
    const result = await retainMemory(content, type, {
      source: `PR #${prContext.prNumber}`,
      repo: prContext.repo,
      confidence: Number(mem.confidence.toFixed(2)),
    });
    const wasRetained = !!(result && result.success !== false);
    if (wasRetained) retained.push(mem);
    // Local source of truth: every extracted learning is recorded,
    // including ones Hindsight refused — they can be re-synced later.
    await recordLearning({
      repo: prContext.repo,
      prNumber: prContext.prNumber,
      type,
      content,
      confidence: mem.confidence,
      retained: wasRetained,
    });
    recordLearningActivity({
      repo: prContext.repo,
      prNumber: prContext.prNumber,
      type,
      content,
      retained: wasRetained,
      source: 'review',
    });
  }

  log.info({ retained: retained.length, candidates: candidates.length }, 'learnings processed');
  return retained;
}
