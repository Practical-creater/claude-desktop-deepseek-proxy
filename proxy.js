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
const fs = require('fs');
const path = require('path');
const os = require('os');

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
    fallbackModel: 'gpt-5.4-mini',
    modelRules: [
      { match: 'opus', target: 'gpt-5.5' },
      { match: 'sonnet', target: 'gpt-5.4' },
      { match: 'haiku', target: 'gpt-5.4-mini' },
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

const VALID_IMAGE_DETAIL = new Set(['auto', 'low', 'high']);
const IMAGE_DETAIL = (() => {
  const raw = (process.env.IMAGE_DETAIL || 'auto').toLowerCase();
  if (!VALID_IMAGE_DETAIL.has(raw)) {
    console.error(`[proxy] IMAGE_DETAIL="${raw}" 非法 (允许: auto|low|high)，回退到 "auto"`);
    return 'auto';
  }
  return raw;
})();

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
// 多供应商路由（routes.json + secrets.json）
//
// 触发条件：~/.local/model-proxy/routes.json 存在
// 触发后：每条请求按 bodyObj.model 查路由表，使用对应 baseUrl/apiKey/apiFormat
// 不存在时：维持单上游模式（沿用 UPSTREAM_API_KEY 等环境变量）
// ─────────────────────────────────────────────────────────────────────────────

const PROXY_HOME = process.env.MODEL_PROXY_HOME ||
  path.join(os.homedir(), '.local', 'model-proxy');
const ROUTES_PATH = path.join(PROXY_HOME, 'routes.json');
const SECRETS_PATH = path.join(PROXY_HOME, 'secrets.json');

// 简易 JSON-with-comments 解析：支持 // 和 /* */ 注释。
// 不处理字符串里偶然出现的 // 序列（足够路由配置场景使用）。
function parseJsonWithComments(text) {
  let out = '';
  let i = 0;
  let inString = false;
  let stringQuote = '';
  while (i < text.length) {
    const ch = text[i];
    const next = text[i + 1];

    if (inString) {
      out += ch;
      if (ch === '\\') {
        if (i + 1 < text.length) {
          out += text[i + 1];
          i += 2;
          continue;
        }
      } else if (ch === stringQuote) {
        inString = false;
      }
      i += 1;
      continue;
    }

    if (ch === '"' || ch === "'") {
      inString = true;
      stringQuote = ch;
      out += ch;
      i += 1;
      continue;
    }

    if (ch === '/' && next === '/') {
      while (i < text.length && text[i] !== '\n') i += 1;
      continue;
    }

    if (ch === '/' && next === '*') {
      i += 2;
      while (i < text.length && !(text[i] === '*' && text[i + 1] === '/')) i += 1;
      i += 2;
      continue;
    }

    out += ch;
    i += 1;
  }
  return JSON.parse(out);
}

// HTTP header value 不允许控制字符、换行或非 ASCII。
// API key 实测都是 printable ASCII，超出范围的几乎必然是误粘贴的提示文本 / 换行污染。
function isValidApiKey(value) {
  if (typeof value !== 'string') return false;
  if (value.length === 0) return false;
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    if (code < 0x20 || code > 0x7e) return false;
  }
  return true;
}

function loadSecrets() {
  if (!fs.existsSync(SECRETS_PATH)) return {};
  const stat = fs.statSync(SECRETS_PATH);
  if (process.platform !== 'win32') {
    const mode = stat.mode & 0o777;
    if (mode !== 0o600) {
      console.error(`[proxy] secrets.json 权限不安全 (mode=${mode.toString(8)})，应为 600`);
      console.error(`[proxy] 修复: chmod 600 "${SECRETS_PATH}"`);
      process.exit(1);
    }
  }
  const text = fs.readFileSync(SECRETS_PATH, 'utf8');
  let parsed;
  try {
    parsed = parseJsonWithComments(text);
  } catch (e) {
    console.error('[proxy] secrets.json 解析失败:', e.message);
    process.exit(1);
  }

  // 对每个 key 做合法性校验。坏 key 不抛错（避免单一坏 key 拖垮整个代理），
  // 而是从结果里剔除并打警告——引用该 secretId 的 route 会在 loadRoutes 里失效。
  const clean = {};
  for (const [id, value] of Object.entries(parsed)) {
    const trimmed = typeof value === 'string' ? value.trim() : value;
    if (!isValidApiKey(trimmed)) {
      console.error(`[proxy] ⚠️  secrets.json 里 secretId="${id}" 的值无效 (含非可打印 ASCII 或为空)，已忽略`);
      console.error('[proxy]     最常见原因：交互式 setup 时误把提示文本粘成了 key');
      continue;
    }
    if (trimmed !== value) {
      console.error(`[proxy] ⚠️  secretId="${id}" 有前后空白，已自动 trim`);
    }
    clean[id] = trimmed;
  }
  return clean;
}

