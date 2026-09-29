# Code Review Agent with Hindsight Memory — Build Plan

> **Team:** [Your Name] + [Brother's Name]
> **Hackathon:** HackwithHyderabad 3.0
> **Stack:** Node.js + Express + Hindsight + Groq + GitHub Webhooks
> **Goal:** MVP in 5–6 hours. Win hackathon. Portfolio piece.

---

## 0. Project Summary

An AI code review agent that:
1. Listens for GitHub pull request events via webhook
2. Recalls past team decisions, conventions, and incidents from Hindsight
3. Reviews the PR diff using an LLM (Groq) with those memories injected
4. Posts a review comment on the PR that references past decisions
5. Retains new learnings from each review into Hindsight
6. Gets smarter over time — same mistake in PR #2 references the decision made in PR #1

**Why memory is central:** Without Hindsight, the agent is a generic linter. With Hindsight, it becomes a long-term team contributor that remembers what your team decided, what broke before, and what conventions you follow.

---

## 1. Environment Setup Checklist

| Item | Status | Notes |
|:---|:---:|:---|
| GitHub repo created | ☐ | `code-review-agent` |
| Hindsight Cloud account | ☐ | https://ui.hindsight.vectorize.io |
| Hindsight promo code applied | ☐ | `MEMHACK99` → $50 credits |
| Hindsight API key saved | ☐ | Add to `.env` |
| Groq API key saved | ☐ | https://groq.com |
| Node.js 20+ installed | ☐ | `node --version` |
| `gh` CLI installed | ☐ | `gh --version` |
| `gh webhook forward` extension | ☐ | `gh extension install cli/gh-webhook` |
| GitHub webhook secret generated | ☐ | Random 32-char string |

---

## 2. Environment Variables (`.env`)

```env
# GitHub
GITHUB_TOKEN=ghp_xxxxxxxxxxxx
GITHUB_WEBHOOK_SECRET=your-random-secret-here
GITHUB_REPO_OWNER=your-username
GITHUB_REPO_NAME=code-review-agent

# Hindsight
HINDSIGHT_BASE_URL=https://api.hindsight.vectorize.io
HINDSIGHT_API_KEY=hsk_xxxxxxxxxxxx
HINDSIGHT_BANK_ID=code-review-agent-bank

# Groq
GROQ_API_KEY=gsk_xxxxxxxxxxxx
GROQ_MODEL=openai/gpt-oss-120b

# Server
PORT=8080
NODE_ENV=development