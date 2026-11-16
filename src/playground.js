'use strict';

const { chromium } = require('playwright');
const { StreamAccumulator } = require('./sse');
const { HttpError } = require('./openai');

const PREDICT_PATTERN = /\/v2\/predict\/models\//;
const MODEL_POST_ROUTE = '**/v2/predict/models/**';

function playgroundFetchPatch() {
  if (window.__kimiBridgePatched) return;
  window.__kimiBridgePatched = true;
  const originalFetch = window.fetch;
  let sequence = 0;
  window.fetch = async function patchedFetch(...args) {
    const response = await originalFetch.apply(this, args);
    try {
      const input = args[0];
      const url = typeof input === 'string'
        ? input
        : (input && (input.url || String(input))) || '';
      const contentType = response.headers.get('content-type') || '';
      if (/\/v2\/predict\/models\//.test(url) && /text\/event-stream/i.test(contentType) && response.body) {
        const emit = window.__kimiBridgeEmit;
        if (typeof emit === 'function') {
          const id = `kimi-${Date.now()}-${++sequence}`;
          const [appStream, mirror] = response.body.tee();
          emit({ kind: 'start', id, url }).catch(() => {});
          (async () => {
            const reader = mirror.getReader();
            const decoder = new TextDecoder();
            try {
              for (;;) {
                const { done, value } = await reader.read();
                if (done) break;
                const text = decoder.decode(value, { stream: true });
                if (text) emit({ kind: 'chunk', id, text }).catch(() => {});
              }
              const tail = decoder.decode();
              if (tail) emit({ kind: 'chunk', id, text: tail }).catch(() => {});
              emit({ kind: 'end', id }).catch(() => {});
            } catch (error) {
              emit({ kind: 'error', id, error: String((error && error.message) || error) }).catch(() => {});
            }
          })();
          return new Response(appStream, {
            status: response.status,
            statusText: response.statusText,
            headers: response.headers,
          });
        }
      }
    } catch {
    }
    return response;
  };
}

const PREDICT_PATTERN_FOR_PAGE = /\/v2\/predict\/models\//;

class PlaygroundWorker {
  constructor(bridge, id, page) {
    this.bridge = bridge;
    this.config = bridge.config;
    this.logger = bridge.logger;
    this.id = id;
    this.page = page;
    this.routeBound = false;
    this.closed = false;
    this.crashed = false;
    this.busy = false;
    this.active = null;
    this.pendingBody = null;
    this.lastHttpError = null;
    this.turns = 0;
    this.needsReset = false;
    this.activeStreamId = null;
    this.ignoredStreams = new Set();
    this.attachListeners();
  }

  static async create(bridge, id) {
    const page = await bridge.takePage();
    const worker = new PlaygroundWorker(bridge, id, page);
    await worker.init();
    return worker;
  }

  attachListeners() {
    const page = this.page;
    page.on('close', () => {
      if (this.page !== page) return;
      this.closed = true;
      if (this.active) this.active.fail('The browser tab was closed');
    });
    page.on('crash', () => {
      if (this.page !== page) return;
      this.crashed = true;
      this.logger.warn(`[worker ${this.id}] page crashed`);
      if (this.active) this.active.fail('The browser tab crashed');
    });
    page.on('pageerror', error => {
      if (this.page !== page) return;
      this.logger.debug(`[worker ${this.id}] page error: ${error.message}`);
    });
  }

  async init() {
    await this.bindRoute();
    await this.goto();
  }

  isAlive() {
    return !this.closed && !this.crashed && !!this.page && !this.page.isClosed();
  }

  async bindRoute() {
    if (this.routeBound) return;
    this.routeBound = true;
    await this.page.route(MODEL_POST_ROUTE, async route => {
      try {
        const request = route.request();
        if (request.method() !== 'POST') {
          await route.continue();
          return;
        }
        const body = this.pendingBody;
        if (!body) {
          await route.continue();
          return;
        }
        const headers = { ...request.headers() };
        delete headers['content-length'];
        delete headers['Content-Length'];
        headers['content-type'] = 'application/json';
        await route.continue({ postData: JSON.stringify(body), headers });
      } catch (error) {
        this.logger.debug(`[worker ${this.id}] route error: ${error.message}`);
      }
    });
    this.page.on('response', response => this.handleResponse(response));
  }

