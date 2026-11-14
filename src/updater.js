'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { EventEmitter } = require('events');
const store = require('./store');
const platform = require('./platform');
const netclient = require('./netclient');
const { extractZip } = require('./zipx');

const UA = 'yogurt-shell/1.0 (+local panel)';

// 只把像版本号的 tag 当版本，避免 local-xxx 这类目录干扰「有没有新版本」的判断
function isVersionTag(tag) {
  return /^v?\d+\.\d+/.test(String(tag || ''));
}

function versionTokens(v) {
  return String(v || '')
    .replace(/^v/i, '')
    .split(/[.\-+_]/)
    .filter(Boolean);
}

function compareVersions(a, b) {
  const ta = versionTokens(a);
  const tb = versionTokens(b);
  const len = Math.max(ta.length, tb.length);
  for (let i = 0; i < len; i++) {
    const x = ta[i];
    const y = tb[i];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    const nx = /^\d+$/.test(x);
    const ny = /^\d+$/.test(y);
    if (nx && ny) {
      const d = Number(x) - Number(y);
      if (d !== 0) return d > 0 ? 1 : -1;
    } else if (x !== y) {
      return x > y ? 1 : -1;
    }
  }
  return 0;
}

// 统一的下载/检查入口：走 netclient，自动带上配置里的代理
function proxyOf() {
  const cfg = store.getConfig();
  return ((cfg.update && cfg.update.proxy) || '').trim();
}

async function fetchJson(url, headers, timeoutMs) {
  return netclient.readJson(url, {
    headers: { 'User-Agent': UA, ...headers },
    timeoutMs,
    proxy: proxyOf(),
  });
}

class Updater extends EventEmitter {
  constructor({ supervisor }) {
    super();
    this.setMaxListeners(0);
    this.supervisor = supervisor;
    this.state = { checking: false, lastCheck: null, latest: null, error: null };
    // 直连 github.com 刚失败过就先走镜像，省得每次白等超时
    this.directBlockedUntil = 0;
    this.progress = {
      phase: 'idle', // idle | checking | downloading | extracting | installing | done | error
      percent: 0,
      received: 0,
      total: 0,
      message: '',
      startedAt: 0,
      updatedAt: 0,
      error: null,
    };
  }

  setProgress(patch) {
    this.progress = { ...this.progress, ...patch, updatedAt: Date.now() };
    if (!this.progress.startedAt) this.progress.startedAt = Date.now();
    this.emit('progress', this.progress);
    return this.progress;
  }

  beginProgress(message) {
    this.progress = {
      phase: 'checking',
      percent: 1,
      received: 0,
      total: 0,
      message,
      startedAt: Date.now(),
      updatedAt: Date.now(),
      error: null,
    };
    this.emit('progress', this.progress);
    return this.progress;
  }

  endProgress(patch = {}) {
    return this.setProgress({ phase: 'done', percent: 100, ...patch });
  }

  failProgress(err) {
    return this.setProgress({ phase: 'error', error: err && err.message ? err.message : String(err), message: '失败' });
  }

  installedDists() {
    try {
      return fs
        .readdirSync(store.PATHS.dist, { withFileTypes: true })
        .filter((d) => d.isDirectory())
        .map((d) => {
          const dir = path.join(store.PATHS.dist, d.name);
          const file = platform.findBinary(dir);
          return { tag: d.name, dir, hasExe: Boolean(file), bin: file ? path.basename(file) : null };
        });
    } catch {
      return [];
    }
  }

  assetName() {
    const cfg = store.getConfig();
    return (cfg.update.asset || '').trim() || platform.assetFor();
  }

  // 面板里下载过的 dist 版本（最新那个；本地安装的 local-xxx 目录不算版本）
  distTag() {
    const cfg = store.getConfig();
    const tags = [];
    if (cfg.update && isVersionTag(cfg.update.installedTag)) tags.push(cfg.update.installedTag);
    const dists = this.installedDists().filter((d) => d.hasExe && isVersionTag(d.tag));
    if (dists.length) tags.push(dists.sort((a, b) => compareVersions(a.tag, b.tag))[dists.length - 1].tag);
    if (!tags.length) return null;
    return tags.sort(compareVersions)[tags.length - 1];
  }

  // 「当前版本」以账号实际跑起来的版本为准（有账号落后就提示可更新）；没有账号时退回 dist 版本
  currentVersion() {
    try {
      const running = this.supervisor.snapshots().map((s) => s.version).filter(Boolean);
      if (running.length) return running.sort(compareVersions)[0];
    } catch {}
    return this.distTag();
  }

