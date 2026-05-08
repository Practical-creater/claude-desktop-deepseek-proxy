#!/usr/bin/env node
/**
 * Claude Desktop local model gateway.
 *
 * Modes:
 * 1. anthropic  - forward Anthropic-compatible requests after model remapping.
 * 2. responses  - translate Anthropic Messages requests to OpenAI Responses API.
 */

'use strict';

const http = require('http');
const https = require('https');

// ─────────────────────────────────────────────────────────────────────────────
// 基础配置
// ─────────────────────────────────────────────────────────────────────────────

const PORT = parseInt(process.env.PROXY_PORT || '3099', 10);

const PROVIDER = process.env.PROVIDER || process.env.UPSTREAM_NAME || 'deepseek';

const PROVIDER_PRESETS = {
  deepseek: {
    apiFormat: 'anthropic',
    baseUrl: 'https://api.deepseek.com/anthropic',
    fallbackModel: 'deepseek-v4-flash',
    modelRules: [
      { match: 'haiku', target: 'deepseek-v4-flash' },
      { match: 'opus', target: 'deepseek-v4-pro' },
      { match: 'sonnet', target: 'deepseek-v4-pro' },
    ],
  },

  mimo: {
    apiFormat: 'anthropic',
    baseUrl: 'https://token-plan-cn.xiaomimimo.com/anthropic',
    fallbackModel: 'mimo-v2.5-pro',
    modelRules: [
      { match: 'haiku', target: 'mimo-v2.5-pro' },
      { match: 'opus', target: 'mimo-v2.5-pro' },
      { match: 'sonnet', target: 'mimo-v2.5-pro' },
    ],
  },

  'custom-responses': {
    apiFormat: 'responses',
    baseUrl: 'https://www.msutools.cn/v1',
    fallbackModel: 'gpt-5.5',
    modelRules: [
      { match: 'haiku', target: 'gpt-5.5' },
      { match: 'opus', target: 'gpt-5.5' },
      { match: 'sonnet', target: 'gpt-5.5' },
    ],
  },
};

const PRESET = PROVIDER_PRESETS[PROVIDER] || PROVIDER_PRESETS.deepseek;

const UPSTREAM_API_FORMAT = (
  process.env.UPSTREAM_API_FORMAT ||
  PRESET.apiFormat ||
  'anthropic'
).toLowerCase();

const UPSTREAM_BASE_URL = (
  process.env.UPSTREAM_BASE_URL ||
  process.env.UPSTREAM_BASE_URL_URL ||
  process.env.DEEPSEEK_BASE_URL ||
  PRESET.baseUrl
).replace(/\/$/, '');

const UPSTREAM_API_KEY =
  process.env.UPSTREAM_API_KEY ||
  process.env.DEEPSEEK_API_KEY ||
  '';

const MODEL_REASONING_EFFORT = process.env.MODEL_REASONING_EFFORT || 'high';
const DISABLE_RESPONSE_STORAGE = parseBool(process.env.DISABLE_RESPONSE_STORAGE, true);

function loadModelRules() {
  if (process.env.MODEL_RULES_JSON) {
    try {
      const rules = JSON.parse(process.env.MODEL_RULES_JSON);
      return rules.map(rule => ({
        match: new RegExp(rule.match, 'i'),
        target: rule.target,
      }));
    } catch (e) {
      console.error('[proxy] MODEL_RULES_JSON 解析失败:', e.message);
      console.error('[proxy] 将回退到 provider 默认模型映射');
    }
  }

  return PRESET.modelRules.map(rule => ({
    match: new RegExp(rule.match, 'i'),
    target: rule.target,
  }));
}

const MODEL_RULES = loadModelRules();

const FALLBACK_MODEL =
  process.env.FALLBACK_MODEL ||
  PRESET.fallbackModel;

function resolveModel(name = '') {
  for (const rule of MODEL_RULES) {
    if (rule.match.test(name)) return rule.target;
  }
  return FALLBACK_MODEL;
}