function loadRoutes() {
  if (!fs.existsSync(ROUTES_PATH)) return null;
  const text = fs.readFileSync(ROUTES_PATH, 'utf8');
  let raw;
  try {
    raw = parseJsonWithComments(text);
  } catch (e) {
    console.error('[proxy] routes.json 解析失败:', e.message);
    process.exit(1);
  }

  const secrets = loadSecrets();
  const routes = {};
  let fallback = null;

  for (const [aliasName, def] of Object.entries(raw)) {
    // _fallback 是特殊键：定义关键字 → 别名映射，处理 Claude Desktop 对
    // claude-haiku-4-5 这类硬编码名字的探测请求
    if (aliasName === '_fallback') {
      if (!def || typeof def !== 'object') {
        console.error('[proxy] routes.json 的 _fallback 不是对象，忽略');
        continue;
      }
      fallback = def;
      continue;
    }

    if (!def || typeof def !== 'object') {
      console.error(`[proxy] routes.json 条目 "${aliasName}" 不是对象，跳过`);
      continue;
    }
    const { apiFormat, baseUrl, secretId, targetModel, displayName } = def;
    if (!apiFormat || !baseUrl || !secretId || !targetModel) {
      console.error(`[proxy] routes.json 条目 "${aliasName}" 缺字段，需要 apiFormat/baseUrl/secretId/targetModel`);
      continue;
    }
    if (apiFormat !== 'anthropic' && apiFormat !== 'responses') {
      console.error(`[proxy] routes.json 条目 "${aliasName}" apiFormat 非法: ${apiFormat}`);
      continue;
    }
    const apiKey = secrets[secretId];
    if (!apiKey) {
      console.error(`[proxy] routes.json 条目 "${aliasName}" 引用的 secretId="${secretId}" 在 secrets.json 中找不到`);
      continue;
    }
    routes[aliasName] = {
      apiFormat,
      baseUrl: String(baseUrl).replace(/\/$/, ''),
      apiKey,
      targetModel,
      displayName: typeof displayName === 'string' && displayName.trim() ? displayName.trim() : aliasName,
    };
  }

  // 验证 _fallback 引用的别名都存在
  const fallbackEntries = [];
  if (fallback) {
    for (const [keyword, aliasName] of Object.entries(fallback)) {
      if (typeof aliasName !== 'string') continue;
      if (!routes[aliasName]) {
        console.error(`[proxy] _fallback["${keyword}"]="${aliasName}" 引用的别名不存在，忽略`);
        continue;
      }
      fallbackEntries.push({ keyword: String(keyword).toLowerCase(), aliasName });
    }
  }

  return { routes, fallback: fallbackEntries };
}

// Claude Desktop UI 在某些版本下会吃掉模型名里的 "."，所以查找时归一化：
// 大小写不敏感、"." 视同 "-"。这样 claude-gpt-5.4 / claude-GPT-5-4 都能命中同一条路由。
function normalizeAlias(name) {
  return String(name || '').toLowerCase().replace(/\./g, '-');
}

// 路由状态用 let 而非 const，以便 /admin/save 写完文件后热重载
let ROUTES = null;
let FALLBACK_ENTRIES = [];
let MULTI_MODE = false;
let NORMALIZED_ROUTES = null;

function applyRoutesData(data) {
  if (!data) {
    ROUTES = null;
    FALLBACK_ENTRIES = [];
    MULTI_MODE = false;
    NORMALIZED_ROUTES = null;
    return;
  }
  ROUTES = data.routes;
  FALLBACK_ENTRIES = data.fallback;
  MULTI_MODE = true;
  NORMALIZED_ROUTES = Object.fromEntries(
    Object.entries(ROUTES).map(([k, v]) => [normalizeAlias(k), v]),
  );
}

function reloadRouting() {
  applyRoutesData(loadRoutes());
}

applyRoutesData(loadRoutes());

