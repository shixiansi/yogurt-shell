'use strict';

const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');

// Windows 上的进程枚举 / 清理小工具（依赖系统自带 PowerShell，不装任何依赖）

// 找一个能用的 PowerShell：优先 pwsh 7，其次系统自带的 Windows PowerShell。
// 注意：面板可能被计划任务/服务以精简 PATH 启动，不能只依赖 `pwsh` 这个名字。
function findPowerShell() {
  if (process.platform !== 'win32') return null;
  const candidates = [];
  candidates.push('C:\\Program Files\\PowerShell\\7\\pwsh.exe');
  candidates.push('C:\\Program Files\\PowerShell\\7-preview\\pwsh.exe');
  if (process.env.SystemRoot) {
    candidates.push(path.join(process.env.SystemRoot, 'System32\\WindowsPowerShell\\v1.0\\powershell.exe'));
  }
  if (process.env.LOCALAPPDATA) {
    candidates.push(path.join(process.env.LOCALAPPDATA, 'Microsoft\\WindowsApps\\pwsh.exe'));
  }
  for (const dir of String(process.env.PATH || '').split(path.delimiter)) {
    if (!dir) continue;
    candidates.push(path.join(dir, 'pwsh.exe'));
  }
  for (const candidate of candidates) {
    try {
      if (fs.existsSync(candidate)) return candidate;
    } catch {}
  }
  return 'powershell.exe';
}

const pwshPath = findPowerShell;

function runPowerShell(script, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    const exe = pwshPath();
    if (!exe) return resolve('');
    execFile(
      exe,
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
      { windowsHide: true, timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024 },
      (err, stdout, stderr) => {
        if (err && !stdout) return reject(new Error(stderr || err.message));
        resolve(String(stdout || ''));
      }
    );
  });
}

async function listYogurtProcesses() {
  if (process.platform !== 'win32') return [];
  const script =
    "Get-CimInstance Win32_Process -Filter \"Name='yogurt.exe'\" | " +
    'Select-Object ProcessId,ExecutablePath | ConvertTo-Json -Compress';
  try {
    const out = (await runPowerShell(script)).trim();
    if (!out) return [];
    const parsed = JSON.parse(out);
    return Array.isArray(parsed) ? parsed : [parsed];
  } catch {
    return [];
  }
}

function killPid(pid) {
  return new Promise((resolve) => {
    if (!pid) return resolve(false);
    execFile('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true }, () => resolve(true));
  });
}

module.exports = { findPowerShell, pwshPath, runPowerShell, listYogurtProcesses, killPid };
