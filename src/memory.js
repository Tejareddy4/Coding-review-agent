import { extractMemories } from './groq.js';
import { retainMemory } from './hindsight.js';
import { config } from './config.js';
import { logger } from './logger.js';

const VALID_TYPES = new Set([
  'decision',
  'convention',
  'incident',
  'security_constraint',
  'failed_approach',
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
  logger.info('[MEMORY] Extracting learnings from review...');
  const candidates = await extractMemories(reviewText, prContext);
  const retained = [];

  for (const mem of candidates.slice(0, MAX_MEMORIES_PER_REVIEW)) {
    if (!isValidMemory(mem)) continue;
    const result = await retainMemory(
      mem.content.trim(),
      mem.type || 'observation',
      {
        source: `PR #${prContext.prNumber}`,
        repo: prContext.repo,
        confidence: Number(mem.confidence.toFixed(2)),
      }
    );
    if (result && result.success !== false) retained.push(mem);
  }

  logger.info(`[MEMORY] Retained ${retained.length} memories`);
  return retained;
}
