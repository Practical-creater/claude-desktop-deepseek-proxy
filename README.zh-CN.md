# Claude Desktop 本地模型网关

<p align="center">
  <a href="./README.md">English</a> |
  <strong>简体中文</strong>
</p>

macOS 本地代理，让 Claude Desktop **同时**连多个模型供应商
（DeepSeek、MiMo、走 msutools.cn 中转的 OpenAI Responses 接口 GPT‑5.x 等），
并在模型选择器里显示自定义的干净名字。

```
Claude Desktop ──► 127.0.0.1:3099 ──► DeepSeek / MiMo / GPT 中转 / ...
```

## 快速开始

> 仅支持 macOS。需要 Node.js（脚本会用 Homebrew 自动装）。

### 多供应商模式（推荐）

```bash
git clone https://github.com/Practical-creater/claude-desktop-local-model-gateway.git
cd claude-desktop-local-model-gateway
MULTI=1 bash setup.sh
```

会依次提示输入三个 API key（输入隐藏）。只用其中一两家也没关系，
其它家填占位字符串即可——选到没真 key 的模型时上游会返回 401。

非交互式：

```bash
MULTI=1 \
DEEPSEEK_API_KEY=sk-xxx \
MIMO_API_KEY=sk-xxx \
MSU_API_KEY=sk-xxx \
bash setup.sh
```

### 单供应商模式（更简单）

```bash
DEEPSEEK_API_KEY=sk-xxx bash setup.sh                          # DeepSeek
PROVIDER=mimo            UPSTREAM_API_KEY=sk-xxx bash setup.sh # MiMo
PROVIDER=custom-responses UPSTREAM_API_KEY=sk-xxx bash setup.sh # GPT (msutools.cn)
```

### 安装完成后

1. **完全退出** Claude Desktop（`⌘Q`）再重新打开。
2. 进 **Settings → Identity & Models**，把 *Model list* **清空**——
   清空后 Claude Desktop 才会调用代理的 `/v1/models` 自动发现接口。
3. API Key 字段填任意非空字符串即可，代理完全不读。
4. 打开模型选择器，应能看到你的全部供应商。

## 功能特点

- **多供应商路由**——按别名分发到不同上游。
- **自定义显示名**——picker 显示 `DeepSeek V4 Pro`，不是 `claude-deepseek-v4-pro`。
- **图片输入**——Claude Desktop 上传的图片透传给支持视觉的上游。
- **密钥存盘不放 plist**——key 在 `secrets.json` 里，权限 `600`。
- **配置支持注释**——`routes.json` 接受 `//` 与 `/* */`。
- **坏 key 不再拖垮代理**——加载时校验非 ASCII / 控制字符直接剔除。
- **向后兼容**——删掉 `routes.json` 自动回退单上游模式。

## 工作原理

Claude Desktop gateway 模式要求模型 ID 含
`claude`/`sonnet`/`opus`/`haiku`/`anthropic`（1.6259.1 起新加的客户端校验）。
我们用三个手段绕过：

1. 别名 id 加 `claude-` 前缀（如 `claude-deepseek-v4-pro`）通过校验。
2. `GET /v1/models` 返回独立的 `display_name` 字段，让 picker 显示干净名
   （`DeepSeek V4 Pro`）。
3. 转发前把 model 名重写成上游真名（`deepseek-v4-pro`）。

代理还会按路由从 `secrets.json` 注入真 API key——所以 Claude Desktop UI 里
"API Key" 字段的值代理一概忽略。

## 配置文件

| 路径 | 用途 | 权限 |
|---|---|---|
| `~/.local/model-proxy/proxy.js` | 代理本体 | 755 |
| `~/.local/model-proxy/routes.json` | 别名 → 上游配置（多模式） | 644 |
| `~/.local/model-proxy/secrets.json` | `secretId → apiKey` 映射 | **600** （强制） |
| `~/Library/LaunchAgents/com.local.model-proxy.plist` | launchd 服务定义 | 644 |
| `~/Library/Application Support/Claude/claude_desktop_config.json` | Claude Desktop gateway URL | 644 |

`routes.json` 示例：

```jsonc
{
  "claude-deepseek-v4-pro": {
    "displayName": "DeepSeek V4 Pro",
    "apiFormat":   "anthropic",
    "baseUrl":     "https://api.deepseek.com/anthropic",
    "secretId":    "deepseek",
    "targetModel": "deepseek-v4-pro"
  },
  // 兜底处理 Claude Desktop 硬编码探测标准 Claude 名字
  "_fallback": { "haiku": "claude-gpt-5-4", "sonnet": "claude-gpt-5-4", "opus": "claude-gpt-5-5" }
}
```

## 常用操作

```bash
# 健康检查 + 路由表
curl http://127.0.0.1:3099/health | python3 -m json.tool

# Claude Desktop 看到的模型清单
curl http://127.0.0.1:3099/v1/models | python3 -m json.tool

# 实时日志 / 错误
tail -f ~/.local/model-proxy/proxy.log
tail -f ~/.local/model-proxy/proxy.err

# 改完 routes/secrets 后重启
launchctl unload ~/Library/LaunchAgents/com.local.model-proxy.plist
launchctl load   ~/Library/LaunchAgents/com.local.model-proxy.plist

# 完全卸载
bash uninstall.sh
```

## 排错速查

| 现象 | 原因 | 解决 |
|---|---|---|
| picker 是空的 | *Settings → Identity & Models* 里还有 Model list 覆盖了发现 | 把里面条目全部 ✕ 删掉，重启 Claude Desktop |
| `Server is busy. Retrying…` | `secrets.json` 里某个 key 含非 ASCII 或空白 | 重跑 `MULTI=1 bash setup.sh`，或手编 `secrets.json` |
| `400 未知模型别名` | 请求的 model 既不在路由表也匹配不上 `_fallback` | 看 `curl .../v1/models` 列表，加条路由或扩 `_fallback` |
| `403 daily usage limit exceeded` | 上游配额，**不是代理问题** | 切换 provider 或等额度刷新 |
| GPT 条目在 picker 里坍缩 | Claude Desktop 内置美化器对 `^claude-gpt-数字-数字` 强行美化，无视 `display_name` | 换个不匹配该正则的别名（如 `claude-gpt-mini`） |

## License

MIT — 见 [LICENSE](./LICENSE)。
