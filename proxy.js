#!/usr/bin/env node
/**
 * Claude Desktop ↔ DeepSeek Anthropic API 本地代理 v3.1
 *
 * 作用：
 * 1. Claude Desktop 连接本地代理：http://127.0.0.1:3099
 * 2. 本代理转发到 DeepSeek Anthropic 兼容端点：https://api.deepseek.com/anthropic
 * 3. 只修改请求里的 model 字段，其余请求体尽量保持原样透传
 * 4. 清理 Claude Desktop system prompt 里的动态 cch=xxx 字段，减少缓存被 bust 的概率
 * 5. 打印 DeepSeek 返回的 prompt cache 命中统计
 *
 * 模型映射：
 *   claude-haiku-*  → deepseek-v4-flash
 *   claude-opus-*   → deepseek-v4-pro
 *   claude-sonnet-* → deepseek-v4-pro
 */

'use strict';

const http  = require('http');
const https = require('https');

// ─────────────────────────────────────────────────────────────────────────────
// 基础配置
// ─────────────────────────────────────────────────────────────────────────────

const PORT = parseInt(process.env.PROXY_PORT || '3099', 10);

// 注意：这里必须是 DeepSeek 的 Anthropic 兼容端点。
// Claude Desktop 的 Gateway base URL 则应该填本地代理：http://127.0.0.1:3099
const DEEPSEEK_BASE = (
  process.env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com/anthropic'
).replace(/\/$/, '');

const DEEPSEEK_API_KEY = process.env.DEEPSEEK_API_KEY || '';

// 模糊匹配：只要 Claude Desktop 发来的模型名里包含关键词，就映射到对应 DeepSeek 模型。
const MODEL_RULES = [
  { match: /haiku/i,  target: 'deepseek-v4-flash' },
  { match: /opus/i,   target: 'deepseek-v4-pro'   },
  { match: /sonnet/i, target: 'deepseek-v4-pro'   },
];

// 兜底模型：如果 Claude Desktop 将来发来未知模型名，默认走 flash，避免直接失败。
// 注意：如果你希望未知模型一律走 pro，可以把这里改成 'deepseek-v4-pro'。
const FALLBACK_MODEL = 'deepseek-v4-flash';

function resolveModel(name = '') {
  for (const rule of MODEL_RULES) {
    if (rule.match.test(name)) return rule.target;
  }
  return FALLBACK_MODEL;
}

