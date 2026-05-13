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

> 需要 Node.js。macOS 可由安装脚本通过 Homebrew 自动安装；Windows 先安装 Node.js LTS MSI。

### 多供应商模式（推荐）

#### macOS

```bash
git clone https://github.com/Practical-creater/claude-desktop-local-model-gateway.git
cd claude-desktop-local-model-gateway
MULTI=1 bash setup.sh
```

脚本会装好代理 + 启动后台服务，并生成一份**空白**的路由表——
不在终端问任何 API key，也不预置任何供应商。剩下的配置全在浏览器里完成：

1. 浏览器打开 <http://127.0.0.1:3099/admin>
2. 在 **Routes** 卡片点 **+ Add Route**，为每个供应商加一条（参考下面的 [示例路由](#示例路由)）
3. 在 **API Keys** 区域粘贴对应的 API key
4. 点 **Save Changes**
5. 完全退出 Claude Desktop 再重新打开，picker 里就能看到新模型

重跑 `bash setup.sh` 是安全的：已有的 `routes.json` 和 `secrets.json` 会保留，
你在 `/admin` 里的修改不会被覆盖。

#### Windows

```powershell
git clone https://github.com/Practical-creater/claude-desktop-local-model-gateway.git
cd claude-desktop-local-model-gateway
powershell -ExecutionPolicy Bypass -File .\setup.ps1 -Multi
```

脚本会把代理安装到 `%LOCALAPPDATA%\model-proxy`，注册任务计划程序，并打开同一个浏览器后台页面 <http://127.0.0.1:3099/admin>。

1. 浏览器打开 <http://127.0.0.1:3099/admin>
2. 在 **Routes** 卡片点 **+ Add Route**，为每个供应商加一条
3. 在 **API Keys** 区域粘贴对应的 API key
4. 点 **Save Changes**
5. 完全退出 Claude Desktop 再重新打开，picker 里就能看到新模型

重跑 `setup.ps1` 是安全的：已有的 `routes.json` 和 `secrets.json` 会保留，
你在 `/admin` 里的修改不会被覆盖。

### 单供应商模式（legacy，更简单）

#### macOS

```bash
DEEPSEEK_API_KEY=sk-xxx bash setup.sh                          # DeepSeek
PROVIDER=mimo            UPSTREAM_API_KEY=sk-xxx bash setup.sh # MiMo
PROVIDER=custom-responses UPSTREAM_API_KEY=sk-xxx bash setup.sh # GPT (msutools.cn)
```

#### Windows

```powershell
powershell -ExecutionPolicy Bypass -File .\setup.ps1 -Provider deepseek -ApiKey sk-xxx
powershell -ExecutionPolicy Bypass -File .\setup.ps1 -Provider mimo -ApiKey sk-xxx
powershell -ExecutionPolicy Bypass -File .\setup.ps1 -Provider custom-responses -ApiKey sk-xxx
```

picker 里显示三个标准 Claude 名字（`claude-haiku-4-5` 等），统一转发到那个上游。

### 安装完成后（Claude Desktop 侧）

1. **完全退出** Claude Desktop 再重新打开。
2. 进 **Settings → Identity & Models**，把 *Model list* **清空**——
   清空后 Claude Desktop 才会调用代理的 `/v1/models` 自动发现接口。
3. API Key 字段填任意非空字符串即可，代理完全不读。

## 示例路由

在 `/admin` 的 **+ Add Route** 里填这些值。`Target Model` 是真实上游模型名，
`secretId` 只是一个标签，指向你在 **API Keys** 区域粘贴的 key。

| Display Name | Model ID | Format | Base URL | Secret ID | Target Model |
|---|---|---|---|---|---|
| DeepSeek V4 Pro | `claude-deepseek-v4-pro` | anthropic | `https://api.deepseek.com/anthropic` | `deepseek` | `deepseek-v4-pro` |
| MiMo V2.5 Pro | `claude-mimo-v2-5-pro` | anthropic | `https://token-plan-cn.xiaomimimo.com/anthropic` | `mimo` | `mimo-v2.5-pro` |
| GPT 5.5 | `claude-gpt-5-5` | responses | `https://www.msutools.cn/v1` | `msu` | `gpt-5.5` |

Model ID **必须含** `claude` / `sonnet` / `opus` / `haiku` / `anthropic`
任一关键字，否则过不了 Claude Desktop 的 gateway 校验。ID 里**用横杠不用小数点**
（小数点会被部分 Claude Desktop 版本吃掉）。

Claude Desktop 启动时硬编码探测的 `claude-haiku-4-5` 等标准名，在 `/admin`
的 *Fallback* 卡片里把对应关键字指向你的别名即可兜底。

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
| `~/.local/model-proxy/proxy.js` | 代理本体（macOS） | 755 |
| `~/.local/model-proxy/routes.json` | 别名 → 上游配置（macOS 多模式） | 644 |
| `~/.local/model-proxy/secrets.json` | `secretId → apiKey` 映射 | **600**（macOS/Linux 强制） |
| `~/Library/LaunchAgents/com.local.model-proxy.plist` | launchd 服务定义 | 644 |
| `~/Library/Application Support/Claude/claude_desktop_config.json` | Claude Desktop gateway URL（macOS） | 644 |
| `%LOCALAPPDATA%\model-proxy\proxy.js` | 代理本体（Windows） | 继承用户 ACL |
| `%LOCALAPPDATA%\model-proxy\routes.json` | 别名 → 上游配置（Windows 多模式） | 继承用户 ACL |
| `%LOCALAPPDATA%\model-proxy\secrets.json` | `secretId → apiKey` 映射 | 锁定为当前用户 ACL |
| `%APPDATA%\Claude\claude_desktop_config.json` | Claude Desktop gateway URL（Windows） | 用户配置文件 |

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

### macOS

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

### Windows

```powershell
# 健康检查 + 路由表
Invoke-WebRequest http://127.0.0.1:3099/health -UseBasicParsing | Select-Object -Expand Content

# Claude Desktop 看到的模型清单
Invoke-WebRequest http://127.0.0.1:3099/v1/models -UseBasicParsing | Select-Object -Expand Content

# 实时日志 / 错误
Get-Content -Wait $env:LOCALAPPDATA\model-proxy\proxy.log
Get-Content -Wait $env:LOCALAPPDATA\model-proxy\proxy.err

# 改完 routes/secrets 后重启
Stop-ScheduledTask -TaskName ClaudeModelProxy
Start-ScheduledTask -TaskName ClaudeModelProxy

# 完全卸载
powershell -ExecutionPolicy Bypass -File .\uninstall.ps1
```

## 排错速查

| 现象 | 原因 | 解决 |
|---|---|---|
| picker 是空的 | *Settings → Identity & Models* 里还有 Model list 覆盖了发现 | 把里面条目全部 ✕ 删掉，重启 Claude Desktop |
| `Server is busy. Retrying…` | `secrets.json` 里某个 key 含非 ASCII 或空白 | macOS 重跑 `MULTI=1 bash setup.sh`；Windows 重跑 `powershell -ExecutionPolicy Bypass -File .\setup.ps1 -Multi`，或手编 `secrets.json` |
| `400 未知模型别名` | 请求的 model 既不在路由表也匹配不上 `_fallback` | 看 `curl .../v1/models` 列表，加条路由或扩 `_fallback` |
| `403 daily usage limit exceeded` | 上游配额，**不是代理问题** | 切换 provider 或等额度刷新 |
| GPT 条目在 picker 里坍缩 | Claude Desktop 内置美化器对 `^claude-gpt-数字-数字` 强行美化，无视 `display_name` | 换个不匹配该正则的别名（如 `claude-gpt-mini`） |
| Windows 启动后健康检查超时 | 旧版 `run-proxy.ps1` redirect 损坏，或 `secrets.json` 被误判为权限不安全 | 重新运行 `setup.ps1`，再检查 `proxy.err` 和 `Get-Content -Wait $env:LOCALAPPDATA\model-proxy\proxy.err` |

## License

MIT — 见 [LICENSE](./LICENSE)。
