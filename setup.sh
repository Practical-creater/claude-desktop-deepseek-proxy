#!/bin/bash
# =============================================================================
# setup.sh — Claude Desktop ↔ DeepSeek Anthropic 本地代理一键安装脚本 macOS
#
# 用法：
#   cd ~/Downloads/model-proxy
#   chmod +x setup.sh uninstall.sh
#   DEEPSEEK_API_KEY=sk-xxxx bash setup.sh
#
# 说明：
#   - Claude Desktop 连接本地代理：http://127.0.0.1:3099
#   - 本地代理转发到 DeepSeek Anthropic 兼容端点：
#     https://api.deepseek.com/anthropic
#   - 代理只改 model 名，并清理 system prompt 中动态 cch= 字段以提高缓存命中率
# =============================================================================

set -euo pipefail

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
BOLD='\033[1m'
NC='\033[0m'

info()   { echo -e "${BLUE}ℹ ${NC}$*"; }
ok()     { echo -e "${GREEN}✔ ${NC}$*"; }
warn()   { echo -e "${YELLOW}⚠ ${NC}$*"; }
die()    { echo -e "${RED}✘ ${NC}$*" >&2; exit 1; }
header() { echo -e "\n${BOLD}$*${NC}"; }

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

PROXY_DIR="$HOME/.local/model-proxy"
PROXY_PORT="${PROXY_PORT:-3099}"

# 多供应商模式：MULTI=1 时启用 routes.json/secrets.json 路由
# - secrets.json 强制 chmod 600（API key 不暴露在 plist 里）
# - Claude Desktop 选择器会显示 6 个 claude- 前缀别名
MULTI="${MULTI:-0}"

PROVIDER="${PROVIDER:-deepseek}"

case "$PROVIDER" in
  deepseek)
    DEFAULT_UPSTREAM_API_FORMAT="anthropic"
    DEFAULT_UPSTREAM_BASE_URL="https://api.deepseek.com/anthropic"
    DEFAULT_MODEL_RULES_JSON='[
      {"match":"haiku","target":"deepseek-v4-flash"},
      {"match":"opus","target":"deepseek-v4-pro"},
      {"match":"sonnet","target":"deepseek-v4-pro"}
    ]'
    DEFAULT_FALLBACK_MODEL="deepseek-v4-flash"
    ;;

  mimo)
    DEFAULT_UPSTREAM_API_FORMAT="anthropic"
    DEFAULT_UPSTREAM_BASE_URL="https://token-plan-cn.xiaomimimo.com/anthropic"
    DEFAULT_MODEL_RULES_JSON='[
      {"match":"haiku","target":"mimo-v2.5-pro"},
      {"match":"opus","target":"mimo-v2.5-pro"},
      {"match":"sonnet","target":"mimo-v2.5-pro"}
    ]'
    DEFAULT_FALLBACK_MODEL="mimo-v2.5-pro"
    ;;

  custom-responses)
    DEFAULT_UPSTREAM_API_FORMAT="responses"
    DEFAULT_UPSTREAM_BASE_URL="https://www.msutools.cn/v1"
    DEFAULT_MODEL_RULES_JSON='[
      {"match":"opus","target":"gpt-5.5"},
      {"match":"sonnet","target":"gpt-5.4"},
      {"match":"haiku","target":"gpt-5.4-mini"}
    ]'
    DEFAULT_FALLBACK_MODEL="gpt-5.4-mini"
    ;;

  *)
    echo "未知 PROVIDER: $PROVIDER"
    echo "支持的 PROVIDER: deepseek, mimo, custom-responses"
    exit 1
    ;;
esac