// ─────────────────────────────────────────────────────────────────────────────
// 工具函数
// ─────────────────────────────────────────────────────────────────────────────

function parseBool(value, defaultValue) {
  if (value === undefined || value === '') return defaultValue;
  return ['1', 'true', 'yes', 'on'].includes(String(value).toLowerCase());
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];

    req.on('data', chunk => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function normalizeSystemForCache(system) {
  if (!Array.isArray(system)) return system;

  return system.map(block => {
    if (
      block &&
      typeof block === 'object' &&
      block.type === 'text' &&
      typeof block.text === 'string' &&
      block.text.includes('cch=')
    ) {
      return {
        ...block,
        text: block.text.replace(/cch=[^;]+;?\s*/g, ''),
      };
    }

    return block;
  });
}

function extractCacheUsage(usage = {}) {
  const hit =
    usage.prompt_cache_hit_tokens ??
    usage.cache_read_input_tokens ??
    0;

  const miss =
    usage.prompt_cache_miss_tokens ??
    usage.cache_creation_input_tokens ??
    0;

  const input =
    usage.input_tokens ??
    usage.prompt_tokens ??
    hit + miss ??
    0;

  const output =
    usage.output_tokens ??
    usage.completion_tokens ??
    0;

  const denom = hit + miss || input || 0;
  const rate = denom > 0 ? `${((hit / denom) * 100).toFixed(1)}%` : '未知';

  return { hit, miss, input, output, rate };
}

function logCacheUsage(usage) {
  const u = extractCacheUsage(usage);

  console.log(
    `  缓存统计     : hit=${u.hit}  miss=${u.miss}  input=${u.input}  output=${u.output}  命中率=${u.rate}`
  );
}

function safeJsonPrefix(value, maxLen = 500) {
  try {
    const json = JSON.stringify(value);
    return (json === undefined ? 'undefined' : json).slice(0, maxLen);
  } catch {
    return '[unserializable]';
  }
}

function sendJson(res, statusCode, value) {
  res.writeHead(statusCode, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(value));
}

function sendProxyError(res, statusCode, message) {
  sendJson(res, statusCode, {
    type: 'error',
    error: {
      type: statusCode >= 500 ? 'api_error' : 'invalid_request_error',
      message,
    },
  });
}

function readResponseBody(proxyRes) {
  return new Promise((resolve, reject) => {
    let data = '';
    proxyRes.on('data', chunk => {
      data += chunk.toString('utf8');
    });
    proxyRes.on('end', () => resolve(data));
    proxyRes.on('error', reject);
  });
}

function createUpstreamHeaders(upstreamUrl, sendBody, extra = {}) {
  const headers = {
    host: upstreamUrl.host,
    authorization: `Bearer ${UPSTREAM_API_KEY}`,
    'content-type': 'application/json',
    'content-length': String(sendBody.length),
    ...extra,
  };

  return headers;
}

function requestUpstream(upstreamUrl, method, headers, sendBody, onResponse, onError) {
  const isHttps = upstreamUrl.protocol === 'https:';
  const transport = isHttps ? https : http;

  const proxyReq = transport.request({
    hostname: upstreamUrl.hostname,
    port: upstreamUrl.port || (isHttps ? 443 : 80),
    path: upstreamUrl.pathname + upstreamUrl.search,
    method,
    headers,
  }, onResponse);

  proxyReq.on('error', onError);
  proxyReq.write(sendBody);
  proxyReq.end();
}

// ─────────────────────────────────────────────────────────────────────────────
// Anthropic-compatible 透传
// ─────────────────────────────────────────────────────────────────────────────

function buildAnthropicBody(bodyObj) {
  const originalModel = bodyObj.model || '';
  const targetModel = resolveModel(originalModel);

  console.log(`[${new Date().toISOString()}]`);
  console.log(`  API格式        : anthropic`);
  console.log(`  收到模型名     : "${originalModel}"`);
  console.log(`  原始system前缀 : ${safeJsonPrefix(bodyObj.system, 500)}`);

  bodyObj.system = normalizeSystemForCache(bodyObj.system);
  bodyObj.model = targetModel;

  console.log(`  转发模型名     : "${targetModel}"`);
  console.log(`  转发system前缀 : ${safeJsonPrefix(bodyObj.system, 500)}`);

  return Buffer.from(JSON.stringify(bodyObj), 'utf8');
}

function forwardAnthropic(req, res, rawBody, bodyObj) {
  let sendBody = rawBody;

  if (req.method === 'POST' && rawBody.length > 0 && bodyObj) {
    sendBody = buildAnthropicBody(bodyObj);
  }

  const upstreamUrl = new URL(`${UPSTREAM_BASE_URL}${req.url}`);
  const upstreamHeaders = {
    ...req.headers,
    host: upstreamUrl.host,
    authorization: `Bearer ${UPSTREAM_API_KEY}`,
    'content-length': String(sendBody.length),
  };

  for (const h of ['connection', 'keep-alive', 'transfer-encoding', 'upgrade']) {
    delete upstreamHeaders[h];
  }

  const isStream = bodyObj?.stream === true;

  requestUpstream(
    upstreamUrl,
    req.method,
    upstreamHeaders,
    sendBody,
    proxyRes => {
      const resHeaders = { ...proxyRes.headers };
      delete resHeaders['transfer-encoding'];

      if (proxyRes.statusCode >= 400) {
        readResponseBody(proxyRes).then(errData => {
          console.error(`  上游HTTP错误  : ${proxyRes.statusCode}`);
          console.error(`  上游错误内容  : ${errData.slice(0, 1000)}`);

          res.writeHead(proxyRes.statusCode, resHeaders);
          res.end(errData);
        }).catch(e => {
          if (!res.headersSent) sendProxyError(res, 502, e.message);
        });
        return;
      }

      if (isStream) {
        res.writeHead(proxyRes.statusCode, resHeaders);

        let buf = '';

        proxyRes.on('data', chunk => {
          const text = chunk.toString('utf8');
          res.write(chunk);

          buf += text;
          const lines = buf.split('\n');
          buf = lines.pop();

          for (const line of lines) {
            if (!line.startsWith('data: ')) continue;

            const payload = line.slice(6).trim();
            if (!payload || payload === '[DONE]') continue;

            try {
              const evt = JSON.parse(payload);
              if (evt.usage) logCacheUsage(evt.usage);
            } catch {
              // 忽略非 JSON data 行，不影响主链路。
            }
          }
        });

        proxyRes.on('end', () => {
          res.end();
        });

        proxyRes.on('error', e => {
          console.error('[proxy] 上游流式响应错误:', e.message);
          if (!res.destroyed) res.end();
        });
      } else {
        readResponseBody(proxyRes).then(data => {
          try {
            const parsed = JSON.parse(data);
            if (parsed.usage) logCacheUsage(parsed.usage);
            else console.log('  缓存统计     : 响应中未找到 usage 字段');
          } catch {
            console.log('  缓存统计     : 响应不是 JSON，无法解析 usage');
          }

          res.writeHead(proxyRes.statusCode, resHeaders);
          res.end(data);
        }).catch(e => {
          if (!res.headersSent) sendProxyError(res, 502, e.message);
        });
      }
    },
    e => {
      console.error('[proxy] 上游请求错误:', e.message);

      if (!res.headersSent) {
        res.writeHead(502, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end(e.message);
      }
    }
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Responses API 转换
// ─────────────────────────────────────────────────────────────────────────────

function assertObject(value, message) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(message);
  }
}

function getTextFromContent(content, context) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';

  const parts = [];
  for (const block of content) {
    if (typeof block === 'string') {
      parts.push(block);
      continue;
    }

    if (!block || typeof block !== 'object') continue;

    if (block.type === 'text') {
      parts.push(block.text || '');
      continue;
    }

    if (block.type === 'tool_use' || block.type === 'tool_result') continue;

    throw new Error(`${context} contains unsupported content block type: ${block.type}`);
  }

  return parts.join('\n');
}

function systemToInstructions(system) {
  if (!system) return undefined;
  if (typeof system === 'string') return system;
  if (!Array.isArray(system)) {
    throw new Error('system must be a string or an array of text blocks');
  }

  const parts = [];
  for (const block of system) {
    if (!block || typeof block !== 'object') continue;
    if (block.type !== 'text') {
      throw new Error(`system contains unsupported block type: ${block.type}`);
    }
    parts.push(block.text || '');
  }

  return parts.join('\n');
}

function toolResultToOutput(block) {
  if (typeof block.content === 'string') return block.content;
  if (!Array.isArray(block.content)) return '';

  return block.content.map(item => {
    if (typeof item === 'string') return item;
    if (!item || typeof item !== 'object') return '';
    if (item.type === 'text') return item.text || '';
    throw new Error(`tool_result contains unsupported content block type: ${item.type}`);
  }).join('\n');
}

function isIgnorableAnthropicBlock(block) {
  return [
    'thinking',
    'redacted_thinking',
    'signature',
  ].includes(block?.type);
}

function convertMessagesToResponsesInput(messages = []) {
  if (!Array.isArray(messages)) {
    throw new Error('messages must be an array');
  }

  const input = [];

  for (const message of messages) {
    assertObject(message, 'message must be an object');

    if (message.role !== 'user' && message.role !== 'assistant') {
      throw new Error(`unsupported message role: ${message.role}`);
    }

    const content = typeof message.content === 'string'
      ? [{ type: 'text', text: message.content }]
      : message.content || [];

    if (!Array.isArray(content)) {
      throw new Error('message content must be a string or an array');
    }

    const textParts = [];

    for (const block of content) {
      if (!block || typeof block !== 'object') continue;

      if (block.type === 'text') {
        textParts.push(block.text || '');
        continue;
      }

      if (block.type === 'tool_use') {
        if (message.role !== 'assistant') {
          throw new Error('tool_use blocks are only supported in assistant messages');
        }
        input.push({
          type: 'function_call',
          call_id: block.id,
          name: block.name,
          arguments: JSON.stringify(block.input || {}),
        });
        continue;
      }

      if (block.type === 'tool_result') {
        if (message.role !== 'user') {
          throw new Error('tool_result blocks are only supported in user messages');
        }
        input.push({
          type: 'function_call_output',
          call_id: block.tool_use_id,
          output: toolResultToOutput(block),
        });
        continue;
      }

      if (isIgnorableAnthropicBlock(block)) {
        continue;
      }

      throw new Error(`message contains unsupported content block type: ${block.type}`);
    }

    const text = textParts.join('\n');
    if (text) {
      input.push({
        role: message.role,
        content: text,
      });
    }
  }

  return input;
}

function convertToolsToResponses(tools) {
  if (!tools) return undefined;
  if (!Array.isArray(tools)) throw new Error('tools must be an array');

  return tools.map(tool => {
    assertObject(tool, 'tool must be an object');
    if (!tool.name || typeof tool.name !== 'string') {
      throw new Error('tool.name must be a string');
    }

    return {
      type: 'function',
      name: tool.name,
      description: tool.description || '',
      parameters: tool.input_schema || {
        type: 'object',
        properties: {},
      },
    };
  });
}

function convertToolChoiceToResponses(toolChoice) {
  if (!toolChoice) return undefined;
  if (typeof toolChoice === 'string') {
    if (['auto', 'none', 'required'].includes(toolChoice)) return toolChoice;
    throw new Error(`unsupported tool_choice: ${toolChoice}`);
  }

  assertObject(toolChoice, 'tool_choice must be a string or object');

  if (toolChoice.type === 'auto') return 'auto';
  if (toolChoice.type === 'none') return 'none';
  if (toolChoice.type === 'any') return 'required';
  if (toolChoice.type === 'tool') {
    if (!toolChoice.name) throw new Error('tool_choice.name is required');
    return {
      type: 'function',
      name: toolChoice.name,
    };
  }

  throw new Error(`unsupported tool_choice.type: ${toolChoice.type}`);
}

function buildResponsesRequest(bodyObj) {
  const originalModel = bodyObj.model || '';
  const targetModel = resolveModel(originalModel);
  const normalizedSystem = normalizeSystemForCache(bodyObj.system);

  console.log(`[${new Date().toISOString()}]`);
  console.log(`  API格式        : responses`);
  console.log(`  收到模型名     : "${originalModel}"`);
  console.log(`  转发模型名     : "${targetModel}"`);
  console.log(`  原始system前缀 : ${safeJsonPrefix(bodyObj.system, 500)}`);
  console.log(`  转发system前缀 : ${safeJsonPrefix(normalizedSystem, 500)}`);

  const requestBody = {
    model: targetModel,
    input: convertMessagesToResponsesInput(bodyObj.messages || []),
    stream: bodyObj.stream === true,
  };

  const instructions = systemToInstructions(normalizedSystem);
  if (instructions) requestBody.instructions = instructions;
  if (bodyObj.max_tokens !== undefined) requestBody.max_output_tokens = bodyObj.max_tokens;
  if (MODEL_REASONING_EFFORT) requestBody.reasoning = { effort: MODEL_REASONING_EFFORT };
  if (DISABLE_RESPONSE_STORAGE) requestBody.store = false;

  const tools = convertToolsToResponses(bodyObj.tools);
  if (tools) requestBody.tools = tools;

  const toolChoice = convertToolChoiceToResponses(bodyObj.tool_choice);
  if (toolChoice !== undefined) requestBody.tool_choice = toolChoice;

  return { requestBody, targetModel };
}

function extractResponsesUsage(usage = {}) {
  return {
    input_tokens: usage.input_tokens ?? 0,
    output_tokens: usage.output_tokens ?? 0,
  };
}

function extractTextFromResponsesItem(item) {
  if (!item || typeof item !== 'object') return '';

  if (typeof item.output_text === 'string') return item.output_text;
  if (typeof item.text === 'string') return item.text;

  if (!Array.isArray(item.content)) return '';

  return item.content.map(part => {
    if (!part || typeof part !== 'object') return '';
    if (typeof part.text === 'string') return part.text;
    if (typeof part.output_text === 'string') return part.output_text;
    return '';
  }).join('');
}

function parseFunctionArguments(value, name) {
  if (value === undefined || value === null || value === '') return {};
  if (typeof value === 'object') return value;
  if (typeof value !== 'string') {
    throw new Error(`function_call arguments for ${name} must be JSON`);
  }

  const parsed = JSON.parse(value);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`function_call arguments for ${name} must be a JSON object`);
  }
  return parsed;
}

