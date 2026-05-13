# =============================================================================
# setup.ps1 — Claude Desktop ↔ 本地模型代理 一键安装脚本 Windows
#
# 用法（PowerShell 5+，无需管理员）：
#   cd <repo>
#   # 多供应商模式（推荐，安装后去 /admin 配置）
#   powershell -ExecutionPolicy Bypass -File .\setup.ps1 -Multi
#
#   # 单供应商模式（兼容旧用法）
#   powershell -ExecutionPolicy Bypass -File .\setup.ps1 -Provider deepseek -ApiKey sk-xxx
#   powershell -ExecutionPolicy Bypass -File .\setup.ps1 -Provider mimo -ApiKey sk-xxx
#   powershell -ExecutionPolicy Bypass -File .\setup.ps1 -Provider custom-responses -ApiKey sk-xxx
#
# 也支持环境变量：MULTI=1 / PROVIDER / UPSTREAM_API_KEY / DEEPSEEK_API_KEY
#
# 说明：
#   - Claude Desktop 连接本地代理：http://127.0.0.1:3099
#   - 安装目录： %LOCALAPPDATA%\model-proxy
#   - 后台常驻： 任务计划程序里的 ClaudeModelProxy（登录时自启）
# =============================================================================

[CmdletBinding()]
param(
    [switch]$Multi,
    [ValidateSet('deepseek','mimo','custom-responses')]
    [string]$Provider = 'deepseek',
    [int]$Port = 3099,
    [string]$ApiKey,
    [string]$UpstreamBaseUrl,
    [string]$UpstreamApiFormat,
    [string]$FallbackModel,
    [string]$ModelRulesJson,
    [string]$ReasoningEffort = 'high',
    [string]$ImageDetail = 'auto',
    [string]$DisableResponseStorage = 'true',
    [string]$TaskName = 'ClaudeModelProxy'
)

$ErrorActionPreference = 'Stop'

function Write-Info   { param([string]$m) Write-Host "[i] $m" -ForegroundColor Cyan }
function Write-Ok     { param([string]$m) Write-Host "[+] $m" -ForegroundColor Green }
function Write-Warn2  { param([string]$m) Write-Host "[!] $m" -ForegroundColor Yellow }
function Write-Header { param([string]$m) Write-Host ""; Write-Host $m -ForegroundColor White }

function Quote-PSSingle {
    param([string]$s)
    if ($null -eq $s) { return "''" }
    return "'" + ($s -replace "'", "''") + "'"
}

# ─── 环境变量后备（与 bash 版本对齐） ──────────────────────────────────────
if (-not $PSBoundParameters.ContainsKey('Multi') -and $env:MULTI -eq '1') {
    $Multi = $true
}
if (-not $PSBoundParameters.ContainsKey('Provider') -and $env:PROVIDER) {
    $Provider = $env:PROVIDER
}
if (-not $ApiKey) {
    if ($env:UPSTREAM_API_KEY)  { $ApiKey = $env:UPSTREAM_API_KEY }
    elseif ($env:DEEPSEEK_API_KEY) { $ApiKey = $env:DEEPSEEK_API_KEY }
}
if (-not $PSBoundParameters.ContainsKey('Port') -and $env:PROXY_PORT) {
    $Port = [int]$env:PROXY_PORT
}

# ─── 路径常量 ─────────────────────────────────────────────────────────────
$ProxyDir       = Join-Path $env:LOCALAPPDATA 'model-proxy'
$ClaudeCfgDir   = Join-Path $env:APPDATA 'Claude'
$ClaudeConfig   = Join-Path $ClaudeCfgDir 'claude_desktop_config.json'
$ScriptDir      = Split-Path -Parent $MyInvocation.MyCommand.Path
$ProxyJsSource  = Join-Path $ScriptDir 'proxy.js'
$ProxyJsTarget  = Join-Path $ProxyDir 'proxy.js'
$RunScriptPath  = Join-Path $ProxyDir 'run-proxy.ps1'
$LogPath        = Join-Path $ProxyDir 'proxy.log'
$ErrPath        = Join-Path $ProxyDir 'proxy.err'
$RoutesPath     = Join-Path $ProxyDir 'routes.json'
$SecretsPath    = Join-Path $ProxyDir 'secrets.json'