  handleResponse(response) {
    try {
      const request = response.request();
      if (request.method() !== 'POST' || !PREDICT_PATTERN_FOR_PAGE.test(response.url())) return;
      const contentType = response.headers()['content-type'] || '';
      if (/text\/event-stream/i.test(contentType)) {
        if (this.active) this.active.markStarted();
        return;
      }
      response.text().then(body => {
        this.lastHttpError = { status: response.status(), body: body.slice(0, 2000) };
        this.logger.debug(`[worker ${this.id}] playground HTTP ${response.status()}: ${body.slice(0, 500)}`);
        if (this.active && !this.active.started) {
          this.active.fail(`The playground request failed with HTTP ${response.status()}: ${body.slice(0, 300)}`);
        }
      }).catch(() => {});
    } catch {
    }
  }

  handleEvent(payload) {
    const active = this.active;
    if (!active || !payload) return;
    const streamId = payload.id ? String(payload.id) : null;
    if (payload.kind === 'start') {
      if (!this.activeStreamId) {
        this.activeStreamId = streamId;
        this.logger.debug(`[worker ${this.id}] following stream ${streamId}`);
        active.markStarted();
      } else if (streamId && streamId !== this.activeStreamId) {
        if (!this.ignoredStreams.has(streamId)) {
          this.ignoredStreams.add(streamId);
          this.logger.warn(`[worker ${this.id}] ignoring duplicate stream ${streamId} while following ${this.activeStreamId}`);
        }
      }
      return;
    }
    if (streamId && this.activeStreamId && streamId !== this.activeStreamId) return;
    if (streamId && !this.activeStreamId) this.activeStreamId = streamId;
    if (payload.kind === 'chunk') {
      this.lastHttpError = null;
      active.push(payload.text);
    } else if (payload.kind === 'end') {
      active.markEnded();
    } else if (payload.kind === 'error') {
      active.fail(`Browser stream error: ${payload.error}`);
    }
  }

  async goto() {
    await this.page.goto(this.config.playgroundUrl, {
      waitUntil: 'domcontentloaded',
      timeout: this.config.browserTimeoutMs,
    });
    await this.page.locator('textarea[aria-label="chat prompt"]').first().waitFor({
      state: 'visible',
      timeout: this.config.browserTimeoutMs,
    });
    await this.page.waitForTimeout(1200);
    this.turns = 0;
    this.needsReset = false;
    this.lastHttpError = null;
  }

  async recreatePage() {
    if (this.page && !this.page.isClosed()) {
      await this.page.close().catch(() => {});
    }
    this.bridge.unregisterPage(this.page);
    this.closed = false;
    this.crashed = false;
    this.routeBound = false;
    this.page = await this.bridge.createPageForWorker(this);
    this.attachListeners();
    await this.bindRoute();
  }

  async recover() {
    if (!this.page || this.page.isClosed() || this.crashed) {
      await this.recreatePage();
    }
    await this.goto();
  }

  stopButton() {
    return this.page.locator('button[aria-label="cancel"]:has(svg[data-icon-name="stop"]), button:has(svg[data-icon-name="stop"])').first();
  }

