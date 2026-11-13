'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const store = require('./store');
const platform = require('./platform');
const { extractZip } = require('./zipx');

const UA = 'yogurt-shell/1.0 (+local panel)';

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

async function fetchWithTimeout(url, opts = {}, timeoutMs = 20000) {
  const res = await fetch(url, {
    ...opts,
    headers: { 'User-Agent': UA, Accept: '*/*', ...(opts.headers || {}) },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`HTTP ${res.status} ${res.statusText} ${String(text).slice(0, 200)}`);
  }
  return res;
}

class Updater {
  constructor({ supervisor }) {
    this.supervisor = supervisor;
    this.state = { checking: false, lastCheck: null, latest: null, error: null };
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

  // 面板里下载过的 dist 版本（最新那个）
  distTag() {
    const cfg = store.getConfig();
    const tags = [];
    if (cfg.update && cfg.update.installedTag) tags.push(cfg.update.installedTag);
    const dists = this.installedDists().filter((d) => d.hasExe);
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
    try {
      const res = await fetchWithTimeout(`https://api.github.com/repos/${repo}/releases/latest`, {
        headers: { Accept: 'application/vnd.github+json' },
      });
      const json = await res.json();
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
      return latest;
    } catch (err) {
      this.state.error = err.message;
      this.state.lastCheck = Date.now();
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

    // 国内网络常见情况：api.github.com 可用，但 github.com 被墙 → 自动走镜像
    const candidates = [{ url, timeoutMs: 15000, mirror: null }];
    if (mirror) candidates.push({ url: withSlash(mirror) + url, timeoutMs: 120000, mirror: withSlash(mirror) });
    for (const m of ['https://gh-proxy.com/', 'https://ghfast.top/']) {
      candidates.push({ url: withSlash(m) + url, timeoutMs: 120000, mirror: withSlash(m) });
    }

    let lastErr = null;
    for (const candidate of candidates) {
      try {
        const res = await fetchWithTimeout(candidate.url, {}, candidate.timeoutMs);
        const arrayBuf = await res.arrayBuffer();
        const data = Buffer.from(arrayBuf);
        if (digest && /^sha256:/i.test(digest)) {
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
      }
    }
    throw lastErr || new Error('下载失败');
  }

  async stage(zipPath, tag) {
    const safeTag = String(tag || 'local-' + Date.now()).replace(/[^\w.\-+]/g, '_');
    const dest = path.join(store.PATHS.dist, safeTag);
    fs.rmSync(dest, { recursive: true, force: true });
    fs.mkdirSync(dest, { recursive: true });
    extractZip(zipPath, dest);
    const bin = platform.findBinary(dest);
    if (!bin) {
      throw new Error(`压缩包里没有 ${platform.binNames().join(' / ')}（可能下错了平台的包，当前是 ${platform.label()}）`);
    }
    platform.ensureExecutable(bin);
    return { tag: safeTag, dir: dest, exe: bin };
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

  async install({ zipPath, tag, restartRunning = true }) {
    const cfg = store.getConfig();
    const staged = await this.stage(zipPath, tag);
    const results = [];
    for (const account of cfg.accounts) {
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
    store.updateConfig((c) => {
      c.update.installedTag = staged.tag;
      c.update.installedAt = Date.now();
      c.update.installedZip = zipPath;
    });
    return { tag: staged.tag, distDir: staged.dir, accounts: results };
  }
}

module.exports = { Updater, compareVersions, versionTokens };
