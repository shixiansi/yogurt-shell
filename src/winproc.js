'use strict';

const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');

// Windows 上的进程枚举 / 清理小工具（依赖系统自带 PowerShell，不装任何依赖）

function pwshPath() {
  if (process.platform !== 'win32') return null;
  const candidates = [
    'C:\\Program Files\\PowerShell\\7\\pwsh.exe',
    path.join(process.env.SystemRoot || 'C:\\Windows', 'System32\\WindowsPowerShell\\v1.0\\powershell.exe'),
  ];
  for (const c of candidates) if (fs.existsSync(c)) return c;
  return 'powershell.exe';
}

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

module.exports = { pwshPath, runPowerShell, listYogurtProcesses, killPid };