  async sendTrigger() {
    const stop = this.stopButton();
    if (await stop.isVisible().catch(() => false)) {
      await stop.click({ timeout: 3000 }).catch(() => {});
      await stop.waitFor({ state: 'hidden', timeout: 10000 }).catch(() => {});
    }
    const textarea = this.page.locator('textarea[aria-label="chat prompt"]').first();
    await textarea.waitFor({ state: 'visible', timeout: 30000 });
    await textarea.click({ timeout: 10000 });
    await textarea.fill(this.config.triggerText);
    let sent = false;
    try {
      const send = this.page.locator('button[aria-label="Send"]').first();
      await send.waitFor({ state: 'visible', timeout: 5000 });
      if (await send.isEnabled().catch(() => false)) {
        await send.click({ timeout: 10000 });
        sent = true;
      }
    } catch {
    }
    if (!sent) {
      const generating = await this.stopButton().isVisible().catch(() => false);
      if (!generating) await textarea.press('Enter');
    }
    const cleared = await this.page.waitForFunction(() => {
      const element = document.querySelector('textarea[aria-label="chat prompt"]');
      return !!element && element.value === '';
    }, null, { timeout: 8000 }).then(() => true).catch(() => false);
    this.logger.debug(`[worker ${this.id}] trigger sent=${sent} cleared=${cleared}`);
    if (!sent && !cleared) {
      const generating = await this.stopButton().isVisible().catch(() => false);
      if (!generating) await textarea.press('Enter').catch(() => {});
      await this.page.waitForTimeout(1000);
    }
  }

  async execute(upstreamBody, callbacks = {}) {
    if (!this.bridge.context) {
      throw new HttpError(503, 'The browser is not ready', 'service_unavailable');
    }
    if (this.busy) {
      throw new HttpError(503, 'This browser tab is already handling a request', 'service_unavailable');
    }
    if (!this.isAlive()) {
      await this.recreatePage();
    }
    if (this.needsReset) {
      await this.goto();
    }
    this.busy = true;
    const accumulator = new StreamAccumulator(callbacks);
    this.active = accumulator;
    this.activeStreamId = null;
    this.ignoredStreams.clear();
    this.pendingBody = upstreamBody;
    this.lastHttpError = null;
    try {
      await this.sendTrigger();
      const started = await accumulator.waitForStart(this.config.firstByteTimeoutMs);
      if (!started) {
        throw new HttpError(502, this.describeStartFailure(), 'upstream_error');
      }
      await accumulator.waitForEnd(this.config.requestTimeoutMs, this.config.idleTimeoutMs);
      if (accumulator.error) {
        throw new HttpError(502, accumulator.error, 'upstream_error');
      }
      if (!accumulator.sawFinish && !accumulator.hasOutput()) {
        throw new HttpError(502, 'Kimi returned an empty response', 'upstream_error');
      }
      this.turns += 1;
      if (this.turns >= this.config.resetAfterTurns) {
        this.needsReset = true;
      }
      return accumulator;
    } catch (error) {
      this.needsReset = true;
      await this.stopGeneration();
      throw error;
    } finally {
      this.pendingBody = null;
      this.active = null;
      this.busy = false;
    }
  }

  describeStartFailure() {
    const http = this.lastHttpError;
    if (http) {
      return `The playground request failed with HTTP ${http.status}: ${http.body.slice(0, 300)}`;
    }
    return 'Timed out waiting for the playground to start responding. Look at the browser window: you may need to solve a captcha or accept a dialog.';
  }

  async stopGeneration() {
    try {
      const stop = this.stopButton();
      if (await stop.isVisible().catch(() => false)) {
        await stop.click({ timeout: 3000 }).catch(() => {});
      }
    } catch {
    }
  }

  abort(reason) {
    this.needsReset = true;
    if (this.active) {
      this.active.fail(reason || 'Request aborted');
    }
    this.stopGeneration().catch(() => {});
  }

  async dispose() {
    try {
      this.abort('Bridge shutting down');
      if (this.page && !this.page.isClosed()) {
        await this.page.close().catch(() => {});
      }
    } catch {
    }
  }
}