function convertResponsesToAnthropic(responseObj, model) {
  const content = [];

  if (typeof responseObj.output_text === 'string' && responseObj.output_text) {
    content.push({ type: 'text', text: responseObj.output_text });
  }

  if (Array.isArray(responseObj.output)) {
    for (const item of responseObj.output) {
      if (!item || typeof item !== 'object') continue;

      if (item.type === 'function_call') {
        content.push({
          type: 'tool_use',
          id: item.call_id || item.id,
          name: item.name,
          input: parseFunctionArguments(item.arguments, item.name),
        });
        continue;
      }

      const text = extractTextFromResponsesItem(item);
      if (text) content.push({ type: 'text', text });
    }
  }

  const hasToolUse = content.some(block => block.type === 'tool_use');
  const usage = extractResponsesUsage(responseObj.usage);

  return {
    id: responseObj.id || `msg_${Date.now()}`,
    type: 'message',
    role: 'assistant',
    model,
    content,
    stop_reason: hasToolUse ? 'tool_use' : 'end_turn',
    stop_sequence: null,
    usage,
  };
}

function sseWrite(res, event, data) {
  res.write(`event: ${event}\n`);
  res.write(`data: ${JSON.stringify(data)}\n\n`);
}

function parseSseRecords(buffer) {
  const records = [];
  const parts = buffer.split(/\n\n/);
  const rest = parts.pop();

  for (const part of parts) {
    const record = { event: '', data: '' };
    for (const rawLine of part.split('\n')) {
      const line = rawLine.replace(/\r$/, '');
      if (line.startsWith('event:')) record.event = line.slice(6).trim();
      if (line.startsWith('data:')) {
        record.data += (record.data ? '\n' : '') + line.slice(5).trimStart();
      }
    }
    if (record.data) records.push(record);
  }

  return { records, rest };
}

