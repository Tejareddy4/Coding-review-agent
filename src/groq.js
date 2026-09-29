import Groq from 'groq-sdk';
import { config } from './config.js';
import { childLogger } from './logger.js';
import { buildReviewPrompt, buildExtractionPrompt } from './prompts.js';
import { parseLooseJson, parseStructuredReview } from './findings.js';

const log = childLogger('groq');

const groq = new Groq({
  apiKey: config.groq.apiKey,
  baseURL: config.groq.baseUrl,
  timeout: 30000,
  maxRetries: 0, // rate-limit retry/shift/backoff is handled below
});

// Groq free-tier rate limits are enforced PER MODEL (30 RPM / 1K RPD /
// 8K TPM / 200K TPD). Strategy on 429:
//   1. shift immediately to the next model in the chain (independent limits)
//   2. if the whole chain is cooling down, wait out the server's
//      Retry-After (bounded to one rate window) and make one final pass
const MAX_RATE_LIMIT_WAIT_MS = 60_000; // one full rate window (1m for RPM/TPM)

const modelCooldowns = new Map(); // model -> timestamp when usable again

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Test helper: clear per-model rate-limit cooldowns. */
export function resetRateLimitState() {
  modelCooldowns.clear();
}

function isRateLimitError(err) {
  return err?.status === 429 || /rate.?limit/i.test(String(err?.message ?? ''));
}

function isShiftableError(err) {
  const status = err?.status ?? 0;
  return (
    isRateLimitError(err) ||
    status >= 500 ||
    /model.*(overload|unavailable|deprecat)|service_unavailable/i.test(String(err?.message ?? ''))
  );
}

function retryAfterMs(err) {
  const headers = err?.headers ?? {};
  const raw =
    typeof headers.get === 'function' ? headers.get('retry-after') : headers['retry-after'];
  const seconds = Number(raw);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
  return MAX_RATE_LIMIT_WAIT_MS; // server didn't say: assume one window
}

/**
 * Call chat.completions, walking the model chain on rate limits / model
 * errors. One bounded wait + one final pass if every model is cooling.
 * @param {object} base - request payload without `model`
 * @param {boolean} [finalPass] - internal: retry pass after waiting
 * @returns {Promise<{completion:object, model:string}>}
 */
async function createWithModelFallback(base, finalPass = false) {
  let lastError = null;

  for (const model of config.groq.models) {
    if (!finalPass) {
      const coolingMs = (modelCooldowns.get(model) ?? 0) - Date.now();
      if (coolingMs > 0) {
        log.info({ model, cooldown_ms: coolingMs }, 'model in rate-limit cooldown, skipping');
        continue;
      }
    }
    try {
      const completion = await groq.chat.completions.create({ ...base, model });
      if (finalPass) log.info({ model }, 'recovered after rate-limit wait');
      return { completion, model };
    } catch (err) {
      lastError = err;
      if (isRateLimitError(err)) {
        const waitMs = Math.min(retryAfterMs(err), MAX_RATE_LIMIT_WAIT_MS);
        modelCooldowns.set(model, Date.now() + waitMs);
        log.warn({ model, retry_after_ms: waitMs }, 'rate limited, shifting to next model');
        continue;
      }
      if (isShiftableError(err)) {
        log.warn({ err, model }, 'model unavailable, shifting to next model');
        continue;
      }
      throw err; // auth/validation bugs: fail fast, no point trying other models
    }
  }

  if (finalPass) {
    throw lastError ?? new Error('all Groq models exhausted');
  }

  const soonest = Math.min(...config.groq.models.map((m) => modelCooldowns.get(m) ?? 0));
  const waitMs = Math.min(Math.max(soonest - Date.now(), 0), MAX_RATE_LIMIT_WAIT_MS);
  log.warn({ wait_ms: waitMs }, 'all models rate limited, waiting for next rate window');
  await sleep(waitMs);
  return createWithModelFallback(base, true);
}

const FALLBACK_REVIEW =
  '⚠️ Review agent could not generate a review (LLM error). Please review manually.';