# ─── 单上游模式的默认值 ───────────────────────────────────────────────────
$DefaultUpstreamApiFormat = 'anthropic'
$DefaultUpstreamBaseUrl   = 'https://api.deepseek.com/anthropic'
$DefaultFallbackModel     = 'deepseek-v4-flash'
$DefaultModelRulesJson    = '[{"match":"haiku","target":"deepseek-v4-flash"},{"match":"opus","target":"deepseek-v4-pro"},{"match":"sonnet","target":"deepseek-v4-pro"}]'

switch ($Provider) {
    'deepseek' {
        $DefaultUpstreamApiFormat = 'anthropic'
        $DefaultUpstreamBaseUrl   = 'https://api.deepseek.com/anthropic'
        $DefaultModelRulesJson    = '[{"match":"haiku","target":"deepseek-v4-flash"},{"match":"opus","target":"deepseek-v4-pro"},{"match":"sonnet","target":"deepseek-v4-pro"}]'
        $DefaultFallbackModel     = 'deepseek-v4-flash'
    }
    'mimo' {
        $DefaultUpstreamApiFormat = 'anthropic'
        $DefaultUpstreamBaseUrl   = 'https://token-plan-cn.xiaomimimo.com/anthropic'
        $DefaultModelRulesJson    = '[{"match":"haiku","target":"mimo-v2.5-pro"},{"match":"opus","target":"mimo-v2.5-pro"},{"match":"sonnet","target":"mimo-v2.5-pro"}]'
        $DefaultFallbackModel     = 'mimo-v2.5-pro'
    }
    'custom-responses' {
        $DefaultUpstreamApiFormat = 'responses'
        $DefaultUpstreamBaseUrl   = 'https://www.msutools.cn/v1'
        $DefaultModelRulesJson    = '[{"match":"opus","target":"gpt-5.5"},{"match":"sonnet","target":"gpt-5.4"},{"match":"haiku","target":"gpt-5.4-mini"}]'
        $DefaultFallbackModel     = 'gpt-5.4-mini'
    }
}

if (-not $UpstreamApiFormat) { $UpstreamApiFormat = $DefaultUpstreamApiFormat }
if (-not $UpstreamBaseUrl)   { $UpstreamBaseUrl   = $DefaultUpstreamBaseUrl }
if (-not $ModelRulesJson)    { $ModelRulesJson    = $DefaultModelRulesJson }
if (-not $FallbackModel)     { $FallbackModel     = $DefaultFallbackModel }

# ─── 步骤 0 / 6  检查文件 ─────────────────────────────────────────────────
Write-Header "步骤 0 / 6  检查文件"

if (-not (Test-Path $ProxyJsSource)) {
    throw "当前目录缺少 proxy.js: $ProxyJsSource"
}
Write-Ok "必要文件存在"