class PlaygroundBridge {
  constructor(config, logger) {
    this.config = config;
    this.logger = logger;
    this.context = null;
    this.workers = [];
    this.idle = [];
    this.waiters = [];
    this.pageToWorker = new Map();
    this.starting = null;
    this.startError = null;
    this.lastStartFailureAt = 0;
    this.pendingInitialPage = null;
    this.startedAt = Date.now();
    this.closing = false;
    this.nextWorkerId = 0;
    this.spawnInFlight = false;
    this._onBinding = this._onBinding.bind(this);
  }

  async start() {
    if (this.context && this.workers.some(worker => worker.isAlive())) return;
    if (this.starting) return this.starting;
    if (this.startError && Date.now() - this.lastStartFailureAt < 15000) {
      throw this.startError;
    }
    this.starting = this.launch().finally(() => {
      this.starting = null;
    });
    return this.starting;
  }

  async launch() {
    this.closing = true;
    await this.closeContext();
    this.closing = false;
    this.nextWorkerId = 0;
    this.spawnInFlight = false;
    this.logger.info(`Opening Chromium with profile ${this.config.profileDir}`);
    let context;
    try {
      context = await chromium.launchPersistentContext(this.config.profileDir, {
        headless: this.config.headless,
        viewport: { width: 1280, height: 900 },
        args: [
          '--no-sandbox',
          '--disable-setuid-sandbox',
          '--disable-blink-features=AutomationControlled',
        ],
      });
    } catch (error) {
      this.startError = new HttpError(503, this.launchHint(error), 'browser_error');
      this.lastStartFailureAt = Date.now();
      this.startError.cause = error;
      throw this.startError;
    }
    this.context = context;
    context.setDefaultTimeout(60000);
    context.setDefaultNavigationTimeout(this.config.browserTimeoutMs);
    context.on('close', () => this.handleContextClosed());
    await context.exposeBinding('__kimiBridgeEmit', this._onBinding);
    await context.addInitScript(playgroundFetchPatch);
    this.pendingInitialPage = context.pages()[0] || null;
    this.workers = [];
    this.idle = [];
    this.waiters = [];
    this.pageToWorker.clear();
    this.startError = null;
    const first = await this.spawnWorker(0);
    this.nextWorkerId = 1;
    this.workers.push(first);
    this.idle.push(first);
    this.logger.info('Playground ready; Kimi is available');
    this.spawnMissingWorkers().catch(() => {});
  }

  launchHint(error) {
    const message = String((error && error.message) || error);
    if (/singleton|profile|in use|lock/i.test(message)) {
      return `${message}\nClose the bridge Chromium window and any other process using ${this.config.profileDir} before retrying.`;
    }
    return message;
  }

  async spawnWorker(id) {
    const worker = await PlaygroundWorker.create(this, id);
    this.registerPage(worker, worker.page);
    return worker;
  }

  async spawnMissingWorkers() {
    if (this.spawnInFlight) return;
    const missing = this.config.workers - this.workers.filter(worker => worker.isAlive()).length;
    if (missing <= 0) return;
    this.spawnInFlight = true;
    try {
      for (let index = 0; index < missing; index += 1) {
        const id = this.nextWorkerId;
        this.nextWorkerId += 1;
        try {
          const worker = await this.spawnWorker(id);
          if (!this.context || this.closing) {
            await worker.dispose();
            return;
          }
          this.workers.push(worker);
          this.dispatchIdle(worker);
          this.logger.info(`Worker ${id} ready (${this.liveWorkerCount()}/${this.config.workers})`);
        } catch (error) {
          this.logger.warn(`Worker ${id} could not start: ${error.message}`);
        }
      }
    } finally {
      this.spawnInFlight = false;
    }
    const stillMissing = this.config.workers - this.workers.filter(worker => worker.isAlive()).length;
    if (stillMissing > 0 && !this.closing) {
      setTimeout(() => {
        this.spawnMissingWorkers().catch(() => {});
      }, 10000).unref?.();
    }
  }

  liveWorkerCount() {
    return this.workers.filter(worker => worker.isAlive()).length;
  }

