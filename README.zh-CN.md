# Claude Desktop 本地模型网关

<p align="center">
  <a href="./README.md">English</a> |
  <strong>简体中文</strong>
</p>

这是一个运行在 macOS 本地的小工具，用来让 Claude Desktop Gateway 调用 DeepSeek、MiMo、OpenAI Responses API 风格中转站以及其他模型服务。

Claude Desktop Gateway 通常要求使用 Claude 风格的模型名，比如 `claude-haiku-4-5`、`claude-opus-4-7`。但很多第三方模型服务使用自己的模型名。这个项目会在本地运行一个代理，自动把 Claude 模型名转换成对应服务商的模型名。

## 它能做什么

Claude Desktop 只需要连接一个本地地址：

`http://127.0.0.1:3099`

然后本地网关会把请求转发到你选择的服务商：

- DeepSeek
- MiMo
- OpenAI Responses API 风格中转站，例如 GPT 5.5 中转站
- 其他 Anthropic-compatible API

基本流程：

`Claude Desktop -> 本地网关 -> 模型服务商 API`

此外，网关还会清理 system prompt 里的动态 `cch=...` 字段。这个字段可能会导致上游缓存命中率降低，清理后有助于提高缓存复用率。

## 功能特点

- 支持 Claude Desktop Gateway
- 默认支持 DeepSeek
- 内置支持 MiMo
- 内置支持 OpenAI Responses API 风格的 `custom-responses`
- 支持 Anthropic tools 与 Responses function calling 双向转换
- 支持自定义 Anthropic-compatible 服务商
- 自动把 Claude 模型名映射到上游模型名
- 本地运行，不暴露公网端口
- 使用 macOS `launchd` 自动启动
- 打印模型路由和缓存统计日志
- Claude Desktop 配置简单

## 使用要求

- macOS
- Claude Desktop
- Node.js
- 对应服务商的 API Key

检查 Node.js：

    node --version

如果没有安装 Node.js，安装脚本会尝试通过 Homebrew 安装。

## 文件说明

    model-proxy/
    ├── proxy.js
    ├── setup.sh
    ├── uninstall.sh
    ├── README.md
    └── README.zh-CN.md

| 文件 | 说明 |
|---|---|
| `proxy.js` | 本地网关核心代码 |
| `setup.sh` | 安装脚本 |
| `uninstall.sh` | 卸载脚本 |
| `README.md` | 英文文档 |
| `README.zh-CN.md` | 中文文档 |

## 快速开始

### 使用 DeepSeek

    cd ~/Downloads/model-proxy
    chmod +x setup.sh uninstall.sh
    PROVIDER=deepseek UPSTREAM_API_KEY=sk-your-key bash setup.sh

### 使用 MiMo

    cd ~/Downloads/model-proxy
    chmod +x setup.sh uninstall.sh
    PROVIDER=mimo UPSTREAM_API_KEY=tp-your-key bash setup.sh

### 使用 GPT 5.5 Responses 中转站

    cd ~/Downloads/model-proxy
    chmod +x setup.sh uninstall.sh
    PROVIDER=custom-responses UPSTREAM_API_KEY=your-key bash setup.sh

安装完成后，需要完全退出并重新打开 Claude Desktop。

请使用：

`菜单栏 Claude -> Quit Claude`

不要只是关闭窗口。

## Claude Desktop 应该怎么配置

Claude Desktop 永远只需要连接本地网关：

    http://127.0.0.1:3099

不要把服务商地址直接填进 Claude Desktop，例如：

    https://api.deepseek.com/anthropic
    https://token-plan-cn.xiaomimimo.com/anthropic

这些地址是本地网关内部使用的，不应该直接填到 Claude Desktop 里。

安装脚本会自动更新这个配置文件：

    ~/Library/Application Support/Claude/claude_desktop_config.json

配置内容大致如下：

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

本地网关内置 provider 预设。

