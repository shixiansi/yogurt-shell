'use strict';

const fs = require('fs');
const path = require('path');
const store = require('./store');
const platform = require('./platform');

const SIGNS = 'https://sign.shixiansi.pw/laptop/';

function accountConfigTemplate({ uin, port, host = '127.0.0.1', os = 'Linux', version = 'custom', signApiUrl = SIGNS, password = '', accessToken = '', ffmpegPath = '' }) {
  return {
    configVersion: 3,
    protocol: {
      uin: Number(uin),
      password: password || '',
      os,
      version,
      signApiUrl,
      pcLagrangeSignToken: '',
      androidUseLegacySign: false,
      autoRenewSession: true,
    },
    milky: {
      http: { host, port: Number(port), prefix: '', accessToken, corsOrigins: [] },
      webhook: { endpoints: [] },
      reportSelfMessage: true,
      preloadContacts: false,
      ffmpegPath,
    },
    logging: { ansiLevel: 'ANSI256', coreLogLevel: 'DEBUG' },
    security: { skipOnLaunchListenAddressCheck: false },
    debug: { enableFaceDetailsApi: false },
  };
}

function newestDistExe() {
  try {
    const dirs = fs
      .readdirSync(store.PATHS.dist, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => {
        const file = platform.findBinary(path.join(store.PATHS.dist, d.name));
        return file ? { p: file, t: fs.statSync(file).mtimeMs } : null;
      })
      .filter(Boolean)
      .sort((a, b) => b.t - a.t);
    return dirs.length ? dirs[0].p : null;
  } catch {
    return null;
  }
}

function linkOrCopy(src, dest) {
  fs.rmSync(dest, { force: true });
  let mode = 'copy';
  try {
    fs.linkSync(src, dest);
    mode = 'link';
  } catch {
    fs.copyFileSync(src, dest);
  }
  platform.ensureExecutable(dest);
  return mode;
}

function ensureExe(account, { sourceDir } = {}) {
  const dir = store.accountDir(account);
  const existing = platform.findBinary(dir);
  if (existing) return { ok: true, path: existing, mode: 'existing' };
  const cfg = store.getConfig();
  // 优先级：导入源目录里原有的可执行文件（保持现状）> 全局指定路径 > 面板已下载的最新 dist
  const candidates = [];
  if (sourceDir) {
    const fromSource = platform.findBinary(sourceDir);
    if (fromSource) candidates.push(fromSource);
  }
  if (cfg.yogurt.exePath) {
    const p = path.isAbsolute(cfg.yogurt.exePath) ? cfg.yogurt.exePath : path.join(store.DATA_DIR, cfg.yogurt.exePath);
    candidates.push(p);
  }
  const dist = newestDistExe();
  if (dist) candidates.push(dist);
  for (const src of candidates) {
    if (src && fs.existsSync(src)) {
      // 用源文件名（windows 是 yogurt.exe，其它平台是 yogurt.kexe/yogurt），保持跨平台一致
      const target = path.join(dir, path.basename(src));
      const mode = linkOrCopy(src, target);
      return { ok: true, path: target, mode, from: src };
    }
  }
  return { ok: false, path: path.join(dir, platform.defaultBinName()), mode: 'missing' };
}

function copyIfExists(from, to) {
  try {
    if (fs.existsSync(from)) {
      fs.copyFileSync(from, to);
      return true;
    }
  } catch {}
  return false;
}

function ensureAppInfo(account, sourceDir) {
  const dir = store.accountDir(account);
  const target = path.join(dir, 'app-info.json');
  if (fs.existsSync(target)) return;
  const copies = [];
  if (sourceDir) copies.push(path.join(sourceDir, 'app-info.json'));
  copies.push(path.join(store.PATHS.template, 'app-info.json'));
  for (const c of copies) {
    if (fs.existsSync(c)) {
      fs.copyFileSync(c, target);
      return;
    }
  }
}

function validateUin(uin) {
  const s = String(uin || '').trim();
  if (!/^\d{5,12}$/.test(s)) throw new Error('QQ 号必须是 5-12 位数字');
  return s;
}

function create(input) {
  const cfg = store.getConfig();
  const uin = validateUin(input.uin);
  if (cfg.accounts.some((a) => a.id === uin)) throw new Error('该账号已存在：' + uin);
  const port = Number(input.port) || store.pickFreePort(3000, uin);
  if (cfg.accounts.some((a) => Number(a.port) === port)) throw new Error('端口 ' + port + ' 已被其它账号占用');

  const account = {
    id: uin,
    name: (input.name || '').trim() || uin,
    dir: path.join('accounts', uin),
    port,
    host: input.host || '127.0.0.1',
    accessToken: input.accessToken || '',
    enabled: true,
    autoStart: input.autoStart !== false,
    autoRestart: input.autoRestart === true,
    createdAt: Date.now(),
    note: input.note || '',
  };

  const dir = store.accountDir(account);
  fs.mkdirSync(dir, { recursive: true });
  const ac = accountConfigTemplate({
    uin,
    port,
    host: account.host,
    os: input.os || 'Linux',
    version: input.version || 'custom',
    signApiUrl: input.signApiUrl || SIGNS,
    password: input.password || '',
    accessToken: account.accessToken,
    ffmpegPath: input.ffmpegPath || '',
  });
  store.writeAccountConfig(account, ac);
  ensureAppInfo(account, input.sourceDir);
  const exe = ensureExe(account, { sourceDir: input.sourceDir });

  cfg.accounts.push(account);
  store.save(cfg);
  return { account, exe };
}

