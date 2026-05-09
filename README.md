# Claude Desktop Local Model Gateway

<p align="center">
  <strong>English</strong> |
  <a href="./README.zh-CN.md">简体中文</a>
</p>

A local macOS gateway that lets Claude Desktop use DeepSeek, MiMo, OpenAI Responses API gateways, and other model providers.

Claude Desktop Gateway expects Claude-style model names such as `claude-haiku-4-5` and `claude-opus-4-7`. Many third-party model providers use their own model names. This project runs a small local proxy that translates those model names and forwards requests to your selected provider.

## What It Does

Claude Desktop only needs to talk to one local address:

`http://127.0.0.1:3099`

The local gateway then forwards requests to the provider you choose:

- DeepSeek
- MiMo
- OpenAI Responses API gateways, such as a GPT 5.5 gateway
- other Anthropic-compatible APIs

Basic flow:

`Claude Desktop -> Local Gateway -> Provider API`

The gateway also removes dynamic `cch=...` values injected into the system prompt. These values can make prompt prefixes unstable and reduce cache hits. Removing them helps upstream context caching work better.

## Features

- Works with Claude Desktop Gateway
- Supports DeepSeek by default
- Supports MiMo as a built-in provider
- Supports `custom-responses` for OpenAI Responses API gateways
- Converts Anthropic tools to Responses function calling and back
- Supports custom Anthropic-compatible providers
- Maps Claude model names to provider model names
- Runs locally on macOS
- Auto-starts with `launchd`
- Logs model routing and cache statistics
- Keeps Claude Desktop config simple

## Requirements

- macOS
- Claude Desktop
- Node.js
- API key from your provider

Check Node.js:

    node --version

If Node.js is missing, the installer will try to install it with Homebrew.

## Files

    model-proxy/
    ├── proxy.js
    ├── setup.sh
    ├── uninstall.sh
    ├── README.md
    └── README.zh-CN.md

| File | Description |
|---|---|
| `proxy.js` | Local gateway server |
| `setup.sh` | Installer |
| `uninstall.sh` | Uninstaller |
| `README.md` | English documentation |
| `README.zh-CN.md` | Chinese documentation |

## Quick Start

### Use DeepSeek

    cd ~/Downloads/model-proxy
    chmod +x setup.sh uninstall.sh
    PROVIDER=deepseek UPSTREAM_API_KEY=sk-your-key bash setup.sh

### Use MiMo

    cd ~/Downloads/model-proxy
    chmod +x setup.sh uninstall.sh
    PROVIDER=mimo UPSTREAM_API_KEY=tp-your-key bash setup.sh

### Use a GPT 5.5 Responses Gateway

    cd ~/Downloads/model-proxy
    chmod +x setup.sh uninstall.sh
    PROVIDER=custom-responses UPSTREAM_API_KEY=your-key bash setup.sh

After installation, fully quit and reopen Claude Desktop.

Use:

`Claude menu -> Quit Claude`

Do not just close the window.

## Claude Desktop Setup

Claude Desktop should always use the local gateway URL:

    http://127.0.0.1:3099

Do not put provider URLs directly into Claude Desktop, such as:

    https://api.deepseek.com/anthropic
    https://token-plan-cn.xiaomimimo.com/anthropic

Those URLs are used internally by the local gateway.

The installer updates this file automatically:

    ~/Library/Application Support/Claude/claude_desktop_config.json

The gateway config should look like this:

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

## Providers

The gateway includes provider presets.

| Provider | Upstream URL | Default mapping |
|---|---|---|
| `deepseek` | `https://api.deepseek.com/anthropic` | Haiku -> `deepseek-v4-flash`, Opus/Sonnet -> `deepseek-v4-pro` |
| `mimo` | `https://token-plan-cn.xiaomimimo.com/anthropic` | Haiku/Opus/Sonnet -> `mimo-v2.5-pro` |
| `custom-responses` | `https://www.msutools.cn/v1` | Haiku -> `gpt-5.4-mini`, Sonnet -> `gpt-5.4`, Opus -> `gpt-5.5` |

To switch providers, run `setup.sh` again with another provider.

DeepSeek:

    PROVIDER=deepseek UPSTREAM_API_KEY=sk-your-key bash setup.sh

MiMo:

    PROVIDER=mimo UPSTREAM_API_KEY=tp-your-key bash setup.sh

GPT 5.5 Responses gateway:

    PROVIDER=custom-responses UPSTREAM_API_KEY=your-key bash setup.sh

Claude Desktop still uses the same local URL:

    http://127.0.0.1:3099

## Model Mapping

### DeepSeek

| Claude Desktop model contains | Provider model |
|---|---|
| `haiku` | `deepseek-v4-flash` |
| `opus` | `deepseek-v4-pro` |
| `sonnet` | `deepseek-v4-pro` |
| other | `deepseek-v4-flash` |

### MiMo

| Claude Desktop model contains | Provider model |
|---|---|
| `haiku` | `mimo-v2.5-pro` |
| `opus` | `mimo-v2.5-pro` |
| `sonnet` | `mimo-v2.5-pro` |
| other | `mimo-v2.5-pro` |

### MiMo 1M Context

If your MiMo account supports 1M context models, you can use the `[1m]` suffix:

    PROVIDER=mimo \
    UPSTREAM_API_KEY=tp-your-key \
    MODEL_RULES_JSON='[
      {"match":"haiku","target":"mimo-v2.5-pro[1m]"},
      {"match":"opus","target":"mimo-v2.5-pro[1m]"},
      {"match":"sonnet","target":"mimo-v2.5-pro[1m]"}
    ]' \
    FALLBACK_MODEL='mimo-v2.5-pro[1m]' \
    bash setup.sh

