# 把 Yogurt Shell 加进「启动」文件夹，登录 Windows 后自动跑起来（窗口最小化）
$ErrorActionPreference = 'Stop'

$root = Split-Path -Parent $PSScriptRoot
$cmd = Join-Path $root 'start.cmd'
if (-not (Test-Path $cmd)) { throw "找不到 $cmd" }

$startup = [Environment]::GetFolderPath('Startup')
$lnkPath = Join-Path $startup 'Yogurt Shell.lnk'

$shell = New-Object -ComObject WScript.Shell
$shortcut = $shell.CreateShortcut($lnkPath)
$shortcut.TargetPath = $cmd
$shortcut.WorkingDirectory = $root
$shortcut.WindowStyle = 7
$shortcut.Description = 'Yogurt Shell - 本地控制面板'
$shortcut.Save()

Write-Host "已创建开机自启快捷方式：$lnkPath"
Write-Host "想取消就删掉这个 .lnk 文件。"
