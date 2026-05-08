# Claude Desktop DeepSeek Proxy

<p align="center">
  <strong>English</strong> |
  <a href="./README.zh-CN.md">简体中文</a>
</p>

A local macOS proxy that lets Claude Desktop Gateway use DeepSeek models.

It forwards Claude Desktop requests to DeepSeek's Anthropic-compatible API, maps Claude-style model names to DeepSeek model names, and removes dynamic `cch=` values from system prompts to improve cache reuse.

## How It Works

```txt
Claude Desktop                  Local Proxy :3099                DeepSeek API
────────────────                ─────────────────                ────────────
POST /v1/messages   ────────►   replace model name   ────────►   /anthropic/v1/messages
model: claude-opus              clean dynamic cch                 model: deepseek-v4-pro
                    ◄────────   passthrough response  ◄────────   Anthropic-compatible response
```

This proxy does **not** convert Anthropic format to OpenAI format.

DeepSeek provides an Anthropic-compatible endpoint, so the proxy only:

- replaces the `model` field
- removes dynamic `cch=...` values
- forwards the request and response as-is
- logs model routing and cache usage

## Quick Start

### 1. Install

```bash
cd ~/Downloads/model-proxy
chmod +x setup.sh uninstall.sh
DEEPSEEK_API_KEY=sk-your-key bash setup.sh
```

Or run without an environment variable:

```bash
bash setup.sh
```

The script will ask for your DeepSeek API key.

### 2. Restart Claude Desktop

Fully quit Claude Desktop:

```txt
Claude menu → Quit Claude
```

Then reopen it.

### 3. Verify

```bash
curl http://127.0.0.1:3099/health
```

Expected output:

```json
{
  "status": "ok",
  "port": 3099,
  "upstream": "https://api.deepseek.com/anthropic"
}
```

Watch logs:

```bash
tail -f ~/.local/model-proxy/proxy.log
```

Send a message in Claude Desktop. You should see model routing logs.

## Files

```txt
model-proxy/
├── proxy.js
├── setup.sh
├── uninstall.sh
└── README.md
```

| File | Description |
|---|---|
| `proxy.js` | Local proxy server |
| `setup.sh` | macOS installer |
| `uninstall.sh` | Uninstaller |
| `README.md` | Documentation |

## Claude Desktop Configuration

The installer updates:

```txt
~/Library/Application Support/Claude/claude_desktop_config.json
```

It writes:

```json
{
  "gateway": {
    "url": "http://127.0.0.1:3099",
    "inferenceModels": [
      "claude-haiku-4-5",
      "claude-opus-4-7",
      "claude-sonnet-4-5"
    ]
  }
}
```

The Gateway base URL must be:

```txt
http://127.0.0.1:3099
```

Do **not** set it to:

```txt
https://api.deepseek.com/anthropic
```

If Claude Desktop connects directly to DeepSeek, the proxy is bypassed and model mapping will not work.

## Model Mapping

| Claude Desktop model contains | DeepSeek model |
|---|---|
| `haiku` | `deepseek-v4-flash` |
| `opus` | `deepseek-v4-pro` |
| `sonnet` | `deepseek-v4-pro` |
| other | `deepseek-v4-flash` |

Examples:

```txt
claude-haiku-4-5       → deepseek-v4-flash
claude-haiku-4-5-xxx   → deepseek-v4-flash
claude-opus-4-7        → deepseek-v4-pro
claude-sonnet-4-5      → deepseek-v4-pro
```

## Environment Variables

| Variable | Default | Description |
|---|---|---|
| `DEEPSEEK_API_KEY` | required | DeepSeek API key |
| `DEEPSEEK_BASE_URL` | `https://api.deepseek.com/anthropic` | DeepSeek Anthropic-compatible endpoint |
| `PROXY_PORT` | `3099` | Local proxy port |

Example:

```bash
PROXY_PORT=3100 DEEPSEEK_API_KEY=sk-your-key bash setup.sh
```

If you change the port, Claude Desktop Gateway URL must use the same port:

```txt
http://127.0.0.1:3100
```

## Cache Optimization

Claude Desktop may inject dynamic values into the system prompt:

```txt
x-anthropic-billing-header: ...; cch=a430b;
```

The `cch` value changes between sessions and can reduce DeepSeek cache hits.

The proxy removes it before forwarding:

```txt
x-anthropic-billing-header: ...;
```

Logs show both the original and forwarded system prefix:

```txt
原始system前缀 : ... cch=a430b;
转发system前缀 : ...
```

The forwarded system prefix should not contain `cch=`.

Cache statistics are logged as:

```txt
缓存统计 : hit=34688 miss=0 input=1641 output=651 命中率=100.0%
```

If `hit > 0`, DeepSeek cache was used.

## Common Commands

Health check:

```bash
curl http://127.0.0.1:3099/health
```

View logs:

```bash
tail -f ~/.local/model-proxy/proxy.log
```

View errors:

```bash
tail -f ~/.local/model-proxy/proxy.err
```

Restart service:

```bash
PLIST=~/Library/LaunchAgents/com.local.model-proxy.plist
launchctl unload "$PLIST" 2>/dev/null || true
launchctl load "$PLIST"
```

Check syntax:

```bash
node --check ~/.local/model-proxy/proxy.js
```

## macOS launchd Service

The installer creates:

```txt
~/Library/LaunchAgents/com.local.model-proxy.plist
```

The service:

- starts automatically after login
- restarts if the proxy crashes
- writes logs to `~/.local/model-proxy/proxy.log`
- writes errors to `~/.local/model-proxy/proxy.err`

## Update

If you edit the project copy of `proxy.js`, reinstall it with:

```bash
cp ~/Downloads/model-proxy/proxy.js ~/.local/model-proxy/proxy.js
PLIST=~/Library/LaunchAgents/com.local.model-proxy.plist
launchctl unload "$PLIST" 2>/dev/null || true
launchctl load "$PLIST"
```

## Uninstall

```bash
cd ~/Downloads/model-proxy
bash uninstall.sh
```

The uninstaller will:

- stop the launchd service
- remove the launch agent
- delete the installed proxy directory
- remove `gateway` from Claude Desktop config
- back up the old Claude Desktop config

Restart Claude Desktop after uninstalling.

## Troubleshooting

| Problem | Cause | Fix |
|---|---|---|
| No proxy logs | Claude Desktop is not using the proxy | Set Gateway URL to `http://127.0.0.1:3099` |
| Opus still uses flash | Model mapping is not active | Check `proxy.log` and confirm Opus maps to `deepseek-v4-pro` |
| `401 Unauthorized` | Missing or invalid API key | Reinstall with `DEEPSEEK_API_KEY=sk-your-key bash setup.sh` |
| Port already in use | `3099` is occupied | Use `PROXY_PORT=3100` |
| Edited `proxy.js` but no change | Edited the wrong file | Update `~/.local/model-proxy/proxy.js` and restart service |

## Security

Do not commit or share:

```txt
~/Library/LaunchAgents/com.local.model-proxy.plist
~/.local/model-proxy/proxy.log
~/.local/model-proxy/proxy.err
```

These files may contain local paths, request metadata, or your API key.

Never commit your DeepSeek API key.

## License

MIT