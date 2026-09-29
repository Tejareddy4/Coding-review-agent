import express from 'express';
import crypto from 'crypto';
import { pathToFileURL } from 'node:url';
import { config } from './config.js';
import { logContext, childLogger } from './logger.js';
import { initStore, closeStore } from './store.js';
import { processPR } from './review.js';

const httpLog = childLogger('http');
const webhookLog = childLogger('webhook');
const serverLog = childLogger('server');

/**
 * Verify the GitHub HMAC-SHA256 webhook signature against the raw body.
 * Timing-safe; constant behavior on length mismatch.
 * @param {Buffer} rawBody
 * @param {string|undefined} signature - value of x-hub-signature-256
 * @returns {boolean}
 */
export function verifySignature(rawBody, signature) {
  if (!signature || !Buffer.isBuffer(rawBody)) return false;
  const expected =
    'sha256=' +
    crypto.createHmac('sha256', config.github.webhookSecret).update(rawBody).digest('hex');
  const sigBuf = Buffer.from(signature);
  const expBuf = Buffer.from(expected);
  if (sigBuf.length !== expBuf.length) return false;
  return crypto.timingSafeEqual(sigBuf, expBuf);
}

/** Read a header as a bounded string (rejects arrays, caps length for log safety). */
const headerString = (value, max = 64) =>
  typeof value === 'string' && value.length ? value.slice(0, max) : undefined;

export function buildApp() {
  const app = express();

  // Raw body required for webhook signature verification.
  // 25mb = GitHub's documented max webhook payload size.
  app.use('/webhook', express.raw({ type: 'application/json', limit: '25mb' }));

  // Access log (health-probe traffic excluded as noise).
  app.use((req, res, next) => {
    if (req.path === '/health') return next();
    const start = Date.now();
    res.on('finish', () => {
      httpLog.info(
        {
          method: req.method,
          path: req.url,
          status: res.statusCode,
          duration_ms: Date.now() - start,
        },
        'request completed'
      );
    });
    next();
  });

  app.get('/health', (_req, res) => {
    res.json({ status: 'ok', uptime: process.uptime() });
  });

  app.post('/webhook', (req, res) => {
    const headers = {
      // 'sha256=' + 64 hex chars = 71 — cap must not truncate valid signatures
      signature: headerString(req.headers['x-hub-signature-256'], 128),
      deliveryId: headerString(req.headers['x-github-delivery']),
      event: headerString(req.headers['x-github-event']),
    };

    // Correlate every log line in this delivery's async chain.
    logContext.run({ deliveryId: headers.deliveryId, event: headers.event }, () =>
      handleWebhook(req, res, headers)
    );
  });

  return app;
}

function handleWebhook(req, res, { signature, deliveryId, event }) {
  if (!verifySignature(req.body, signature)) {
    webhookLog.warn('rejected: missing/invalid signature');
    return res.status(401).send('Unauthorized');
  }
  if (!event) {
    webhookLog.warn('rejected: missing x-github-event header');
    return res.status(400).send('Bad Request');
  }

  let payload;
  try {
    payload = JSON.parse(req.body.toString('utf8'));
  } catch {
    webhookLog.warn('rejected: invalid JSON');
    return res.status(400).send('Bad Request');
  }

  if (event === 'ping') {
    webhookLog.info('ping acknowledged');
    return res.status(200).json({ ok: true, event: 'ping' });
  }

  webhookLog.info('webhook accepted');
  res.status(202).send('Accepted');

  // Process asynchronously — GitHub requires fast ACK and will
  // redeliver (and eventually disable the hook) on slow responses.
  setImmediate(() => {
    if (event === 'pull_request') {
      processPR(payload, deliveryId).catch((err) =>
        webhookLog.error({ err }, 'processPR failed')
      );
    }
  });
}

// Guard: only start listening when run directly (not when imported by tests).
const isMain =
  process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  await initStore();
  const app = buildApp();
  const server = app.listen(config.port, () => {
    serverLog.info(`listening on port ${config.port} (${config.nodeEnv})`);
  });

  // Graceful shutdown (Docker sends SIGTERM; finish in-flight work first).
  const shutdown = (signal) => {
    serverLog.info(`${signal} received, shutting down`);
    server.close(() => {
      closeStore().finally(() => {
        serverLog.info('closed');
        process.exit(0);
      });
    });
    setTimeout(() => {
      serverLog.warn('forced exit after timeout');
      process.exit(1);
    }, 10000).unref();
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}