function handleResponsesStream(proxyRes, res, model) {
  res.writeHead(proxyRes.statusCode, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });

  const state = {
    messageId: `msg_${Date.now()}`,
    textIndex: null,
    nextIndex: 0,
    functionByOutputIndex: new Map(),
    hasToolUse: false,
    messageStarted: false,
    inputTokens: 0,
    outputTokens: 0,
  };

  function ensureMessageStarted(id) {
    if (state.messageStarted) return;
    state.messageStarted = true;
    state.messageId = id || state.messageId;
    sseWrite(res, 'message_start', {
      type: 'message_start',
      message: {
        id: state.messageId,
        type: 'message',
        role: 'assistant',
        model,
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: {
          input_tokens: state.inputTokens,
          output_tokens: 0,
        },
      },
    });
  }

  function ensureTextBlock() {
    ensureMessageStarted();
    if (state.textIndex !== null) return state.textIndex;

    const index = state.nextIndex++;
    state.textIndex = index;
    sseWrite(res, 'content_block_start', {
      type: 'content_block_start',
      index,
      content_block: {
        type: 'text',
        text: '',
      },
    });
    return index;
  }

  function startFunctionBlock(item) {
    ensureMessageStarted();
    const index = item.output_index ?? state.nextIndex++;
    const callId = item.call_id || item.id || `call_${index}`;
    state.hasToolUse = true;
    state.functionByOutputIndex.set(index, {
      id: callId,
      name: item.name,
      closed: false,
    });

    sseWrite(res, 'content_block_start', {
      type: 'content_block_start',
      index,
      content_block: {
        type: 'tool_use',
        id: callId,
        name: item.name,
        input: {},
      },
    });
  }

  function closeFunctionBlock(index) {
    const fn = state.functionByOutputIndex.get(index);
    if (!fn || fn.closed) return;
    fn.closed = true;
    sseWrite(res, 'content_block_stop', {
      type: 'content_block_stop',
      index,
    });
  }

  function finishMessage() {
    ensureMessageStarted();

    if (state.textIndex !== null) {
      sseWrite(res, 'content_block_stop', {
        type: 'content_block_stop',
        index: state.textIndex,
      });
      state.textIndex = null;
    }

    for (const [index] of state.functionByOutputIndex) {
      closeFunctionBlock(index);
    }

    sseWrite(res, 'message_delta', {
      type: 'message_delta',
      delta: {
        stop_reason: state.hasToolUse ? 'tool_use' : 'end_turn',
        stop_sequence: null,
      },
      usage: {
        output_tokens: state.outputTokens,
      },
    });

    sseWrite(res, 'message_stop', {
      type: 'message_stop',
    });
  }

  let buffer = '';

  proxyRes.on('data', chunk => {
    buffer += chunk.toString('utf8');
    const parsed = parseSseRecords(buffer);
    buffer = parsed.rest;

    for (const record of parsed.records) {
      if (record.data === '[DONE]') continue;

      let evt;
      try {
        evt = JSON.parse(record.data);
      } catch {
        continue;
      }

      if (evt.response?.id) ensureMessageStarted(evt.response.id);

      if (evt.response?.usage) {
        const usage = extractResponsesUsage(evt.response.usage);
        state.inputTokens = usage.input_tokens;
        state.outputTokens = usage.output_tokens;
      }

      switch (evt.type || record.event) {
        case 'response.created':
          ensureMessageStarted(evt.response?.id);
          break;

        case 'response.output_text.delta': {
          const index = ensureTextBlock();
          sseWrite(res, 'content_block_delta', {
            type: 'content_block_delta',
            index,
            delta: {
              type: 'text_delta',
              text: evt.delta || '',
            },
          });
          break;
        }

        case 'response.output_item.added':
          if (evt.item?.type === 'function_call') startFunctionBlock({
            ...evt.item,
            output_index: evt.output_index,
          });
          break;

        case 'response.function_call_arguments.delta': {
          const index = evt.output_index ?? 0;
          if (!state.functionByOutputIndex.has(index)) {
            startFunctionBlock({
              output_index: index,
              id: evt.item_id,
              call_id: evt.call_id || evt.item_id,
              name: evt.name || 'tool',
            });
          }

          sseWrite(res, 'content_block_delta', {
            type: 'content_block_delta',
            index,
            delta: {
              type: 'input_json_delta',
              partial_json: evt.delta || '',
            },
          });
          break;
        }

        case 'response.function_call_arguments.done':
          if (evt.output_index !== undefined) closeFunctionBlock(evt.output_index);
          break;

        case 'response.output_item.done':
          if (evt.item?.type === 'function_call') closeFunctionBlock(evt.output_index);
          break;

        case 'response.completed':
          finishMessage();
          break;

        case 'error':
        case 'response.failed':
          sseWrite(res, 'error', {
            type: 'error',
            error: evt.error || evt.response?.error || {
              type: 'api_error',
              message: 'Responses upstream failed',
            },
          });
          break;
      }
    }
  });

  proxyRes.on('end', () => {
    if (!res.writableEnded) res.end();
  });

  proxyRes.on('error', e => {
    console.error('[proxy] Responses 流式响应错误:', e.message);
    if (!res.destroyed) res.end();
  });
}

