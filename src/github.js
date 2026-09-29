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
    // The shared axios instance disables response parsing (needed for raw
    // diffs), so parse the JSON envelope here to recover the comment id.
    let payload = data;
    if (typeof data === 'string') {
      try {
        payload = JSON.parse(data);
      } catch {
        log.warn({ pr }, 'comment response was not valid JSON');
        payload = null;
      }
    }
    log.info({ comment_id: payload?.id, duration_ms: Date.now() - start }, 'review comment posted');
    return payload?.id;
  } catch (err) {
    throw new Error(githubError(err), { cause: err });
  }
}
