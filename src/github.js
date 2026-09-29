import axios from 'axios';
import { config } from './config.js';
import { childLogger } from './logger.js';

const log = childLogger('github');

const api = axios.create({
  baseURL: config.github.apiUrl,
  headers: {
    Authorization: `Bearer ${config.github.token}`,
    Accept: 'application/vnd.github.v3+json',
    'User-Agent': 'code-review-agent',
  },
  timeout: 15000,
  // Never let axios parse our string diff as JSON
  transformResponse: [(data) => data],
});

/**
 * Extract a short, safe error message from an axios error.
 * @param {unknown} err
 * @returns {string}
 */
function githubError(err) {
  const status = err?.response?.status;
  const body = err?.response?.data;
  const detail =
    typeof body === 'string' ? body.slice(0, 200) : body?.message || err.message;
  return status ? `GitHub API ${status}: ${detail}` : `GitHub API error: ${err.message}`;
}

/**
 * Fetch the unified diff for a pull request.
 * @param {string} owner
 * @param {string} repo
 * @param {number} prNumber
 * @returns {Promise<string>} empty string if the diff is missing
 * @throws {Error} on transport/HTTP failure (original error attached as `cause`)
 */
export async function fetchPRDiff(owner, repo, prNumber) {
  const start = Date.now();
  const pr = `${owner}/${repo}#${prNumber}`;
  log.info({ pr }, 'fetching diff');
  try {
    const { data } = await api.get(`/repos/${owner}/${repo}/pulls/${prNumber}`, {
      headers: { Accept: 'application/vnd.github.v3.diff' },
      responseType: 'text',
    });
    if (typeof data !== 'string') {
      throw new Error('GitHub returned a non-diff response');
    }
    if (!data.trim()) {
      log.warn({ pr }, 'empty diff');
    }
    log.info({ chars: data.length, duration_ms: Date.now() - start }, 'diff fetched');
    return data;
  } catch (err) {
    throw new Error(githubError(err), { cause: err });
  }
}

/**
 * Post a review comment on a pull request.
 * @param {string} owner
 * @param {string} repo
 * @param {number} prNumber
 * @param {string} body
 * @returns {Promise<number>} comment id
 * @throws {Error} on failure (caller decides how to surface it)
 */
export async function postPRComment(owner, repo, prNumber, body) {
  const start = Date.now();
  const pr = `${owner}/${repo}#${prNumber}`;
  log.info({ pr, chars: body.length }, 'posting review comment');
  try {
    const { data } = await api.post(
      `/repos/${owner}/${repo}/issues/${prNumber}/comments`,
      { body }
    );
    const payload = parseJson(data);
    if (!payload) log.warn({ pr }, 'comment response was not valid JSON');
    log.info({ comment_id: payload?.id, duration_ms: Date.now() - start }, 'review comment posted');
    return payload?.id;
  } catch (err) {
    throw new Error(githubError(err), { cause: err });
  }
}

/**
 * The shared axios instance disables response parsing (needed for raw
 * diffs), so JSON envelopes are parsed here.
 * @returns {object|null}
 */
function parseJson(data) {
  if (typeof data !== 'string') return data ?? null;
  try {
    return JSON.parse(data);
  } catch {
    return null;
  }
}

/**
 * Fetch pull request metadata (title, head sha, draft flag, ...).
 * @returns {Promise<object>}
 * @throws {Error} on failure
 */
export async function fetchPR(owner, repo, prNumber) {
  let data;
  try {
    ({ data } = await api.get(`/repos/${owner}/${repo}/pulls/${prNumber}`));
  } catch (err) {
    throw new Error(githubError(err), { cause: err });
  }
  const pr = parseJson(data);
  if (!pr || typeof pr !== 'object') throw new Error('GitHub returned a non-JSON PR response');
  return pr;
}

/**
 * Submit a PR review: summary body plus line-anchored inline comments.
 * Uses the COMMENT event — it never approves or blocks by itself (that is
 * what the commit status is for), and GitHub forbids REQUEST_CHANGES on
 * your own PR, which is common when the agent runs on a personal token.
 * @param {string} owner
 * @param {string} repo
 * @param {number} prNumber
 * @param {{body:string, comments:Array<{path:string,line:number,body:string}>, commitId?:string}} review
 * @returns {Promise<{id:number, url:string}>}
 * @throws {Error} on failure (e.g. 422 when an anchor is not part of the diff)
 */
export async function createPRReview(owner, repo, prNumber, { body, comments, commitId }) {
  const start = Date.now();
  const pr = `${owner}/${repo}#${prNumber}`;
  log.info({ pr, inline_comments: comments.length }, 'submitting PR review');
  try {
    const { data } = await api.post(`/repos/${owner}/${repo}/pulls/${prNumber}/reviews`, {
      body,
      event: 'COMMENT',
      ...(commitId ? { commit_id: commitId } : {}),
      comments: comments.map((c) => ({ path: c.path, line: c.line, side: 'RIGHT', body: c.body })),
    });
    const payload = parseJson(data);
    log.info({ review_id: payload?.id, duration_ms: Date.now() - start }, 'PR review submitted');
    return { id: payload?.id, url: payload?.html_url };
  } catch (err) {
    throw new Error(githubError(err), { cause: err });
  }
}

/**
 * Set a commit status (shows as a check on the PR; can be made a required
 * check in branch protection to gate merges on critical findings).
 * Best-effort: failures are logged, never thrown — tokens without the
 * statuses permission must not break reviews.
 * @param {string} owner
 * @param {string} repo
 * @param {string} sha
 * @param {{state:'success'|'failure'|'error'|'pending', description:string, targetUrl?:string}} status
 * @returns {Promise<boolean>}
 */
export async function setCommitStatus(owner, repo, sha, { state, description, targetUrl }) {
  try {
    await api.post(`/repos/${owner}/${repo}/statuses/${sha}`, {
      state,
      context: 'code-review-agent',
      description: String(description).slice(0, 140),
      ...(targetUrl ? { target_url: targetUrl } : {}),
    });
    log.info({ state, sha: sha.slice(0, 7) }, 'commit status set');
    return true;
  } catch (err) {
    log.warn({ error: githubError(err) }, 'commit status failed (token may lack statuses permission)');
    return false;
  }
}

/**
 * React to an issue/PR comment (e.g. 👀 to acknowledge a command). Best-effort.
 * @param {'+1'|'-1'|'laugh'|'confused'|'heart'|'hooray'|'rocket'|'eyes'} content
 * @returns {Promise<boolean>}
 */
export async function addCommentReaction(owner, repo, commentId, content) {
  try {
    await api.post(`/repos/${owner}/${repo}/issues/comments/${commentId}/reactions`, { content });
    return true;
  } catch (err) {
    log.debug({ error: githubError(err) }, 'reaction failed');
    return false;
  }
}
