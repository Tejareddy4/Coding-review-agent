#!/usr/bin/env node
/**
 * Review one PR from the command line (GitHub Actions mode, or a local demo).
 *
 *   node src/cli.js <owner> <repo> <pr-number> [title] [--dry-run]
 *
 * --dry-run prints the review (summary + inline comments) without posting,
 * setting a status, or retaining memories. Without a title the PR's own
 * title is fetched from GitHub.
 */
import { fetchPR } from './github.js';
import { runReview, validSha } from './review.js';
import { initStore, closeStore } from './store.js';

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const [owner, repoName, prArg, ...titleParts] = args.filter((a) => a !== '--dry-run');
const prNumber = Number.parseInt(prArg, 10);

if (!owner || !repoName || !Number.isInteger(prNumber) || prNumber <= 0) {
  console.error('Usage: node src/cli.js <owner> <repo> <pr-number> [title] [--dry-run]');
  process.exit(2);
}

let exitCode = 0;
try {
  if (!dryRun) await initStore();
  const pr = await fetchPR(owner, repoName, prNumber);
  const result = await runReview({
    owner,
    repoName,
    prNumber,
    prTitle: titleParts.join(' ') || pr.title || `PR #${prNumber}`,
    headSha: validSha(pr.head?.sha),
    trigger: 'cli',
    dryRun,
  });

  if (result.status === 'dry_run') {
    console.log(result.body);
    for (const c of result.inline) {
      console.log(`\n──── inline comment · ${c.path}:${c.line} ────\n${c.body}`);
    }
  } else {
    console.log(JSON.stringify(result, null, 2));
  }
  if (result.status === 'error') exitCode = 1;
} catch (err) {
  console.error(`Review failed: ${err.message}`);
  exitCode = 1;
} finally {
  await closeStore();
}
process.exit(exitCode);
