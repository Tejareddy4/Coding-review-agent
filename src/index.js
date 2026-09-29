import express from 'express';
import crypto from 'crypto';
import { pathToFileURL } from 'node:url';
import { config } from './config.js';
import { logger } from './logger.js';
import { processPR } from './review.js';

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

export function buildApp() {
  const app = express();

  // Raw body required for webhook signature verification.
  // 25mb = GitHub's documented max webhook payload size.
  app.use('/webhook', express.raw({ type: 'application/json', limit: '25mb' }));

  app.get('/health', (_req, res) => {
    res.json({ status: 'ok', uptime: process.uptime() });
  });

  app.post('/webhook', (req, res) => {
    const signature = req.headers['x-hub-signature-256'];
    const deliveryId = req.headers['x-github-delivery'];
    const event = req.headers['x-github-event'];

    if (!verifySignature(req.body, signature)) {
      logger.warn('[WEBHOOK] Rejected: missing/invalid signature');
      return res.status(401).send('Unauthorized');
    }
    if (typeof event !== 'string') {
      logger.warn('[WEBHOOK] Rejected: missing x-github-event header');
      return res.status(400).send('Bad Request');
    }

    let payload;
    try {
      payload = JSON.parse(req.body.toString('utf8'));
    } catch {
      logger.warn('[WEBHOOK] Rejected: invalid JSON');
      return res.status(400).send('Bad Request');
    }

    if (event === 'ping') {
      logger.info(`[WEBHOOK] ping ok (delivery ${deliveryId})`);
      return res.status(200).json({ ok: true, event: 'ping' });
    }

    logger.info(`[WEBHOOK] Received ${event} (delivery ${deliveryId})`);
    res.status(202).send('Accepted');

    // Process asynchronously — GitHub requires fast ACK and will
    // redeliver (and eventually disable the hook) on slow responses.
    setImmediate(() => {
      if (event === 'pull_request') {
        processPR(payload, deliveryId).catch((err) =>
          logger.error({ err: err.message }, '[WEBHOOK] processPR failed')
        );
      }
    });
  });

  return app;
}

// Guard: only start listening when run directly (not when imported by tests).
const isMain =
  process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  const app = buildApp();
  const server = app.listen(config.port, () => {
    logger.info(`[SERVER] Listening on port ${config.port} (${config.nodeEnv})`);
  });

  // Graceful shutdown (Docker sends SIGTERM; finish in-flight work first).
  const shutdown = (signal) => {
    logger.info(`[SERVER] ${signal} received, shutting down...`);
    server.close(() => {
      logger.info('[SERVER] Closed');
      process.exit(0);
    });
    setTimeout(() => {
      logger.warn('[SERVER] Forced exit after timeout');
      process.exit(1);
    }, 10000).unref();
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}
