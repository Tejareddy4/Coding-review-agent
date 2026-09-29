import { fetchPR, postPRComment, addCommentReaction } from './github.js';
import { retainMemory, recallMemories, reflectOnMemories } from './hindsight.js';
import { runReview, claimDelivery, isAllowedRepo, validSha } from './review.js';
import { BOT_MARKER } from './findings.js';
import { recordCommandActivity, recordLearningActivity } from './activity.js';
import { recordLearning, clearMemoryCache } from './store.js';
import { config } from './config.js';
import { childLogger, logContext } from './logger.js';

const log = childLogger('commands');

/**
 * ChatOps: slash commands typed in a PR comment.
 *
 *   /review               re-run the review now (fresh memory recall)
 *   /remember <decision>  teach the team memory a decision / convention
 *   /ask <question>       answer from team memory (Hindsight reflect)
 *   /recall <topic>       show what the agent remembers about a topic
 *   /help                 list commands
 *
 * Only repo OWNER / MEMBER / COLLABORATOR comments are obeyed — otherwise
 * anyone able to comment on a public PR could poison the team memory.
 */
const COMMANDS = new Set(['review', 'remember', 'ask', 'recall', 'help']);
const TRUSTED_ASSOCIATIONS = new Set(['OWNER', 'MEMBER', 'COLLABORATOR']);
const MAX_ARG_CHARS = 500;

const HELP = [
  '| Command | What it does |',
  '|---|---|',
  '| `/review` | Re-run the review on the latest commit (fresh memory recall) |',
  '| `/remember <decision>` | Teach the team memory, e.g. `/remember All DB access goes through the repository layer` |',
  '| `/ask <question>` | Answer from team memory, e.g. `/ask why do we validate with Zod?` |',
  '| `/recall <topic>` | Show what the agent remembers about a topic |',
  '| `/help` | This list |',
].join('\n');

/**
 * Parse a slash command from a comment body.
 * @param {string} body
 * @returns {{command:string, arg:string}|null}
 */
export function parseCommand(body) {
  if (typeof body !== 'string' || body.includes(BOT_MARKER)) return null;
  const m = body.trim().match(/^\/([a-z]+)\b[ \t]*([\s\S]*)$/i);
  if (!m) return null;
  const command = m[1].toLowerCase();
  if (!COMMANDS.has(command)) return null; // leave other bots' commands alone
  return { command, arg: m[2].trim() };
}

/**
 * Validate the issue_comment payload shape we rely on.
 * @returns {{ok:boolean, reason?:string}}
 */
export function validateCommentPayload(payload) {
  if (!payload || typeof payload !== 'object') return { ok: false, reason: 'payload not an object' };
  const { issue, comment, repository: repo } = payload;
  if (!issue || !Number.isInteger(issue.number)) return { ok: false, reason: 'missing issue' };
  if (!comment || typeof comment.body !== 'string' || !Number.isInteger(comment.id)) {
    return { ok: false, reason: 'missing comment' };
  }
  if (!repo?.name || !repo.owner?.login) return { ok: false, reason: 'missing repository/owner info' };
  return { ok: true };
}

const reply = (ctx, text) => postPRComment(ctx.owner, ctx.repoName, ctx.prNumber, `${BOT_MARKER}\n${text}`);

/** Neutralize @-mentions in echoed user/LLM text. */
const quote = (text) => String(text).replace(/@(?=[A-Za-z0-9-])/g, '@​');

async function cmdReview(ctx) {
  const pr = await fetchPR(ctx.owner, ctx.repoName, ctx.prNumber);
  const result = await runReview({
    owner: ctx.owner,
    repoName: ctx.repoName,
    prNumber: ctx.prNumber,
    prTitle: typeof pr.title === 'string' ? pr.title : ctx.issueTitle,
    headSha: validSha(pr.head?.sha),
    trigger: 'command',
    bypassCache: true, // the user asked for a fresh look, possibly right after /remember
  });
  return result.status === 'completed' || result.status === 'empty_diff';
}

async function cmdRemember(ctx) {
  const text = ctx.arg.slice(0, MAX_ARG_CHARS);
  if (text.length < 8) {
    await reply(ctx, '⚠️ Usage: `/remember <team decision or convention>`');
    return false;
  }
  const result = await retainMemory(text, 'decision', {
    source: `PR #${ctx.prNumber} (@${ctx.user})`,
    repo: ctx.repo,
    confidence: 1,
  });
  const retained = !!(result && result.success !== false);
  await recordLearning({
    repo: ctx.repo,
    prNumber: ctx.prNumber,
    type: 'decision',
    content: text,
    confidence: 1,
    retained,
  });
  recordLearningActivity({
    repo: ctx.repo,
    prNumber: ctx.prNumber,
    type: 'decision',
    content: text,
    retained,
    source: `@${ctx.user}`,
  });
  if (retained) await clearMemoryCache(); // the next review must see the new memory
  await reply(
    ctx,
    retained
      ? `🧠 **Remembered.** Future reviews will enforce this team decision:\n\n> ${quote(text)}\n\nComment \`/review\` to re-review this PR with it.`
      : '⚠️ Could not store that memory right now (Hindsight unavailable). Please try again.'
  );
  return retained;
}

