'use strict';

const path = require('path');

function readInt(name, fallback, options = {}) {
  const min = options.min ?? Number.MIN_SAFE_INTEGER;
  const max = options.max ?? Number.MAX_SAFE_INTEGER;
  const parsed = Number.parseInt(process.env[name] ?? '', 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}

function readBool(name, fallback = false) {
  const value = process.env[name];
  if (value == null || value === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(String(value).toLowerCase());
}

const root = path.resolve(__dirname, '..');

const publicModelIds = Array.from(new Set([
  process.env.MODEL_ID || 'moonshotai/kimi-k3_1-pro',
  'moonshotai/kimi-k3.1-pro',
]));

module.exports = {
  root,
  host: process.env.HOST || '127.0.0.1',
  port: readInt('PORT', 4000, { min: 1, max: 65535 }),
  profileDir: process.env.PROFILE_DIR ? path.resolve(process.env.PROFILE_DIR) : path.join(root, 'nvidia-profile'),
  headless: readBool('HEADLESS', false),
  workers: readInt('WORKERS', 2, { min: 1, max: 6 }),
  playgroundUrl: process.env.PLAYGROUND_URL || 'https://build.nvidia.com/moonshotai/kimi-k3_1-pro/playground',
  upstreamModel: process.env.UPSTREAM_MODEL || 'moonshotai/kimi-k3.1-pro',
  publicModelIds,
  triggerText: process.env.TRIGGER_TEXT || 'continuar',
  maxTokens: readInt('MAX_TOKENS', 65536, { min: 256, max: 131072 }),
  reasoningEffort: process.env.REASONING_EFFORT || 'low',
  conciseResponses: readBool('CONCISE_RESPONSES', true),
  firstByteTimeoutMs: readInt('FIRST_BYTE_TIMEOUT_MS', 90000, { min: 10000 }),
  idleTimeoutMs: readInt('IDLE_TIMEOUT_MS', 180000, { min: 10000 }),
  requestTimeoutMs: readInt('REQUEST_TIMEOUT_MS', 1800000, { min: 60000 }),
  queueTimeoutMs: readInt('QUEUE_TIMEOUT_MS', 600000, { min: 10000 }),
  resetAfterTurns: readInt('RESET_AFTER_TURNS', 40, { min: 1 }),
  browserTimeoutMs: readInt('BROWSER_TIMEOUT_MS', 60000, { min: 10000 }),
  headersDelayMs: readInt('HEADERS_DELAY_MS', 8000, { min: 0 }),
  debug: readBool('DEBUG', false),
  maxMessageBytes: readInt('MAX_MESSAGE_BYTES', 100 * 1024 * 1024, { min: 1024 * 1024 }),
};
