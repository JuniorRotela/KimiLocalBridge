'use strict';

function delay(ms) {
  return new Promise(resolve => {
    const timer = setTimeout(resolve, ms);
    if (timer.unref) timer.unref();
  });
}

function randomId() {
  return Math.random().toString(36).slice(2, 10);
}

function mergeToolCall(entries, delta) {
  const index = Number.isInteger(delta.index) ? delta.index : entries.length;
  let entry = entries[index];
  if (!entry) {
    entry = entries[index] = {
      id: '',
      type: 'function',
      function: { name: '', arguments: '' },
    };
  }
  if (delta.id) entry.id = String(delta.id);
  if (delta.type) entry.type = String(delta.type);
  const incomingName = delta.function && delta.function.name;
  if (incomingName) {
    const name = String(incomingName);
    if (entry.function.name && name.startsWith(entry.function.name)) {
      entry.function.name = name;
    } else {
      entry.function.name += name;
    }
  }
  const incomingArgs = delta.function && delta.function.arguments;
  if (incomingArgs != null) {
    const args = typeof incomingArgs === 'string' ? incomingArgs : JSON.stringify(incomingArgs);
    if (entry.function.arguments && args.startsWith(entry.function.arguments)) {
      entry.function.arguments = args;
    } else {
      entry.function.arguments += args;
    }
  }
}

class StreamAccumulator {
  constructor(options = {}) {
    this.onRaw = typeof options.onRaw === 'function' ? options.onRaw : null;
    this.lineBuffer = '';
    this.aggregate = {
      id: null,
      created: null,
      model: null,
      content: '',
      reasoning: '',
      toolCalls: [],
      finishReason: null,
      usage: null,
    };
    this.sawFinish = false;
    this.sawDone = false;
    this.started = false;
    this.finished = false;
    this.error = null;
    this.lastEventAt = Date.now();
    this.startResolvers = [];
    this.endPromise = new Promise(resolve => {
      this.resolveEnd = resolve;
    });
    this.graceTimer = null;
  }

  hasOutput() {
    return this.aggregate.content.length > 0 || this.aggregate.reasoning.length > 0 || this.aggregate.toolCalls.some(Boolean);
  }

  markStarted() {
    if (this.started) return;
    this.started = true;
    for (const resolve of this.startResolvers.splice(0)) resolve(true);
  }

  waitForStart(timeoutMs) {
    if (this.started) return Promise.resolve(true);
    if (this.finished) return Promise.resolve(false);
    return new Promise(resolve => {
      const timer = setTimeout(() => resolve(false), timeoutMs);
      if (timer.unref) timer.unref();
      this.startResolvers.push(value => {
        clearTimeout(timer);
        resolve(value);
      });
    });
  }

  push(text) {
    if (!text || this.finished) return;
    this.lastEventAt = Date.now();
    this.markStarted();
    if (this.onRaw) {
      try {
        this.onRaw(text);
      } catch {
      }
    }
    this.lineBuffer += text;
    let newline;
    while ((newline = this.lineBuffer.indexOf('\n')) !== -1) {
      let line = this.lineBuffer.slice(0, newline);
      this.lineBuffer = this.lineBuffer.slice(newline + 1);
      if (line.endsWith('\r')) line = line.slice(0, -1);
      this.handleLine(line);
    }
    if (this.sawFinish && !this.finished) {
      this.scheduleGraceFinish();
    }
  }

  handleLine(line) {
    const trimmed = line.trimStart();
    if (!trimmed.startsWith('data:')) return;
    const payload = trimmed.slice(5).trim();
    if (!payload) return;
    if (payload === '[DONE]') {
      this.sawDone = true;
      this.finish();
      return;
    }
    let json;
    try {
      json = JSON.parse(payload);
    } catch {
      return;
    }
    if (json.error) {
      const message = typeof json.error === 'string' ? json.error : json.error.message || JSON.stringify(json.error);
      this.fail(`Upstream error: ${message}`);
      return;
    }
    if (!this.aggregate.id && json.id) this.aggregate.id = String(json.id);
    if (!this.aggregate.created && json.created) this.aggregate.created = Number(json.created);
    if (!this.aggregate.model && json.model) this.aggregate.model = String(json.model);
    if (json.usage) this.aggregate.usage = json.usage;
    const choice = Array.isArray(json.choices) ? json.choices[0] : null;
    if (!choice) return;
    const delta = choice.delta || {};
    if (typeof delta.content === 'string' && delta.content.length) {
      this.aggregate.content += delta.content;
      this.clearGraceFinish();
    }
    if (typeof delta.reasoning_content === 'string' && delta.reasoning_content.length) {
      this.aggregate.reasoning += delta.reasoning_content;
      this.clearGraceFinish();
    }
    if (Array.isArray(delta.tool_calls)) {
      for (const call of delta.tool_calls) {
        if (call && typeof call === 'object') mergeToolCall(this.aggregate.toolCalls, call);
      }
      this.clearGraceFinish();
    }
    if (choice.finish_reason) {
      this.aggregate.finishReason = String(choice.finish_reason);
      this.sawFinish = true;
      this.scheduleGraceFinish();
    }
  }

