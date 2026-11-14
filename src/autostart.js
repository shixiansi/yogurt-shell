'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile, spawn } = require('child_process');
const store = require('./store');

// 开机自启 / 后台运行的落地实现：
//   Windows → 「启动」文件夹快捷方式
//   Linux   → 有 systemd 用 systemd 用户服务；没有 systemd（容器/精简系统）退回 crontab @reboot
const UNIT_NAME = 'yogurt-shell.service';
const CRON_TAG = '# yogurt-shell-autostart';

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
  // 只有 systemd 真正在跑（/run/systemd/system 存在）才谈得上 enable；
  // 容器里常见「systemctl 能用但连不上 bus」，所以不能只判断命令存在
  if (!fs.existsSync('/run/systemd/system')) return false;
  const uid = typeof process.getuid === 'function' ? process.getuid() : -1;
  if (fs.existsSync(`/run/user/${uid}/bus`) || process.env.DBUS_SESSION_BUS_ADDRESS) return true;
  const res = await run('systemctl', ['is-system-running'], 8000);
  return res.ok || /running|degraded|starting/.test(res.stdout);
}

async function hasCrontab() {
  if (process.platform !== 'linux') return false;
  const res = await run('crontab', ['-l'], 8000);
  return res.ok || /no crontab/i.test(res.stderr || '');
}

async function readCrontab() {
  const res = await run('crontab', ['-l'], 8000);
  return res.ok ? res.stdout : '';
}

function writeCrontab(text) {
  return new Promise((resolve) => {
    const child = spawn('crontab', ['-'], { windowsHide: true });
    let stderr = '';
    child.stderr.on('data', (d) => (stderr += d.toString()));
    child.on('error', (err) => resolve({ ok: false, stderr: err.message }));
    child.on('exit', (code) => resolve({ ok: code === 0, stderr }));
    child.stdin.end(text);
  });
}

function cronLine() {
  const node = process.execPath;
  const entry = path.join(store.ROOT, 'server.js');
  const log = path.join(store.DATA_DIR, 'panel.out.log');
  return `@reboot cd ${store.ROOT} && nohup "${node}" "${entry}" >> "${log}" 2>&1 &`;
}

async function crontabEnabled() {
  const text = await readCrontab();
  return text.split('\n').some((line) => line.includes(CRON_TAG));
}

async function enableCron() {
  const current = await readCrontab();
  const kept = current
    .split('\n')
    .filter((line) => !line.includes(CRON_TAG) && line.trim() !== cronLine().trim());
  const next = [...kept.filter((line, idx) => idx < kept.length || line.trim()), `${cronLine()} ${CRON_TAG}`]
    .join('\n')
    .replace(/\n+$/, '');
  const res = await writeCrontab(next + '\n');
  if (!res.ok) throw new Error('写 crontab 失败：' + (res.stderr || '未知错误'));
  return status();
}

async function disableCron() {
  const current = await readCrontab();
  const next = current
    .split('\n')
    .filter((line) => !line.includes(CRON_TAG))
    .join('\n')
    .replace(/\n+$/, '');
  if (next.trim() || current.trim()) {
    await writeCrontab(next + '\n');
  }
  return status();
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

// pm2 托管的进程会带 pm_id：这类环境不要自己再搞自启/重启，交给 pm2
function pm2Info() {
  const id = process.env.pm_id;
  if (id === undefined || id === '') return null;
  return { id, name: process.env.name || process.env.pm_exec_path || 'yogurt-shell' };
}

async function status() {
  const pm2 = pm2Info();
  if (pm2) {
    return {
      platform: process.platform,
      supported: true,
      method: 'pm2',
      enabled: true,
      running: true,
      target: `pm2（实例 id ${pm2.id}）`,
      hint: '面板由 pm2 托管：开机自启/守护都归 pm2 管，重启用 pm2 restart <名字>（别用面板里的「重启面板」，pm2 会同时拉起，两边抢端口）',
    };
  }

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
    const systemd = await hasSystemd();
    if (systemd) {
      const file = systemdUnitPath();
      let enabled = false;
      let running = false;
      const en = await run('systemctl', ['--user', 'is-enabled', UNIT_NAME], 8000);
      enabled = en.ok && /enabled/.test(en.stdout);
      const ac = await run('systemctl', ['--user', 'is-active', UNIT_NAME], 8000);
      running = ac.ok && /active/.test(ac.stdout);
      return {
        platform: 'linux',
        supported: true,
        method: 'systemd-user-unit',
        enabled,
        running,
        target: file,
        hint: '由 systemd 用户服务托管（崩溃自动拉起）；想让未登录也跑需 sudo loginctl enable-linger $USER',
      };
    }

    const cron = await hasCrontab();
    if (cron) {
      const enabled = await crontabEnabled();
      return {
        platform: 'linux',
        supported: true,
        method: 'crontab-reboot',
        enabled,
        running: null,
        target: 'crontab（@reboot 一行）',
        hint: '这台机器没有 systemd，改用 crontab @reboot 开机启动；需要 cron 服务在跑（部分容器默认没有）',
      };
    }

    return {
      platform: 'linux',
      supported: false,
      method: 'none',
      enabled: false,
      target: null,
      hint: '这个环境既没有 systemd 也没有 crontab：请用 ./start-background.sh 后台启动（容器可设 restart: unless-stopped）',
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
  if (pm2Info()) throw new Error('面板由 pm2 托管：开机自启用 pm2 save + pm2 startup，不需要在这里开');
  if (process.platform === 'win32') return enableWindows();
  if (process.platform === 'linux') {
    if (await hasSystemd()) return enableLinux();
    if (await hasCrontab()) return enableCron();
    throw new Error(
      '这个环境既没有 systemd 也没有 crontab，做不了一键自启：用 ./start-background.sh 后台启动' +
        '（容器里可以给容器设 restart: unless-stopped）'
    );
  }
  throw new Error('当前平台不支持一键自启');
}

async function disable() {
  if (pm2Info()) throw new Error('面板由 pm2 托管：要停自启用 pm2 delete / pm2 unstartup，面板里不用改');
  if (process.platform === 'win32') {
    const file = windowsShortcutPath();
    fs.rmSync(file, { force: true });
    return status();
  }
  if (process.platform === 'linux') {
    if (await hasSystemd()) {
      await run('systemctl', ['--user', 'disable', UNIT_NAME], 20000);
      fs.rmSync(systemdUnitPath(), { force: true });
      await run('systemctl', ['--user', 'daemon-reload'], 20000);
      return status();
    }
    if (await hasCrontab()) return disableCron();
    throw new Error('当前环境没有 systemd / crontab，本来就没有可关的自启');
  }
  throw new Error('当前平台不支持一键自启');
}

// 把当前面板交给 systemd 管理：先 enable，再延迟重启服务（此时自己退出，避免抢端口）
function handoverCommand() {
  if (process.platform !== 'linux') return null;
  return { file: 'systemctl', args: ['--user', 'restart', UNIT_NAME] };
}

module.exports = {
  status,
  enable,
  disable,
  handoverCommand,
  windowsShortcutPath,
  systemdUnitPath,
  unitContent,
  // 给自测用
  __test: { cronLine, hasSystemd, hasCrontab, crontabEnabled },
};