UPSTREAM_API_FORMAT="${UPSTREAM_API_FORMAT:-$DEFAULT_UPSTREAM_API_FORMAT}"
UPSTREAM_BASE_URL="${UPSTREAM_BASE_URL:-$DEFAULT_UPSTREAM_BASE_URL}"
MODEL_RULES_JSON="${MODEL_RULES_JSON:-$DEFAULT_MODEL_RULES_JSON}"
FALLBACK_MODEL="${FALLBACK_MODEL:-$DEFAULT_FALLBACK_MODEL}"
MODEL_REASONING_EFFORT="${MODEL_REASONING_EFFORT:-high}"
DISABLE_RESPONSE_STORAGE="${DISABLE_RESPONSE_STORAGE:-true}"
IMAGE_DETAIL="${IMAGE_DETAIL:-auto}"

UPSTREAM_API_KEY="${UPSTREAM_API_KEY:-${DEEPSEEK_API_KEY:-}}"

PLIST_LABEL="com.local.model-proxy"
PLIST_PATH="$HOME/Library/LaunchAgents/${PLIST_LABEL}.plist"

CLAUDE_CONFIG="$HOME/Library/Application Support/Claude/claude_desktop_config.json"

header "步骤 0 / 6  检查文件"

[[ -f "$SCRIPT_DIR/proxy.js" ]] || die "当前目录缺少 proxy.js"
[[ -f "$SCRIPT_DIR/uninstall.sh" ]] || warn "当前目录缺少 uninstall.sh，不影响安装，但不方便卸载"

ok "必要文件存在"

if [[ "$MULTI" == "1" ]]; then
  header "步骤 1 / 6  多供应商模式（配置走 /admin 后台）"
  info "多供应商模式不再在终端要求 API Key，安装完成后请在浏览器打开 http://127.0.0.1:${PROXY_PORT}/admin 添加路由和密钥"
  ok "跳过 API Key 输入"
else
  header "步骤 1 / 6  读取 ${PROVIDER} API Key"

  if [[ -z "${UPSTREAM_API_KEY:-}" ]]; then
    read -rsp "请粘贴 ${PROVIDER} API Key（输入不显示）: " UPSTREAM_API_KEY
    echo
  fi

  [[ -z "$UPSTREAM_API_KEY" ]] && die "API Key 不能为空"

  ok "API Key 已读取"
fi

header "步骤 2 / 6  检查 Node.js"

if ! command -v node >/dev/null 2>&1; then
  warn "未检测到 Node.js"

  if command -v brew >/dev/null 2>&1; then
    info "检测到 Homebrew，尝试安装 Node.js"
    brew install node
  else
    die "未找到 Node.js，也未找到 Homebrew。请先安装 Node.js 后重新运行。"
  fi
fi

NODE_BIN="$(command -v node)"
NODE_VER="$(node --version)"

ok "Node.js: $NODE_VER"
info "Node 路径: $NODE_BIN"

header "步骤 3 / 6  安装代理文件"

mkdir -p "$PROXY_DIR"

cp "$SCRIPT_DIR/proxy.js" "$PROXY_DIR/proxy.js"
chmod +x "$PROXY_DIR/proxy.js"

node --check "$PROXY_DIR/proxy.js" >/dev/null

ok "proxy.js 已安装到 $PROXY_DIR/proxy.js"

if [[ "$MULTI" == "1" ]]; then
  ROUTES_PATH="$PROXY_DIR/routes.json"
  SECRETS_PATH="$PROXY_DIR/secrets.json"

  # 幂等：已存在的 routes.json 不覆盖，保护用户在 /admin 里改过的配置
  if [[ -f "$ROUTES_PATH" ]]; then
    info "routes.json 已存在，保留当前内容（用 /admin 修改）"
  else
    cat > "$ROUTES_PATH" <<'ROUTES_EOF'
{
  // ─────────────────────────────────────────────────────────────────
  // 多供应商路由表 — 在浏览器打开 http://127.0.0.1:3099/admin 添加路由
  //
  // 别名 (id) → {
  //   displayName, apiFormat ("anthropic"|"responses"),
  //   baseUrl, secretId, targetModel
  // }
  //
  // 注意：
  // - id 必须含 "claude/sonnet/opus/haiku/anthropic" 关键字
  // - id 用横杠不用小数点
  // - targetModel 用真实上游名（可带小数点）
  // - _fallback 是兜底：Claude Desktop 启动会硬编码探测 claude-haiku-4-5
  //   等标准名，命中关键字就路由到指定别名
  // ─────────────────────────────────────────────────────────────────

  "_fallback": {}
}
ROUTES_EOF
    ok "已创建空白 routes.json，去 /admin 添加路由"
  fi

  # 同样幂等：已存在的 secrets.json 不覆盖
  if [[ -f "$SECRETS_PATH" ]]; then
    info "secrets.json 已存在，保留当前内容（用 /admin 修改）"
    chmod 600 "$SECRETS_PATH"
  else
    echo '{}' > "$SECRETS_PATH"
    chmod 600 "$SECRETS_PATH"
    ok "已创建空白 secrets.json (chmod 600)"
  fi