function forwardResponses(req, res, bodyObj) {
  if (req.method !== 'POST') {
    sendProxyError(res, 405, 'responses mode only supports POST requests');
    return;
  }

  let built;
  try {
    built = buildResponsesRequest(bodyObj);
  } catch (e) {
    sendProxyError(res, 400, e.message);
    return;
  }

  const upstreamUrl = new URL(`${UPSTREAM_BASE_URL}/responses`);
  const sendBody = Buffer.from(JSON.stringify(built.requestBody), 'utf8');
  const isStream = built.requestBody.stream === true;
  const upstreamHeaders = createUpstreamHeaders(upstreamUrl, sendBody, {
    accept: isStream ? 'text/event-stream' : 'application/json',
  });

  requestUpstream(
    upstreamUrl,
    'POST',
    upstreamHeaders,
    sendBody,
    proxyRes => {
      if (proxyRes.statusCode >= 400) {
        readResponseBody(proxyRes).then(errData => {
          console.error(`  Responses上游错误: ${proxyRes.statusCode}`);
          console.error(`  上游错误内容  : ${errData.slice(0, 1000)}`);
          res.writeHead(proxyRes.statusCode, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(errData);
        }).catch(e => {
          if (!res.headersSent) sendProxyError(res, 502, e.message);
        });
        return;
      }

      if (isStream) {
        handleResponsesStream(proxyRes, res, built.targetModel);
        return;
      }

      readResponseBody(proxyRes).then(data => {
        let parsed;
        try {
          parsed = JSON.parse(data);
        } catch {
          sendProxyError(res, 502, 'Responses upstream returned non-JSON data');
          return;
        }

        if (parsed.usage) logCacheUsage(parsed.usage);

        let anthropicMessage;
        try {
          anthropicMessage = convertResponsesToAnthropic(parsed, built.targetModel);
        } catch (e) {
          sendProxyError(res, 502, e.message);
          return;
        }

        sendJson(res, proxyRes.statusCode, anthropicMessage);
      }).catch(e => {
        if (!res.headersSent) sendProxyError(res, 502, e.message);
      });
    },
    e => {
      console.error('[proxy] Responses 上游请求错误:', e.message);
      if (!res.headersSent) sendProxyError(res, 502, e.message);
    }
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// HTTP 服务器
// ─────────────────────────────────────────────────────────────────────────────

const server = http.createServer(async (req, res) => {
  if (req.method === 'GET' && req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      status: 'ok',
      port: PORT,
      provider: PROVIDER,
      apiFormat: UPSTREAM_API_FORMAT,
      upstream: UPSTREAM_BASE_URL,
      modelRules: MODEL_RULES.map(r => ({
        match: String(r.match),
        target: r.target,
      })),
      fallback: FALLBACK_MODEL,
      reasoningEffort: MODEL_REASONING_EFFORT,
      disableResponseStorage: DISABLE_RESPONSE_STORAGE,
    }));
    return;
  }

  let rawBody;
  try {
    rawBody = await readBody(req);
  } catch (e) {
    sendProxyError(res, 400, e.message);
    return;
  }

  let bodyObj = null;

  if (req.method === 'POST' && rawBody.length > 0) {
    try {
      bodyObj = JSON.parse(rawBody.toString('utf8'));
    } catch (e) {
      if (UPSTREAM_API_FORMAT === 'anthropic') {
        console.log(`[${new Date().toISOString()}]`);
        console.log(`  PATH           : ${req.url}`);
        console.log(`  JSON解析失败    : ${e.message}`);
        console.log(`  处理方式       : 原样透传`);
      } else {
        sendProxyError(res, 400, `JSON解析失败: ${e.message}`);
        return;
      }
    }
  }

  if (UPSTREAM_API_FORMAT === 'responses') {
    if (!bodyObj) {
      sendProxyError(res, 400, 'responses mode requires a JSON request body');
      return;
    }
    forwardResponses(req, res, bodyObj);
    return;
  }

  if (UPSTREAM_API_FORMAT !== 'anthropic') {
    sendProxyError(res, 500, `unsupported UPSTREAM_API_FORMAT: ${UPSTREAM_API_FORMAT}`);
    return;
  }

  forwardAnthropic(req, res, rawBody, bodyObj);
});

