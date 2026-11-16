'use strict';

class HttpError extends Error {
  constructor(status, message, type = 'bridge_error', code = null) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
    this.type = type;
    this.code = code;
  }
}

function randomId() {
  return Math.random().toString(36).slice(2, 10);
}

function stringifyContent(value) {
  if (value == null) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function normalizeContent(content) {
  if (content == null) return '';
  if (typeof content === 'string') return content;
  if (typeof content === 'number' || typeof content === 'boolean') return String(content);
  if (Array.isArray(content)) {
    const parts = content.map(part => {
      if (typeof part === 'string') return { type: 'text', text: part };
      if (!part || typeof part !== 'object') return { type: 'text', text: stringifyContent(part) };
      if (part.type === 'text' && typeof part.text === 'string') return { type: 'text', text: part.text };
      if (part.type === 'image_url' && part.image_url) return { type: 'image_url', image_url: part.image_url };
      return { type: 'text', text: stringifyContent(part) };
    });
    if (parts.every(part => part.type === 'text')) {
      return parts.map(part => part.text).join('\n\n');
    }
    return parts;
  }
  return stringifyContent(content);
}

function normalizeArguments(value) {
  if (value == null) return '{}';
  if (typeof value === 'string') return value === '' ? '{}' : value;
  try {
    return JSON.stringify(value);
  } catch {
    return '{}';
  }
}

function normalizeMessages(messages, options = {}) {
  if (!Array.isArray(messages) || messages.length === 0) {
    throw new HttpError(400, 'messages must be a non-empty array', 'invalid_request_error');
  }
  const normalized = [];
  for (const raw of messages) {
    if (!raw || typeof raw !== 'object') continue;
    let role = raw.role;
    if (role === 'developer') role = 'system';
    if (!['system', 'user', 'assistant', 'tool'].includes(role)) continue;
    const message = { role };
    if (raw.name) message.name = String(raw.name);
    if (role === 'assistant') {
      const content = normalizeContent(raw.content);
      message.content = content === '' ? null : content;
      if (Array.isArray(raw.tool_calls) && raw.tool_calls.length > 0) {
        const calls = raw.tool_calls.map(call => {
          const fn = call && call.function ? call.function : call;
          return {
            id: call && call.id ? String(call.id) : `call_${randomId()}`,
            type: 'function',
            function: {
              name: fn && fn.name ? String(fn.name) : '',
              arguments: normalizeArguments(fn && fn.arguments),
            },
          };
        }).filter(call => call.function.name);
        if (calls.length > 0) {
          message.tool_calls = calls;
        } else if (message.content == null) {
          message.content = '';
        }
      } else if (message.content == null) {
        message.content = '';
      }
    } else if (role === 'tool') {
      if (raw.tool_call_id) message.tool_call_id = String(raw.tool_call_id);
      message.content = stringifyContent(raw.content);
    } else {
      message.content = normalizeContent(raw.content);
    }
    normalized.push(message);
  }
  if (normalized.length === 0) {
    throw new HttpError(400, 'messages did not contain any valid entries', 'invalid_request_error');
  }
  const conciseInstructions = [
    'Answer in the user\'s language, defaulting to Spanish for Spanish prompts.',
    'Be precise, direct, and concise. Usually use at most three short points.',
    'Do not repeat the request or add unnecessary introductions, summaries, or offers.',
    'For coding tasks, take action and verify the result. Keep explanations short, but never truncate requested files or code.',
    'If information is uncertain, state the uncertainty briefly instead of guessing.',
  ].join('\n');
  const system = normalized.find(message => message.role === 'system');
  if (options.conciseResponses) {
    if (system) {
      if (typeof system.content === 'string') system.content = `${conciseInstructions}\n\n${system.content}`;
      else system.content = [{ type: 'text', text: conciseInstructions }, ...system.content];
    } else {
      normalized.unshift({ role: 'system', content: conciseInstructions });
    }
  }
  return normalized;
}

function normalizeTools(tools) {
  if (!Array.isArray(tools) || tools.length === 0) return undefined;
  const normalized = [];
  for (const tool of tools) {
    if (!tool || tool.type !== 'function' || !tool.function || !tool.function.name) continue;
    const fn = { name: String(tool.function.name) };
    if (typeof tool.function.description === 'string' && tool.function.description) {
      fn.description = tool.function.description.slice(0, 8000);
    }
    const parameters = tool.function.parameters;
    fn.parameters = parameters && typeof parameters === 'object' && !Array.isArray(parameters)
      ? parameters
      : { type: 'object', properties: {} };
    normalized.push({ type: 'function', function: fn });
  }
  return normalized.length > 0 ? normalized : undefined;
}

function normalizeReasoningEffort(clientValue, fallback) {
  if (typeof clientValue === 'string') {
    const value = clientValue.toLowerCase();
    if (['low', 'medium', 'high', 'max'].includes(value)) return value;
    if (value === 'minimal' || value === 'none') return 'low';
  }
  return fallback;
}

function pickRequestedModel(clientBody, config) {
  if (clientBody && typeof clientBody.model === 'string' && clientBody.model.trim()) {
    return clientBody.model.trim();
  }
  return config.publicModelIds[0];
}

function buildUpstreamBody(clientBody, config) {
  const messages = normalizeMessages(clientBody.messages, config);
  const tools = normalizeTools(clientBody.tools);
  const requestedMax = Number(clientBody.max_completion_tokens ?? clientBody.max_tokens);
  let maxTokens = Number.isFinite(requestedMax) && requestedMax > 0
    ? Math.floor(requestedMax)
    : config.maxTokens;
  const clamped = maxTokens > config.maxTokens;
  if (clamped) maxTokens = config.maxTokens;

  const body = {
    reasoning_effort: normalizeReasoningEffort(clientBody.reasoning_effort, config.reasoningEffort),
    stream: true,
    model: config.upstreamModel,
    seed: Number.isFinite(Number(clientBody.seed)) ? Number(clientBody.seed) : 0,
    max_tokens: maxTokens,
    messages,
    stream_options: { include_usage: true, continuous_usage_stats: true },
  };

  const temperature = Number(clientBody.temperature);
  if (Number.isFinite(temperature)) body.temperature = Math.min(2, Math.max(0, temperature));
  const topP = Number(clientBody.top_p);
  if (Number.isFinite(topP)) body.top_p = Math.min(1, Math.max(0, topP));
  if (typeof clientBody.stop === 'string' || Array.isArray(clientBody.stop)) {
    body.stop = clientBody.stop;
  }

  if (tools) {
    body.tools = tools;
    if (typeof clientBody.tool_choice === 'string' || (clientBody.tool_choice && typeof clientBody.tool_choice === 'object')) {
      body.tool_choice = clientBody.tool_choice;
    }
    if (typeof clientBody.parallel_tool_calls === 'boolean') {
      body.parallel_tool_calls = clientBody.parallel_tool_calls;
    }
  }

  return {
    body,
    requestedModel: pickRequestedModel(clientBody, config),
    meta: {
      messages: messages.length,
      tools: tools ? tools.length : 0,
      maxTokens,
      clamped,
    },
  };
}

function toChatCompletion(accumulator, requestedModel) {
  const aggregate = accumulator.aggregate;
  const toolCalls = accumulator.getToolCalls();
  const message = { role: 'assistant' };
  if (aggregate.content) {
    message.content = aggregate.content;
  } else {
    message.content = toolCalls.length > 0 ? null : '';
  }
  if (aggregate.reasoning) message.reasoning_content = aggregate.reasoning;
  if (toolCalls.length > 0) message.tool_calls = toolCalls;
  return {
    id: aggregate.id || `chatcmpl-kimi-${Date.now()}${randomId()}`,
    object: 'chat.completion',
    created: aggregate.created || Math.floor(Date.now() / 1000),
    model: requestedModel,
    choices: [{
      index: 0,
      message,
      finish_reason: accumulator.getFinishReason(),
    }],
    usage: aggregate.usage || { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
  };
}

function errorPayload(message, type = 'bridge_error', code = null) {
  return { error: { message, type, code } };
}

module.exports = {
  HttpError,
  buildUpstreamBody,
  errorPayload,
  normalizeMessages,
  normalizeTools,
  toChatCompletion,
};
