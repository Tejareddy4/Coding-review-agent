# 60-Second Demo Script

**0:00–0:10 — Problem**
"Teams forget decisions. The same mistakes repeat in every PR. Generic AI reviewers don't know YOUR conventions."

**0:10–0:20 — Setup**
Show the webhook firing (terminal logs: `[WEBHOOK] → [GITHUB] → [HINDSIGHT] → [GROQ] → [REVIEW]`).

**0:20–0:35 — PR #1 (With seeded memory)**
Open PR #1 that uses TypeScript `any` and logs user email.
Agent posts: "Per team convention [2]: never use `any` — use `unknown` with type guards. Per security constraint [3]: never log PII — use redactSensitive()."

**0:35–0:50 — Memory grows**
Switch to Hindsight UI. Show memories recalled for this review + the NEW memory retained from PR #1's review (e.g. "user service must validate input with Zod").

**0:50–1:00 — PR #2 (Memory compounds)**
Open PR #2 touching the same service. Review now cites BOTH the seed conventions AND the decision learned from PR #1. Same agent, smarter review.

**Punchline:** "Same mistake. Two completely different reviews over time. That's the power of memory."

## Prep checklist
- [ ] `npm run seed` completed
- [ ] Server running (`npm run dev`) with webhook forwarded (`gh webhook forward`)
- [ ] PR #1 and PR #2 branches ready to open in demo repo
- [ ] Hindsight bank dashboard open in a browser tab
