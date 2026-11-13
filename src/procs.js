'use strict';

const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const { binNames } = require('./platform');

// 跨平台的进程枚举 / 结束进程 / 找 PowerShell
function findPowerShell() {
  if (process.platform !== 'win32') return null;
  const candidates = ['C:\\Program Files\\PowerShell\\7\\pwsh.exe', 'C:\\Program Files\\PowerShell\\7-preview\\pwsh.exe'];
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
    const exe = findPowerShell();
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

// 取路径最后一段：显式按 / 和 \ 切，避免 path.basename 在 Linux 上不认反斜杠
function basenameAny(exePath) {
  const text = String(exePath || '').replace(/ \(deleted\)$/, '');
  const parts = text.split(/[\\/]/);
  return parts[parts.length - 1];
}

function matchesBinaryName(exePath, platform = process.platform) {
  if (!exePath) return false;
  return binNames(platform).includes(basenameAny(exePath));
}

function listYogurtProcessesWindows() {
  return runPowerShell(
    "Get-CimInstance Win32_Process | Where-Object { $_.Name -like 'yogurt*' } | " +
      'Select-Object ProcessId,ExecutablePath | ConvertTo-Json -Compress'
  )
    .then((out) => {
      const text = out.trim();
      if (!text) return [];
      const parsed = JSON.parse(text);
      return (Array.isArray(parsed) ? parsed : [parsed]).map((p) => ({
        pid: p.ProcessId,
        exePath: p.ExecutablePath || '',
      }));
    })
    .catch(() => []);
}

function listYogurtProcessesLinux(procRoot = '/proc') {
  const result = [];
  let entries = [];
  try {
    entries = fs.readdirSync(procRoot);
  } catch {
    return result;
  }
  for (const entry of entries) {
    if (!/^\d+$/.test(entry)) continue;
    let exePath = '';
    try {
      exePath = fs.readlinkSync(path.join(procRoot, entry, 'exe'));
    } catch {
      continue; // 权限不足或进程已退出
    }
    if (!matchesBinaryName(exePath)) continue;
    result.push({ pid: Number(entry), exePath });
  }
  return result;
}

function listYogurtProcessesMac() {
  return new Promise((resolve) => {
    execFile('ps', ['-axo', 'pid=,comm='], { timeout: 10000 }, (err, stdout) => {
      if (err) return resolve([]);
      const result = [];
      for (const line of String(stdout).split('\n')) {
        const m = /^\s*(\d+)\s+(.+)$/.exec(line);
        if (!m) continue;
        if (!matchesBinaryName(m[2])) continue;
        result.push({ pid: Number(m[1]), exePath: m[2] });
      }
      resolve(result);
    });
  });
}

async function listYogurtProcesses() {
  if (process.platform === 'win32') return listYogurtProcessesWindows();
  if (process.platform === 'linux') return listYogurtProcessesLinux();
  if (process.platform === 'darwin') return listYogurtProcessesMac();
  return [];
}

function killPid(pid, { tree = true } = {}) {
  return new Promise((resolve) => {
    if (!pid) return resolve(false);
    if (process.platform === 'win32') {
      const args = tree ? ['/PID', String(pid), '/T', '/F'] : ['/PID', String(pid), '/F'];
      return execFile('taskkill', args, { windowsHide: true }, () => resolve(true));
    }
    // POSIX：先杀进程组（spawn 时 detached 建了新组），不行再单杀
    try {
      process.kill(-pid, 'SIGKILL');
      return resolve(true);
    } catch {}
    try {
      process.kill(pid, 'SIGKILL');
    } catch {}
    resolve(true);
  });
}

module.exports = {
  findPowerShell,
  pwshPath,
  runPowerShell,
  listYogurtProcesses,
  listYogurtProcessesLinux,
  killPid,
  matchesBinaryName,
};
