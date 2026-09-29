import pg from 'pg';
import crypto from 'node:crypto';
import dns from 'node:dns/promises';
import { config } from './config.js';
import { childLogger } from './logger.js';

const log = childLogger('store');

let pool = null;
let reconnecting = false;

/** Connection-error signature that should trigger a pool rebuild. */
const CONNECTION_ERROR = /terminated|timeout|ECONN|ETIMEDOUT|fetch failed|network|57P01|57P03/i;

/**
 * Create a pool for the configured database.
 * - Neon URLs use the serverless driver over HTTPS/443: works even where
 *   outbound 5432 is blocked, and rides undici keep-alive for stable
 *   warm connections.
 * - Other Postgres hosts use node-postgres; the host is resolved to IPv4
 *   (broken IPv6 routes cause OS-level TCP timeouts) with TLS SNI preserved.
 */
async function createPool() {
  if (/neon\.tech/i.test(config.database.url)) {
    const { Pool: NeonPool, neonConfig } = await import('@neondatabase/serverless');
    // Node has no global WebSocket (unlike edge/browser runtimes the driver
    // targets by default); without this the Pool's WS handshake fails with
    // "fetch failed" and never reaches the actual connection error.
    const { default: ws } = await import('ws');
    neonConfig.webSocketConstructor = ws;
    return new NeonPool({ connectionString: config.database.url });
  }
  const options = {
    connectionString: config.database.url,
    max: 5,
    connectionTimeoutMillis: 10000,
  };
  try {
    const { hostname } = new URL(config.database.url);
    const ipv4 = await dns.lookup(hostname, { family: 4 });
    if (ipv4?.address) {
      options.host = ipv4.address;
      options.ssl = { servername: hostname, rejectUnauthorized: true };
    }
  } catch {
    // fall back to hostname connection as-is
  }
  return new pg.Pool(options);
}

async function runMigrations() {
  await pool.query(`CREATE TABLE IF NOT EXISTS processed_deliveries (
    delivery_id TEXT PRIMARY KEY,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
  )`);
  await pool.query(`CREATE TABLE IF NOT EXISTS memory_cache (
    cache_key  TEXT PRIMARY KEY,
    memories   JSONB NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )`);
  await pool.query(`CREATE TABLE IF NOT EXISTS reviews (
    id            SERIAL PRIMARY KEY,
    delivery_id   TEXT,
    repo          TEXT NOT NULL,
    pr_number     INTEGER NOT NULL,
    status        TEXT NOT NULL,
    model         TEXT,
    memories_used INTEGER,
    duration_ms   INTEGER,
    review_text   TEXT,
    error         TEXT,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
  )`);
  await pool.query(`CREATE TABLE IF NOT EXISTS learnings (
    id                    SERIAL PRIMARY KEY,
    repo                  TEXT NOT NULL,
    pr_number             INTEGER NOT NULL,
    type                  TEXT NOT NULL,
    content               TEXT NOT NULL,
    confidence            REAL,
    retained_in_hindsight BOOLEAN NOT NULL DEFAULT false,
    created_at            TIMESTAMPTZ NOT NULL DEFAULT now()
  )`);
}

/** Connect + migrate, with bounded retries (cold connections can be flaky). */
async function connect(maxAttempts = 5) {
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    let candidate = null;
    try {
      candidate = await createPool();
      await candidate.query('SELECT 1');
      pool = candidate;
      await runMigrations();
      return true;
    } catch (err) {
      await candidate?.end().catch(() => {});
      if (attempt === maxAttempts) {
        log.error({ err: err.message }, `store connect failed after ${maxAttempts} attempts`);
        return false;
      }
      log.warn({ attempt, retrying_in_ms: 3000 }, 'store connect failed, retrying');
      await new Promise((r) => setTimeout(r, 3000));
    }
  }
  return false;
}

/**
 * Optional Postgres persistence layer. Reduces load on external services
 * and hardens the pipeline:
 *   - processed_deliveries: webhook dedupe that survives restarts / multi-instance
 *   - memory_cache:         Hindsight recall results cache (TTL)
 *   - reviews / learnings:  local audit + source of truth for extracted learnings
 * Disabled unless DATABASE_URL is set. Every operation fails OPEN:
 * a Postgres problem must never block a review.
 */
export async function initStore() {
  if (!config.database.url) {
    log.info('DATABASE_URL not set — persistence disabled (in-memory dedupe, no cache)');
    return false;
  }
  const ok = await connect();
  if (ok) log.info('store initialized: persistent dedupe, recall cache, review/learning audit');
  return ok;
}

