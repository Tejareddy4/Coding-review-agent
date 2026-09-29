import http from 'node:http';

/**
 * Minimal mock HTTP upstream for tests. Records every request and
 * routes by { method, matcher } pairs.
 * @param {Array<{method:string, match:(url:string)=>boolean, handler:(res:http.ServerResponse, body:string)=>void}>} routes
 * @returns {Promise<{server:http.Server, url:string, calls:Array<{method:string,url:string,body:string,at:number}>}>}
 */
export function startMockServer(routes = []) {
  const calls = [];

  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      calls.push({
        method: req.method,
        url: req.url,
        body,
        headers: req.headers,
        at: Date.now(),
      });
      const route = routes.find(
        (r) => r.method === req.method && r.match(req.url)
      );
      if (!route) {
        res.writeHead(404, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ message: `no mock route: ${req.method} ${req.url}` }));
        return;
      }
      route.handler(res, body);
    });
  });

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({ server, url: `http://127.0.0.1:${port}`, calls });
    });
  });
}

/** JSON response helper for mock handlers. */
export const json = (res, status, obj) => {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(obj));
};

/** OpenAI-compatible chat completion response. */
export const completion = (content) => ({
  choices: [{ message: { role: 'assistant', content } }],
});

/** Standard mock upstreams for the full pipeline. */
export async function startMockUpstreams(overrides = {}) {
  // Mutable so tests can change LLM/mock behavior between calls.
  const state = {
    reviewText: overrides.reviewText ?? '## Review\nPer convention [1]: avoid `any`. Use `unknown`.',
    failDiff: false,
    // Rate-limit simulation: listed models get one 429 (with retry-after),
    // then behave normally; always429 keeps 429-ing forever.
    rateLimitedModels: [],
    rateLimitRetryAfterSecs: 1,
    always429: false,
    rateLimited429s: 0,
    extractedMemories:
      overrides.extractedMemories ??
      [
        {
          type: 'convention',
          content: 'User service must validate input with Zod.',
          confidence: 0.9,
        },
      ],
    recallResults:
      overrides.recallResults ??
      [
        {
          id: 'm1',
          text: 'Never use the `any` type in TypeScript.',
          type: 'convention',
          scores: { final: 0.92 },
        },
        {
          id: 'm2',
          text: 'Never log PII. Use redactSensitive().',
          type: 'security_constraint',
          scores: { final: 0.81 },
        },
      ],
  };

  const github = await startMockServer([
    {
      method: 'GET',
      match: (u) => /\/repos\/([^/]+)\/([^/]+)\/pulls\/\d+$/.test(u),
      handler: (res) => {
        if (state.failDiff) {
          return json(res, 500, { message: 'boom' });
        }
        res.writeHead(200, { 'content-type': 'text/plain' });
        res.end(
          overrides.diff ??
            `diff --git a/src/user.ts b/src/user.ts
+++ b/src/user.ts
@@ -1,3 +1,5 @@
 export function getUser(id: any) {
-  console.log('user', id);
+  console.log('user email', id?.email);
+  const x: any = null;
 }`
        );
      },
    },
    {
      method: 'POST',
      match: (u) => /\/repos\/([^/]+)\/([^/]+)\/issues\/\d+\/comments$/.test(u),
      handler: (res, body) => {
        const parsed = JSON.parse(body);
        if (parsed.body.length > 65000) {
          return json(res, 422, { message: 'body too long' });
        }
        json(res, 201, { id: 42, body: parsed.body });
      },
    },
  ]);

  const groq = await startMockServer([
    {
      method: 'POST',
      match: (u) => u.endsWith('/chat/completions'),
      handler: (res, body) => {
        const parsed = JSON.parse(body);
        const model = parsed.model;
        if (state.always429 || state.rateLimitedModels.includes(model)) {
          if (!state.always429) {
            state.rateLimitedModels = state.rateLimitedModels.filter((m) => m !== model);
          }
          state.rateLimited429s++;
          res.writeHead(429, {
            'content-type': 'application/json',
            'retry-after': String(state.rateLimitRetryAfterSecs ?? 1),
          });
          return res.end(
            JSON.stringify({
              error: { message: `Rate limit reached for model ${model}`, type: 'rate_limit_exceeded' },
            })
          );
        }
        const system = parsed.messages?.[0]?.content || '';
        if (system.includes('Extract durable team decisions')) {
          return json(
            res,
            200,
            completion(JSON.stringify({ memories: state.extractedMemories }))
          );
        }
        json(res, 200, completion(state.reviewText));
      },
    },
  ]);

  const hindsight = await startMockServer([
    {
      method: 'POST',
      match: (u) => u.includes('/recall'),
      handler: (res) => json(res, 200, { results: state.recallResults }),
    },
    {
      method: 'POST',
      match: (u) => u.includes('/memories') || u.includes('/retain'),
      handler: (res) =>
        json(res, 200, {
          success: true,
          bank_id: 'test-bank',
          items_count: 1,
          async: false,
        }),
    },
    {
      method: 'POST',
      match: (u) => u.includes('/reflect'),
      handler: (res) => json(res, 200, { text: 'reflected' }),
    },
  ]);

  return { github, groq, hindsight, state };
}

/** Set env to point all upstreams at the mocks; must run BEFORE src imports. */
export function configureTestEnv(upstreams, extra = {}) {
  process.env = {
    ...process.env,
    GITHUB_TOKEN: 'ghp_test-token',
    GITHUB_WEBHOOK_SECRET: 'test-webhook-secret',
    GITHUB_REPO_OWNER: 'test-owner',
    GITHUB_REPO_NAME: 'test-repo',
    GITHUB_API_URL: upstreams.github.url,
    GROQ_API_KEY: 'gsk_test-key',
    GROQ_BASE_URL: upstreams.groq.url,
    GROQ_MODEL: 'test-model',
    HINDSIGHT_BASE_URL: upstreams.hindsight.url,
    HINDSIGHT_API_KEY: 'hsk_test-key',
    HINDSIGHT_BANK_ID: 'test-bank',
    NODE_ENV: 'production', // disables pino-pretty transport worker in tests
    LOG_LEVEL: 'silent',
    PORT: '0',
    DATABASE_URL: '', // never touch a real DB from the test suite
    ...extra,
  };
}

/** Wait for an Express app to actually listen on an ephemeral port. */
export function listen(app) {
  return new Promise((resolve) => {
    const server = app.listen(0, '127.0.0.1', () => resolve(server));
  });
}

/** Close a server including keep-alive sockets (prevents test-runner hangs). */
export function closeServer(server) {
  return new Promise((resolve) => {
    if (server.closeAllConnections) server.closeAllConnections();
    server.close(() => resolve());
  });
}

/** Poll until fn() returns truthy or timeout. */
export async function waitFor(fn, { timeoutMs = 5000, intervalMs = 25 } = {}) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (fn()) return true;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error(`waitFor timed out after ${timeoutMs}ms`);
}
