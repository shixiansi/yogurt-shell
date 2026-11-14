'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');
const store = require('./store');

// 开机自启 / 后台运行的落地实现：
//   Windows → 在「启动」文件夹放一个指向 node server.js 的快捷方式（最小化）
//   Linux   → 写 systemd 用户服务并按需 enable（有 systemd 时）
const UNIT_NAME = 'yogurt-shell.service';

function windowsShortcutPath() {
  const appData = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
  return path.join(appData, 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup', 'Yogurt Shell.lnk');
}

function systemdConfigHome() {
  return process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config');
}

function systemdUnitPath() {
  return path.join(systemdConfigHome(), 'systemd', 'user', UNIT_NAME);
}

function run(file, args, timeoutMs = 20000) {
  return new Promise((resolve) => {
    execFile(file, args, { timeout: timeoutMs, windowsHide: true, maxBuffer: 2 * 1024 * 1024 }, (err, stdout, stderr) => {
      resolve({ ok: !err, stdout: String(stdout || '').trim(), stderr: String(stderr || '').trim(), error: err });
    });
  });
}

async function hasSystemd() {
  if (process.platform !== 'linux') return false;
  if (!fs.existsSync('/run/systemd/system') && !process.env.INVOCATION_ID) {
    // 容器里常见没有 systemd；再试一下 systemctl 是否可用
    const res = await run('systemctl', ['--user', '--version'], 8000);
    return res.ok;
  }
  return true;
}

function unitContent() {
  const node = process.execPath;
  const entry = path.join(store.ROOT, 'server.js');
  return [
    '[Unit]',
    'Description=Yogurt Shell (Yogurt control panel)',
    'After=network-online.target',
    'Wants=network-online.target',
    '',
    '[Service]',
    'Type=simple',
    `WorkingDirectory=${store.ROOT}`,
    `ExecStart=${node} ${entry}`,
    'Restart=on-failure',
    'RestartSec=5',
    'TimeoutStopSec=30',
    '',
    '[Install]',
    'WantedBy=default.target',
    '',
  ].join('\n');
}

async function status() {
  if (process.platform === 'win32') {
    const file = windowsShortcutPath();
    const exists = fs.existsSync(file);
    return {
      platform: 'win32',
      supported: true,
      method: 'windows-startup-shortcut',
      enabled: exists,
      target: file,
      hint: exists ? '登录 Windows 后会自动启动面板（窗口最小化）' : '开启后会放进「启动」文件夹，登录即自动运行',
    };
  }

  if (process.platform === 'linux') {
    const supported = await hasSystemd();
    const file = systemdUnitPath();
    let enabled = false;
    let running = false;
    if (supported) {
      const en = await run('systemctl', ['--user', 'is-enabled', UNIT_NAME], 8000);
      enabled = en.ok && /enabled/.test(en.stdout);
      const ac = await run('systemctl', ['--user', 'is-active', UNIT_NAME], 8000);
      running = ac.ok && /active/.test(ac.stdout);
    }
    return {
      platform: 'linux',
      supported,
      method: 'systemd-user-unit',
      enabled,
      running,
      target: file,
      hint: supported
        ? '开启后由 systemd 用户服务托管（崩溃自动拉起）；想让未登录也跑需执行 loginctl enable-linger'
        : '当前环境没有 systemd，只能手动后台运行（可用 start-background.sh）',
    };
  }

  return {
    platform: process.platform,
    supported: false,
    method: 'none',
    enabled: false,
    target: null,
    hint: '当前平台未实现一键自启，可用 start-background.sh / nohup 手动后台运行',
  };
}

async function enableWindows() {
  const file = windowsShortcutPath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const node = process.execPath;
  const entry = path.join(store.ROOT, 'server.js');
  const script = [
    "$ws = New-Object -ComObject WScript.Shell",
    `$s = $ws.CreateShortcut('${file.replace(/'/g, "''")}')`,
    `$s.TargetPath = '${node.replace(/'/g, "''")}'`,
    `$s.Arguments = '"${entry.replace(/'/g, "''")}"'`,
    `$s.WorkingDirectory = '${store.ROOT.replace(/'/g, "''")}'`,
    '$s.WindowStyle = 7',
    "$s.Description = 'Yogurt Shell - 本地控制面板'",
    '$s.Save()',
  ].join('; ');
  const res = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script], 30000);
  if (!res.ok) throw new Error('创建启动快捷方式失败：' + (res.stderr || res.error.message));
  return status();
}

async function enableLinux() {
  if (!(await hasSystemd())) throw new Error('当前环境没有 systemd，无法安装自启服务');
  const unit = systemdUnitPath();
  fs.mkdirSync(path.dirname(unit), { recursive: true });
  fs.writeFileSync(unit, unitContent(), 'utf8');
  const reload = await run('systemctl', ['--user', 'daemon-reload'], 20000);
  if (!reload.ok) throw new Error('systemctl --user daemon-reload 失败：' + (reload.stderr || reload.error.message));
  const en = await run('systemctl', ['--user', 'enable', UNIT_NAME], 20000);
  if (!en.ok) throw new Error('systemctl --user enable 失败：' + (en.stderr || en.error.message));
  return status();
}

async function enable() {
  if (process.platform === 'win32') return enableWindows();
  if (process.platform === 'linux') return enableLinux();
  throw new Error('当前平台不支持一键自启');
}

async function disable() {
  if (process.platform === 'win32') {
    const file = windowsShortcutPath();
    fs.rmSync(file, { force: true });
    return status();
  }
  if (process.platform === 'linux') {
    if (await hasSystemd()) {
      await run('systemctl', ['--user', 'disable', UNIT_NAME], 20000);
    }
    fs.rmSync(systemdUnitPath(), { force: true });
    if (await hasSystemd()) await run('systemctl', ['--user', 'daemon-reload'], 20000);
    return status();
  }
  throw new Error('当前平台不支持一键自启');
}

// 把当前面板交给 systemd 管理：先 enable，再延迟重启服务（此时自己退出，避免抢端口）
function handoverCommand() {
  if (process.platform !== 'linux') return null;
  return { file: 'systemctl', args: ['--user', 'restart', UNIT_NAME] };
}

module.exports = { status, enable, disable, handoverCommand, windowsShortcutPath, systemdUnitPath, unitContent };