// ─────────────────────────────────────────────────────────────────────────────
// 启动
// ─────────────────────────────────────────────────────────────────────────────

server.on('error', e => {
  if (e.code === 'EADDRINUSE') {
    console.error(`端口 ${PORT} 已占用，请用 PROXY_PORT=XXXX 指定其他端口`);
  } else {
    console.error('Server error:', e);
  }

  process.exit(1);
});

server.listen(PORT, '127.0.0.1', () => {
  console.log('\nClaude Desktop local model gateway');
  console.log(`    Claude Desktop → http://127.0.0.1:${PORT}`);
  console.log(`    Provider       → ${PROVIDER}`);
  console.log(`    API format     → ${UPSTREAM_API_FORMAT}`);
  console.log(`    Upstream       → ${UPSTREAM_BASE_URL}`);
  console.log('');

  if (!UPSTREAM_API_KEY) {
    console.log('警告：UPSTREAM_API_KEY 为空，请检查 launchd plist 里的 EnvironmentVariables。');
    console.log('');
  }

  console.log('    模型映射规则:');
  for (const r of MODEL_RULES) {
    console.log(`      含 ${String(r.match).padEnd(12)}  →  ${r.target}`);
  }
  console.log(`      其他             →  ${FALLBACK_MODEL}`);
  console.log('');
});
