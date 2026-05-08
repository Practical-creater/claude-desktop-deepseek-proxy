# Claude Desktop DeepSeek Proxy

<p align="center">
  <a href="./README.md">English</a> |
  <strong>简体中文</strong>
</p>

一个运行在 macOS 本地的 Claude Desktop Gateway 代理，用于让 Claude Desktop 调用 DeepSeek 模型。

它会把 Claude 风格的模型名转换成 DeepSeek 模型名，通过 DeepSeek 的 Anthropic 兼容端点转发请求，并清理 system prompt 里的动态 `cch=` 字段，以提高缓存复用率。

## 原理

```txt
Claude Desktop                  本地代理 :3099                   DeepSeek API
────────────────                ─────────────────                ────────────
POST /v1/messages   ────────►   替换 model 名       ────────►   /anthropic/v1/messages
model: claude-opus              清理动态 cch                     model: deepseek-v4-pro
                    ◄────────   原样透传响应        ◄────────   Anthropic 兼容响应
```

本项目**不做 Anthropic → OpenAI 格式转换**。

DeepSeek 已经提供 Anthropic 兼容端点，所以代理只做：

- 替换 `model` 字段
- 删除动态 `cch=...` 字段
- 原样转发请求和响应
- 打印模型路由和缓存统计日志

## 快速开始

### 1. 安装

```bash
cd ~/Downloads/model-proxy
chmod +x setup.sh uninstall.sh
DEEPSEEK_API_KEY=sk-your-key bash setup.sh
```

也可以直接运行：

```bash
bash setup.sh
```

脚本会提示你输入 DeepSeek API Key。

### 2. 重启 Claude Desktop

完全退出 Claude Desktop：

```txt
菜单栏 Claude → Quit Claude
```

然后重新打开。

### 3. 验证

```bash
curl http://127.0.0.1:3099/health
```

正常输出类似：

```json
{
  "status": "ok",
  "port": 3099,
  "upstream": "https://api.deepseek.com/anthropic"
}
```

查看实时日志：

```bash
tail -f ~/.local/model-proxy/proxy.log
```

在 Claude Desktop 里发送消息，应该能看到模型转发日志。

## 文件说明

```txt
model-proxy/
├── proxy.js
├── setup.sh
├── uninstall.sh
└── README.md
```

| 文件 | 作用 |
|---|---|
| `proxy.js` | 本地代理核心 |
| `setup.sh` | macOS 一键安装脚本 |
| `uninstall.sh` | 卸载脚本 |
| `README.md` | 项目说明 |

## Claude Desktop 配置

安装脚本会更新：

```txt
~/Library/Application Support/Claude/claude_desktop_config.json
```

写入：

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

Gateway base URL 必须是：

```txt
http://127.0.0.1:3099
```

不要填：

```txt
https://api.deepseek.com/anthropic
```

如果 Claude Desktop 直接连接 DeepSeek，就会绕过本地代理，模型映射不会生效。

## 模型映射

| Claude Desktop 模型名包含 | DeepSeek 模型 |
|---|---|
| `haiku` | `deepseek-v4-flash` |
| `opus` | `deepseek-v4-pro` |
| `sonnet` | `deepseek-v4-pro` |
| 其他 | `deepseek-v4-flash` |

示例：

```txt
claude-haiku-4-5       → deepseek-v4-flash
claude-haiku-4-5-xxx   → deepseek-v4-flash
claude-opus-4-7        → deepseek-v4-pro
claude-sonnet-4-5      → deepseek-v4-pro
```

## 环境变量

| 变量 | 默认值 | 说明 |
|---|---|---|
| `DEEPSEEK_API_KEY` | 必填 | DeepSeek API Key |
| `DEEPSEEK_BASE_URL` | `https://api.deepseek.com/anthropic` | DeepSeek Anthropic 兼容端点 |
| `PROXY_PORT` | `3099` | 本地代理端口 |

示例：

```bash
PROXY_PORT=3100 DEEPSEEK_API_KEY=sk-your-key bash setup.sh
```

如果修改端口，Claude Desktop 的 Gateway URL 也要使用相同端口：

```txt
http://127.0.0.1:3100
```

## 缓存优化

Claude Desktop 可能会在 system prompt 中注入动态字段：

```txt
x-anthropic-billing-header: ...; cch=a430b;
```

其中 `cch` 会变化，可能降低 DeepSeek 缓存命中率。

代理会在转发前删除它：

```txt
x-anthropic-billing-header: ...;
```

日志中会同时显示原始和转发后的 system 前缀：

```txt
原始system前缀 : ... cch=a430b;
转发system前缀 : ...
```

`转发system前缀` 中不应该再出现 `cch=`。

缓存统计示例：

```txt
缓存统计 : hit=34688 miss=0 input=1641 output=651 命中率=100.0%
```

只要 `hit > 0`，就说明 DeepSeek 缓存已经命中。

## 常用命令

健康检查：

```bash
curl http://127.0.0.1:3099/health
```

查看日志：

```bash
tail -f ~/.local/model-proxy/proxy.log
```

查看错误：

```bash
tail -f ~/.local/model-proxy/proxy.err
```

重启服务：

```bash
PLIST=~/Library/LaunchAgents/com.local.model-proxy.plist
launchctl unload "$PLIST" 2>/dev/null || true
launchctl load "$PLIST"
```

检查语法：

```bash
node --check ~/.local/model-proxy/proxy.js
```

## macOS launchd 服务

安装脚本会创建：

```txt
~/Library/LaunchAgents/com.local.model-proxy.plist
```

该服务会：

- 登录后自动启动
- 崩溃后自动重启
- 将日志写入 `~/.local/model-proxy/proxy.log`
- 将错误写入 `~/.local/model-proxy/proxy.err`

## 更新

如果你修改了项目目录里的 `proxy.js`，需要复制到实际运行目录并重启：

```bash
cp ~/Downloads/model-proxy/proxy.js ~/.local/model-proxy/proxy.js
PLIST=~/Library/LaunchAgents/com.local.model-proxy.plist
launchctl unload "$PLIST" 2>/dev/null || true
launchctl load "$PLIST"
```

## 卸载

```bash
cd ~/Downloads/model-proxy
bash uninstall.sh
```

卸载脚本会：

- 停止 launchd 服务
- 删除 launch agent
- 删除代理安装目录
- 从 Claude Desktop 配置中移除 `gateway`
- 备份旧的 Claude Desktop 配置

卸载后请重启 Claude Desktop。

## 故障排查

| 现象 | 原因 | 解决方法 |
|---|---|---|
| 没有代理日志 | Claude Desktop 没有走代理 | 确认 Gateway URL 是 `http://127.0.0.1:3099` |
| Opus 仍然走 flash | 模型映射未生效 | 查看 `proxy.log`，确认 Opus 转发到 `deepseek-v4-pro` |
| `401 Unauthorized` | API Key 缺失或错误 | 使用 `DEEPSEEK_API_KEY=sk-your-key bash setup.sh` 重新安装 |
| 端口被占用 | `3099` 已被使用 | 使用 `PROXY_PORT=3100` |
| 修改 `proxy.js` 后没变化 | 修改了错误文件 | 更新 `~/.local/model-proxy/proxy.js` 并重启服务 |

## 安全说明

不要提交或分享：

```txt
~/Library/LaunchAgents/com.local.model-proxy.plist
~/.local/model-proxy/proxy.log
~/.local/model-proxy/proxy.err
```

这些文件可能包含本机路径、请求信息或 API Key。

不要把 DeepSeek API Key 提交到仓库。

## License

MIT