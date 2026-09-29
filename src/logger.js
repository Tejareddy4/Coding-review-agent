import pino from 'pino';
import { config } from './config.js';

/**
 * Structured application logger.
 * Redacts fields that could carry secrets so they never hit stdout.
 */
export const logger = pino({
  level: config.logLevel,
  base: undefined, // omit pid/hostname noise
  redact: {
    paths: [
      'req.headers.authorization',
      'req.headers["x-hub-signature-256"]',
      'err.config.headers.Authorization',
      'err.config.headers.authorization',
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
