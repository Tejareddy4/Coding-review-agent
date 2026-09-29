// Show everything the agent stored in Postgres.
// Usage: npm run list-store
import { initStore, closeStore, query } from '../src/store.js';
import { logger } from '../src/logger.js';

const ok = await initStore();
if (!ok) {
  logger.error('store unavailable — check DATABASE_URL');
  process.exit(1);
}

const show = async (title, sql) => {
  const rows = (await query(sql)) ?? [];
  logger.info({ rows: rows.length }, title);
  for (const r of rows) logger.info(r, '-');
};

await show('processed deliveries (webhook dedupe)',
  `SELECT delivery_id, created_at FROM processed_deliveries ORDER BY created_at DESC LIMIT 10`);
await show('recall cache entries',
  `SELECT cache_key, jsonb_array_length(memories) AS memories, created_at FROM memory_cache ORDER BY created_at DESC LIMIT 10`);
await show('review audit trail',
  `SELECT repo, pr_number, status, memories_used, duration_ms, error, created_at FROM reviews ORDER BY id DESC LIMIT 10`);
await show('learnings (local source of truth)',
  `SELECT repo, pr_number, type, confidence, retained_in_hindsight, content, created_at FROM learnings ORDER BY id DESC LIMIT 10`);

await closeStore();
process.exit(0);
