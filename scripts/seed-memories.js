import { retainMemory } from '../src/hindsight.js';
import { logger } from '../src/logger.js';

const SEED_MEMORIES = [
  { content: 'Never use the `any` type in TypeScript. Use `unknown` with type guards.', type: 'convention' },
  { content: 'All API endpoints must validate input with Zod before any business logic.', type: 'convention' },
  { content: 'Never log PII. Use redactSensitive() before logging user data.', type: 'security_constraint' },
  { content: 'Database queries must use parameterized statements, never string concatenation.', type: 'security_constraint' },
  { content: 'React components must ship with a Storybook story in the same PR.', type: 'convention' },
  { content: 'Do not add new Express middleware without an error handler; broke prod in the 2025 incident.', type: 'incident' },
];

async function seed() {
  let ok = 0;
  for (const mem of SEED_MEMORIES) {
    const result = await retainMemory(mem.content, mem.type, { source: 'seed' });
    if (result) {
      ok++;
      logger.info(`Seeded: ${mem.content}`);
    }
  }
  logger.info(`Seeding complete: ${ok}/${SEED_MEMORIES.length} retained.`);
  if (ok === 0) {
    logger.error('No memories retained — check HINDSIGHT_BASE_URL / HINDSIGHT_API_KEY.');
    process.exit(1);
  }
}

seed().catch((err) => {
  logger.error({ err: err.message }, 'Seed failed');
  process.exit(1);
});
