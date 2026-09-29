import Groq from 'groq-sdk';
import { config } from './config.js';
import { logger } from './logger.js';
import { buildReviewPrompt, buildExtractionPrompt } from './prompts.js';

const groq = new Groq({
  apiKey: config.groq.apiKey,
  baseURL: config.groq.baseUrl,
  timeout: 30000,
  maxRetries: 2,
});

/**
 * Generate a code review using Groq, injecting Hindsight memories.
 * One in-process retry; returns a safe fallback message on total failure
 * so the PR still gets a response.
 * @param {string} diff
 * @param {Array<{text:string,type:string}>} memories
 * @param {string} prTitle
 * @returns {Promise<string>}
 */
export async function generateReview(diff, memories, prTitle) {
  const prompt = buildReviewPrompt(diff, memories, prTitle);
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const completion = await groq.chat.completions.create({
        model: config.groq.model,
        messages: [
          { role: 'system', content: prompt.system },
          { role: 'user', content: prompt.user },
        ],
        temperature: 0.2,
        max_tokens: 700,
      });
      const content = completion.choices[0]?.message?.content?.trim();
      if (content) return content;
      logger.warn('[GROQ] Empty completion on attempt %d', attempt);
    } catch (err) {
      logger.warn(`[GROQ] Attempt ${attempt} failed: ${err.message}`);
    }
  }
  return '⚠️ Review agent could not generate a review (LLM error). Please review manually.';
}

/**
 * Safely parse a JSON object out of an LLM response string.
 * Tolerates ```json fences and trailing prose.
 * @param {string} raw
 * @returns {object|null}
 */
function parseLooseJson(raw) {
  const fenced = raw.match(/\{[\s\S]*\}/); // first {...} block
  const candidate = fenced ? fenced[0] : raw;
  try {
    return JSON.parse(candidate);
  } catch {
    return null;
  }
}

/**
 * Extract typed memories from a review using Groq JSON mode.
 * Falls back to plain-text completion if the model rejects json_object mode.
 * @param {string} reviewText
 * @param {object} prContext
 * @returns {Promise<Array<{type:string,content:string,confidence:number}>>}
 */
export async function extractMemories(reviewText, prContext) {
  const prompt = buildExtractionPrompt(reviewText, prContext);
  const base = {
    model: config.groq.model,
    messages: [
      { role: 'system', content: prompt.system },
      { role: 'user', content: prompt.user },
    ],
    temperature: 0,
  };

  for (const withJsonMode of [true, false]) {
    try {
      const completion = await groq.chat.completions.create({
        ...base,
        ...(withJsonMode ? { response_format: { type: 'json_object' } } : {}),
      });
      const raw = completion.choices[0]?.message?.content || '{}';
      const parsed = parseLooseJson(raw);
      const memories = Array.isArray(parsed) ? parsed : parsed?.memories;
      if (Array.isArray(memories)) return memories;
      logger.warn('[GROQ] extractMemories: unparseable response shape');
    } catch (err) {
      logger.warn(
        `[GROQ] extractMemories (jsonMode=${withJsonMode}) failed: ${err.message}`
      );
    }
  }
  return [];
}