async function cmdAsk(ctx) {
  const question = ctx.arg.slice(0, MAX_ARG_CHARS);
  if (!question) {
    await reply(ctx, '⚠️ Usage: `/ask <question about team decisions>`');
    return false;
  }
  const answer = await reflectOnMemories(
    question,
    `You are the long-term memory of the engineering team behind ${ctx.repo}. Answer from the team's recorded decisions, conventions and incidents; say so when nothing relevant is recorded.`
  );
  await reply(
    ctx,
    answer
      ? `### 🧠 Team memory says…\n\n> **Q:** ${quote(question)}\n\n${quote(answer.slice(0, 3000))}\n\n<sub>Answered by Hindsight \`reflect\` over the team's long-term memory.</sub>`
      : '⚠️ Team memory could not answer right now. Please try again.'
  );
  return !!answer;
}

async function cmdRecall(ctx) {
  const topic = (ctx.arg || ctx.issueTitle).slice(0, MAX_ARG_CHARS);
  const memories = await recallMemories(topic, 8);
  const list = memories.length
    ? memories
        .map((m, i) => `${i + 1}. **[${m.type}]** ${quote(m.text.replace(/\s*\n\s*/g, ' ').slice(0, 300))}`)
        .join('\n')
    : '_Nothing recorded yet. Teach me with `/remember <decision>`._';
  await reply(ctx, `### 🧠 What I remember about “${quote(topic.slice(0, 120))}”\n\n${list}`);
  return true;
}

async function cmdHelp(ctx) {
  await reply(ctx, `### 🤖 Code Review Agent — commands\n\n${HELP}`);
  return true;
}

const HANDLERS = {
  review: cmdReview,
  remember: cmdRemember,
  ask: cmdAsk,
  recall: cmdRecall,
  help: cmdHelp,
};

/**
 * Handle one issue_comment webhook event. Never throws.
 * @param {object} payload
 * @param {string} [deliveryId]
 */
export async function processComment(payload, deliveryId) {
  if (!config.chatops.enabled) return { status: 'chatops_disabled' };
  if (payload?.action !== 'created') return { status: 'skipped_action' };

  const shape = validateCommentPayload(payload);
  if (!shape.ok) {
    log.warn({ reason: shape.reason }, 'rejecting malformed comment payload');
    return { status: 'invalid_payload' };
  }
  const { issue, comment, repository } = payload;
  if (!issue.pull_request) return { status: 'not_a_pr' };
  if (comment.user?.type === 'Bot') return { status: 'bot_comment' };

  const parsed = parseCommand(comment.body);
  if (!parsed) return { status: 'no_command' };

  if (!(await claimDelivery(deliveryId))) {
    log.info({ deliveryId }, 'skipping duplicate delivery');
    return { status: 'duplicate' };
  }

  const owner = repository.owner.login;
  const repoName = repository.name;
  if (!isAllowedRepo(owner, repoName)) {
    log.warn({ repo: `${owner}/${repoName}` }, 'repository not in allowlist, skipping command');
    return { status: 'foreign_repo' };
  }

  const user = String(comment.user?.login ?? 'unknown');
  if (!TRUSTED_ASSOCIATIONS.has(comment.author_association)) {
    log.warn({ user, association: comment.author_association }, 'command from untrusted user ignored');
    return { status: 'forbidden' };
  }

  const ctx = {
    owner,
    repoName,
    repo: `${owner}/${repoName}`,
    prNumber: issue.number,
    issueTitle: typeof issue.title === 'string' ? issue.title : '',
    user,
    arg: parsed.arg,
  };

  return logContext.run({ ...logContext.getStore(), pr: `${ctx.repo}#${ctx.prNumber}` }, async () => {
    log.info({ command: parsed.command, user }, 'running command');
    await addCommentReaction(owner, repoName, comment.id, 'eyes');
    let ok = false;
    try {
      ok = await HANDLERS[parsed.command](ctx);
    } catch (err) {
      log.error({ err, command: parsed.command }, 'command failed');
      await reply(ctx, `⚠️ \`/${parsed.command}\` failed: ${quote(err.message).slice(0, 200)}`).catch(() => {});
    }
    await addCommentReaction(owner, repoName, comment.id, ok ? 'rocket' : 'confused');
    recordCommandActivity({ repo: ctx.repo, prNumber: ctx.prNumber, user, command: parsed.command, ok });
    return { status: ok ? 'completed' : 'failed', command: parsed.command };
  });
}
