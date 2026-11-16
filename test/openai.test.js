'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
  buildContinuationBody,
  buildUpstreamBody,
  mergeUsage,
  toChatCompletionChunk,
} = require('../src/openai.js');
const { SseRelay, StreamAccumulator } = require('../src/sse.js');

function makeConfig(overrides = {}) {
  return {
    publicModelIds: ['moonshotai/kimi-k3_1-pro'],
    upstreamModel: 'moonshotai/kimi-k3.1-pro',
    maxTokens: 0,
    reasoningEffort: 'low',
    conciseResponses: false,
    continuePrompt: 'Keep going.',
    ...overrides,
  };
}

test('sends a safe default per-call cap when neither client nor bridge sets a limit', () => {
  const prepared = buildUpstreamBody({ messages: [{ role: 'user', content: 'hi' }] }, makeConfig());
  assert.equal(prepared.body.max_tokens, 65536);
  assert.equal(prepared.meta.maxTokens, 65536);
  assert.equal(prepared.meta.clamped, false);
});

test('honors the client max_tokens without clamping when no bridge limit is set', () => {
  const prepared = buildUpstreamBody(
    { messages: [{ role: 'user', content: 'hi' }], max_tokens: 200000 },
    makeConfig(),
  );
  assert.equal(prepared.body.max_tokens, 200000);
  assert.equal(prepared.meta.clamped, false);
});

test('applies an explicit bridge ceiling only when configured', () => {
  const prepared = buildUpstreamBody(
    { messages: [{ role: 'user', content: 'hi' }], max_completion_tokens: 200000 },
    makeConfig({ maxTokens: 65536 }),
  );
  assert.equal(prepared.body.max_tokens, 65536);
  assert.equal(prepared.meta.clamped, true);
});

test('builds a continuation body that preserves prior output', () => {
  const config = makeConfig();
  const prepared = buildUpstreamBody({ messages: [{ role: 'user', content: 'hi' }] }, config);
  const body = buildContinuationBody(prepared.body, 'partial answer', config);
  assert.equal(body.messages.at(-2).role, 'assistant');
  assert.equal(body.messages.at(-2).content, 'partial answer');
  assert.equal(body.messages.at(-1).role, 'user');
  assert.equal(body.messages.at(-1).content, 'Keep going.');
  assert.equal(prepared.body.messages.length, 1);
});

test('stream relay hides intermediate finish reasons, usage, and done markers', () => {
  const out = [];
  const relay = new SseRelay(chunk => out.push(chunk));
  relay.push('data: {"choices":[{"delta":{"content":"hola"},"finish_reason":null}]}\n\n');
  relay.push('data: {"choices":[{"delta":{},"finish_reason":"length"}],"usage":{"total_tokens":10}}\n\n');
  relay.push('data: [DONE]\n\ndata: {"choices":[{"delta":{"content":" mundo"}}]}\n\n');
  relay.flush();
  const text = out.join('');
  assert.match(text, /"content":"hola"/);
  assert.match(text, /"content":" mundo"/);
  assert.doesNotMatch(text, /length/);
  assert.doesNotMatch(text, /usage/);
  assert.doesNotMatch(text, /\[DONE\]/);
});

test('stream relay reassembles events split across network chunks', () => {
  const out = [];
  const relay = new SseRelay(chunk => out.push(chunk));
  relay.push('data: {"choices":[{"delta":{"content":"par');
  relay.push('tial"},"finish_reason":"length"}]}\r\n\r\n');
  relay.push('data: [DONE]\n\n');
  relay.flush();
  const text = out.join('');
  assert.match(text, /"content":"partial"/);
  assert.doesNotMatch(text, /length|\[DONE\]/);
});

test('unfinished streams with output report length so the bridge can continue', () => {
  const accumulator = new StreamAccumulator();
  accumulator.push('data: {"choices":[{"delta":{"content":"partial"}}]}\n\n');
  accumulator.markEnded();
  assert.equal(accumulator.getFinishReason(), 'length');
});

test('merges usage across continuation turns', () => {
  const merged = mergeUsage(
    { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 },
    { prompt_tokens: 160, completion_tokens: 25, total_tokens: 185 },
  );
  assert.deepEqual(merged, { prompt_tokens: 160, completion_tokens: 75, total_tokens: 235 });
});

test('final stream chunk reports the combined finish reason and usage', () => {
  const accumulator = new StreamAccumulator();
  accumulator.push('data: {"choices":[{"delta":{"content":"done"},"finish_reason":"stop"}]}\n\n');
  accumulator.markEnded();
  accumulator.aggregate.usage = { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 };
  const chunk = toChatCompletionChunk(accumulator, 'moonshotai/kimi-k3_1-pro');
  assert.equal(chunk.choices[0].finish_reason, 'stop');
  assert.equal(chunk.usage.total_tokens, 15);
});