  runningVersions() {
    try {
      return this.supervisor.snapshots().map((s) => ({ id: s.id, name: s.name, version: s.version, running: Boolean(s.pid) }));
    } catch {
      return [];
    }
  }

  async check({ force = false } = {}) {
    const cfg = store.getConfig();
    const repo = cfg.update.repo || 'SaltifyDev/yogurt-releases';
    this.state.checking = true;
    this.beginProgress('查询 GitHub Releases…');
    try {
      const json = await fetchJson(
        `https://api.github.com/repos/${repo}/releases/latest`,
        { Accept: 'application/vnd.github+json' },
        30000
      );
      const assetName = this.assetName();
      const asset = (json.assets || []).find((a) => a.name === assetName) || null;
      const current = this.currentVersion();
      const latest = {
        tag: json.tag_name,
        name: json.name,
        publishedAt: json.published_at,
        notes: (json.body || '').split('\n').slice(0, 12).join('\n'),
        assets: (json.assets || []).map((a) => ({ name: a.name, size: a.size })),
        asset: asset ? { name: asset.name, size: asset.size, digest: asset.digest, url: asset.browser_download_url } : null,
        hasUpdate: current ? compareVersions(json.tag_name, current) > 0 : true,
        current,
      };
      this.state.latest = latest;
      this.state.lastCheck = Date.now();
      this.state.error = null;
      this.endProgress({ message: '检查完成：' + latest.tag });
      return latest;
    } catch (err) {
      this.state.error = err.message;
      this.state.lastCheck = Date.now();
      this.failProgress(err);
      throw err;
    } finally {
      this.state.checking = false;
    }
  }

  async download(url, filename, digest) {
    const cfg = store.getConfig();
    const target = path.join(store.PATHS.updates, filename);
    const mirror = (cfg.update.mirrorPrefix || '').trim();
    const withSlash = (p) => p.replace(/\/?$/, '/');

    // 配了 GitHub 代理前缀就先走它（用户既然填了，多半是直连不通），再退直连和内置镜像。
    // 直连刚失败过也挪到最后，省掉每次 15 秒空等。
    const direct = { url, timeoutMs: 15000, mirror: null };
    const mirrorCand = mirror ? { url: withSlash(mirror) + url, timeoutMs: 120000, mirror: withSlash(mirror) } : null;
    const candidates = [];
    if (mirrorCand) candidates.push(mirrorCand);
    candidates.push(direct);
    for (const m of ['https://gh-proxy.com/', 'https://ghfast.top/']) {
      if (mirrorCand && withSlash(m) === mirrorCand.mirror) continue;
      candidates.push({ url: withSlash(m) + url, timeoutMs: 120000, mirror: withSlash(m) });
    }
    if (!mirrorCand && this.directBlockedUntil > Date.now()) {
      const idx = candidates.findIndex((c) => !c.mirror);
      if (idx >= 0) candidates.push(candidates.splice(idx, 1)[0]);
    }

    let lastErr = null;
    for (let index = 0; index < candidates.length; index += 1) {
      const candidate = candidates[index];
      try {
        if (index > 0) {
          this.setProgress({
            phase: 'downloading',
            percent: 2,
            message: '切换下载源：' + (candidate.mirror ? candidate.mirror : '直连 github.com'),
          });
        }
        const res = await netclient.openRequest(candidate.url, { timeoutMs: candidate.timeoutMs, proxy: proxyOf() });
        if (res.status < 200 || res.status >= 300) {
          throw new Error(`HTTP ${res.status}（${candidate.mirror || '直连'}）`);
        }
        const total = Number(res.headers['content-length'] || 0);
        const chunks = [];
        let received = 0;
        this.setProgress({ phase: 'downloading', percent: 3, received: 0, total, message: `开始下载 ${filename}…` });
        for await (const chunk of res.stream) {
          const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
          chunks.push(buf);
          received += buf.length;
          const percent = total > 0 ? 3 + (received / total) * 85 : Math.min(88, 3 + (received / (8 * 1024 * 1024)) * 60);
          this.setProgress({
            phase: 'downloading',
            percent: Math.min(88, percent),
            received,
            total,
            message: `下载 ${filename}：${(received / 1048576).toFixed(1)}${total ? ' / ' + (total / 1048576).toFixed(1) : ''} MB`,
          });
        }
        const data = Buffer.concat(chunks);
        if (digest && /^sha256:/i.test(digest)) {
          this.setProgress({ phase: 'downloading', percent: 89, message: '校验 sha256…' });
          const expected = digest.split(':')[1].toLowerCase();
          const actual = crypto.createHash('sha256').update(data).digest('hex');
          if (actual !== expected) throw new Error('sha256 校验失败，包可能损坏');
        }
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.writeFileSync(target, data);
        if (candidate.mirror && candidate.mirror !== mirror) {
          store.updateConfig((c) => {
            c.update.mirrorPrefix = candidate.mirror;
          });
        }
        return { file: target, size: data.length, source: candidate.url, viaMirror: candidate.mirror };
      } catch (err) {
        lastErr = err;
        if (!candidate.mirror) this.directBlockedUntil = Date.now() + 6 * 3600 * 1000;
      }
    }
    this.failProgress(lastErr || new Error('下载失败'));
    throw lastErr || new Error('下载失败');
  }

