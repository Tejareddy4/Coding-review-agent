import axios from 'axios';
import crypto from 'crypto';
import { config } from '../src/config.js';

// Sends a properly-signed synthetic pull_request event to the local server.
// Requires the server to be running (npm run dev) with the same
// GITHUB_WEBHOOK_SECRET, and mocks if GITHUB_API_URL/GROQ_BASE_URL point at
// local mock servers. Against real GitHub it will attempt a real fetch.

const payload = {
  action: 'opened',
  pull_request: { number: 1, title: 'Add user service', body: 'New service for user data' },
  repository: {
    name: config.github.repoName || 'test-repo',
    owner: { login: config.github.repoOwner || 'test-user' },
  },
};

const body = JSON.stringify(payload);
const signature =
  'sha256=' +
  crypto.createHmac('sha256', config.github.webhookSecret).update(body).digest('hex');

try {
  const res = await axios.post(`http://localhost:${config.port}/webhook`, body, {
    headers: {
      'Content-Type': 'application/json',
      'X-Hub-Signature-256': signature,
      'X-GitHub-Event': 'pull_request',
      'X-GitHub-Delivery': `test-${Date.now()}`,
    },
    timeout: 10000,
  });
  console.log('Response:', res.status, JSON.stringify(res.data));
} catch (err) {
  console.error('Error:', err.response ? `${err.response.status} ${err.response.data}` : err.message);
  process.exit(1);
}
