'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { EventEmitter } = require('events');
const store = require('./store');
const { findPowerShell } = require('./procs');
const procfs = require('./sampler-linux');

const CORES = Math.max(1, os.cpus().length);
const HISTORY = 90; // 3s * 90 = 4.5 分钟

// 采样后端：
//   Windows → 常驻一个 PowerShell 进程，每 3s 输出一行 NDJSON（Get-Process）
//   Linux   → 直接读 /proc/<pid>/{stat,status,fd}，无子进程
// 两者输出同一种结构，交给 ingest() 统一算百分比、存历史。
class Metrics extends EventEmitter {
  constructor() {
    super();
    this.setMaxListeners(0);
    this.mode = process.platform === 'win32' ? 'powershell' : process.platform === 'linux' ? 'procfs' : 'unsupported';
    this.child = null;
    this.timer = null;
    this.buf = '';
    this.pids = [];
    this.pidToAccount = new Map();
    this.prev = new Map(); // pid -> {cpuSeconds, t}
    this.history = new Map(); // accountId -> [{t, cpu, mem}]
    this.last = new Map(); // accountId -> sample
    this.restartTimer = null;
    this.failures = 0;
    this.stopped = false;
    this.disabled = null;
  }

  setAccounts(snapshots) {
    this.pidToAccount.clear();
    const pids = [];
    for (const s of snapshots) {
      if (s.pid) {
        this.pidToAccount.set(s.pid, s.id);
        pids.push(s.pid);
      }
    }
    const changed = pids.length !== this.pids.length || pids.some((p, i) => p !== this.pids[i]);
    this.pids = pids;
    if (changed && this.mode === 'powershell') this.writePids();
  }

  writePids() {
    try {
      const file = store.PATHS.pids;
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const tmp = file + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify({ pids: this.pids, t: Date.now() }), 'utf8');
      fs.renameSync(tmp, file);
    } catch {}
  }

  start() {
    if (this.mode === 'powershell') return this.startWindows();
    if (this.mode === 'procfs') return this.startProcfs();
    this.disabled = `当前平台（${process.platform}）暂未实现资源采样`;
  }

  // ---- Linux ----
  startProcfs() {
    if (this.timer) return;
    const tick = () => {
      if (this.stopped) return;
      try {
        this.ingest(procfs.sampleMany(this.pids));
      } catch (err) {
        this.disabled = '采样失败：' + err.message;
      }
    };
    tick();
    this.timer = setInterval(tick, 3000);
  }

  // ---- Windows ----
  startWindows() {
    if (this.child) return;
    this.writePids();
    const exe = findPowerShell();
    const script = path.join(store.ROOT, 'scripts', 'win-sampler.ps1');
    let child;
    try {
      child = spawn(
        exe,
        ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script, '-TrackFile', store.PATHS.pids, '-IntervalMs', '3000'],
        { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }
      );
    } catch (err) {
      this.disabled = '采样器启动失败：' + err.message;
      return;
    }
    this.child = child;

    child.on('error', (err) => {
      this.disabled = '采样器启动失败：' + err.message;
      this.child = null;
      this.failures += 1;
      if (this.failures <= 3 && !this.stopped) {
        if (this.restartTimer) clearTimeout(this.restartTimer);
        this.restartTimer = setTimeout(() => this.start(), 5000);
      }
    });

    child.stdout.on('data', (chunk) => {
      this.buf += chunk.toString('utf8');
      let idx;
      while ((idx = this.buf.indexOf('\n')) >= 0) {
        const line = this.buf.slice(0, idx).trim();
        this.buf = this.buf.slice(idx + 1);
        if (line) this.onSamplerLine(line);
      }
    });

    child.stderr.on('data', (d) => {
      const text = d.toString('utf8').trim();
      if (text) this.emit('sampler-error', text);
    });

    child.on('exit', () => {
      this.child = null;
      if (this.stopped) return;
      this.failures += 1;
      if (this.restartTimer) clearTimeout(this.restartTimer);
      const delay = Math.min(30000, 2000 * this.failures);
      this.restartTimer = setTimeout(() => this.start(), delay);
    });
  }

  onSamplerLine(line) {
    let payload;
    try {
      payload = JSON.parse(line);
    } catch {
      return;
    }
    this.ingest(payload);
  }

  // ---- 统一样本处理 ----
  ingest(payload) {
    const t = payload.t || Date.now();
    const items = Array.isArray(payload.items) ? payload.items : [];
    this.disabled = null;
    for (const item of items) {
      const accountId = this.pidToAccount.get(item.pid);
      if (!accountId) continue;
      if (item.alive === false) {
        this.prev.delete(item.pid);
        continue;
      }
      const cpuSeconds = Number(item.cpuSeconds != null ? item.cpuSeconds : item.cpu) || 0;
      const prev = this.prev.get(item.pid);
      let cpuPercent = 0;
      if (prev && t > prev.t) {
        const wall = (t - prev.t) / 1000;
        if (wall > 0) cpuPercent = ((cpuSeconds - prev.cpuSeconds) / wall) * 100 / CORES;
      }
      if (cpuPercent < 0 || !Number.isFinite(cpuPercent)) cpuPercent = 0;
      this.prev.set(item.pid, { cpuSeconds, t });
      const sample = {
        t,
        cpu: Number(cpuPercent.toFixed(1)),
        mem: Math.round((item.ws || 0) / (1024 * 1024)),
        memPrivate: Math.round((item.priv || 0) / (1024 * 1024)),
        threads: item.threads || 0,
        handles: item.handles || 0,
      };
      this.last.set(accountId, sample);
      const hist = this.history.get(accountId) || [];
      hist.push({ t: sample.t, cpu: sample.cpu, mem: sample.mem });
      while (hist.length > HISTORY) hist.shift();
      this.history.set(accountId, hist);
    }
    this.failures = 0;
    this.emit('sample', { t, last: Object.fromEntries(this.last) });
  }

  series(accountId) {
    return this.history.get(accountId) || [];
  }

  current(accountId) {
    return this.last.get(accountId) || null;
  }

  stop() {
    this.stopped = true;
    if (this.restartTimer) clearTimeout(this.restartTimer);
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    if (this.child) {
      try {
        this.child.kill();
      } catch {}
      this.child = null;
    }
  }
}

module.exports = { Metrics, CORES };
