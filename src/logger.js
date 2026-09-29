import pino from 'pino';
import { AsyncLocalStorage } from 'node:async_hooks';
import { config } from './config.js';

/**
 * Per-delivery logging context. Populated by the webhook handler
 * (deliveryId, event) and the review pipeline (pr), then merged into
 * every log line via pino's `mixin` — so any log anywhere inside an
 * async chain automatically carries its correlation fields.
 */
export const logContext = new AsyncLocalStorage();

/**
 * Structured application logger.
 * - child loggers add a `component` field (replaces "[PREFIX]" string tags)
 * - `mixin` injects request-scoped correlation (deliveryId / pr)
 * - full error serialization (stack + cause chain) under the `err` key
 * - redacts fields that could carry secrets so they never hit stdout
 */
export const logger = pino({
  name: 'code-review-agent',
  level: config.logLevel,
  base: undefined, // omit pid/hostname noise
  // NOTE: pino does `obj = Object.assign(mixin(), obj)` — the mixin result is
  // the assign TARGET. Returning the live store would let pino write every
  // logged field back onto it, so we always hand pino a fresh copy.
  mixin: () => {
    const store = logContext.getStore();
    return store ? { ...store } : {};
  },
  serializers: { err: pino.stdSerializers.err },
  redact: {
    paths: [
      'req.headers.authorization',
      'req.headers["x-hub-signature-256"]',
      'err.config.headers.Authorization',
      'err.config.headers.authorization',
      'err.cause.config.headers.Authorization',
      'err.cause.config.headers.authorization',
      '*.token',
      '*.apiKey',
    ],
    censor: '[REDACTED]',
  },
  transport:
    config.nodeEnv !== 'production'
      ? { target: 'pino-pretty', options: { colorize: true, ignore: 'pid,hostname' } }
      : undefined,
});

/** Child logger bound to a component name, e.g. childLogger('github'). */
export function childLogger(component) {
  return logger.child({ component });
}