  scheduleGraceFinish() {
    this.clearGraceFinish();
    this.graceTimer = setTimeout(() => this.finish(), 5000);
    if (this.graceTimer.unref) this.graceTimer.unref();
  }

  clearGraceFinish() {
    if (this.graceTimer) {
      clearTimeout(this.graceTimer);
      this.graceTimer = null;
    }
  }

  markEnded() {
    this.finish();
  }

  fail(message) {
    if (this.finished) return;
    this.error = this.error || message || 'Unknown playground error';
    this.finish();
  }

  finish() {
    if (this.finished) return;
    this.finished = true;
    this.clearGraceFinish();
    for (const resolve of this.startResolvers.splice(0)) resolve(false);
    this.resolveEnd();
  }

  async waitForEnd(totalTimeoutMs, idleTimeoutMs) {
    const startedAt = Date.now();
    while (!this.finished) {
      if (Date.now() - startedAt >= totalTimeoutMs) {
        this.fail(`Timed out after ${Math.round(totalTimeoutMs / 1000)}s waiting for Kimi to finish`);
        break;
      }
      if (Date.now() - this.lastEventAt >= idleTimeoutMs) {
        this.fail(`Kimi stopped streaming for ${Math.round(idleTimeoutMs / 1000)}s`);
        break;
      }
      await Promise.race([this.endPromise, delay(1000)]);
    }
    return this.aggregate;
  }

  getToolCalls() {
    const calls = this.aggregate.toolCalls.filter(Boolean).map(call => {
      const id = call.id || `call_${randomId()}`;
      let args = call.function.arguments;
      if (args == null || args === '') args = '{}';
      if (typeof args !== 'string') args = JSON.stringify(args);
      return {
        id,
        type: 'function',
        function: { name: call.function.name, arguments: args },
      };
    }).filter(call => call.function.name);
    return calls;
  }

  getFinishReason() {
    if (this.getToolCalls().length > 0) return 'tool_calls';
    if (this.aggregate.finishReason) return this.aggregate.finishReason;
    if (this.hasOutput()) return 'length';
    return 'stop';
  }
}

class SseRelay {
  constructor(write) {
    this.write = write;
    this.buffer = '';
  }

  push(text) {
    if (!text) return;
    this.buffer += text;
    for (;;) {
      const match = /\r?\n\r?\n/.exec(this.buffer);
      if (!match) break;
      const end = match.index + match[0].length;
      const event = this.buffer.slice(0, end);
      this.buffer = this.buffer.slice(end);
      this.handleEvent(event);
    }
  }

  handleEvent(event) {
    const match = /^data:[ \t]?(.*)$/m.exec(event);
    if (!match) {
      this.write(event);
      return;
    }
    const payload = match[1].trim();
    if (payload === '[DONE]') return;
    let json;
    try {
      json = JSON.parse(payload);
    } catch {
      this.write(event);
      return;
    }
    let changed = false;
    if (json.usage) {
      delete json.usage;
      changed = true;
    }
    if (Array.isArray(json.choices)) {
      for (const choice of json.choices) {
        if (choice && choice.finish_reason != null) {
          choice.finish_reason = null;
          changed = true;
        }
      }
    }
    this.write(changed ? `data: ${JSON.stringify(json)}\n\n` : event);
  }

  flush() {
    if (!this.buffer) return;
    this.write(this.buffer);
    this.buffer = '';
  }
}

module.exports = { SseRelay, StreamAccumulator };