  async stage(zipPath, tag) {
    const safeTag = String(tag || 'local-' + Date.now()).replace(/[^\w.\-+]/g, '_');
    this.setProgress({ phase: 'extracting', percent: 90, message: '解压安装包…' });
    const dest = path.join(store.PATHS.dist, safeTag);
    fs.rmSync(dest, { recursive: true, force: true });
    fs.mkdirSync(dest, { recursive: true });
    extractZip(zipPath, dest);
    const bin = platform.findBinary(dest);
    if (!bin) {
      throw new Error(`压缩包里没有 ${platform.binNames().join(' / ')}（可能下错了平台的包，当前是 ${platform.label()}）`);
    }
    platform.ensureExecutable(bin);
    this.setProgress({ phase: 'extracting', percent: 95, message: '安装包校验通过' });
    return { tag: safeTag, dir: dest, exe: bin };
  }

  // 直接用一个本地可执行文件生成 dist 目录（「选择已安装的 yogurt」走这里）
  stageBinary(binPath, tag) {
    const safeTag = String(tag || 'local-' + Date.now()).replace(/[^\w.\-+]/g, '_');
    this.setProgress({ phase: 'extracting', percent: 88, message: '准备本地可执行文件…' });
    const dest = path.join(store.PATHS.dist, safeTag);
    fs.rmSync(dest, { recursive: true, force: true });
    fs.mkdirSync(dest, { recursive: true });
    const target = path.join(dest, path.basename(binPath));
    fs.copyFileSync(binPath, target); // 用复制而不是硬链：不要把用户原目录里的文件绑在一起
    platform.ensureExecutable(target);
    this.setProgress({ phase: 'extracting', percent: 95, message: '已复制到面板的 dist 目录' });
    return { tag: safeTag, dir: dest, exe: target };
  }

  // 把 dist 里的可执行文件装到账号目录（优先硬链接，省磁盘；不行就复制）
  installExeForAccount(account, distExe) {
    const dir = store.accountDir(account);
    fs.mkdirSync(dir, { recursive: true });
    const target = path.join(dir, path.basename(distExe));
    const backupDir = store.PATHS.backups;
    fs.mkdirSync(backupDir, { recursive: true });
    const current = platform.findBinary(dir);
    if (current) {
      const oldVersion = this.currentVersion() || 'unknown';
      const backup = path.join(backupDir, `${account.id}-${oldVersion}-${Date.now()}${path.extname(current)}`);
      try {
        fs.copyFileSync(current, backup);
      } catch {}
      fs.rmSync(current, { force: true });
    }
    let linked = false;
    try {
      fs.linkSync(distExe, target);
      linked = true;
    } catch {
      fs.copyFileSync(distExe, target);
    }
    platform.ensureExecutable(target);
    return { target, linked };
  }

  async installStaged(staged, { restartRunning = true } = {}) {
    const cfg = store.getConfig();
    const results = [];
    const total = Math.max(1, cfg.accounts.length);
    for (let i = 0; i < cfg.accounts.length; i += 1) {
      const account = cfg.accounts[i];
      this.setProgress({
        phase: 'installing',
        percent: Math.min(99, 95 + (i / total) * 4),
        message: `替换 ${account.name || account.id} 的可执行文件（${i + 1}/${total}）`,
      });
      const snap = this.supervisor.snapshot(account);
      const wasRunning = Boolean(snap.pid);
      if (wasRunning) await this.supervisor.stop(account.id, '升级到 ' + staged.tag);
      const info = this.installExeForAccount(account, staged.exe);
      let started = false;
      if (wasRunning && restartRunning) {
        try {
          await this.supervisor.start(account.id);
          started = true;
        } catch {}
      }
      results.push({ accountId: account.id, exe: info.target, linked: info.linked, wasRunning, started });
    }
    return { tag: staged.tag, distDir: staged.dir, accounts: results };
  }

