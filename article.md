# Building a Code Reviewer That Actually Remembers Your Team's Decisions

Every time a code review comment gets posted, it disappears into GitHub's timeline. The next PR, the reviewer forgets everything—including the decisions your team made three weeks ago. I built a system to fix that: a code review agent backed by persistent semantic memory that recalls and enforces team conventions on every PR.

This is the story of how I integrated [Hindsight semantic memory](https://hindsight.vectorize.io/) into a production code reviewer, the technical decisions that made it work, and what I learned about building stateful agents that teams actually use.

## The Problem: Stateless Reviews

Most code reviewers are memoryless. GitHub's native code review runs in isolation. Your CI linter has no context. AI-powered reviewers? They see the diff and nothing else. Three weeks ago, your team decided to use Zod for all validation. Today, someone submits a PR with hand-rolled validators. The LLM reviewer has no idea this violates your convention—it's not a syntax error, so the reviewer misses it entirely.

I'd seen this pattern play out at scale: teams making the same architectural corrections over and over, explaining the same design decisions repeatedly, and gradually watching code quality drift as context gets lost.

The solution was clear: give the reviewer a long-term memory. But not a dumb database of past reviews—a semantic memory that understands *why* decisions matter and can surface them when relevant.

## How It Works: The Full Pipeline

When a pull request lands on GitHub, the system activates:

1. **Webhook signature verification** (HMAC-SHA256, timing-safe)
2. **Diff fetch and sanitization** from the GitHub API
3. **Semantic recall** via [Hindsight](https://github.com/vectorize-io/hindsight)—querying team memories relevant to the changed files and title
4. **LLM generation** (Groq, with memory citations injected)
5. **Publication** as both inline comments and a summary
6. **Learning extraction**—pulling new insights from the review and storing them back into memory

The magic happens in steps 3 and 4: the reviewer recalls what your team has decided and grounds its findings in those decisions.

## The Core Story: Recall Query Design

Building a working code reviewer is straightforward. Building one that *actually finds relevant memories* is the hard part. This is where I spent most of my thinking.

The naive approach: query Hindsight with the PR title. This fails immediately. A title like "Add user auth" is too generic. You'll get back memories about *any* auth work, not the specific conventions that matter for this change.

I learned that **file paths carry stronger signals than code content**. If someone is changing `src/validators/user.ts`, that's more informative than a diff excerpt. The system now builds a multi-layered recall query:

```javascript
function buildRecallQuery(prTitle, diff) {
  const files = extractChangedFiles(diff);
  const fileBlock = files.length ? `\nChanged files: ${files.join(', ')}` : '';
  return `${prTitle}${fileBlock}\n${sanitizeDiff(diff, 1500)}`;
}
```

The query combines:
- The PR title (what the author *thinks* they're doing)
- Changed file paths (structural signal)
- A truncated diff excerpt (behavioral signal)

This three-part query significantly improves recall relevance. When someone touches `src/validators/`, Hindsight surfaces memories about validation frameworks. When they touch `src/secrets/`, it recalls security constraints.

## Memory Retention: Tolerating Failure

Here's something I had to learn the hard way: **memory writes must never break a review**. If Hindsight is down, the review must still ship. If the retention API times out, you don't fail the entire pipeline.

I made retention failures silent and logged:

```javascript
export async function retainMemory(content, context, metadata = {}) {
  log.info({ type: context, content_preview: content.slice(0, 60) }, 'retaining memory');
  try {
    const response = await client.retain(BANK, content, {
      context,
      metadata: Object.fromEntries(
        Object.entries(metadata).map(([k, v]) => [k, String(v)])
      ),
      async: false,
    });
    if (response && response.success === false) {
      log.error('retain reported failure');
      return null;
    }
    return response;
  } catch (err) {
    log.error({ err }, 'retain failed');
    return null;
  }
}
```

Failures are caught, logged, and swallowed. The review completes. The memory write is retried asynchronously or deferred, but the user gets their feedback on time. This design principle—**fail gracefully, log thoroughly, keep moving**—became central to the whole system.

The local store (Postgres) keeps a record of everything the system *tried* to retain, even if Hindsight rejected it. This lets us resync later without losing data.

## Citation Tracking: Making Memory Visible

A memory that isn't cited isn't trusted. I needed the LLM to reference specific memories by number, so reviewers could see what past decision grounded each finding.

The review pipeline tracks this:

```javascript
export function citedMemories(review, memoryCount) {
  const cited = new Set();
  for (const f of review.findings) f.memoryRefs.forEach((n) => cited.add(n));
  return new Set([...cited].filter((n) => n >= 1 && n <= memoryCount));
}
```

When the LLM generates a finding, it includes `memory_refs: [1, 3]` to say "this violation was caught because of team decisions #1 and #3." The review comment then renders those memories inline:

```
> 🧠 **Team memory [1]** (decision): All database access goes through the repository layer
```

This transparency—showing *why* the reviewer flagged something—is what makes memories actionable instead of just background noise.

## ChatOps: Teaching the Memory

The reviewer also listens to slash commands in PR comments. A team member can type `/remember All validators use Zod` and it gets stored as a team decision immediately. This turns GitHub comments into a teaching interface:

```javascript
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
  // ...
}
```

A team member can also type `/ask "Why do we use Zod?"` and get an answer grounded in your team's recorded decisions, powered by Hindsight's `reflect` capability. This transforms the reviewer from a passive observer into an active participant in institutional knowledge.

## Real-World Workflow

Here's what this looks like in practice:

1. **Week 1:** A developer opens a PR with inconsistent error handling. The reviewer has no relevant memories yet, so it catches the issue but can't cite a convention.

2. **The PR comment:** A senior engineer types `/remember Errors should be typed; use custom Error subclasses for domain errors`. The memory is retained.

3. **Week 2:** Another developer opens a PR with the same pattern. Now Hindsight recalls the decision from Week 1. The reviewer's comment includes:
   ```
   > 🧠 **Team memory [1]** (decision): Errors should be typed; 
   > use custom Error subclasses for domain errors
   ```

4. **Week 3:** The system has accumulated five memories about error handling. A new pattern violation triggers citations to memories 1 and 3. The developer sees not just "this is wrong" but "this contradicts two earlier decisions we made."

This is where the system starts to work. Repetition decreases. Context builds. New team members learn conventions by reading review comments.

## What I Learned

### 1. Memory Quality Beats Memory Quantity

Early on, I tried retaining everything. Every finding from every review became a memory. The system drowned in noise. Now I'm strict: only high-confidence extractions (>0.7) become memories, and I cap it at 5 per review. The [Hindsight documentation](https://hindsight.vectorize.io/) emphasizes this—more memories don't mean better recalls. Focused, confident memories do.

### 2. Timing Safety Matters for Webhooks

I spend more time on webhook signature verification than I'd like to admit. HMAC verification must be timing-safe (constant-time comparison), raw body hashing (not parsed JSON), and verified before any processing. One mistake here and an attacker can make your reviewer spam any repository.

### 3. Graceful Degradation Is Non-Negotiable

If Hindsight is slow, the review waits. If it's down, the review ships without memory. If memory retention fails, the review completes and we log it for async retry. I built explicit fallback paths for each external dependency. This is why the system stays reliable even when upstream services wobble.

### 4. File Paths Are Better Signals Than Code

The biggest surprise: semantic relevance came from *which files changed*, not *what code changed*. A recall query that includes changed file paths outperforms one that relies on diff content alone. This isn't intuitive, but it works. Structure signals intent better than implementation details.

### 5. Teach the Reviewer Through Its Own Comments

Instead of a separate knowledge base or wiki, I let team members teach the memory through PR comments. `/remember` is a one-liner. It's right there in the workflow. No friction. This makes institutional knowledge actually sticky because the people who understand it write it down *in the moment*, not in a separate system weeks later.

## Deployment and Operations

The system runs as a Docker service on a managed platform, listening for GitHub webhooks. One deployment handles any number of repositories—you just point the webhook at the service and set `GITHUB_REPO_OWNER` + `GITHUB_REPO_NAME` to allowlist specific repos. Postgres stores review history and memory cache. [Hindsight](https://github.com/vectorize-io/hindsight) backs the semantic layer.

Logging is structured (Pino), with every request traced. Idempotency is built in: GitHub redelivers webhooks on timeout, and a bounded TTL cache dedupes them. The system handles Groq rate limits by shifting to fallback models. It's boring infrastructure, but that's the point—it works reliably.

## Why This Matters

Code review at scale is a knowledge problem, not a linting problem. Your linter catches syntax errors. Your type checker catches type errors. But who catches *decision violations*? Who ensures your team's architectural choices propagate? Without memory, this falls to humans, and humans get tired.

A reviewer backed by [agent memory](https://vectorize.io/what-is-agent-memory) doesn't get tired. It recalls every decision your team made. It cites them when violations appear. It learns new conventions in real time. Over months, it becomes an institutional memory that actually shapes code quality.

That's worth building.

---

*This system is in production, handling reviews across multiple repositories. The memory layer itself is powered by [Hindsight](https://github.com/vectorize-io/hindsight). If you're thinking about stateful reviewers or team memory systems, the technical patterns here transfer directly.*
