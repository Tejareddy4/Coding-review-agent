import dotenv from 'dotenv';
dotenv.config();

/**
 * Read a required environment variable; throw at boot if missing.
 * @param {string} key
 * @param {string} [purpose] - human hint included in the error
 * @returns {string}
 */
const required = (key, purpose = '') => {
  const val = process.env[key];
  if (!val) {
    throw new Error(`Missing required env var: ${key}${purpose ? ` (${purpose})` : ''}`);
  }
  return val;
};

const int = (key, fallback) => {
  const n = parseInt(process.env[key] ?? '', 10);
  return Number.isFinite(n) ? n : fallback;
};

/**
 * Ordered Groq model chain. Free-tier rate limits are enforced PER MODEL
 * (30 RPM / 1K RPD / 8K TPM / 200K TPD each), so on a 429 the client
 * shifts to the next model instead of waiting.
 * GROQ_MODELS (comma-separated) overrides; otherwise GROQ_MODEL pins the
 * primary and known same-class models serve as failover.
 */
function groqModels() {
  const fromEnv = (process.env.GROQ_MODELS || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  if (fromEnv.length) return fromEnv;
  const primary = process.env.GROQ_MODEL || 'openai/gpt-oss-120b';
  const fallbacks = ['openai/gpt-oss-20b', 'qwen/qwen3.8-27b'];
  return [primary, ...fallbacks.filter((m) => m !== primary)];
}

/**
 * Centralized application configuration. Built once at import time;
 * import-time validation means the process fails fast on bad config.
 */
export const config = {
  port: int('PORT', 8080),
  logLevel: process.env.LOG_LEVEL || 'info',
  nodeEnv: process.env.NODE_ENV || 'development',
  github: {
    token: required('GITHUB_TOKEN', 'classic PAT or fine-grained token with repo/PR read + comment write'),
    webhookSecret: required('GITHUB_WEBHOOK_SECRET', 'random string shared with the GitHub webhook settings'),
    repoOwner: process.env.GITHUB_REPO_OWNER || '',
    repoName: process.env.GITHUB_REPO_NAME || '',
    apiUrl: process.env.GITHUB_API_URL || 'https://api.github.com',
  },
  hindsight: {
    baseUrl: process.env.HINDSIGHT_BASE_URL || 'https://api.hindsight.vectorize.io',
    apiKey: process.env.HINDSIGHT_API_KEY || '',
    bankId: process.env.HINDSIGHT_BANK_ID || 'code-review-agent-bank',
  },
  groq: {
    apiKey: required('GROQ_API_KEY', 'key from https://console.groq.com'),
    model: process.env.GROQ_MODEL || 'openai/gpt-oss-120b',
    // NOTE: groq-sdk appends /openai/v1 itself — do NOT include it here,
    // or every request 404s with a doubled path (/openai/v1/openai/v1/...).
    baseUrl: process.env.GROQ_BASE_URL || 'https://api.groq.com',
    models: groqModels(),
  },
  review: {
    maxDiffChars: int('MAX_DIFF_CHARS', 8000),
    memoryConfidenceThreshold: Number(process.env.MEMORY_CONFIDENCE_THRESHOLD || 0.7),
  },
  database: {
    // Optional Postgres (e.g. Neon). Enables persistent webhook dedupe,
    // Hindsight recall caching and local review/learning audit storage.
    url: process.env.DATABASE_URL || '',
  },
  store: {
    recallCacheTtlSec: int('RECALL_CACHE_TTL_SEC', 3600),
  },
};

/**
 * Fail fast on semantically invalid config that would otherwise surface
 * as confusing runtime errors (e.g. threshold out of range).
 */
export function validateConfig(cfg = config) {
  const errors = [];
  if (cfg.review.memoryConfidenceThreshold <= 0 || cfg.review.memoryConfidenceThreshold >= 1) {
    errors.push('MEMORY_CONFIDENCE_THRESHOLD must be between 0 and 1 (exclusive)');
  }
  if (!/^[a-zA-Z0-9._-]+$/.test(cfg.hindsight.bankId)) {
    errors.push('HINDSIGHT_BANK_ID contains invalid characters');
  }
  if (cfg.github.apiUrl && !/^https?:\/\//.test(cfg.github.apiUrl)) {
    errors.push('GITHUB_API_URL must start with http:// or https://');
  }
  if (errors.length) {
    throw new Error(`Invalid configuration:\n  - ${errors.join('\n  - ')}`);
  }
  return true;
}

validateConfig();
