// List what is actually stored in the Hindsight bank (raw, from the server).
// Usage: npm run list-memories
import { config } from '../src/config.js';
import { HindsightClient } from '@vectorize-io/hindsight-client';
import { logger } from '../src/logger.js';

const client = new HindsightClient({
  baseUrl: config.hindsight.baseUrl,
  ...(config.hindsight.apiKey ? { apiKey: config.hindsight.apiKey } : {}),
});

try {
  const res = await client.listMemories(config.hindsight.bankId, { limit: 100 });
  const items = res?.items ?? res?.memories ?? [];
  const byType = items.reduce((acc, m) => {
    const t = m.fact_type ?? m.type ?? '?';
    acc[t] = (acc[t] ?? 0) + 1;
    return acc;
  }, {});

  logger.info(
    { endpoint: config.hindsight.baseUrl, bank: config.hindsight.bankId, total: items.length, byType },
    'bank contents'
  );
  for (const m of items) {
    logger.info(
      {
        id: m.id?.slice(0, 8),
        type: m.fact_type ?? m.type,
        state: m.state,
        updated: m.updated_at ?? m.date,
        text: String(m.text ?? '').slice(0, 100),
      },
      'memory'
    );
  }
} catch (err) {
  logger.error({ err }, 'failed to list memories');
  process.exit(1);
}
process.exit(0);
