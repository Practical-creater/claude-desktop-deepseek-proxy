# =============================================================================
# uninstall.ps1 — 卸载 Claude Desktop ↔ 本地模型代理 Windows 版
# =============================================================================

[CmdletBinding()]
param(
    [string]$TaskName = 'ClaudeModelProxy',
    [switch]$KeepData,
    [switch]$KeepClaudeConfig
)

$ErrorActionPreference = 'Continue'

function Write-Ok    { param([string]$m) Write-Host "[+] $m" -ForegroundColor Green }
function Write-Warn2 { param([string]$m) Write-Host "[!] $m" -ForegroundColor Yellow }
function Write-Info  { param([string]$m) Write-Host "[i] $m" -ForegroundColor Cyan }

$ProxyDir       = Join-Path $env:LOCALAPPDATA 'model-proxy'
$ClaudeConfig   = Join-Path $env:APPDATA 'Claude\claude_desktop_config.json'
$ProxyJsTarget  = Join-Path $ProxyDir 'proxy.js'

Write-Host ""
Write-Host "卸载 Claude Desktop ↔ 本地模型代理" -ForegroundColor White
Write-Host ""

# 1) 任务计划程序
$task = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
if ($task) {
    try { Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue } catch {}
    Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false -ErrorAction SilentlyContinue
    Write-Ok "任务计划程序 $TaskName 已移除"
} else {
    Write-Warn2 "未找到任务 $TaskName，跳过"
}

# 2) 杀掉跑着的 node proxy.js 进程
$running = Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue |
    Where-Object { $_.CommandLine -like "*$ProxyJsTarget*" -or $_.CommandLine -like "*model-proxy*proxy.js*" }

if ($running) {
    foreach ($p in $running) {
        Write-Info "终止 node 进程 PID=$($p.ProcessId)"
        Stop-Process -Id $p.ProcessId -Force -ErrorAction SilentlyContinue
    }
    Write-Ok "已停止运行中的 proxy.js 进程"
} else {
    Write-Warn2 "未发现运行中的 proxy.js 进程，跳过"
}

# 3) 代理目录
if ($KeepData) {
    Write-Info "保留代理目录: $ProxyDir（指定了 -KeepData）"
} elseif (Test-Path $ProxyDir) {
    try {
        Remove-Item -Recurse -Force $ProxyDir
        Write-Ok "代理目录已删除: $ProxyDir"
    } catch {
        Write-Warn2 "删除目录失败: $($_.Exception.Message)"
    }
} else {
    Write-Warn2 "代理目录不存在，跳过"
}

# 4) Claude Desktop 配置：移除 gateway 字段
if ($KeepClaudeConfig) {
    Write-Info "保留 Claude Desktop 配置（指定了 -KeepClaudeConfig）"
} elseif (Test-Path $ClaudeConfig) {
    $backup = "$ClaudeConfig.bak.$(Get-Date -Format 'yyyyMMdd_HHmmss')"
    Copy-Item -Force $ClaudeConfig $backup
    Write-Info "已备份原配置到 $backup"

    try {
        $cfg = Get-Content -Raw -Path $ClaudeConfig -Encoding UTF8 | ConvertFrom-Json
    } catch {
        $cfg = $null
    }

    if ($cfg) {
        if ($cfg.PSObject.Properties.Name -contains 'gateway') {
            $cfg.PSObject.Properties.Remove('gateway')
        }
        $json = $cfg | ConvertTo-Json -Depth 20
        [System.IO.File]::WriteAllText($ClaudeConfig, $json + "`r`n", (New-Object System.Text.UTF8Encoding($false)))
        Write-Ok "已从 Claude Desktop 配置中移除 gateway 字段"
    } else {
        Write-Warn2 "Claude Desktop 配置解析失败，保留原文件不动"
    }
} else {
    Write-Warn2 "未找到 Claude Desktop 配置文件，跳过"
}

Write-Host ""
Write-Host "卸载完成。" -ForegroundColor Green
Write-Host "请完全退出并重启 Claude Desktop，使配置还原生效。"
Write-Host ""
