import axios from 'axios';
import { config } from './config.js';
import { logger } from './logger.js';

const api = axios.create({
  baseURL: config.github.apiUrl,
  headers: {
    Authorization: `Bearer ${config.github.token}`,
    Accept: 'application/vnd.github.v3+json',
    'User-Agent': 'code-review-agent',
  },
  timeout: 15000,
  // Never let axios serialize our string diff as JSON
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
 * @throws {Error} on transport/HTTP failure
 */
export async function fetchPRDiff(owner, repo, prNumber) {
  logger.info(`[GITHUB] Fetch diff: ${owner}/${repo}#${prNumber}`);
  try {
    const { data } = await api.get(`/repos/${owner}/${repo}/pulls/${prNumber}`, {
      headers: { Accept: 'application/vnd.github.v3.diff' },
      responseType: 'text',
    });
    if (typeof data !== 'string') {
      throw new Error('GitHub returned a non-diff response');
    }
    if (!data.trim()) {
      logger.warn(`[GITHUB] Empty diff for ${owner}/${repo}#${prNumber}`);
    }
    return data;
  } catch (err) {
    throw new Error(githubError(err));
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
  logger.info(`[GITHUB] Post comment: ${owner}/${repo}#${prNumber}`);
  try {
    const { data } = await api.post(
      `/repos/${owner}/${repo}/issues/${prNumber}/comments`,
      { body }
    );
    return data.id;
  } catch (err) {
    throw new Error(githubError(err));
  }
}