/** One review completion; returns trimmed content ('' when empty). */
async function completeReview(prompt, { jsonMode, maxTokens }) {
  const { completion, model } = await createWithModelFallback({
    messages: [
      { role: 'system', content: prompt.system },
      { role: 'user', content: prompt.user },
    ],
    temperature: 0.2,
    max_tokens: maxTokens,
    ...(jsonMode ? { response_format: { type: 'json_object' } } : {}),
  });
  return { content: completion.choices[0]?.message?.content?.trim() ?? '', model };
}

/**
 * Generate a code review using Groq, injecting Hindsight memories.
 *
 * Asks first for a structured JSON review (line-anchored findings). If the
 * model answers in prose anyway, the prose is used as-is; if it produced
 * broken JSON (e.g. cut off at the token limit) or rejected JSON mode, one
 * plain markdown review is requested instead. Model fallback + rate-limit
 * backoff are handled by the chain; on total failure a safe notice is
 * returned so the PR still gets a response.
 * @param {string} diff
 * @param {Array<{text:string,type:string}>} memories
 * @param {string} prTitle
 * @returns {Promise<{text:string, structured:object|null, model:string|null, failed:boolean}>}
 */
export async function generateReviewDetailed(diff, memories, prTitle) {
  const start = Date.now();
  let model = null;
  try {
    let needsProse = false;
    try {
      const res = await completeReview(buildReviewPrompt(diff, memories, prTitle), {
        jsonMode: true,
        maxTokens: 2000,
      });
      model = res.model;
      const structured = parseStructuredReview(res.content);
      if (structured) {
        log.info(
          { model, findings: structured.findings.length, duration_ms: Date.now() - start },
          'structured review generated'
        );
        return { text: res.content, structured, model, failed: false };
      }
      if (res.content && !res.content.startsWith('{')) {
        log.info({ model, chars: res.content.length }, 'model answered in prose; using it');
        return { text: res.content, structured: null, model, failed: false };
      }
      log.warn({ model }, 'structured review unusable; retrying as prose');
      needsProse = true;
    } catch (err) {
      if (err?.status !== 400) throw err; // only a JSON-mode rejection is worth a prose retry
      log.warn({ err }, 'JSON mode rejected; retrying as prose');
      needsProse = true;
    }

    if (needsProse) {
      const res = await completeReview(
        buildReviewPrompt(diff, memories, prTitle, { structured: false }),
        { jsonMode: false, maxTokens: 900 }
      );
      model = res.model;
      if (res.content) {
        log.info({ model, chars: res.content.length, duration_ms: Date.now() - start }, 'review generated');
        return { text: res.content, structured: null, model, failed: false };
      }
    }
    log.warn({ model }, 'empty completion');
  } catch (err) {
    log.error(
      { err, duration_ms: Date.now() - start },
      'review generation failed; returning fallback notice'
    );
  }
  return { text: FALLBACK_REVIEW, structured: null, model, failed: true };
}

/**
 * Generate a code review and return just its text (structured reviews come
 * back as their raw JSON). Kept for callers that only need a string.
 * @param {string} diff
 * @param {Array<{text:string,type:string}>} memories
 * @param {string} prTitle
 * @returns {Promise<string>}
 */
export async function generateReview(diff, memories, prTitle) {
  return (await generateReviewDetailed(diff, memories, prTitle)).text;
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
  const start = Date.now();
  const base = {
    messages: [
      { role: 'system', content: prompt.system },
      { role: 'user', content: prompt.user },
    ],
    temperature: 0,
  };

  for (const withJsonMode of [true, false]) {
    try {
      const { completion, model } = await createWithModelFallback({
        ...base,
        ...(withJsonMode ? { response_format: { type: 'json_object' } } : {}),
      });
      const raw = completion.choices[0]?.message?.content || '{}';
      const parsed = parseLooseJson(raw);
      const memories = Array.isArray(parsed) ? parsed : parsed?.memories;
      if (Array.isArray(memories)) {
        log.info(
          { count: memories.length, jsonMode: withJsonMode, model, duration_ms: Date.now() - start },
          'memories extracted'
        );
        return memories;
      }
      log.warn({ jsonMode: withJsonMode }, 'unparseable response shape');
    } catch (err) {
      log.warn({ err, jsonMode: withJsonMode }, 'memory extraction attempt failed');
    }
  }
  return [];
}