### GPT 5.5 Responses Gateway

`custom-responses` uses the OpenAI Responses API wire format. It is not an Anthropic-compatible endpoint. The proxy converts Claude Desktop Anthropic Messages requests into Responses requests, then converts Responses output back into Anthropic Messages / SSE.

Default mapping:

| Claude Desktop model contains | Provider model |
|---|---|
| `haiku` | `gpt-5.4-mini` |
| `opus` | `gpt-5.5` |
| `sonnet` | `gpt-5.4` |
| other | `gpt-5.4-mini` |

Use the default tiered mapping:

    PROVIDER=custom-responses \
    UPSTREAM_API_KEY=your-key \
    bash setup.sh

If you want all Claude Desktop models to use `gpt-5.5`, override the mapping:

    PROVIDER=custom-responses \
    UPSTREAM_API_KEY=your-key \
    MODEL_RULES_JSON='[
      {"match":"haiku","target":"gpt-5.5"},
      {"match":"opus","target":"gpt-5.5"},
      {"match":"sonnet","target":"gpt-5.5"}
    ]' \
    FALLBACK_MODEL='gpt-5.5' \
    bash setup.sh

Tool support:

- Supports common Claude Desktop / MCP JSON Schema tools
- Converts Anthropic `tool_use` / `tool_result` to Responses `function_call` / `function_call_output`
- Supports streaming text and streaming tool argument deltas
- Does not map images, documents, extended thinking, or OpenAI built-in `web_search` / `file_search` / `computer_use` tools

## Custom Provider

You can use any Anthropic-compatible provider by setting these variables:

    PROVIDER=custom \
    UPSTREAM_BASE_URL=https://your-provider.example.com/anthropic \
    UPSTREAM_API_KEY=your-api-key \
    MODEL_RULES_JSON='[
      {"match":"haiku","target":"your-fast-model"},
      {"match":"opus","target":"your-strong-model"},
      {"match":"sonnet","target":"your-strong-model"}
    ]' \
    FALLBACK_MODEL=your-fast-model \
    bash setup.sh

## Environment Variables

| Variable | Default | Description |
|---|---|---|
| `PROVIDER` | `deepseek` | Provider preset. Supports `deepseek`, `mimo`, or `custom-responses` |
| `UPSTREAM_API_FORMAT` | provider preset | Upstream API format. Supports `anthropic` or `responses` |
| `UPSTREAM_API_KEY` | required | API key for the selected provider |
| `UPSTREAM_BASE_URL` | provider preset | Upstream API URL |
| `MODEL_RULES_JSON` | provider preset | Custom model mapping rules |
| `FALLBACK_MODEL` | provider preset | Model used when no rule matches |
| `MODEL_REASONING_EFFORT` | `high` | Reasoning effort for Responses providers |
| `DISABLE_RESPONSE_STORAGE` | `true` | Sets `store:false` for Responses providers |
| `PROXY_PORT` | `3099` | Local gateway port |

Backward compatibility:

| Variable | Status |
|---|---|
| `DEEPSEEK_API_KEY` | Still accepted as a fallback for `UPSTREAM_API_KEY` |
| `DEEPSEEK_BASE_URL` | Still accepted as a fallback for `UPSTREAM_BASE_URL` |

## Verify

Health check:

    curl http://127.0.0.1:3099/health

View logs:

    tail -f ~/.local/model-proxy/proxy.log

For DeepSeek, you should see logs like:

    收到模型名     : "claude-opus-4-7"
    转发模型名     : "deepseek-v4-pro"

For MiMo, you should see:

    收到模型名     : "claude-opus-4-7"
    转发模型名     : "mimo-v2.5-pro"

For the GPT 5.5 Responses gateway, you should see:

    API格式        : responses
    收到模型名     : "claude-opus-4-7"
    转发模型名     : "gpt-5.5"

## Common Commands

View logs:

    tail -f ~/.local/model-proxy/proxy.log

View errors:

    tail -f ~/.local/model-proxy/proxy.err

Restart service:

    PLIST=~/Library/LaunchAgents/com.local.model-proxy.plist
    launchctl unload "$PLIST" 2>/dev/null || true
    launchctl load "$PLIST"

Check script syntax:

    node --check ~/.local/model-proxy/proxy.js

## Uninstall

    cd ~/Downloads/model-proxy
    bash uninstall.sh

The uninstaller will:

- stop the local gateway service
- remove the launch agent
- delete the installed proxy files
- remove the `gateway` field from Claude Desktop config
- back up the old Claude Desktop config

Restart Claude Desktop after uninstalling.

## Troubleshooting

| Problem | Possible cause | Fix |
|---|---|---|
| No logs appear | Claude Desktop is not using the local gateway | Set Gateway URL to `http://127.0.0.1:3099` |
| Opus still uses flash | Model mapping is not active | Check `proxy.log` |
| `401 Unauthorized` | API key is missing or invalid | Reinstall with the correct `UPSTREAM_API_KEY` |
| MiMo says `Not supported model` | Wrong MiMo model ID | Use `mimo-v2.5-pro` or the exact model ID from MiMo docs |
| Health check shows the wrong provider | Old provider is still installed | Rerun `setup.sh` with the provider you want |
| Port already in use | Port `3099` is occupied | Use `PROXY_PORT=3100` |

## Security

Do not commit or share your API key.

Do not share these local files:

    ~/Library/LaunchAgents/com.local.model-proxy.plist
    ~/.local/model-proxy/proxy.log
    ~/.local/model-proxy/proxy.err

They may contain local paths, request metadata, or API keys.

## License

MIT