function resolveRoute(originalModel) {
  if (MULTI_MODE) {
    if (ROUTES[originalModel]) return ROUTES[originalModel];

    const normalized = normalizeAlias(originalModel);
    if (NORMALIZED_ROUTES[normalized]) {
      console.log(`[proxy] 归一化匹配: "${originalModel}" → 别名 "${normalized}"`);
      return NORMALIZED_ROUTES[normalized];
    }

    // Fallback：把 Claude Desktop 探测的 claude-haiku-4-5 / claude-sonnet-4-5 等
    // 名字映射到用户配置的别名（routes.json 里的 _fallback 段）
    for (const { keyword, aliasName } of FALLBACK_ENTRIES) {
      if (normalized.includes(keyword)) {
        console.log(`[proxy] fallback: "${originalModel}" → "${aliasName}" (匹配关键字 "${keyword}")`);
        return ROUTES[aliasName];
      }
    }
    return null;
  }
  // 单上游模式：合成一个 route 复用同一套转发逻辑
  return {
    apiFormat: UPSTREAM_API_FORMAT,
    baseUrl: UPSTREAM_BASE_URL,
    apiKey: UPSTREAM_API_KEY,
    targetModel: resolveModel(originalModel),
  };
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

function formatLogTime(date = new Date()) {
  const pad = (value, len = 2) => String(value).padStart(len, '0');

  return [
    date.getFullYear(),
    '-',
    pad(date.getMonth() + 1),
    '-',
    pad(date.getDate()),
    ' ',
    pad(date.getHours()),
    ':',
    pad(date.getMinutes()),
    ':',
    pad(date.getSeconds()),
    '.',
    pad(date.getMilliseconds(), 3),
  ].join('');
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

function createUpstreamHeaders(upstreamUrl, sendBody, apiKey, extra = {}) {
  const headers = {
    host: upstreamUrl.host,
    authorization: `Bearer ${apiKey}`,
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

function buildAnthropicBody(bodyObj, targetModel) {
  const originalModel = bodyObj.model || '';

  console.log(`[${formatLogTime()}]`);
  console.log(`  API格式        : anthropic`);
  console.log(`  收到模型名     : "${originalModel}"`);

  bodyObj.system = normalizeSystemForCache(bodyObj.system);
  bodyObj.model = targetModel;

  console.log(`  转发模型名     : "${targetModel}"`);
  console.log(`  stream         : ${bodyObj.stream === true}`);
  console.log(`  tools          : ${Array.isArray(bodyObj.tools) ? bodyObj.tools.length : 0}`);

  return Buffer.from(JSON.stringify(bodyObj), 'utf8');
}

function forwardAnthropic(req, res, rawBody, bodyObj, route) {
  let sendBody = rawBody;

  if (req.method === 'POST' && rawBody.length > 0 && bodyObj) {
    sendBody = buildAnthropicBody(bodyObj, route.targetModel);
  }

  const upstreamUrl = new URL(`${route.baseUrl}${req.url}`);
  const upstreamHeaders = {
    ...req.headers,
    host: upstreamUrl.host,
    authorization: `Bearer ${route.apiKey}`,
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

function imageBlockToInputImage(block) {
  const source = block.source;
  if (!source || typeof source !== 'object') {
    throw new Error('image block missing source');
  }

  let imageUrl;
  if (source.type === 'base64') {
    if (!source.media_type || typeof source.data !== 'string') {
      throw new Error('image base64 source requires media_type and data');
    }
    imageUrl = `data:${source.media_type};base64,${source.data}`;
  } else if (source.type === 'url') {
    if (typeof source.url !== 'string' || !source.url) {
      throw new Error('image url source requires a non-empty url');
    }
    imageUrl = source.url;
  } else {
    throw new Error(`unsupported image source type: ${source.type}`);
  }

  return { type: 'input_image', image_url: imageUrl, detail: IMAGE_DETAIL };
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

    const items = [];

    for (const block of content) {
      if (!block || typeof block !== 'object') continue;

      if (block.type === 'text') {
        items.push({ type: 'input_text', text: block.text || '' });
        continue;
      }

      if (block.type === 'image') {
        if (message.role !== 'user') {
          console.error('[proxy] 忽略 assistant 消息中的 image 块');
          continue;
        }
        items.push(imageBlockToInputImage(block));
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

    if (items.length === 0) continue;

    const allText = items.every(i => i.type === 'input_text');
    if (allText) {
      const text = items.map(i => i.text).join('\n');
      if (text) {
        input.push({ role: message.role, content: text });
      }
    } else {
      input.push({ role: message.role, content: items });
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

function buildResponsesRequest(bodyObj, targetModel) {
  const originalModel = bodyObj.model || '';
  const normalizedSystem = normalizeSystemForCache(bodyObj.system);

  console.log(`[${formatLogTime()}]`);
  console.log(`  API格式        : responses`);
  console.log(`  收到模型名     : "${originalModel}"`);
  console.log(`  转发模型名     : "${targetModel}"`);
  console.log(`  stream         : ${bodyObj.stream === true}`);
  console.log(`  tools          : ${Array.isArray(bodyObj.tools) ? bodyObj.tools.length : 0}`);

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

function forwardResponses(req, res, bodyObj, route) {
  if (req.method !== 'POST') {
    sendProxyError(res, 405, 'responses mode only supports POST requests');
    return;
  }

  let built;
  try {
    built = buildResponsesRequest(bodyObj, route.targetModel);
  } catch (e) {
    sendProxyError(res, 400, e.message);
    return;
  }

  const upstreamUrl = new URL(`${route.baseUrl}/responses`);
  const sendBody = Buffer.from(JSON.stringify(built.requestBody), 'utf8');
  const isStream = built.requestBody.stream === true;
  const upstreamHeaders = createUpstreamHeaders(upstreamUrl, sendBody, route.apiKey, {
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

// 用于 /v1/models 响应里的 created_at — 启动时固定一个值
const SERVER_STARTED_AT = new Date().toISOString();

// ─────────────────────────────────────────────────────────────────────────────
// /admin 后台（浏览器可视化配置）
// ─────────────────────────────────────────────────────────────────────────────

// 从 secrets.json 拿到"安全版"信息：只返回长度和首尾 4 位字符，不暴露完整 key
function loadSecretsForAdmin() {
  if (!fs.existsSync(SECRETS_PATH)) return {};
  try {
    const text = fs.readFileSync(SECRETS_PATH, 'utf8');
    const parsed = parseJsonWithComments(text);
    const result = {};
    for (const [id, value] of Object.entries(parsed)) {
      if (typeof value !== 'string') continue;
      result[id] = {
        length: value.length,
        prefix: value.slice(0, 4),
        suffix: value.slice(-4),
      };
    }
    return result;
  } catch {
    return {};
  }
}

// 把 routes object + fallback 对象序列化成漂亮的 routes.json（含注释头）
function serializeRoutes(routesObj, fallbackObj) {
  const header = `{
  // ─────────────────────────────────────────────────────────────────
  // 多供应商路由表（由 /admin 可视化界面生成）
  // 别名 id 必须含 claude/sonnet/opus/haiku/anthropic 任一关键字
  // ─────────────────────────────────────────────────────────────────
`;
  const entries = [];
  for (const [k, v] of Object.entries(routesObj)) {
    const val = JSON.stringify(v, null, 4).replace(/\n/g, '\n  ');
    entries.push(`  ${JSON.stringify(k)}: ${val}`);
  }
  if (fallbackObj && Object.keys(fallbackObj).length > 0) {
    const val = JSON.stringify(fallbackObj, null, 4).replace(/\n/g, '\n  ');
    entries.push(`  "_fallback": ${val}`);
  }
  return header + entries.join(',\n') + '\n}\n';
}

function writeSecretsAtomic(secretsObj) {
  fs.writeFileSync(SECRETS_PATH, JSON.stringify(secretsObj, null, 2) + '\n', { mode: 0o600 });
  // 显式 chmod 防止 fs.writeFileSync 在文件已存在时不应用 mode 参数
  fs.chmodSync(SECRETS_PATH, 0o600);
}

function writeRoutesAtomic(routesObj, fallbackObj) {
  fs.writeFileSync(ROUTES_PATH, serializeRoutes(routesObj, fallbackObj));
}

function adminJson(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
}

function handleAdminGetConfig(res) {
  // 把内存里的路由表 + secrets 元数据返给前端，方便初始化表单
  const routes = {};
  if (MULTI_MODE) {
    for (const [alias, r] of Object.entries(ROUTES)) {
      routes[alias] = {
        displayName: r.displayName,
        apiFormat: r.apiFormat,
        baseUrl: r.baseUrl,
        secretId: Object.entries(loadSecretsForAdmin())
          .find(([id]) => loadSecrets()[id] === r.apiKey)?.[0] || '',
        targetModel: r.targetModel,
      };
    }
  }
  // 上面 secretId 反查比较绕——重新做一次：直接从磁盘读 routes.json 拿原始 secretId
  let rawRoutes = {};
  let fallback = {};
  if (fs.existsSync(ROUTES_PATH)) {
    try {
      const parsed = parseJsonWithComments(fs.readFileSync(ROUTES_PATH, 'utf8'));
      for (const [k, v] of Object.entries(parsed)) {
        if (k === '_fallback') {
          fallback = v || {};
        } else if (v && typeof v === 'object') {
          rawRoutes[k] = {
            displayName: v.displayName || k,
            apiFormat: v.apiFormat,
            baseUrl: v.baseUrl,
            secretId: v.secretId,
            targetModel: v.targetModel,
          };
        }
      }
    } catch (e) {
      return adminJson(res, 500, { error: `routes.json 解析失败: ${e.message}` });
    }
  }
  adminJson(res, 200, {
    multiMode: MULTI_MODE,
    routes: rawRoutes,
    fallback,
    secrets: loadSecretsForAdmin(),
  });
}

const ADMIN_HTML = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Local Gateway · Admin</title>
<style>
  :root {
    --bg: #f5f5f7;
    --card: #ffffff;
    --text: #1d1d1f;
    --muted: #6e6e73;
    --border: rgba(0,0,0,0.08);
    --accent: #0071e3;
    --accent-hover: #0077ed;
    --danger: #ff3b30;
    --success: #34c759;
    --input-bg: #ffffff;
    --input-border: #d2d2d7;
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --bg: #000000;
      --card: #1c1c1e;
      --text: #f5f5f7;
      --muted: #98989d;
      --border: rgba(255,255,255,0.1);
      --input-bg: #2c2c2e;
      --input-border: #3a3a3c;
    }
  }
  * { box-sizing: border-box; }
  html, body { margin: 0; padding: 0; }
  body {
    font-family: -apple-system, BlinkMacSystemFont, "SF Pro Display", "SF Pro Text", "Helvetica Neue", Helvetica, Arial, sans-serif;
    background: var(--bg);
    color: var(--text);
    -webkit-font-smoothing: antialiased;
    line-height: 1.5;
    padding: 32px 16px 96px;
  }
  .container { max-width: 720px; margin: 0 auto; }
  header {
    display: flex; align-items: baseline; justify-content: space-between;
    margin-bottom: 28px; gap: 12px; flex-wrap: wrap;
  }
  header h1 { font-size: 28px; font-weight: 600; margin: 0; letter-spacing: -0.02em; }
  .pill {
    font-size: 12px; padding: 4px 10px; border-radius: 999px;
    background: rgba(52,199,89,0.12); color: var(--success);
    display: inline-flex; align-items: center; gap: 6px;
  }
  .pill::before {
    content: ""; width: 6px; height: 6px; border-radius: 50%;
    background: var(--success);
  }
  .card {
    background: var(--card); border: 1px solid var(--border);
    border-radius: 14px; padding: 24px; margin-bottom: 16px;
  }
  .card h2 {
    font-size: 19px; font-weight: 600; margin: 0 0 4px;
    letter-spacing: -0.01em;
  }
  .card .subtitle { color: var(--muted); font-size: 13px; margin: 0 0 18px; }
  .field { margin-bottom: 14px; }
  .field:last-child { margin-bottom: 0; }
  label { display: block; font-size: 13px; color: var(--muted); margin-bottom: 6px; }
  input, select {
    width: 100%; padding: 9px 12px; font-size: 14px; font-family: inherit;
    background: var(--input-bg); color: var(--text);
    border: 1px solid var(--input-border); border-radius: 8px;
    outline: none; transition: border-color 0.15s, box-shadow 0.15s;
  }
  input:focus, select:focus {
    border-color: var(--accent);
    box-shadow: 0 0 0 3px rgba(0,113,227,0.18);
  }
  .row { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
  .row-3 { display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 12px; }
  @media (max-width: 560px) {
    .row, .row-3 { grid-template-columns: 1fr; }
  }
  button {
    font-family: inherit; font-size: 14px; font-weight: 500;
    padding: 8px 16px; border-radius: 8px; cursor: pointer;
    border: 1px solid transparent; background: transparent; color: var(--accent);
    transition: background 0.15s, opacity 0.15s;
  }
  button:hover { background: rgba(0,113,227,0.08); }
  button.primary {
    background: var(--accent); color: white; border-color: var(--accent);
  }
  button.primary:hover { background: var(--accent-hover); }
  button.danger { color: var(--danger); }
  button.danger:hover { background: rgba(255,59,48,0.08); }
  button:disabled { opacity: 0.5; cursor: not-allowed; }
  .route {
    border: 1px solid var(--border); border-radius: 10px;
    padding: 16px; margin-bottom: 12px; background: var(--bg);
  }
  .route-head {
    display: flex; align-items: center; justify-content: space-between;
    margin-bottom: 12px; gap: 8px;
  }
  .route-head strong { font-size: 15px; }
  .route-head code {
    font-family: ui-monospace, "SF Mono", Menlo, monospace;
    font-size: 12px; color: var(--muted);
    background: var(--card); padding: 2px 8px; border-radius: 6px;
  }
  .actions {
    position: fixed; bottom: 0; left: 0; right: 0;
    background: color-mix(in srgb, var(--bg) 95%, transparent);
    backdrop-filter: saturate(180%) blur(20px);
    -webkit-backdrop-filter: saturate(180%) blur(20px);
    padding: 14px 16px; border-top: 1px solid var(--border);
    display: flex; justify-content: center;
  }
  .actions .inner {
    width: 100%; max-width: 720px;
    display: flex; gap: 10px; justify-content: flex-end; align-items: center;
  }
  #status { font-size: 13px; color: var(--muted); margin-right: auto; }
  #status.ok { color: var(--success); }
  #status.err { color: var(--danger); }
  .add-btn {
    border: 1px dashed var(--input-border); border-radius: 10px;
    width: 100%; padding: 12px; color: var(--muted); margin-top: 4px;
  }
  .add-btn:hover { color: var(--accent); border-color: var(--accent); }
  .key-meta {
    font-size: 12px; color: var(--muted); margin-top: 6px;
    font-family: ui-monospace, "SF Mono", Menlo, monospace;
  }
  .empty {
    text-align: center; color: var(--muted); padding: 24px 0; font-size: 13px;
  }
</style>
</head>
<body>
<div class="container">
  <header>
    <h1>Local Gateway</h1>
    <span class="pill">running on :__PORT__</span>
  </header>

  <div class="card">
    <h2>API Keys</h2>
    <p class="subtitle">Stored in <code>~/.local/model-proxy/secrets.json</code> with permission 600. Leave a field blank to keep the existing key; otherwise the new value replaces it.</p>
    <div id="secrets"></div>
  </div>

  <div class="card">
    <h2>Routes</h2>
    <p class="subtitle">Each entry maps a model id (with required <code>claude-</code> prefix) to an upstream API. <code>display_name</code> is what Claude Desktop shows in the picker.</p>
    <div id="routes"></div>
    <button class="add-btn" id="add-route">+ Add Route</button>
  </div>

  <div class="card">
    <h2>Fallback</h2>
    <p class="subtitle">When Claude Desktop probes a standard name like <code>claude-haiku-4-5</code>, route it to one of your aliases by keyword.</p>
    <div id="fallback"></div>
  </div>
</div>

<div class="actions">
  <div class="inner">
    <span id="status"></span>
    <button id="reload-btn">Reload from Disk</button>
    <button class="primary" id="save-btn">Save Changes</button>
  </div>
</div>

<script>
const $ = (sel) => document.querySelector(sel);
const el = (tag, attrs = {}, ...children) => {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') node.className = v;
    else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
    else if (v !== null && v !== undefined) node.setAttribute(k, v);
  }
  for (const c of children) {
    if (c == null) continue;
    node.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
  }
  return node;
};

let state = { routes: {}, fallback: {}, secrets: {}, multiMode: false };

async function loadConfig() {
  const r = await fetch('/admin/config');
  state = await r.json();
  if (!state.multiMode) {
    document.body.innerHTML = '<div class="container"><div class="card"><h2>Single-provider mode</h2><p class="subtitle">This admin UI manages the multi-provider routing table. Your gateway is currently running in single-provider mode (env-based). To enable multi-provider mode, re-run setup.sh with MULTI=1.</p></div></div>';
    return;
  }
  render();
}

function render() {
  renderSecrets();
  renderRoutes();
  renderFallback();
}

function renderSecrets() {
  const root = $('#secrets');
  root.innerHTML = '';
  // 收集所有 secrets：现有的 + routes 里引用到但还没建的
  const ids = new Set(Object.keys(state.secrets));
  for (const r of Object.values(state.routes)) if (r.secretId) ids.add(r.secretId);
  if (ids.size === 0) {
    root.appendChild(el('div', { class: 'empty' }, 'No API keys yet — add a route and reference a new secretId, then enter its key here.'));
    return;
  }
  for (const id of ids) {
    const meta = state.secrets[id];
    const placeholder = meta
      ? \`\${meta.prefix}••••\${meta.suffix}  (\${meta.length} chars)\`
      : 'paste API key here';
    const wrap = el('div', { class: 'field' },
      el('label', {}, id),
      el('input', { type: 'password', 'data-secret': id, placeholder, autocomplete: 'off' }),
    );
    if (meta) {
      wrap.appendChild(el('div', { class: 'key-meta' }, 'Existing key kept unless you type a new one.'));
    }
    root.appendChild(wrap);
  }
}

function renderRoutes() {
  const root = $('#routes');
  root.innerHTML = '';
  const entries = Object.entries(state.routes);
  if (entries.length === 0) {
    root.appendChild(el('div', { class: 'empty' }, 'No routes yet — click "Add Route" to create one.'));
    return;
  }
  for (const [alias, r] of entries) {
    root.appendChild(renderRoute(alias, r));
  }
}

function renderRoute(alias, r) {
  const idInput = el('input', { value: alias, placeholder: 'claude-deepseek-v4-pro' });
  const dnInput = el('input', { value: r.displayName || '', placeholder: 'DeepSeek V4 Pro' });
  const fmt = el('select', {},
    new Option('anthropic', 'anthropic', false, r.apiFormat === 'anthropic'),
    new Option('responses', 'responses', false, r.apiFormat === 'responses'),
  );
  const baseInput = el('input', { value: r.baseUrl || '', placeholder: 'https://api.deepseek.com/anthropic' });
  const sidInput = el('input', { value: r.secretId || '', placeholder: 'deepseek' });
  const targetInput = el('input', { value: r.targetModel || '', placeholder: 'deepseek-v4-pro' });

  const node = el('div', { class: 'route', 'data-route': '' },
    el('div', { class: 'route-head' },
      el('strong', {}, r.displayName || alias),
      el('code', {}, alias),
      el('button', { class: 'danger', onclick: () => { node.remove(); collectAndRerenderSecrets(); } }, 'Remove'),
    ),
    el('div', { class: 'row' },
      el('div', { class: 'field' }, el('label', {}, 'Model ID'), idInput),
      el('div', { class: 'field' }, el('label', {}, 'Display Name'), dnInput),
    ),
    el('div', { class: 'row-3' },
      el('div', { class: 'field' }, el('label', {}, 'Format'), fmt),
      el('div', { class: 'field' }, el('label', {}, 'Secret ID'), sidInput),
      el('div', { class: 'field' }, el('label', {}, 'Target Model'), targetInput),
    ),
    el('div', { class: 'field' }, el('label', {}, 'Base URL'), baseInput),
  );
  node._collect = () => ({
    alias: idInput.value.trim(),
    def: {
      displayName: dnInput.value.trim() || idInput.value.trim(),
      apiFormat: fmt.value,
      baseUrl: baseInput.value.trim(),
      secretId: sidInput.value.trim(),
      targetModel: targetInput.value.trim(),
    },
  });
  // 触发 secrets 区域刷新（用户改 secretId 后）
  sidInput.addEventListener('change', collectAndRerenderSecrets);
  return node;
}

function collectAndRerenderSecrets() {
  // 暂时收集当前界面的路由，更新 state.routes，然后只刷新 secrets 区域
  const tmp = {};
  for (const node of document.querySelectorAll('[data-route]')) {
    const { alias, def } = node._collect();
    if (alias) tmp[alias] = def;
  }
  state.routes = tmp;
  renderSecrets();
}

function renderFallback() {
  const root = $('#fallback');
  root.innerHTML = '';
  const aliasOptions = Object.keys(state.routes);
  const placeholder = el('option', { value: '' }, '— none —');
  for (const kw of ['haiku', 'sonnet', 'opus']) {
    const sel = el('select', { 'data-fallback': kw });
    sel.appendChild(placeholder.cloneNode(true));
    for (const a of aliasOptions) {
      const opt = new Option(a, a, false, state.fallback[kw] === a);
      sel.appendChild(opt);
    }
    root.appendChild(el('div', { class: 'field' },
      el('label', {}, \`Claude Desktop sends "\${kw}" probes → route to\`),
      sel,
    ));
  }
}

$('#add-route').addEventListener('click', () => {
  // 给个建议默认值，告诉新人 "claude-" 前缀是必要的
  const newAlias = 'claude-new-model';
  state.routes[newAlias] = {
    displayName: 'New Model',
    apiFormat: 'anthropic',
    baseUrl: '',
    secretId: '',
    targetModel: '',
  };
  renderRoutes();
  renderSecrets();
});

$('#reload-btn').addEventListener('click', loadConfig);

$('#save-btn').addEventListener('click', async () => {
  const btn = $('#save-btn');
  btn.disabled = true;
  const status = $('#status');
  status.className = '';
  status.textContent = 'Saving…';

  // 收集 routes
  const routes = {};
  for (const node of document.querySelectorAll('[data-route]')) {
    const { alias, def } = node._collect();
    if (!alias) {
      status.className = 'err'; status.textContent = 'Model ID cannot be empty.';
      btn.disabled = false; return;
    }
    routes[alias] = def;
  }
  // 收集 fallback
  const fallback = {};
  for (const sel of document.querySelectorAll('[data-fallback]')) {
    const kw = sel.getAttribute('data-fallback');
    if (sel.value) fallback[kw] = sel.value;
  }
  // 收集 secrets（只发非空字段）
  const secrets = {};
  for (const inp of document.querySelectorAll('[data-secret]')) {
    if (inp.value) secrets[inp.getAttribute('data-secret')] = inp.value;
  }

  try {
    const r = await fetch('/admin/save', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ routes, fallback, secrets }),
    });
    const data = await r.json();
    if (!r.ok) throw new Error(data.error || 'save failed');
    status.className = 'ok';
    status.textContent = \`Saved · \${data.routeCount} routes active\`;
    setTimeout(() => loadConfig(), 400);
  } catch (e) {
    status.className = 'err';
    status.textContent = e.message;
  } finally {
    btn.disabled = false;
  }
});

loadConfig();
</script>
</body>
</html>
`;

function handleAdminSave(res, bodyText) {
  let payload;
  try {
    payload = JSON.parse(bodyText);
  } catch (e) {
    return adminJson(res, 400, { error: `请求体不是合法 JSON: ${e.message}` });
  }

  const { routes, fallback, secrets } = payload || {};
  if (!routes || typeof routes !== 'object') {
    return adminJson(res, 400, { error: 'routes 必须是对象' });
  }

  // 校验每条 route 字段齐全
  for (const [alias, def] of Object.entries(routes)) {
    if (!alias || typeof alias !== 'string') {
      return adminJson(res, 400, { error: '别名 id 不能为空' });
    }
    if (!def || typeof def !== 'object') {
      return adminJson(res, 400, { error: `route "${alias}" 不是对象` });
    }
    const required = ['apiFormat', 'baseUrl', 'secretId', 'targetModel'];
    for (const f of required) {
      if (!def[f] || typeof def[f] !== 'string') {
        return adminJson(res, 400, { error: `route "${alias}" 缺字段 ${f}` });
      }
    }
    if (def.apiFormat !== 'anthropic' && def.apiFormat !== 'responses') {
      return adminJson(res, 400, { error: `route "${alias}" apiFormat 必须是 anthropic 或 responses` });
    }
  }

  // 合并 secrets：空字符串 = 保留原值，非空 = 替换
  const oldSecrets = (() => {
    if (!fs.existsSync(SECRETS_PATH)) return {};
    try { return parseJsonWithComments(fs.readFileSync(SECRETS_PATH, 'utf8')); }
    catch { return {}; }
  })();
  const newSecrets = { ...oldSecrets };
  if (secrets && typeof secrets === 'object') {
    for (const [id, value] of Object.entries(secrets)) {
      if (typeof value !== 'string') continue;
      if (value === '') continue; // 保留原值
      if (!isValidApiKey(value.trim())) {
        return adminJson(res, 400, { error: `secret "${id}" 含非可打印 ASCII 字符，已拒绝` });
      }
      newSecrets[id] = value.trim();
    }
  }

  // 删除 routes 不再引用的 secretId（避免无用的 key 留在磁盘）
  const usedSecretIds = new Set(Object.values(routes).map(r => r.secretId));
  for (const id of Object.keys(newSecrets)) {
    if (!usedSecretIds.has(id)) delete newSecrets[id];
  }

  // 写文件
  try {
    writeSecretsAtomic(newSecrets);
    writeRoutesAtomic(routes, fallback || {});
  } catch (e) {
    return adminJson(res, 500, { error: `写文件失败: ${e.message}` });
  }

  // 热重载内存里的路由表
  try {
    reloadRouting();
  } catch (e) {
    return adminJson(res, 500, { error: `热重载失败: ${e.message}` });
  }

  adminJson(res, 200, { ok: true, routeCount: Object.keys(routes).length });
}

function buildModelsResponse() {
  if (MULTI_MODE) {
    const data = Object.entries(ROUTES).map(([alias, route]) => ({
      type: 'model',
      id: alias,
      display_name: route.displayName,
      created_at: SERVER_STARTED_AT,
    }));
    return {
      data,
      first_id: data[0]?.id || null,
      last_id: data[data.length - 1]?.id || null,
      has_more: false,
    };
  }

  // 单上游模式：以 MODEL_RULES 的 target 反推出来 id（不太好看，但单模式本来就靠 env 配置）
  const seen = new Set();
  const data = [];
  for (const rule of MODEL_RULES) {
    const id = rule.target;
    if (seen.has(id)) continue;
    seen.add(id);
    data.push({
      type: 'model',
      id,
      display_name: id,
      created_at: SERVER_STARTED_AT,
    });
  }
  return {
    data,
    first_id: data[0]?.id || null,
    last_id: data[data.length - 1]?.id || null,
    has_more: false,
  };
}

const server = http.createServer(async (req, res) => {
  if (req.method === 'GET' && req.url === '/health') {
    const body = MULTI_MODE
      ? {
          status: 'ok',
          port: PORT,
          mode: 'multi',
          routes: Object.fromEntries(
            Object.entries(ROUTES).map(([alias, r]) => [
              alias,
              { apiFormat: r.apiFormat, baseUrl: r.baseUrl, targetModel: r.targetModel },
            ]),
          ),
          fallback: Object.fromEntries(
            FALLBACK_ENTRIES.map(({ keyword, aliasName }) => [keyword, aliasName]),
          ),
          reasoningEffort: MODEL_REASONING_EFFORT,
          disableResponseStorage: DISABLE_RESPONSE_STORAGE,
        }
      : {
          status: 'ok',
          port: PORT,
          mode: 'single',
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
        };
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(body));
    return;
  }

  // /v1/models — 给 Claude Desktop 自动发现模型用，按 Anthropic 标准格式返回
  // 客户端通过 display_name 字段拿到 picker 显示名，跟 id 解耦
  if (req.method === 'GET' && (req.url === '/v1/models' || req.url.startsWith('/v1/models?'))) {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(buildModelsResponse()));
    return;
  }

  // /admin — 浏览器可视化配置界面
  if (req.method === 'GET' && req.url === '/admin') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(ADMIN_HTML.replace('__PORT__', String(PORT)));
    return;
  }
  if (req.method === 'GET' && req.url === '/admin/config') {
    handleAdminGetConfig(res);
    return;
  }
  if (req.method === 'POST' && req.url === '/admin/save') {
    try {
      const buf = await readBody(req);
      handleAdminSave(res, buf.toString('utf8'));
    } catch (e) {
      adminJson(res, 400, { error: e.message });
    }
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
      // 无法决定路由前必须先解析 body 拿到 model 名（多模式下硬性要求 JSON）
      // 单上游 anthropic 模式可能透传非 JSON（例如 ping、健康检查），保留原行为
      if (!MULTI_MODE && UPSTREAM_API_FORMAT === 'anthropic') {
        console.log(`[${formatLogTime()}]`);
        console.log(`  PATH           : ${req.url}`);
        console.log(`  JSON解析失败    : ${e.message}`);
        console.log(`  处理方式       : 原样透传`);
      } else {
        sendProxyError(res, 400, `JSON解析失败: ${e.message}`);
        return;
      }
    }
  }

  const requestedModel = bodyObj?.model || '';
  const route = resolveRoute(requestedModel);

  if (!route) {
    // multi 模式下找不到匹配的别名
    const validAliases = Object.keys(ROUTES || {});
    sendProxyError(
      res,
      400,
      `未知模型别名: "${requestedModel}". 可用别名: ${validAliases.join(', ')}`,
    );
    return;
  }

  if (route.apiFormat === 'responses') {
    if (!bodyObj) {
      sendProxyError(res, 400, 'responses mode requires a JSON request body');
      return;
    }
    forwardResponses(req, res, bodyObj, route);
    return;
  }

  if (route.apiFormat !== 'anthropic') {
    sendProxyError(res, 500, `unsupported apiFormat: ${route.apiFormat}`);
    return;
  }

  forwardAnthropic(req, res, rawBody, bodyObj, route);
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

  if (MULTI_MODE) {
    console.log('    Mode           → multi (routes.json)');
    console.log(`    Routes file    → ${ROUTES_PATH}`);
    console.log(`    Secrets file   → ${SECRETS_PATH}`);
    console.log('');
    console.log('    路由表:');
    for (const [alias, r] of Object.entries(ROUTES)) {
      console.log(`      ${alias.padEnd(28)} → [${r.apiFormat}] ${r.targetModel} @ ${r.baseUrl}`);
    }
  } else {
    console.log(`    Mode           → single (env)`);
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
  }
  console.log('');
});