# ─── 步骤 1 / 6  API Key ──────────────────────────────────────────────────
if ($Multi) {
    Write-Header "步骤 1 / 6  多供应商模式（配置走 /admin 后台）"
    Write-Info "多供应商模式不再在终端要求 API Key，安装完成后请在浏览器打开 http://127.0.0.1:$Port/admin 添加路由和密钥"
    Write-Ok "跳过 API Key 输入"
} else {
    Write-Header "步骤 1 / 6  读取 $Provider API Key"

    if (-not $ApiKey) {
        $secure = Read-Host -Prompt "请粘贴 $Provider API Key（输入不显示）" -AsSecureString
        $bstr = [System.Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
        try {
            $ApiKey = [System.Runtime.InteropServices.Marshal]::PtrToStringAuto($bstr)
        } finally {
            [System.Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr)
        }
    }

    if (-not $ApiKey) { throw "API Key 不能为空" }
    Write-Ok "API Key 已读取"
}

# ─── 步骤 2 / 6  检查 Node.js ─────────────────────────────────────────────
Write-Header "步骤 2 / 6  检查 Node.js"

$nodeCmd = Get-Command node -ErrorAction SilentlyContinue
if (-not $nodeCmd) {
    throw "未找到 Node.js。请先从 https://nodejs.org/ 下载并安装 Node.js LTS（任选 MSI 安装包），重启 PowerShell 后再运行本脚本。"
}

$NodeBin = $nodeCmd.Source
$NodeVer = (& $NodeBin --version).Trim()
Write-Ok "Node.js: $NodeVer"
Write-Info "Node 路径: $NodeBin"

# ─── 步骤 3 / 6  安装代理文件 ─────────────────────────────────────────────
Write-Header "步骤 3 / 6  安装代理文件"

New-Item -ItemType Directory -Force -Path $ProxyDir | Out-Null

Copy-Item -Force $ProxyJsSource $ProxyJsTarget
& $NodeBin --check $ProxyJsTarget | Out-Null
Write-Ok "proxy.js 已安装到 $ProxyJsTarget"

if ($Multi) {
    $utf8NoBom = New-Object System.Text.UTF8Encoding($false)

    if (Test-Path $RoutesPath) {
        Write-Info "routes.json 已存在，保留当前内容（用 /admin 修改）"
    } else {
        $routesDefault = @"
{
  // ─────────────────────────────────────────────────────────────────
  // 多供应商路由表 — 在浏览器打开 http://127.0.0.1:$Port/admin 添加路由
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
"@
        [System.IO.File]::WriteAllText($RoutesPath, $routesDefault, $utf8NoBom)
        Write-Ok "已创建空白 routes.json，去 /admin 添加路由"
    }

    if (Test-Path $SecretsPath) {
        Write-Info "secrets.json 已存在，保留当前内容（用 /admin 修改）"
    } else {
        [System.IO.File]::WriteAllText($SecretsPath, "{}`n", $utf8NoBom)
        Write-Ok "已创建空白 secrets.json"
    }

    # secrets.json ACL：仅当前用户可访问（chmod 600 的 Windows 等价）
    try {
        $acl = Get-Acl $SecretsPath
        $acl.SetAccessRuleProtection($true, $false)
        foreach ($ace in @($acl.Access)) {
            if (-not $ace.IsInherited) { [void]$acl.RemoveAccessRule($ace) }
        }
        $me = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name
        $rule = New-Object System.Security.AccessControl.FileSystemAccessRule(
            $me, 'FullControl', 'Allow')
        $acl.AddAccessRule($rule)
        Set-Acl -Path $SecretsPath -AclObject $acl
        Write-Ok "secrets.json 已锁定为仅 $me 可读写"
    } catch {
        Write-Warn2 "secrets.json ACL 设置失败: $($_.Exception.Message)（文件本身仍在 %LOCALAPPDATA% 用户目录下，未公开）"
    }
}

# ─── 步骤 4 / 6  生成 run-proxy.ps1 并注册任务计划 ───────────────────────
Write-Header "步骤 4 / 6  注册任务计划程序 ($TaskName)"

# 把环境变量烘焙进 run-proxy.ps1（对齐 launchd plist 的做法）
$envSets = @()
$envSets += "`$env:MODEL_PROXY_HOME       = " + (Quote-PSSingle $ProxyDir)
$envSets += "`$env:PROXY_PORT             = " + (Quote-PSSingle "$Port")
$envSets += "`$env:MODEL_REASONING_EFFORT = " + (Quote-PSSingle $ReasoningEffort)
$envSets += "`$env:DISABLE_RESPONSE_STORAGE = " + (Quote-PSSingle $DisableResponseStorage)
$envSets += "`$env:IMAGE_DETAIL           = " + (Quote-PSSingle $ImageDetail)

if (-not $Multi) {
    $envSets += "`$env:PROVIDER            = " + (Quote-PSSingle $Provider)
    $envSets += "`$env:UPSTREAM_API_KEY    = " + (Quote-PSSingle $ApiKey)
    $envSets += "`$env:UPSTREAM_API_FORMAT = " + (Quote-PSSingle $UpstreamApiFormat)
    $envSets += "`$env:UPSTREAM_BASE_URL   = " + (Quote-PSSingle $UpstreamBaseUrl)
    $envSets += "`$env:MODEL_RULES_JSON    = " + (Quote-PSSingle $ModelRulesJson)
    $envSets += "`$env:FALLBACK_MODEL      = " + (Quote-PSSingle $FallbackModel)
}

$envBlock = $envSets -join "`r`n"

$runScript = @"
# Auto-generated by setup.ps1. 重新跑 setup 会覆盖此文件。
# 由任务计划程序 "$TaskName" 在登录时调起。
`$ErrorActionPreference = 'Stop'

$envBlock

Set-Location -Path $(Quote-PSSingle $ProxyDir)

# 把 stdout / stderr 分别追加到 proxy.log / proxy.err（对齐 launchd 行为）
# 注意：写成单行避免反引号换行被 here-string 吃掉
& $(Quote-PSSingle $NodeBin) $(Quote-PSSingle $ProxyJsTarget) 1>> $(Quote-PSSingle $LogPath) 2>> $(Quote-PSSingle $ErrPath)
"@

[System.IO.File]::WriteAllText($RunScriptPath, $runScript, (New-Object System.Text.UTF8Encoding($false)))
Write-Ok "已写入 $RunScriptPath"

# 先把旧任务和正在跑的实例清掉
$existing = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
if ($existing) {
    try { Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue } catch {}
    Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false -ErrorAction SilentlyContinue
}

# 杀掉占用端口的旧 node 进程（如果存在）
Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue |
    Where-Object { $_.CommandLine -like "*$ProxyJsTarget*" } |
    ForEach-Object {
        Write-Info "终止旧 node 进程 PID=$($_.ProcessId)"
        Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue
    }

$taskArgs = "-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$RunScriptPath`""
$action = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument $taskArgs -WorkingDirectory $ProxyDir
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
$settings = New-ScheduledTaskSettingsSet `
    -AllowStartIfOnBatteries `
    -DontStopIfGoingOnBatteries `
    -StartWhenAvailable `
    -MultipleInstances IgnoreNew `
    -RestartCount 3 `
    -RestartInterval (New-TimeSpan -Minutes 1) `
    -ExecutionTimeLimit (New-TimeSpan -Seconds 0)

Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Settings $settings -Force | Out-Null
Start-ScheduledTask -TaskName $TaskName
Write-Ok "任务计划程序 $TaskName 已注册并启动"

# ─── 步骤 5 / 6  健康检查 ─────────────────────────────────────────────────
Write-Header "步骤 5 / 6  健康检查"

Start-Sleep -Seconds 1
$maxRetry = 15
$healthy = $false
$lastErr = $null

for ($i = 0; $i -lt $maxRetry; $i++) {
    try {
        $resp = Invoke-WebRequest -Uri "http://127.0.0.1:$Port/health" -UseBasicParsing -TimeoutSec 2
        if ($resp.StatusCode -eq 200) {
            $healthy = $true
            $healthBody = $resp.Content
            break
        }
    } catch {
        $lastErr = $_.Exception.Message
    }
    Start-Sleep -Seconds 1
}

if (-not $healthy) {
    Write-Warn2 "代理启动失败，错误日志如下："
    if (Test-Path $ErrPath) { Get-Content -Tail 50 $ErrPath | ForEach-Object { Write-Host $_ } }
    throw "健康检查失败: $lastErr"
}

Write-Ok "代理已就绪: $healthBody"

# ─── 步骤 6 / 6  更新 Claude Desktop 配置 ─────────────────────────────────
Write-Header "步骤 6 / 6  更新 Claude Desktop 配置"

New-Item -ItemType Directory -Force -Path $ClaudeCfgDir | Out-Null

if (Test-Path $ClaudeConfig) {
    $backup = "$ClaudeConfig.bak.$(Get-Date -Format 'yyyyMMdd_HHmmss')"
    Copy-Item -Force $ClaudeConfig $backup
    Write-Info "已备份原配置到 $backup"
}

$cfg = $null
if (Test-Path $ClaudeConfig) {
    try {
        $cfg = Get-Content -Raw -Path $ClaudeConfig -Encoding UTF8 | ConvertFrom-Json
    } catch {
        $cfg = $null
    }
}
if (-not $cfg) { $cfg = New-Object PSCustomObject }

$gateway = New-Object PSCustomObject
$gateway | Add-Member -NotePropertyName url -NotePropertyValue "http://127.0.0.1:$Port"

if (-not $Multi) {
    # 单上游模式：写死 3 个标准模型名
    $gateway | Add-Member -NotePropertyName inferenceModels -NotePropertyValue @(
        'claude-haiku-4-5',
        'claude-opus-4-7',
        'claude-sonnet-4-5'
    )
}
# 多上游模式：不写 inferenceModels，让 Claude Desktop 走 /v1/models 自动发现

if ($cfg.PSObject.Properties.Name -contains 'gateway') {
    $cfg.gateway = $gateway
} else {
    $cfg | Add-Member -NotePropertyName gateway -NotePropertyValue $gateway -Force
}

$json = $cfg | ConvertTo-Json -Depth 20
[System.IO.File]::WriteAllText($ClaudeConfig, $json + "`r`n", (New-Object System.Text.UTF8Encoding($false)))
Write-Ok "Claude Desktop 配置已更新: $ClaudeConfig"

# ─── 完成 ────────────────────────────────────────────────────────────────
Write-Host ""
Write-Host "安装完成！" -ForegroundColor Green
Write-Host ""
if ($Multi) {
    Write-Host "  模式: 多供应商"
    Write-Host "  路由文件: $RoutesPath"
    Write-Host "  密钥文件: $SecretsPath (仅当前用户可读)"
    Write-Host ""
    Write-Host "下一步："
    Write-Host "  1. 浏览器打开 http://127.0.0.1:$Port/admin"
    Write-Host "  2. 在 'Routes' 卡片点 '+ Add Route' 添加供应商，填好 API key"
    Write-Host "  3. 点 Save Changes"
    Write-Host "  4. 完全退出 Claude Desktop（任务栏右键 Quit）再重新打开，picker 里就能看到新模型"
} else {
    Write-Host "  模式: 单供应商"
    Write-Host "  Provider: $Provider"
    Write-Host "  API 格式: $UpstreamApiFormat"
    Write-Host "  上游地址: $UpstreamBaseUrl"
    Write-Host ""
    Write-Host "下一步："
    Write-Host "  1. 完全退出 Claude Desktop 再重新打开"
    Write-Host "  2. picker 里能看到 claude-haiku-4-5 / claude-opus-4-7 / claude-sonnet-4-5"
}
Write-Host ""
Write-Host "常用命令："
Write-Host "  打开后台：   Start-Process http://127.0.0.1:$Port/admin"
Write-Host "  查看日志：   Get-Content -Wait $LogPath"
Write-Host "  查看错误：   Get-Content -Wait $ErrPath"
Write-Host "  健康检查：   Invoke-WebRequest http://127.0.0.1:$Port/health"
Write-Host "  停止服务：   Stop-ScheduledTask -TaskName $TaskName"
Write-Host "  启动服务：   Start-ScheduledTask -TaskName $TaskName"
Write-Host "  卸载：       powershell -ExecutionPolicy Bypass -File .\uninstall.ps1"
Write-Host ""