| Provider | 上游地址 | 默认模型映射 |
|---|---|---|
| `deepseek` | `https://api.deepseek.com/anthropic` | Haiku -> `deepseek-v4-flash`，Opus/Sonnet -> `deepseek-v4-pro` |
| `mimo` | `https://token-plan-cn.xiaomimimo.com/anthropic` | Haiku/Opus/Sonnet -> `mimo-v2.5-pro` |
| `custom-responses` | `https://www.msutools.cn/v1` | Haiku/Opus/Sonnet -> `gpt-5.5` |

切换 provider 只需要重新运行安装脚本。

DeepSeek：

    PROVIDER=deepseek UPSTREAM_API_KEY=sk-your-key bash setup.sh

MiMo：

    PROVIDER=mimo UPSTREAM_API_KEY=tp-your-key bash setup.sh

GPT 5.5 Responses 中转站：

    PROVIDER=custom-responses UPSTREAM_API_KEY=your-key bash setup.sh

Claude Desktop 仍然只需要使用同一个本地地址：

    http://127.0.0.1:3099

## 模型映射

### DeepSeek

| Claude Desktop 模型名包含 | 上游模型 |
|---|---|
| `haiku` | `deepseek-v4-flash` |
| `opus` | `deepseek-v4-pro` |
| `sonnet` | `deepseek-v4-pro` |
| 其他 | `deepseek-v4-flash` |

### MiMo

| Claude Desktop 模型名包含 | 上游模型 |
|---|---|
| `haiku` | `mimo-v2.5-pro` |
| `opus` | `mimo-v2.5-pro` |
| `sonnet` | `mimo-v2.5-pro` |
| 其他 | `mimo-v2.5-pro` |

### MiMo 1M 上下文

如果你的 MiMo 账号支持 1M 上下文模型，可以在模型名后添加 `[1m]`：

    PROVIDER=mimo \
    UPSTREAM_API_KEY=tp-your-key \
    MODEL_RULES_JSON='[
      {"match":"haiku","target":"mimo-v2.5-pro[1m]"},
      {"match":"opus","target":"mimo-v2.5-pro[1m]"},
      {"match":"sonnet","target":"mimo-v2.5-pro[1m]"}
    ]' \
    FALLBACK_MODEL='mimo-v2.5-pro[1m]' \
    bash setup.sh

### GPT 5.5 Responses 中转站

`custom-responses` 使用 OpenAI Responses API 风格，不是 Anthropic-compatible API。代理会把 Claude Desktop 的 Anthropic Messages 请求转换成 Responses 请求，再把 Responses 返回转换回 Claude Desktop 能识别的 Anthropic Messages / SSE。

默认映射：

| Claude Desktop 模型名包含 | 上游模型 |
|---|---|
| `haiku` | `gpt-5.5` |
| `opus` | `gpt-5.5` |
| `sonnet` | `gpt-5.5` |
| 其他 | `gpt-5.5` |

使用默认 GPT 5.5：

    PROVIDER=custom-responses \
    UPSTREAM_API_KEY=your-key \
    bash setup.sh

如果你的中转站当前默认或可用模型是 `gpt-5.4`，可以这样切换：

    PROVIDER=custom-responses \
    UPSTREAM_API_KEY=your-key \
    MODEL_RULES_JSON='[
      {"match":"haiku","target":"gpt-5.4"},
      {"match":"opus","target":"gpt-5.4"},
      {"match":"sonnet","target":"gpt-5.4"}
    ]' \
    FALLBACK_MODEL='gpt-5.4' \
    bash setup.sh

工具调用支持范围：

- 支持 Claude Desktop / MCP 常见的 JSON Schema tools
- 支持 Anthropic `tool_use` / `tool_result` 与 Responses `function_call` / `function_call_output` 转换
- 支持流式文本和流式工具参数增量
- 不支持图片、文档、extended thinking、OpenAI 内置 `web_search` / `file_search` / `computer_use` 的语义映射

## 自定义服务商

只要对方提供 Anthropic-compatible API，就可以通过环境变量接入：

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