fi

header "步骤 4 / 6  创建 launchd 服务"

mkdir -p "$HOME/Library/LaunchAgents"

# 多模式不在 plist 里塞 UPSTREAM_API_KEY（key 已经在 chmod 600 的 secrets.json 里）
if [[ "$MULTI" == "1" ]]; then
ENV_BLOCK=$(cat <<ENV_EOF
    <key>PROXY_PORT</key>
    <string>${PROXY_PORT}</string>

    <key>MODEL_REASONING_EFFORT</key>
    <string>${MODEL_REASONING_EFFORT}</string>

    <key>DISABLE_RESPONSE_STORAGE</key>
    <string>${DISABLE_RESPONSE_STORAGE}</string>

    <key>IMAGE_DETAIL</key>
    <string>${IMAGE_DETAIL}</string>
ENV_EOF
)
else
ENV_BLOCK=$(cat <<ENV_EOF
    <key>PROVIDER</key>
    <string>${PROVIDER}</string>

    <key>UPSTREAM_API_KEY</key>
    <string>${UPSTREAM_API_KEY}</string>

    <key>UPSTREAM_API_FORMAT</key>
    <string>${UPSTREAM_API_FORMAT}</string>

    <key>UPSTREAM_BASE_URL</key>
    <string>${UPSTREAM_BASE_URL}</string>

    <key>MODEL_RULES_JSON</key>
    <string>${MODEL_RULES_JSON}</string>

    <key>FALLBACK_MODEL</key>
    <string>${FALLBACK_MODEL}</string>

    <key>PROXY_PORT</key>
    <string>${PROXY_PORT}</string>

    <key>MODEL_REASONING_EFFORT</key>
    <string>${MODEL_REASONING_EFFORT}</string>

    <key>DISABLE_RESPONSE_STORAGE</key>
    <string>${DISABLE_RESPONSE_STORAGE}</string>

    <key>IMAGE_DETAIL</key>
    <string>${IMAGE_DETAIL}</string>
ENV_EOF
)
fi

cat > "$PLIST_PATH" <<PLIST_EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${PLIST_LABEL}</string>

  <key>ProgramArguments</key>
  <array>
    <string>${NODE_BIN}</string>
    <string>${PROXY_DIR}/proxy.js</string>
  </array>

  <key>EnvironmentVariables</key>
  <dict>
${ENV_BLOCK}
  </dict>

  <key>RunAtLoad</key>
  <true/>

  <key>KeepAlive</key>
  <true/>

  <key>StandardOutPath</key>
  <string>${PROXY_DIR}/proxy.log</string>

  <key>StandardErrorPath</key>
  <string>${PROXY_DIR}/proxy.err</string>
</dict>
</plist>
PLIST_EOF

ok "plist 已写入 $PLIST_PATH"

launchctl unload "$PLIST_PATH" 2>/dev/null || true
launchctl load "$PLIST_PATH"

ok "launchd 服务已启动"

header "步骤 5 / 6  健康检查"

sleep 1

MAX_RETRY=10
i=0

until curl -sf "http://127.0.0.1:${PROXY_PORT}/health" >/dev/null; do
  i=$((i + 1))

  if [[ "$i" -ge "$MAX_RETRY" ]]; then
    echo
    warn "代理启动失败，错误日志如下："
    tail -n 50 "$PROXY_DIR/proxy.err" 2>/dev/null || true
    die "健康检查失败"
  fi

  sleep 1
