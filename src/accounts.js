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

// app-info.json（protocol.version = custom 时 yogurt 必需）的候选来源，按优先级
function appInfoSources(sourceDir) {
  const list = [];
  if (sourceDir) list.push(path.join(sourceDir, 'app-info.json'));
  list.push(path.join(store.PATHS.template, 'app-info.json'));
  list.push(path.join(store.ROOT, 'assets', 'app-info.json'));
  return list;
}

// 把仓库自带的模板放进 data/template，保证全新 clone 也能用 custom 协议
function seedTemplate() {
  const target = path.join(store.PATHS.template, 'app-info.json');
  if (fs.existsSync(target)) return { seeded: false, path: target };
  const asset = path.join(store.ROOT, 'assets', 'app-info.json');
  if (!fs.existsSync(asset)) return { seeded: false, path: null };
  try {
    fs.mkdirSync(store.PATHS.template, { recursive: true });
    fs.copyFileSync(asset, target);
    return { seeded: true, path: target };
  } catch {
    return { seeded: false, path: null };
  }
}

// 返回实际使用的来源路径（null = 没找到）
function ensureAppInfo(account, sourceDir) {
  const dir = store.accountDir(account);
  const target = path.join(dir, 'app-info.json');
  if (fs.existsSync(target)) return target;
  for (const candidate of appInfoSources(sourceDir)) {
    try {
      if (!fs.existsSync(candidate)) continue;
      fs.mkdirSync(dir, { recursive: true });
      fs.copyFileSync(candidate, target);
      return candidate;
    } catch {}
  }
  return null;
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

// 一键修复账号：优先补 app-info.json；补不到就把 protocol.version 从 custom 改成内置版本
function repairAccount(id, mode = 'auto') {
  const account = store.findAccount(id);
  if (!account) throw new Error('账号不存在：' + id);
  const dir = store.accountDir(account);
  const appInfo = path.join(dir, 'app-info.json');
  const config = store.readAccountConfig(account);
  if (!config) throw new Error('读不到账号的 config.json：' + path.join(dir, 'config.json'));
  const protocol = config.protocol || {};
  const version = String(protocol.version || '').trim();
  const isCustom = version.toLowerCase() === 'custom';
  const changed = [];

  if (isCustom) {
    // 1) 文件不存在，或存在但内容不是合法 JSON → 从模板/内置补齐
    let needsCopy = !fs.existsSync(appInfo);
    if (!needsCopy) {
      try {
        const parsed = JSON.parse(fs.readFileSync(appInfo, 'utf8'));
        if (!parsed || !parsed.CurrentVersion) needsCopy = true;
      } catch {
        needsCopy = true;
      }
    }
    if (needsCopy) {
      const from = ensureAppInfo(account);
      if (from) changed.push(`已从 ${from} 补齐 app-info.json`);
      else changed.push('没有可用的 app-info.json 模板（assets/app-info.json 缺失）');
    }
  }

  const missing = isCustom && !fs.existsSync(appInfo);
  if ((mode === 'builtin' && isCustom) || (mode === 'auto' && missing)) {
    const os = String(protocol.os || 'Linux');
    const builtinByOs = {
      Linux: '46494',
      Windows: '52194',
      Mac: '52194',
      AndroidPhone: '9.2.80',
      AndroidPad: '9.2.80',
    };
    const target = builtinByOs[os] || '46494';
    config.protocol = { ...protocol, version: target };
    store.writeAccountConfig(account, config);
    changed.push(`protocol.version 从 custom 改为内置版本 ${target}（os=${os}）`);
  }

  return { changed, version: (config.protocol || {}).version, account };
}

// 账号配置体检：一眼看出 app-info.json / 可执行文件 / 协议版本这些坑
function diagnose(id) {
  const account = store.findAccount(id);
  if (!account) throw new Error('账号不存在：' + id);
  const dir = store.accountDir(account);
  const config = store.readAccountConfig(account);
  const protocol = (config && config.protocol) || {};
  const appInfo = path.join(dir, 'app-info.json');
  const sources = appInfoSources().map((item) => ({ path: item, exists: fs.existsSync(item) }));
  return {
    accountId: account.id,
    dir,
    dirExists: fs.existsSync(dir),
    configPath: path.join(dir, 'config.json'),
    configExists: fs.existsSync(path.join(dir, 'config.json')),
    version: protocol.version || null,
    os: protocol.os || null,
    signApiUrl: protocol.signApiUrl || null,
    appInfoPath: appInfo,
    appInfoExists: fs.existsSync(appInfo),
    appInfoSources: sources,
    binary: platform.findBinary(dir),
    binaryNames: platform.binNames(),
  };
}

module.exports = {
  accountConfigTemplate,
  ensureExe,
  ensureAppInfo,
  seedTemplate,
  appInfoSources,
  create,
  importAccount,
  repairAccount,
  diagnose,
  update,
  remove,
  readConfigText,
  writeConfigText,
  newestDistExe,
};