## 环境变量

| 变量 | 默认值 | 说明 |
|---|---|---|
| `PROVIDER` | `deepseek` | provider 预设，支持 `deepseek`、`mimo`、`custom-responses` |
| `UPSTREAM_API_FORMAT` | provider 预设 | 上游 API 格式，支持 `anthropic` 或 `responses` |
| `UPSTREAM_API_KEY` | 必填 | 当前服务商的 API Key |
| `UPSTREAM_BASE_URL` | provider 预设 | 上游 API 地址 |
| `MODEL_RULES_JSON` | provider 预设 | 自定义模型映射规则 |
| `FALLBACK_MODEL` | provider 预设 | 没有匹配到规则时使用的模型 |
| `MODEL_REASONING_EFFORT` | `high` | Responses provider 的 reasoning effort |
| `DISABLE_RESPONSE_STORAGE` | `true` | Responses provider 是否设置 `store:false` |
| `PROXY_PORT` | `3099` | 本地网关端口 |

兼容旧变量：

| 变量 | 状态 |
|---|---|
| `DEEPSEEK_API_KEY` | 仍可作为 `UPSTREAM_API_KEY` 的 fallback |
| `DEEPSEEK_BASE_URL` | 仍可作为 `UPSTREAM_BASE_URL` 的 fallback |

## 验证是否成功

健康检查：

    curl http://127.0.0.1:3099/health

查看日志：

    tail -f ~/.local/model-proxy/proxy.log

DeepSeek 正常时，日志中应该能看到：

    收到模型名     : "claude-opus-4-7"
    转发模型名     : "deepseek-v4-pro"

MiMo 正常时，日志中应该能看到：

    收到模型名     : "claude-opus-4-7"
    转发模型名     : "mimo-v2.5-pro"

GPT 5.5 Responses 中转站正常时，日志中应该能看到：

    API格式        : responses
    收到模型名     : "claude-opus-4-7"
    转发模型名     : "gpt-5.5"

## 常用命令

查看日志：

    tail -f ~/.local/model-proxy/proxy.log

查看错误：

    tail -f ~/.local/model-proxy/proxy.err

重启服务：

    PLIST=~/Library/LaunchAgents/com.local.model-proxy.plist
    launchctl unload "$PLIST" 2>/dev/null || true
    launchctl load "$PLIST"

检查脚本语法：

    node --check ~/.local/model-proxy/proxy.js

## 卸载

    cd ~/Downloads/model-proxy
    bash uninstall.sh

卸载脚本会：

- 停止本地网关服务
- 删除 launch agent
- 删除已安装的代理文件
- 从 Claude Desktop 配置中移除 `gateway`
- 备份旧的 Claude Desktop 配置

卸载后请重启 Claude Desktop。

## 故障排查

| 问题 | 可能原因 | 解决方法 |
|---|---|---|
| 没有任何代理日志 | Claude Desktop 没有走本地网关 | 确认 Gateway URL 是 `http://127.0.0.1:3099` |
| Opus 还是走 flash | 模型映射没有生效 | 查看 `proxy.log` |
| `401 Unauthorized` | API Key 缺失或错误 | 使用正确的 `UPSTREAM_API_KEY` 重新安装 |
| MiMo 提示 `Not supported model` | MiMo 模型名不正确 | 使用 `mimo-v2.5-pro` 或 MiMo 官方文档里的真实模型名 |
| 健康检查显示的 provider 不对 | 当前安装的是旧 provider | 使用目标 provider 重新运行 `setup.sh` |
| 端口被占用 | `3099` 已被占用 | 使用 `PROXY_PORT=3100` |

## 安全说明

不要提交或分享你的 API Key。

不要分享这些本地文件：

    ~/Library/LaunchAgents/com.local.model-proxy.plist
    ~/.local/model-proxy/proxy.log
    ~/.local/model-proxy/proxy.err

它们可能包含本机路径、请求信息或 API Key。

## License

MIT
