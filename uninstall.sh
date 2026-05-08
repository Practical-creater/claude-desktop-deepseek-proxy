#!/bin/bash
# =============================================================================
# uninstall.sh — 卸载 Claude Desktop ↔ DeepSeek Anthropic 本地代理
# =============================================================================

set -euo pipefail

GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BOLD='\033[1m'
NC='\033[0m'

ok()   { echo -e "${GREEN}✔ ${NC}$*"; }
warn() { echo -e "${YELLOW}⚠ ${NC}$*"; }

PROXY_DIR="$HOME/.local/model-proxy"
PLIST_LABEL="com.local.model-proxy"
PLIST_PATH="$HOME/Library/LaunchAgents/${PLIST_LABEL}.plist"
CLAUDE_CONFIG="$HOME/Library/Application Support/Claude/claude_desktop_config.json"

echo -e "\n${BOLD}卸载 Claude Desktop ↔ DeepSeek Anthropic 本地代理${NC}\n"

if [[ -f "$PLIST_PATH" ]]; then
  launchctl unload "$PLIST_PATH" 2>/dev/null || true
  rm -f "$PLIST_PATH"
  ok "launchd 服务已停止并移除"
else
  warn "未找到 launchd plist，跳过"
fi

if [[ -d "$PROXY_DIR" ]]; then
  rm -rf "$PROXY_DIR"
  ok "代理目录已删除: $PROXY_DIR"
else
  warn "代理目录不存在，跳过"
fi

if [[ -f "$CLAUDE_CONFIG" ]]; then
  cp "$CLAUDE_CONFIG" "${CLAUDE_CONFIG}.bak.$(date +%Y%m%d_%H%M%S)"

  node - "$CLAUDE_CONFIG" <<'NODE_EOF'
const fs = require('fs');

const configPath = process.argv[2];

let cfg = {};

try {
  cfg = JSON.parse(fs.readFileSync(configPath, 'utf8'));
} catch {
  cfg = {};
}

delete cfg.gateway;

fs.writeFileSync(configPath, JSON.stringify(cfg, null, 2) + '\n');
NODE_EOF

  ok "已从 Claude Desktop 配置中移除 gateway 字段"
else
  warn "未找到 Claude Desktop 配置文件，跳过"
fi

echo
echo -e "${GREEN}${BOLD}卸载完成。${NC}"
echo "请完全退出并重启 Claude Desktop，使配置还原生效。"
echo