/** Rebuild the pool once after a connection-level failure (self-healing). */
async function maybeReconnect(err) {
  if (!pool || reconnecting) return;
  if (!CONNECTION_ERROR.test(String(err?.message ?? '') + String(err?.code ?? ''))) return;
  reconnecting = true;
  const dead = pool;
  pool = null;
  await dead.end().catch(() => {});
  log.warn('store connection lost — reconnecting');
  const ok = await connect(2);
  if (ok) log.info('store reconnected');
  reconnecting = false;
}

export function isStoreEnabled() {
  return pool !== null;
}

/** Stable cache key for a recall query. */
export function hashRecallQuery(query) {
  return crypto.createHash('sha256').update(String(query)).digest('hex');
}

/**
 * Claim a delivery for processing (persistent dedupe).
 * @returns {Promise<boolean>} true = caller owns this delivery; false = already processed
 */
export async function markDeliveryProcessed(deliveryId) {
  if (!pool || !deliveryId) return true;
  try {
    const res = await pool.query(
      `INSERT INTO processed_deliveries (delivery_id) VALUES ($1)
       ON CONFLICT (delivery_id) DO NOTHING
       RETURNING delivery_id`,
      [deliveryId]
    );
    if (Math.random() < 0.05) {
      await pool.query(
        `DELETE FROM processed_deliveries WHERE created_at < now() - interval '2 hours'`
      );
    }
    return res.rowCount === 1;
  } catch (err) {
    log.error({ err: err.message, deliveryId }, 'delivery dedupe write failed (fail-open)');
    maybeReconnect(err);
    return true;
  }
}

/**
 * Read cached recall results. @returns {Promise<Array|null>} null on miss/ disabled/ error.
 */
export async function getCachedMemories(cacheKey) {
  if (!pool) return null;
  try {
    const res = await pool.query(
      `SELECT memories FROM memory_cache
       WHERE cache_key = $1 AND created_at > now() - make_interval(secs => $2)`,
      [cacheKey, config.store.recallCacheTtlSec]
    );
    return res.rows[0]?.memories ?? null;
  } catch (err) {
    log.error({ err: err.message }, 'cache read failed (treated as miss)');
    maybeReconnect(err);
    return null;
  }
}

/** Best-effort cache write. */
export async function putCachedMemories(cacheKey, memories) {
  if (!pool || !Array.isArray(memories)) return;
  try {
    await pool.query(
      `INSERT INTO memory_cache (cache_key, memories) VALUES ($1, $2::jsonb)
       ON CONFLICT (cache_key) DO UPDATE SET memories = EXCLUDED.memories, created_at = now()`,
      [cacheKey, JSON.stringify(memories)]
    );
  } catch (err) {
    log.error({ err: err.message }, 'cache write failed');
    maybeReconnect(err);
  }
}

/** Best-effort review audit row. */
export async function recordReview(entry) {
  if (!pool) return;
  try {
    await pool.query(
      `INSERT INTO reviews
         (delivery_id, repo, pr_number, status, model, memories_used, duration_ms, review_text, error)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [
        entry.deliveryId ?? null,
        entry.repo,
        entry.prNumber,
        entry.status,
        entry.model ?? null,
        entry.memoriesUsed ?? null,
        entry.durationMs ?? null,
        entry.reviewText ?? null,
        entry.error ?? null,
      ]
    );
  } catch (err) {
    log.error({ err: err.message }, 'review audit write failed');
    maybeReconnect(err);
  }
}

/** Best-effort learning row (local source of truth alongside Hindsight). */
export async function recordLearning(entry) {
  if (!pool) return;
  try {
    await pool.query(
      `INSERT INTO learnings (repo, pr_number, type, content, confidence, retained_in_hindsight)
       VALUES ($1,$2,$3,$4,$5,$6)`,
      [
        entry.repo,
        entry.prNumber,
        entry.type,
        entry.content,
        entry.confidence ?? null,
        !!entry.retained,
      ]
    );
  } catch (err) {
    log.error({ err: err.message }, 'learning write failed');
    maybeReconnect(err);
  }
}

/** Raw query access for scripts (returns rows, or null on failure). */
export async function query(text, params = []) {
  if (!pool) return null;
  try {
    const res = await pool.query(text, params);
    return res.rows ?? null;
  } catch (err) {
    log.error({ err: err.message }, 'query failed');
    return null;
  }
}

/** Close the pool (graceful shutdown / tests). */
export async function closeStore() {
  if (!pool) return;
  const closing = pool;
  pool = null;
  await closing.end().catch(() => {});
}
