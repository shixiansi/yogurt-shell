'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const DATA_DIR = path.join(ROOT, 'data');

const PATHS = {
  root: ROOT,
  data: DATA_DIR,
  config: path.join(DATA_DIR, 'config.json'),
  accounts: path.join(DATA_DIR, 'accounts'),
  logs: path.join(DATA_DIR, 'logs'),
  dist: path.join(DATA_DIR, 'dist'),
  updates: path.join(DATA_DIR, 'updates'),
  backups: path.join(DATA_DIR, 'backups'),
  runtime: path.join(DATA_DIR, 'runtime'),
  template: path.join(DATA_DIR, 'template'),
  events: path.join(DATA_DIR, 'events.jsonl'),
  pids: path.join(DATA_DIR, 'runtime', 'pids.json'),
};

const DEFAULT_CONFIG = {
  panel: {
    host: '127.0.0.1',
    port: 3090,
    token: '',
  },
  yogurt: {
    // 留空表示用「账号目录里的可执行文件」（Windows: yogurt.exe / Linux: yogurt.kexe）
    exePath: '',
    probe: {
      intervalMs: 15000, // 探活间隔
      timeoutMs: 8000,
      failures: 3, // 连续失败几次判定掉线
      graceMs: 90000, // 启动后宽限期（此时扫码/登录中，不判掉线）
    },
    // 命中即视为掉线（对聊天日志不生效，避免群友闲聊误触发）
    offlinePatterns: [
      '被踢下线',
      '踢下线',
      '您已在其他设备登录',
      '账号已在其他设备登录',
      '登录已失效',
      '登录已过期',
      '未登录或登录已失效',
      'KickedOffline',
      'NotLoggedIn',
    ],
    onlinePatterns: ['已上线'],
    // 启动阶段的登录提示（用于把状态标成「登录中」而不是掉线）
    loginPatterns: ['扫码', '二维码', '验证码', 'Ticket', '等待扫描', '等待登录'],
    log: {
      maxBytes: 20 * 1024 * 1024,
      keepFiles: 6,
      memoryLines: 2000,
    },
    autoRestart: false, // 全局默认：掉线/崩溃后不自动重启（等人工处理）
    killTimeoutMs: 8000,
  },
  mail: {
    enabled: false,
    host: '',
    port: 465,
    secure: true,
    user: '',
    pass: '',
    from: '',
    to: [],
    subjectPrefix: '[Yogurt]',
    dedupeMinutes: 10,
    rejectUnauthorized: true,
  },
  update: {
    repo: 'SaltifyDev/yogurt-releases',
    // 留空 = 按当前平台/架构自动选择（windows-x64 / linux-x64 / linux-arm64 / macos-arm64）
    asset: '',
    // GitHub 直连不通时的前缀镜像，例如 https://ghfast.top/
    mirrorPrefix: '',
    autoCheckMinutes: 0,
  },
  accounts: [],
};

function ensureDirs() {
  for (const dir of [
    PATHS.data,
    PATHS.accounts,
    PATHS.logs,
    PATHS.dist,
    PATHS.updates,
    PATHS.backups,
    PATHS.runtime,
    PATHS.template,
  ]) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function mergeDefaults(base, extra) {
  const out = Array.isArray(base) ? base.slice() : { ...base };
  if (!isPlainObject(extra)) return out;
  for (const [key, value] of Object.entries(extra)) {
    if (isPlainObject(value) && isPlainObject(out[key])) {
      out[key] = mergeDefaults(out[key], value);
    } else if (value !== undefined) {
      out[key] = value;
    }
  }
  return out;
}

let cached = null;

function load() {
  if (cached) return cached;
  ensureDirs();
  let raw = {};
  if (fs.existsSync(PATHS.config)) {
    try {
      raw = JSON.parse(fs.readFileSync(PATHS.config, 'utf8'));
    } catch (err) {
      const broken = PATHS.config + '.broken-' + Date.now();
      fs.copyFileSync(PATHS.config, broken);
      throw new Error('config.json 解析失败，已备份到 ' + broken + '：' + err.message);
    }
  }
  cached = mergeDefaults(DEFAULT_CONFIG, raw);
  if (!Array.isArray(cached.accounts)) cached.accounts = [];
  // 账号目录统一用正斜杠存，Windows 的 data/ 拷到 Linux 也能直接用
  cached.accounts = cached.accounts.map((a) => ({
    ...a,
    dir: String(a.dir || `accounts/${a.id}`).replace(/\\/g, '/'),
  }));
  // 从别的平台搬过来的配置里可能残留着那个平台的包名，这里清掉让它按本机自动选
  const AUTO_ASSETS = [
    'yogurt-windows-x64.zip',
    'yogurt-linux-x64.zip',
    'yogurt-linux-arm64.zip',
    'yogurt-macos-arm64.zip',
  ];
  const platformAsset = require('./platform').assetFor();
  if (cached.update && AUTO_ASSETS.includes(cached.update.asset) && cached.update.asset !== platformAsset) {
    cached.update.asset = '';
  }
  return cached;
}

function save(cfg) {
  const next = cfg || cached || DEFAULT_CONFIG;
  cached = next;
  fs.mkdirSync(path.dirname(PATHS.config), { recursive: true });
  const tmp = PATHS.config + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(next, null, 2) + '\n', 'utf8');
  fs.renameSync(tmp, PATHS.config);
  return next;
}

function getConfig() {
  return load();
}

function updateConfig(mutator) {
  const cfg = load();
  mutator(cfg);
  return save(cfg);
}

function accountDir(account) {
  return path.isAbsolute(account.dir) ? account.dir : path.join(DATA_DIR, account.dir);
}

function findAccount(id) {
  return load().accounts.find((a) => a.id === String(id)) || null;
}

function usedPorts(exceptId) {
  return new Set(
    load()
      .accounts.filter((a) => a.id !== exceptId)
      .map((a) => Number(a.port))
  );
}

function pickFreePort(start = 3000, exceptId = null) {
  const used = usedPorts(exceptId);
  let port = start;
  while (port < 65535 && used.has(port)) port += 1;
  return port;
}

function readAccountConfig(account) {
  const file = path.join(accountDir(account), 'config.json');
  if (!fs.existsSync(file)) return null;
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function writeAccountConfig(account, data) {
  const dir = accountDir(account);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'config.json');
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data, null, 4) + '\n', 'utf8');
  fs.renameSync(tmp, file);
}

module.exports = {
  ROOT,
  DATA_DIR,
  PATHS,
  DEFAULT_CONFIG,
  ensureDirs,
  load,
  save,
  getConfig,
  updateConfig,
  accountDir,
  findAccount,
  pickFreePort,
  readAccountConfig,
  writeAccountConfig,
  mergeDefaults,
};