  async takePage() {
    if (this.pendingInitialPage && !this.pendingInitialPage.isClosed()) {
      const page = this.pendingInitialPage;
      this.pendingInitialPage = null;
      return page;
    }
    return this.context.newPage();
  }

  async createPageForWorker(worker) {
    const page = await this.context.newPage();
    this.registerPage(worker, page);
    return page;
  }

  registerPage(worker, page) {
    this.pageToWorker.set(page, worker);
  }

  unregisterPage(page) {
    if (page) this.pageToWorker.delete(page);
  }

  _onBinding(source, payload) {
    const worker = this.pageToWorker.get(source.page);
    if (worker) worker.handleEvent(payload);
  }

  handleContextClosed() {
    if (this.closing) return;
    this.logger.warn('The browser window was closed. It will be relaunched on the next request.');
    this.context = null;
    for (const worker of this.workers) {
      worker.closed = true;
      if (worker.active) worker.active.fail('The browser window was closed');
    }
    this.workers = [];
    this.idle = [];
    this.pageToWorker.clear();
    for (const waiter of this.waiters.splice(0)) {
      clearTimeout(waiter.timer);
      waiter.reject(new HttpError(503, 'The browser window was closed', 'service_unavailable'));
    }
  }

  async closeContext() {
    const context = this.context;
    this.context = null;
    if (context) {
      try {
        await context.close();
      } catch {
      }
    }
  }

  takeIdleWorker() {
    while (this.idle.length > 0) {
      const worker = this.idle.pop();
      if (worker.isAlive()) return worker;
      this.removeWorker(worker);
    }
    return null;
  }

  async acquire(timeoutMs) {
    await this.start();
    const worker = this.takeIdleWorker();
    if (worker) return worker;
    if (this.liveWorkerCount() === 0) {
      await this.start();
      const retried = this.takeIdleWorker();
      if (retried) return retried;
    }
    return new Promise((resolve, reject) => {
      const waiter = { resolve, reject, timer: null };
      waiter.timer = setTimeout(() => {
        const index = this.waiters.indexOf(waiter);
        if (index >= 0) this.waiters.splice(index, 1);
        reject(new HttpError(429, 'All browser tabs are busy. Try again in a moment.', 'rate_limit_exceeded'));
      }, timeoutMs);
      if (waiter.timer.unref) waiter.timer.unref();
      this.waiters.push(waiter);
    });
  }

  dispatchIdle(worker) {
    const waiter = this.waiters.shift();
    if (waiter) {
      clearTimeout(waiter.timer);
      waiter.resolve(worker);
    } else {
      this.idle.push(worker);
    }
  }

  release(worker) {
    if (!worker || !worker.isAlive()) {
      this.removeWorker(worker);
      this.spawnMissingWorkers().catch(() => {});
      return;
    }
    this.dispatchIdle(worker);
  }

  removeWorker(worker) {
    if (!worker) return;
    this.workers = this.workers.filter(candidate => candidate !== worker);
    this.idle = this.idle.filter(candidate => candidate !== worker);
    this.unregisterPage(worker.page);
  }

  async close() {
    this.closing = true;
    for (const waiter of this.waiters.splice(0)) {
      clearTimeout(waiter.timer);
      waiter.reject(new HttpError(503, 'Bridge shutting down', 'service_unavailable'));
    }
    for (const worker of this.workers.slice()) {
      await worker.dispose();
    }
    this.workers = [];
    this.idle = [];
    this.pageToWorker.clear();
    await this.closeContext();
  }

  health() {
    return {
      ok: !!this.context && this.liveWorkerCount() > 0,
      uptimeSeconds: Math.round((Date.now() - this.startedAt) / 1000),
      workers: this.workers.map(worker => ({
        id: worker.id,
        alive: worker.isAlive(),
        busy: worker.busy,
      })),
      idle: this.idle.length,
      queued: this.waiters.length,
      starting: !!this.starting,
      lastStartError: this.startError ? this.startError.message : null,
    };
  }
}

module.exports = { PlaygroundBridge, playgroundFetchPatch };
