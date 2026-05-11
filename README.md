# Claude Desktop Local Model Gateway

<p align="center">
  <strong>English</strong> |
  <a href="./README.zh-CN.md">简体中文</a>
</p>

A local macOS proxy that lets Claude Desktop talk to **multiple** model providers
(DeepSeek, MiMo, OpenAI Responses gateways like GPT‑5.x via msutools.cn, etc.)
at the same time, with custom display names in the model picker.

```
Claude Desktop ──► 127.0.0.1:3099 ──► DeepSeek / MiMo / GPT gateway / ...
```

## Quick Start

> macOS only. Requires Node.js (the installer will offer to install it via Homebrew).

### Multi‑provider mode (recommended)

```bash
git clone https://github.com/Practical-creater/claude-desktop-local-model-gateway.git
cd claude-desktop-local-model-gateway
MULTI=1 bash setup.sh
```

That installs the proxy with an **empty** route table — no terminal prompts,
no hardcoded providers. Configure everything from the browser:

1. Open <http://127.0.0.1:3099/admin>
2. Click **+ Add Route** for each provider (see [Example routes](#example-routes))
3. Paste API keys in the **API Keys** section
4. Click **Save Changes**
5. Fully quit Claude Desktop (`⌘Q`) and reopen — the new models appear in the picker

Re‑running `bash setup.sh` is safe: existing `routes.json` and `secrets.json`
are preserved so your `/admin` edits survive reinstall.

### Single‑provider mode (legacy, simpler)

```bash
DEEPSEEK_API_KEY=sk-xxx bash setup.sh                          # DeepSeek
PROVIDER=mimo            UPSTREAM_API_KEY=sk-xxx bash setup.sh # MiMo
PROVIDER=custom-responses UPSTREAM_API_KEY=sk-xxx bash setup.sh # GPT via msutools.cn
```

The picker shows the three standard Claude names (`claude-haiku-4-5`, etc.) and
they all forward to the configured upstream.

### After install — Claude Desktop side

1. **Fully quit** Claude Desktop (`⌘Q`), then reopen.
2. In **Settings → Identity & Models**, make sure the *Model list* is **empty** —
   that triggers `/v1/models` discovery from the gateway.
3. The API Key field accepts any non‑empty string; the gateway ignores it.

## Example routes

Paste these in **+ Add Route** in `/admin`. Real upstream model names go in
*Target Model*; `secretId` is just a label pointing to a key you'll paste in
the **API Keys** section.

| Display Name | Model ID | Format | Base URL | Secret ID | Target Model |
|---|---|---|---|---|---|
| DeepSeek V4 Pro | `claude-deepseek-v4-pro` | anthropic | `https://api.deepseek.com/anthropic` | `deepseek` | `deepseek-v4-pro` |
| MiMo V2.5 Pro | `claude-mimo-v2-5-pro` | anthropic | `https://token-plan-cn.xiaomimimo.com/anthropic` | `mimo` | `mimo-v2.5-pro` |
| GPT 5.5 | `claude-gpt-5-5` | responses | `https://www.msutools.cn/v1` | `msu` | `gpt-5.5` |

Model IDs **must contain** `claude` / `sonnet` / `opus` / `haiku` / `anthropic`
to pass Claude Desktop's gateway validation. Use dashes, not dots, in the ID
(dots get stripped by some Claude Desktop UI versions).

For Claude Desktop's built‑in probes (`claude-haiku-4-5` etc.), set the *Fallback*
keywords in `/admin` to one of your aliases.

## Features

- **Multi‑provider routing** — one alias → one upstream, picked per request.
- **Custom display names** — picker shows `DeepSeek V4 Pro`, not `claude-deepseek-v4-pro`.
- **Image input** — Claude Desktop image uploads forwarded to vision‑capable upstreams.
- **Secrets on disk, not in plist** — keys live in `secrets.json` (chmod 600).
- **Comments in config** — `routes.json` accepts `//` and `/* */`.
- **Hardened against bad input** — non‑ASCII / control chars in keys are refused at load.
- **Backwards compatible** — drop `routes.json` and the proxy falls back to single‑mode.

## How it works

Claude Desktop's gateway mode requires model IDs that contain
`claude`/`sonnet`/`opus`/`haiku`/`anthropic` (validation added in 1.6259.1).
We work around it by:

1. Using IDs like `claude-deepseek-v4-pro` to satisfy validation.
2. Serving `GET /v1/models` with a separate `display_name` field so the picker
   can show clean names (`DeepSeek V4 Pro`).
3. Rewriting the model name to the real upstream name (`deepseek-v4-pro`)
   before forwarding.

The proxy also injects the real API key from `secrets.json` per route, so the
"API Key" field in Claude Desktop's UI is never used.

## Configuration files

| Path | Purpose | Permissions |
|---|---|---|
| `~/.local/model-proxy/proxy.js` | The proxy itself | 755 |
| `~/.local/model-proxy/routes.json` | Aliases → upstream config (multi mode) | 644 |
| `~/.local/model-proxy/secrets.json` | `secretId → apiKey` map | **600** (enforced) |
| `~/Library/LaunchAgents/com.local.model-proxy.plist` | launchd unit | 644 |
| `~/Library/Application Support/Claude/claude_desktop_config.json` | Claude Desktop gateway URL | 644 |

`routes.json` example:

```jsonc
{
  "claude-deepseek-v4-pro": {
    "displayName": "DeepSeek V4 Pro",
    "apiFormat":   "anthropic",
    "baseUrl":     "https://api.deepseek.com/anthropic",
    "secretId":    "deepseek",
    "targetModel": "deepseek-v4-pro"
  },
  // Fallback for Claude Desktop's hardcoded probe of standard names
  "_fallback": { "haiku": "claude-gpt-5-4", "sonnet": "claude-gpt-5-4", "opus": "claude-gpt-5-5" }
}
```

## Common operations

```bash
# Show health + routes
curl http://127.0.0.1:3099/health | python3 -m json.tool

# Show what Claude Desktop sees
curl http://127.0.0.1:3099/v1/models | python3 -m json.tool

# Tail traffic / errors
tail -f ~/.local/model-proxy/proxy.log
tail -f ~/.local/model-proxy/proxy.err

# Edit routes/secrets, then restart
launchctl unload ~/Library/LaunchAgents/com.local.model-proxy.plist
launchctl load   ~/Library/LaunchAgents/com.local.model-proxy.plist

# Uninstall everything
bash uninstall.sh
```

## Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| Picker is empty | A Model list is still set in *Settings → Identity & Models* | Remove every entry there; restart Claude Desktop |
| `Server is busy. Retrying…` | A key in `secrets.json` contains non‑ASCII or whitespace | Re‑run `MULTI=1 bash setup.sh`, or edit `secrets.json` by hand |
| `400 未知模型别名` | Requested model not in routes; no `_fallback` keyword matches | Check `curl .../v1/models`; add a route or extend `_fallback` |
| `403 daily usage limit exceeded` | Upstream quota — not a proxy issue | Switch provider or wait |
| GPT entries collapse in picker | Claude Desktop's internal pretty‑printer ignores `display_name` for IDs matching `^claude-gpt-N-N` | Rename the alias to escape the pattern (e.g. `claude-gpt-mini`) |

## License

MIT — see [LICENSE](./LICENSE).