  async install({ zipPath, tag, restartRunning = true }) {
    try {
      const staged = await this.stage(zipPath, tag);
      const result = await this.installStaged(staged, { restartRunning });
      store.updateConfig((c) => {
        c.update.installedTag = staged.tag;
        c.update.installedAt = Date.now();
        c.update.installedZip = zipPath;
      });
      this.endProgress({ message: `已安装 ${staged.tag}` });
      return result;
    } catch (err) {
      this.failProgress(err);
      throw err;
    }
  }

  // 本地来源：已安装目录 / 可执行文件 / 本地 zip（不发请求、不联网）
  async installFromSource({ sourcePath, tag, restartRunning = true }) {
    try {
      const raw = String(sourcePath || '').trim();
      if (!raw) throw new Error('请提供 yogurt 路径');
      const src = path.resolve(raw);
      if (!fs.existsSync(src)) throw new Error('路径不存在：' + raw);
      const stat = fs.statSync(src);
      let staged;
      if (stat.isDirectory()) {
        const bin = platform.findBinary(src);
        if (!bin) throw new Error(`目录里找不到 ${platform.binNames().join(' / ')}：${src}`);
        staged = this.stageBinary(bin, tag || 'local-' + path.basename(src).replace(/[^\w.\-+]/g, '_'));
      } else if (/\.zip$/i.test(src)) {
        staged = await this.stage(src, tag || 'local-zip-' + Date.now());
      } else if (platform.binNames().includes(path.basename(src))) {
        staged = this.stageBinary(src, tag || 'local-bin-' + Date.now());
      } else {
        throw new Error(`无法识别：${src}（要 ${platform.binNames().join(' / ')}、包含它的目录，或 .zip）`);
      }
      const result = await this.installStaged(staged, { restartRunning });
      store.updateConfig((c) => {
        c.update.lastLocalInstall = { at: Date.now(), source: src, tag: staged.tag };
      });
      this.pruneLocalDists(2);
      this.endProgress({ message: '已从本地安装：' + staged.tag });
      return result;
    } catch (err) {
      this.failProgress(err);
      throw err;
    }
  }

  // 本地安装会在 data/dist 下堆出 local-xxx 目录，只留最近几个，避免白占几十 MB
  pruneLocalDists(keep = 2) {
    try {
      const locals = this.installedDists()
        .filter((d) => !isVersionTag(d.tag))
        .map((d) => ({ dir: d.dir, t: fs.statSync(d.dir).mtimeMs }))
        .sort((a, b) => b.t - a.t);
      for (const item of locals.slice(keep)) {
        fs.rmSync(item.dir, { recursive: true, force: true });
      }
    } catch {}
  }

  // 本机可选的 yogurt 来源（已下载的 dist、updates 里的 zip、同级目录、账号导入来源）
  listSources() {
    const list = [];
    const seen = new Set();
    const push = (item) => {
      const key = String(item.path).toLowerCase();
      if (seen.has(key)) return;
      seen.add(key);
      list.push(item);
    };
    for (const d of this.installedDists()) {
      if (d.hasExe) push({ path: d.dir, kind: 'dist', tag: d.tag, note: `面板已下载（${d.tag}）` });
    }
    try {
      for (const f of fs.readdirSync(store.PATHS.updates)) {
        if (!/\.zip$/i.test(f)) continue;
        const full = path.join(store.PATHS.updates, f);
        let size = 0;
        try {
          size = fs.statSync(full).size;
        } catch {}
        push({ path: full, kind: 'zip', tag: '', note: `已下载的压缩包（${(size / 1048576).toFixed(1)} MB）` });
      }
    } catch {}
    const parent = path.dirname(store.ROOT);
    try {
      for (const entry of fs.readdirSync(parent, { withFileTypes: true })) {
        if (!entry.isDirectory() || !/yogurt/i.test(entry.name)) continue;
        const dir = path.join(parent, entry.name);
        if (dir === store.ROOT) continue;
        if (platform.findBinary(dir)) push({ path: dir, kind: 'dir', tag: '', note: '项目同级的已安装目录' });
      }
    } catch {}
    for (const account of store.getConfig().accounts) {
      const m = /从现有目录导入：(.+)$/.exec(account.note || '');
      if (!m) continue;
      const dir = m[1].trim();
      try {
        if (fs.existsSync(dir) && platform.findBinary(dir)) {
          push({ path: dir, kind: 'dir', tag: '', note: `${account.name || account.id} 的导入来源` });
        }
      } catch {}
    }
    return list;
  }
}

module.exports = { Updater, compareVersions, versionTokens, isVersionTag };
