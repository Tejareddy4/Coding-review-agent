import { HindsightClient } from '@vectorize-io/hindsight-client';
import { config } from './config.js';
import { logger } from './logger.js';

const client = new HindsightClient({
  baseUrl: config.hindsight.baseUrl,
  ...(config.hindsight.apiKey ? { apiKey: config.hindsight.apiKey } : {}),
});

const BANK = config.hindsight.bankId;

/**
 * Store a memory in Hindsight.
 * Failures are logged and swallowed: a memory write must never break a review.
 * @param {string} content
 * @param {string} context
 * @param {object} [metadata]
 * @returns {Promise<object|null>} the retained memory, or null on failure
 */
export async function retainMemory(content, context, metadata = {}) {
  logger.info(`[HINDSIGHT] Retain: ${content.slice(0, 60)}...`);
  try {
    const response = await client.retain(BANK, content, {
      context,
      metadata: Object.fromEntries(
        Object.entries(metadata).map(([k, v]) => [k, String(v)])
      ),
      async: false,
    });
    if (response && response.success === false) {
      logger.error('[HINDSIGHT] retain reported failure');
      return null;
    }
    return response;
  } catch (err) {
    logger.error({ err: err.message }, '[HINDSIGHT] retain failed');
    return null;
  }
}

/**
 * Normalize one raw recall result to { text, type, score }.
 * Handles both direct-array and wrapped-response SDK shapes.
 * @param {object} r
 */
const normalizeResult = (r) => ({
  text: r.text ?? r.content ?? '',
  type: r.type ?? r.memory_type ?? 'observation',
  score: typeof r.score === 'number' ? r.score : r.scores?.final ?? 0,
});

/**
 * Recall memories relevant to a query.
 * Returns [] on failure so review can proceed without memory.
 * @param {string} query
 * @param {number} [limit=5]
 * @returns {Promise<Array<{text:string,type:string,score:number}>>}
 */
export async function recallMemories(query, limit = 5) {
  logger.info(`[HINDSIGHT] Recall: ${query.slice(0, 60)}...`);
  try {
    const response = await client.recall(BANK, query, { budget: 'high' });
    const results = Array.isArray(response) ? response : response?.results || [];
    return results
      .filter((r) => r && typeof r === 'object')
      .map(normalizeResult)
      .filter((r) => r.text)
      .slice(0, limit);
  } catch (err) {
    logger.error({ err: err.message }, '[HINDSIGHT] recall failed');
    return [];
  }
}

/**
 * Reflect on memories to generate a grounded response.
 * @param {string} query
 * @param {string} context
 * @returns {Promise<string>}
 */
export async function reflectOnMemories(query, context) {
  try {
    const answer = await client.reflect(BANK, query, { context, budget: 'mid' });
    return answer?.text || '';
  } catch (err) {
    logger.error({ err: err.message }, '[HINDSIGHT] reflect failed');
    return '';
  }
}