// ─────────────────────────────────────────────────────────────────────────────
// 工具函数
// ─────────────────────────────────────────────────────────────────────────────

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];

    req.on('data', chunk => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

/**
 * 清理 Claude Desktop / Claude Agent SDK 注入的动态 cch=xxxxx 字段。
 *
 * 原始示例：
 *   x-anthropic-billing-header: cc_version=...; cc_entrypoint=local-agent; cch=a430b;
 *
 * 清理后：
 *   x-anthropic-billing-header: cc_version=...; cc_entrypoint=local-agent;
 *
 * 目的：
 *   DeepSeek 的缓存依赖“前缀完全一致”。如果 system prompt 最前面每次都有不同 cch，
 *   那么后面的长 system prompt 就很难复用缓存。
 */
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

/**
 * 从 DeepSeek usage 里读取缓存统计。
 *
 * DeepSeek 常见字段：
 *   prompt_cache_hit_tokens
 *   prompt_cache_miss_tokens
 *
 * 同时兼容 Anthropic 风格字段：
 *   cache_read_input_tokens
 *   cache_creation_input_tokens
 */
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
    return JSON.stringify(value).slice(0, maxLen);
  } catch {
    return '[unserializable]';
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// HTTP 服务器
// ─────────────────────────────────────────────────────────────────────────────

const server = http.createServer(async (req, res) => {
  // 健康检查：用于 curl http://127.0.0.1:3099/health
  if (req.method === 'GET' && req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      status: 'ok',
      port: PORT,
      upstream: DEEPSEEK_BASE,
      modelRules: MODEL_RULES.map(r => ({
        match: String(r.match),
        target: r.target,
      })),
      fallback: FALLBACK_MODEL,
    }));
    return;
  }

  const rawBody = await readBody(req);

  let bodyObj = null;
  let sendBody = rawBody;
  let originalModel = '';
  let targetModel = '';

  // 只有 POST 且有 body 时，才尝试解析 JSON 并替换 model。
  // 如果将来 Claude Desktop 传文件或其他非 JSON 内容，这里会自动原样透传。
  if (req.method === 'POST' && rawBody.length > 0) {
    try {
      bodyObj = JSON.parse(rawBody.toString('utf8'));

      originalModel = bodyObj.model || '';
      targetModel = resolveModel(originalModel);

      console.log(`[${new Date().toISOString()}]`);
      console.log(`  PATH           : ${req.url}`);
      console.log(`  收到模型名     : "${originalModel}"`);

      // 打印清理前 system，便于确认 Claude Desktop 注入了什么动态内容。
      console.log(`  原始system前缀 : ${safeJsonPrefix(bodyObj.system, 500)}`);

      // 清理动态字段，减少缓存 bust。
      bodyObj.system = normalizeSystemForCache(bodyObj.system);

      // 替换模型名。
      bodyObj.model = targetModel;

      // 打印清理后真正会转发给 DeepSeek 的 system。
      console.log(`  转发模型名     : "${targetModel}"`);
      console.log(`  转发system前缀 : ${safeJsonPrefix(bodyObj.system, 500)}`);

      sendBody = Buffer.from(JSON.stringify(bodyObj), 'utf8');
    } catch (e) {
      console.log(`[${new Date().toISOString()}]`);
      console.log(`  PATH           : ${req.url}`);
      console.log(`  JSON解析失败    : ${e.message}`);
      console.log(`  处理方式       : 原样透传`);
      sendBody = rawBody;
    }
  }

  // 构造 DeepSeek 上游 URL。
  // 例如：
  //   DEEPSEEK_BASE = https://api.deepseek.com/anthropic
  //   req.url       = /v1/messages?beta=true
  //   upstream      = https://api.deepseek.com/anthropic/v1/messages?beta=true
  const upstreamUrl = new URL(`${DEEPSEEK_BASE}${req.url}`);
  const isHttps = upstreamUrl.protocol === 'https:';
  const transport = isHttps ? https : http;

  const upstreamHeaders = {
    ...req.headers,

    // Host 必须改成上游 host，不能继续用 127.0.0.1:3099。
    host: upstreamUrl.host,

    // DeepSeek Anthropic API 支持 Bearer 形式。
    authorization: `Bearer ${DEEPSEEK_API_KEY}`,

    // 因为我们改了 body，所以必须重新计算 Content-Length。
    'content-length': String(sendBody.length),
  };

  // hop-by-hop headers 只在当前连接有效，代理转发时应移除。
  for (const h of ['connection', 'keep-alive', 'transfer-encoding', 'upgrade']) {
    delete upstreamHeaders[h];
  }

  // 是否流式请求，以请求体里的 stream 为准。
  const isStream = bodyObj?.stream === true;

  const proxyReq = transport.request({
    hostname: upstreamUrl.hostname,
    port: upstreamUrl.port || (isHttps ? 443 : 80),
    path: upstreamUrl.pathname + upstreamUrl.search,
    method: req.method,
    headers: upstreamHeaders,
  }, proxyRes => {
    const resHeaders = { ...proxyRes.headers };

    // 避免 Node 在我们手动转发时和上游 transfer-encoding 冲突。
    delete resHeaders['transfer-encoding'];

    if (proxyRes.statusCode >= 400) {
      let errData = '';

      proxyRes.on('data', chunk => {
        errData += chunk.toString('utf8');
      });

      proxyRes.on('end', () => {
        console.error(`  上游HTTP错误  : ${proxyRes.statusCode}`);
        console.error(`  上游错误内容  : ${errData.slice(0, 1000)}`);

        res.writeHead(proxyRes.statusCode, resHeaders);
        res.end(errData);
      });

      return;
    }

    if (isStream) {
      // 流式：边收到边转发，避免影响 Claude Desktop 响应速度。
      // 同时旁路解析 SSE data 行，尽量提取 message_delta 里的 usage。
      res.writeHead(proxyRes.statusCode, resHeaders);

      let buf = '';

      proxyRes.on('data', chunk => {
        const text = chunk.toString('utf8');

        // 先原样转发给 Claude Desktop。
        res.write(chunk);

        // 再旁路解析 SSE。
        buf += text;
        const lines = buf.split('\n');
        buf = lines.pop();

        for (const line of lines) {
          if (!line.startsWith('data: ')) continue;

          const payload = line.slice(6).trim();
          if (!payload || payload === '[DONE]') continue;

          try {
            const evt = JSON.parse(payload);

            // DeepSeek Anthropic 兼容端点通常会在 message_delta 或末尾事件中带 usage。
            if (evt.usage) {
              logCacheUsage(evt.usage);
            } else if (evt.type === 'message_delta' && evt.usage) {
              logCacheUsage(evt.usage);
            }
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
      // 非流式：收集完整响应后，打印 usage，再原样发给 Claude Desktop。
      let data = '';

      proxyRes.on('data', chunk => {
        data += chunk.toString('utf8');
      });

      proxyRes.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          if (parsed.usage) logCacheUsage(parsed.usage);
          else console.log('  缓存统计     : 响应中未找到 usage 字段');
        } catch {
          console.log('  缓存统计     : 响应不是 JSON，无法解析 usage');
        }

        res.writeHead(proxyRes.statusCode, resHeaders);
        res.end(data);
      });
    }
  });

  proxyReq.on('error', e => {
    console.error('[proxy] 上游请求错误:', e.message);

    if (!res.headersSent) {
      res.writeHead(502, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end(e.message);
    }
  });

  proxyReq.write(sendBody);
  proxyReq.end();
});

// ─────────────────────────────────────────────────────────────────────────────
// 启动
// ─────────────────────────────────────────────────────────────────────────────

server.on('error', e => {
  if (e.code === 'EADDRINUSE') {
    console.error(`❌  端口 ${PORT} 已占用，请用 PROXY_PORT=XXXX 指定其他端口`);
  } else {
    console.error('Server error:', e);
  }

  process.exit(1);
});

server.listen(PORT, '127.0.0.1', () => {
  console.log('\n🔀  Claude Desktop ↔ DeepSeek 转译代理 v3.1');
  console.log(`    Claude Desktop → http://127.0.0.1:${PORT}`);
  console.log(`    上游目标       → ${DEEPSEEK_BASE}`);
  console.log('');

  if (!DEEPSEEK_API_KEY) {
    console.log('⚠️   警告：DEEPSEEK_API_KEY 为空，请检查 launchd plist 里的 EnvironmentVariables。');
    console.log('');
  }

  console.log('    模型映射规则:');
  for (const r of MODEL_RULES) {
    console.log(`      含 ${String(r.match).padEnd(12)}  →  ${r.target}`);
  }
  console.log(`      其他             →  ${FALLBACK_MODEL}`);
  console.log('');
});