done

HEALTH="$(curl -sf "http://127.0.0.1:${PROXY_PORT}/health")"

ok "代理已就绪: $HEALTH"

header "步骤 6 / 6  更新 Claude Desktop 配置"

mkdir -p "$(dirname "$CLAUDE_CONFIG")"

if [[ -f "$CLAUDE_CONFIG" ]]; then
  cp "$CLAUDE_CONFIG" "${CLAUDE_CONFIG}.bak.$(date +%Y%m%d_%H%M%S)"
  info "已备份原配置"
fi

if [[ "$MULTI" == "1" ]]; then
  # 多模式：不写 inferenceModels，让 Claude Desktop 走 /v1/models 自动发现
  # 这样 displayName 才能生效，picker 才能显示成 "DeepSeek V4 Pro" 这种自定义名
  INFERENCE_MODELS_JSON='[]'
else
  INFERENCE_MODELS_JSON='[
    "claude-haiku-4-5",
    "claude-opus-4-7",
    "claude-sonnet-4-5"
  ]'
fi

node - "$CLAUDE_CONFIG" "$PROXY_PORT" "$INFERENCE_MODELS_JSON" <<'NODE_EOF'
const fs = require('fs');

const configPath = process.argv[2];
const port = process.argv[3];
const inferenceModels = JSON.parse(process.argv[4]);

let cfg = {};

try {
  if (fs.existsSync(configPath)) {
    cfg = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  }
} catch {
  cfg = {};
}

cfg.gateway = { url: `http://127.0.0.1:${port}` };
if (inferenceModels.length > 0) {
  // 显式写死时（单上游模式）才设 inferenceModels；空数组等同于走 /v1/models 自动发现
  cfg.gateway.inferenceModels = inferenceModels;
}

fs.writeFileSync(configPath, JSON.stringify(cfg, null, 2) + '\n');
NODE_EOF

ok "Claude Desktop 配置已更新: $CLAUDE_CONFIG"

echo
echo -e "${GREEN}${BOLD}安装完成！${NC}"
echo
if [[ "$MULTI" == "1" ]]; then
  echo "  模式: 多供应商"
  echo "  路由文件: ${PROXY_DIR}/routes.json"
  echo "  密钥文件: ${PROXY_DIR}/secrets.json (chmod 600)"
  echo
  echo "下一步："
  echo "  1. 浏览器打开 ${BOLD}http://127.0.0.1:${PROXY_PORT}/admin${NC}"
  echo "  2. 在 'Routes' 卡片点 '+ Add Route' 添加供应商，填好 API key"
  echo "  3. 点 Save Changes"
  echo "  4. 完全退出 Claude Desktop (⌘Q) 再重新打开，picker 里就能看到新模型"
else
  echo "  模式: 单供应商"
  echo "  Provider: ${PROVIDER}"
  echo "  API 格式: ${UPSTREAM_API_FORMAT}"
  echo "  上游地址: ${UPSTREAM_BASE_URL}"
  echo
  echo "下一步："
  echo "  1. 完全退出 Claude Desktop (⌘Q) 再重新打开"
  echo "  2. picker 里能看到 claude-haiku-4-5 / claude-opus-4-7 / claude-sonnet-4-5"
fi
echo
echo "常用命令："
echo "  打开后台：   open http://127.0.0.1:${PROXY_PORT}/admin"
echo "  查看日志：   tail -f ${PROXY_DIR}/proxy.log"
echo "  查看错误：   tail -f ${PROXY_DIR}/proxy.err"
echo "  健康检查：   curl http://127.0.0.1:${PROXY_PORT}/health"
echo "  停止服务：   launchctl unload ${PLIST_PATH}"
echo "  启动服务：   launchctl load ${PLIST_PATH}"
echo "  卸载：       bash uninstall.sh"
echo