function importAccount(input) {
  const fromDir = path.resolve(input.fromDir || '');
  if (!fromDir || !fs.existsSync(fromDir)) throw new Error('源目录不存在：' + input.fromDir);
  const srcConfigFile = path.join(fromDir, 'config.json');
  if (!fs.existsSync(srcConfigFile)) throw new Error('源目录里没有 config.json');
  let srcConfig;
  try {
    srcConfig = JSON.parse(fs.readFileSync(srcConfigFile, 'utf8'));
  } catch (err) {
    throw new Error('源 config.json 解析失败：' + err.message);
  }
  const uin = String((srcConfig.protocol && srcConfig.protocol.uin) || input.uin || '').trim();
  validateUin(uin);

  const cfg = store.getConfig();
  if (cfg.accounts.some((a) => a.id === uin)) throw new Error('该账号已存在：' + uin);

  const port = Number((srcConfig.milky && srcConfig.milky.http && srcConfig.milky.http.port) || input.port) || store.pickFreePort(3000, uin);
  if (cfg.accounts.some((a) => Number(a.port) === port)) throw new Error('端口 ' + port + ' 已被其它账号占用');

  const account = {
    id: uin,
    name: (input.name || '').trim() || String((srcConfig.protocol && srcConfig.protocol.os) || '') + '-' + uin,
    dir: path.join('accounts', uin),
    port,
    host: (srcConfig.milky && srcConfig.milky.http && srcConfig.milky.http.host) || '127.0.0.1',
    accessToken: (srcConfig.milky && srcConfig.milky.http && srcConfig.milky.http.accessToken) || '',
    enabled: true,
    autoStart: input.autoStart !== false,
    autoRestart: input.autoRestart === true,
    createdAt: Date.now(),
    note: input.note || '从现有目录导入：' + fromDir,
  };

  const dir = store.accountDir(account);
  fs.mkdirSync(dir, { recursive: true });

  const copied = [];
  const copyList = [
    'config.json',
    'app-info.json',
    'session-store.json',
    'session-store-android.json',
    'qrcode.png',
  ];
  for (const name of copyList) {
    if (copyIfExists(path.join(fromDir, name), path.join(dir, name))) copied.push(name);
  }
  ensureAppInfo(account, fromDir);
  const exe = ensureExe(account, { sourceDir: fromDir });

  cfg.accounts.push(account);
  store.save(cfg);
  return { account, exe, copied };
}

function update(id, patch) {
  const cfg = store.getConfig();
  const account = cfg.accounts.find((a) => a.id === String(id));
  if (!account) throw new Error('账号不存在：' + id);
  const editable = ['name', 'note', 'enabled', 'autoStart', 'autoRestart', 'host', 'accessToken'];
  for (const key of editable) {
    if (patch[key] !== undefined) account[key] = patch[key];
  }
  if (patch.port !== undefined) {
    const port = Number(patch.port);
    if (!port || port < 1 || port > 65535) throw new Error('端口不合法');
    if (cfg.accounts.some((a) => a.id !== account.id && Number(a.port) === port)) throw new Error('端口已被其它账号占用');
    account.port = port;
    const ac = store.readAccountConfig(account);
    if (ac) {
      ac.milky = ac.milky || {};
      ac.milky.http = ac.milky.http || {};
      ac.milky.http.port = port;
      store.writeAccountConfig(account, ac);
    }
  }
  store.save(cfg);
  return account;
}

function remove(id, { deleteFiles = false } = {}) {
  const cfg = store.getConfig();
  const idx = cfg.accounts.findIndex((a) => a.id === String(id));
  if (idx < 0) throw new Error('账号不存在：' + id);
  const [account] = cfg.accounts.splice(idx, 1);
  store.save(cfg);
  if (deleteFiles) {
    const dir = store.accountDir(account);
    const trash = path.join(store.PATHS.data, 'trash');
    fs.mkdirSync(trash, { recursive: true });
    try {
      fs.renameSync(dir, path.join(trash, `${account.id}-${Date.now()}`));
    } catch {
      try {
        fs.rmSync(dir, { recursive: true, force: true });
      } catch {}
    }
  }
  return account;
}

function readConfigText(id) {
  const account = store.findAccount(id);
  if (!account) throw new Error('账号不存在：' + id);
  const file = path.join(store.accountDir(account), 'config.json');
  return fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
}

function writeConfigText(id, text) {
  const account = store.findAccount(id);
  if (!account) throw new Error('账号不存在：' + id);
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    throw new Error('JSON 语法错误：' + err.message);
  }
  store.writeAccountConfig(account, parsed);
  if (parsed.milky && parsed.milky.http) {
    const patch = {};
    if (parsed.milky.http.port) patch.port = Number(parsed.milky.http.port);
    if (Object.keys(patch).length) {
      try {
        update(account.id, patch);
      } catch {}
    }
  }
  return parsed;
}

module.exports = {
  accountConfigTemplate,
  ensureExe,
  create,
  importAccount,
  update,
  remove,
  readConfigText,
  writeConfigText,
  newestDistExe,
};
