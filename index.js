'use strict';

const express = require('express');
const config = require('./src/config');
const { PlaygroundBridge } = require('./src/playground');
const { SseRelay } = require('./src/sse');
const {
  buildContinuationBody,
  buildUpstreamBody,
  mergeUsage,
  toChatCompletion,
  toChatCompletionChunk,
  errorPayload,
  HttpError,
} = require('./src/openai');

function createLogger(debug) {
  const stamp = () => new Date().toISOString().slice(11, 19);
  return {
    info: (...args) => console.log(`[${stamp()}]`, ...args),
    warn: (...args) => console.warn(`[${stamp()}] WARN`, ...args),
    error: (...args) => console.error(`[${stamp()}] ERROR`, ...args),
    debug: (...args) => {
      if (debug) console.log(`[${stamp()}] DEBUG`, ...args);
    },
  };
}

const logger = createLogger(config.debug);
const bridge = new PlaygroundBridge(config, logger);
const app = express();

app.disable('x-powered-by');
app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (origin && /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/i.test(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
  }
  res.setHeader('Access-Control-Allow-Headers', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  if (req.method === 'OPTIONS') {
    res.status(204).end();
    return;
  }
  next();
});
app.use(express.json({ limit: config.maxMessageBytes }));

function requestId() {
  return `req_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
}

function respondError(res, requestIdValue, error) {
  const status = error instanceof HttpError ? error.status : 502;
  const type = error instanceof HttpError ? error.type : 'bridge_error';
  const code = error instanceof HttpError ? error.code : null;
  const message = (error && error.message) || String(error);
  if (res.destroyed || res.writableEnded) return;
  if (res.headersSent) {
    res.end();
    return;
  }
  res.status(status).json(errorPayload(message, type, code));
  if (status >= 500) {
    logger.error(`[${requestIdValue}] ${status} ${message}`);
  } else {
    logger.warn(`[${requestIdValue}] ${status} ${message}`);
  }
}

app.get('/', (req, res) => {
  res.json({
    name: 'nvidia-playwright-bridge',
    description: 'OpenAI-compatible bridge to the NVIDIA Build Kimi playground',
    model: config.publicModelIds[0],
    endpoints: ['/v1/models', '/v1/chat/completions', '/health'],
  });
});

app.get('/health', (req, res) => {
  const health = bridge.health();
  res.json({
    ...health,
    model: config.publicModelIds[0],
    upstream: config.upstreamModel,
    profile: config.profileDir,
  });
});

app.get('/v1/models', (req, res) => {
  const created = Math.floor(Date.now() / 1000);
  res.json({
    object: 'list',
    data: config.publicModelIds.map(id => ({
      id,
      object: 'model',
      created,
      owned_by: 'nvidia',
    })),
  });
});

app.get('/v1/models/:id', (req, res) => {
  res.json({
    id: req.params.id,
    object: 'model',
    created: Math.floor(Date.now() / 1000),
    owned_by: 'nvidia',
  });
});

app.post('/v1/chat/completions', async (req, res) => {
  const id = requestId();
  const startedAt = Date.now();
  const clientBody = req.body;
  if (!clientBody || typeof clientBody !== 'object') {
    res.status(400).json(errorPayload('The request body must be a JSON object', 'invalid_request_error'));
    return;
  }
  if (!Array.isArray(clientBody.messages) || clientBody.messages.length === 0) {
    res.status(400).json(errorPayload('messages must be a non-empty array', 'invalid_request_error'));
    return;
  }

  let prepared;
  try {
    prepared = buildUpstreamBody(clientBody, config);
  } catch (error) {
    respondError(res, id, error);
    return;
  }

  const wantsStream = clientBody.stream === true;
  logger.info(
    `[${id}] start model=${prepared.requestedModel} messages=${prepared.meta.messages} tools=${prepared.meta.tools} stream=${wantsStream} maxTokens=${prepared.meta.maxTokens ?? 'unlimited'}`,
  );
  if (prepared.meta.clamped) {
    logger.debug(`[${id}] max_tokens clamped to ${prepared.meta.maxTokens}`);
  }

  let closed = false;
  let worker = null;
  let headersSent = false;
  let streamStarted = false;
  let keepAlive = null;
  let headersTimer = null;

  const startSse = () => {
    if (headersSent || closed) return;
    headersSent = true;
    if (headersTimer) {
      clearTimeout(headersTimer);
      headersTimer = null;
    }
    res.status(200);
    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    try {
      if (res.socket) res.socket.setNoDelay(true);
      res.flushHeaders();
    } catch {
      closed = true;
      cleanup();
      if (worker) worker.abort('Client disconnected');
      return;
    }
    keepAlive = setInterval(() => {
      if (closed || res.writableEnded || res.destroyed) return;
      try {
        res.write(': keepalive\n\n');
      } catch {
        cleanup();
      }
    }, 10000);
    if (keepAlive.unref) keepAlive.unref();
  };

  const cleanup = () => {
    if (keepAlive) {
      clearInterval(keepAlive);
      keepAlive = null;
    }
    if (headersTimer) {
      clearTimeout(headersTimer);
      headersTimer = null;
    }
  };

  const safeWrite = chunk => {
    if (closed || res.writableEnded || res.destroyed) return false;
    try {
      res.write(chunk);
      return true;
    } catch {
      closed = true;
      cleanup();
      if (worker) worker.abort('Client disconnected');
      return false;
    }
  };

  res.on('close', () => {
    if (res.writableEnded) return;
    closed = true;
    cleanup();
    if (worker) worker.abort('Client disconnected');
  });

  if (wantsStream) {
    headersTimer = setTimeout(startSse, config.headersDelayMs);
    if (headersTimer.unref) headersTimer.unref();
  }

  const relay = wantsStream ? new SseRelay(chunk => safeWrite(chunk)) : null;
  const onRaw = chunk => {
    if (closed || !wantsStream) return;
    if (!streamStarted) {
      streamStarted = true;
      startSse();
    }
    relay.push(chunk);
  };

  const DEFAULT_UPSTREAM_MAX_TOKENS = 65536;
  let fallbackBody = prepared.body.max_tokens > DEFAULT_UPSTREAM_MAX_TOKENS
    ? { ...prepared.body, max_tokens: DEFAULT_UPSTREAM_MAX_TOKENS }
    : null;
  const isMaxTokensError = error => {
    const message = String((error && error.message) || '');
    return /HTTP 400/i.test(message)
      && /max_tokens|max_completion_tokens|maximum context|context length|token limit|too many tokens/i.test(message);
  };

  const executeTurn = async upstreamBody => {
    let lastError = null;
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      if (closed) return { accumulator: null, error: null };
      let turnWorker;
      try {
        turnWorker = await bridge.acquire(config.queueTimeoutMs);
      } catch (error) {
        return { accumulator: null, error };
      }
      if (closed) {
        bridge.release(turnWorker);
        return { accumulator: null, error: null };
      }
      worker = turnWorker;
      try {
        const accumulator = await turnWorker.execute(upstreamBody, { onRaw });
        return { accumulator, error: null };
      } catch (error) {
        lastError = error;
        logger.warn(`[${id}] attempt ${attempt} failed: ${error.message}`);
        if (attempt === 1 && !streamStarted && !closed) {
          if (fallbackBody && isMaxTokensError(error)) {
            logger.warn(`[${id}] retrying with max_tokens=${DEFAULT_UPSTREAM_MAX_TOKENS}`);
            upstreamBody = fallbackBody;
            prepared.body.max_tokens = DEFAULT_UPSTREAM_MAX_TOKENS;
            fallbackBody = null;
          }
          continue;
        }
        return { accumulator: null, error: lastError };
      } finally {
        bridge.release(turnWorker);
        if (worker === turnWorker) worker = null;
      }
    }
    return { accumulator: null, error: lastError };
  };

  let { accumulator, error: lastError } = await executeTurn(prepared.body);
  let combinedContent = accumulator ? accumulator.aggregate.content : '';
  let combinedReasoning = accumulator ? accumulator.aggregate.reasoning : '';
  let combinedUsage = accumulator ? accumulator.aggregate.usage : null;
  let finishReason = accumulator ? accumulator.getFinishReason() : null;
  let continuations = 0;

  while (
    accumulator
    && !closed
    && !accumulator.error
    && config.autoContinue
    && config.maxContinuations > 0
    && finishReason === 'length'
    && accumulator.getToolCalls().length === 0
    && continuations < config.maxContinuations
  ) {
    continuations += 1;
    logger.info(`[${id}] continuation ${continuations}/${config.maxContinuations}: output limit reached, asking Kimi to continue`);
    const continuationBody = buildContinuationBody(prepared.body, combinedContent, config);
    const result = await executeTurn(continuationBody);
    if (!result.accumulator) {
      lastError = result.error || new HttpError(502, 'The continuation request failed', 'upstream_error');
      accumulator = null;
      break;
    }
    const next = result.accumulator;
    combinedContent += next.aggregate.content;
    combinedReasoning += next.aggregate.reasoning;
    combinedUsage = mergeUsage(combinedUsage, next.aggregate.usage);
    finishReason = next.getFinishReason();
    accumulator = next;
  }

  cleanup();

  if (closed) return;

  if (!accumulator) {
    const error = lastError instanceof HttpError
      ? lastError
      : new HttpError(502, (lastError && lastError.message) || 'The bridge could not get a response from Kimi', 'upstream_error');
    if (wantsStream && headersSent) {
      relay.flush();
      safeWrite(`data: ${JSON.stringify(errorPayload(error.message, error.type, error.code))}\n\n`);
      safeWrite('data: [DONE]\n\n');
      if (!closed && !res.writableEnded) res.end();
      logger.error(`[${id}] failed after ${Date.now() - startedAt}ms: ${error.message}`);
      return;
    }
    respondError(res, id, error);
    return;
  }

  accumulator.aggregate.content = combinedContent;
  accumulator.aggregate.reasoning = combinedReasoning;
  accumulator.aggregate.usage = combinedUsage;
  accumulator.aggregate.finishReason = finishReason;

  if (wantsStream) {
    startSse();
    if (closed) return;
    relay.flush();
    if (accumulator.error) {
      safeWrite(`data: ${JSON.stringify(errorPayload(accumulator.error, 'upstream_error'))}\n\n`);
    } else {
      safeWrite(`data: ${JSON.stringify(toChatCompletionChunk(accumulator, prepared.requestedModel))}\n\n`);
    }
    safeWrite('data: [DONE]\n\n');
    if (!closed && !res.writableEnded && !res.destroyed) res.end();
  } else {
    res.json(toChatCompletion(accumulator, prepared.requestedModel));
  }

  const toolCalls = accumulator.getToolCalls().length;
  logger.info(
    `[${id}] done in ${Date.now() - startedAt}ms tokens=${combinedUsage ? combinedUsage.total_tokens : '?'} tools=${toolCalls} finish=${finishReason} continuations=${continuations}`,
  );
});

app.use((error, req, res, next) => {
  if (error && error.type === 'entity.parse.failed') {
    res.status(400).json(errorPayload('Invalid JSON body', 'invalid_request_error'));
    return;
  }
  if (error && error.type === 'entity.too.large') {
    res.status(413).json(errorPayload('The request body is too large', 'invalid_request_error'));
    return;
  }
  logger.error('Unhandled request error:', error);
  res.status(500).json(errorPayload((error && error.message) || 'Internal server error', 'internal_error'));
});

const server = app.listen(config.port, config.host, () => {
  logger.info(`OpenAI bridge listening on http://${config.host}:${config.port}/v1`);
  logger.info(`Model id for clients: ${config.publicModelIds[0]}`);
  logger.info(`Workers: ${config.workers} | Headless: ${config.headless}`);
  if (config.headless) {
    logger.warn('HEADLESS=true can trigger captchas. If requests time out, run with HEADLESS=false.');
  }
});

server.requestTimeout = 0;
server.timeout = 0;
server.keepAliveTimeout = 65000;
server.headersTimeout = 66000;

server.on('error', error => {
  if (error.code === 'EADDRINUSE') {
    logger.error(`Port ${config.port} is already in use. Stop the other bridge instance and try again.`);
  } else {
    logger.error('Server error:', error);
  }
  process.exit(1);
});

async function ensureBrowser(attempt = 1) {
  try {
    await bridge.start();
  } catch (error) {
    logger.error(`Browser startup failed: ${error.message}`);
    setTimeout(() => {
      ensureBrowser(attempt + 1).catch(() => {});
    }, 30000).unref?.();
  }
}

ensureBrowser().catch(() => {});

let shuttingDown = false;
async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info(`Received ${signal}; shutting down`);
  try {
    await bridge.close();
  } catch {
  }
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 5000).unref();
}

process.on('SIGINT', () => shutdown('SIGINT').catch(() => process.exit(1)));
process.on('SIGTERM', () => shutdown('SIGTERM').catch(() => process.exit(1)));
process.on('unhandledRejection', error => {
  logger.error('Unhandled rejection:', error);
});
process.on('uncaughtException', error => {
  logger.error('Uncaught exception:', error);
});
