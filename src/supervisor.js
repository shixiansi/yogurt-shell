'use strict';

const fs = require('fs');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');
const { EventEmitter } = require('events');
const store = require('./store');
const platform = require('./platform');

const STATUS_LABEL = {
  stopped: '已停止',
  starting: '启动中',
  login: '登录中',
  online: '在线',
  offline: '掉线停机',
  crashed: '异常退出',
  stopping: '停止中',
};

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// 进程守护：只管生命周期、状态机、掉线判定。
class Supervisor extends EventEmitter {
  constructor({ bus }) {
    super();
    this.setMaxListeners(0);
    this.bus = bus;
    this.runtime = new Map();
    this.shuttingDown = false;
  }

  cfg() {
    return store.getConfig();
  }

  exeFor(account) {
    const cfg = this.cfg();
    const dir = store.accountDir(account);
    if (cfg.yogurt.exePath) {
      const p = path.isAbsolute(cfg.yogurt.exePath) ? cfg.yogurt.exePath : path.join(store.DATA_DIR, cfg.yogurt.exePath);
      if (fs.existsSync(p)) return p;
    }
    // Windows: yogurt.exe；Linux/macOS: yogurt.kexe 或 yogurt
    return platform.findBinary(dir) || path.join(dir, platform.defaultBinName());
  }

  rt(id) {
    let r = this.runtime.get(String(id));
    if (!r) {
      r = {
        id: String(id),
        status: 'stopped',
        pid: null,
        proc: null,
        startedAt: null,
        stoppedAt: null,
        exitCode: null,
        version: null,
        reason: null,
        probeFailures: 0,
        lastProbeAt: 0,
        lastProbeError: null,
        lastOnlineAt: null,
        graceUntil: 0,
        intentionalStop: false,
        restartTimer: null,
        stdoutBuf: '',
        stderrBuf: '',
        lastLine: null,
      };
      this.runtime.set(String(id), r);
    }
    return r;
  }

  // ---- 对外快照 ----
  snapshot(account) {
    const r = this.rt(account.id);
    return {
      id: account.id,
      name: account.name,
      port: account.port,
      host: account.host || '127.0.0.1',
      dir: account.dir,
      enabled: account.enabled !== false,
      autoStart: account.autoStart !== false,
      autoRestart: account.autoRestart === true,
      status: r.status,
      statusLabel: STATUS_LABEL[r.status] || r.status,
      pid: r.pid,
      uptimeMs: r.startedAt ? Date.now() - r.startedAt : 0,
      startedAt: r.startedAt,
      stoppedAt: r.stoppedAt,
      exitCode: r.exitCode,
      version: r.version,
      reason: r.reason,
      probeFailures: r.probeFailures,
      lastProbeError: r.lastProbeError,
      lastOnlineAt: r.lastOnlineAt,
      lastLine: r.lastLine,
      exe: this.exeFor(account),
    };
  }

  snapshots() {
    return store.getConfig().accounts.map((a) => this.snapshot(a));
  }

  runningPids() {
    const pids = [];
    for (const r of this.runtime.values()) {
      if (r.proc && r.pid && (r.status === 'starting' || r.status === 'login' || r.status === 'online' || r.status === 'stopping')) {
        pids.push(r.pid);
      }
    }
    return pids;
  }

  syncPortFromConfig(account) {
    const ac = store.readAccountConfig(account);
    const httpCfg = ac && ac.milky && ac.milky.http;
    if (httpCfg) {
      let changed = false;
      if (httpCfg.port && Number(httpCfg.port) !== Number(account.port)) {
        account.port = Number(httpCfg.port);
        changed = true;
      }
      if (httpCfg.host && httpCfg.host !== account.host) {
        account.host = httpCfg.host;
        changed = true;
      }
      if ((httpCfg.accessToken || '') !== (account.accessToken || '')) {
        account.accessToken = httpCfg.accessToken || '';
        changed = true;
      }
      if (changed) store.save();
    }
    return account;
  }

  // ---- 启动 ----
  async start(id, { silent = false } = {}) {
    const account = store.findAccount(id);
    if (!account) throw new Error('账号不存在：' + id);
    const r = this.rt(id);
    if (r.proc) throw new Error('账号已在运行中（pid ' + r.pid + '）');

    const exe = this.exeFor(account);
    if (!fs.existsSync(exe)) {
      throw new Error(
        `找不到 yogurt 可执行文件：${exe}（${process.platform === 'win32' ? 'yogurt.exe' : 'yogurt.kexe'}；可用「更新 / 安装」把它装到账号目录）`
      );
    }
    this.syncPortFromConfig(account);
    const target = this.resolveTarget(account);

    const dir = store.accountDir(account);
    fs.mkdirSync(dir, { recursive: true });

    // protocol.version = custom 时 yogurt 必须在账号目录里找到 app-info.json，否则直接 SIGABRT
    const accountConfig = store.readAccountConfig(account) || {};
    const protocolVersion = String((accountConfig.protocol && accountConfig.protocol.version) || '').trim();
    if (protocolVersion.toLowerCase() === 'custom') {
      const { ensureAppInfo } = require('./accounts');
      const appInfo = path.join(dir, 'app-info.json');
      const healed = ensureAppInfo(account);
      if (!healed) {
        throw new Error(
          `账号目录缺少 app-info.json（protocol.version = custom 时必需）：${appInfo}。` +
            '修法二选一：① 卡片「配置」里把 protocol.version 改成内置版本（Linux 46494 或 39038，Mac 52194 或 52892）；' +
            '② 把 app-info.json 放进账号目录（仓库自带模板在 assets/app-info.json，面板也会自动补）'
        );
      }
      if (healed !== appInfo) {
        this.pushLog(account, 'WARN', `[shell] 账号缺少 app-info.json，已自动从 ${healed} 补齐`);
      }
    }

    const env = { ...process.env };

    const child = spawn(exe, [], {
      cwd: dir,
      env,
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
      detached: process.platform !== 'win32',
    });

    r.proc = child;
    r.pid = child.pid;
    r.status = 'starting';
    r.startedAt = Date.now();
    r.stoppedAt = null;
    r.exitCode = null;
    r.reason = null;
    r.probeFailures = 0;
    r.lastProbeError = null;
    r.target = target;
    r.intentionalStop = false;
    r.stdoutBuf = '';
    r.stderrBuf = '';
    r.graceUntil = Date.now() + (this.cfg().yogurt.probe.graceMs || 90000);
    r.version = null;
    this.emitState(account, r);

    const onData = (chunk, isErr) => {
      const key = isErr ? 'stderrBuf' : 'stdoutBuf';
      r[key] += chunk.toString('utf8');
      let idx;
      while ((idx = r[key].indexOf('\n')) >= 0) {
        const line = r[key].slice(0, idx);
        r[key] = r[key].slice(idx + 1);
        if (line.trim()) this.handleLine(account, r, line);
      }
      if (r[key].length > 64 * 1024) r[key] = r[key].slice(-8192);
    };
    child.stdout.on('data', (d) => onData(d, false));
    child.stderr.on('data', (d) => onData(d, true));

    child.on('error', (err) => {
      this.pushLog(account, 'ERROR', '[shell] 进程启动失败：' + err.message);
      r.lastProbeError = err.message;
    });

    child.on('exit', (code, signal) => {
      const wasIntentional = r.intentionalStop || this.shuttingDown;
      r.proc = null;
      r.pid = null;
      r.exitCode = code;
      r.stoppedAt = Date.now();
      this.pushLog(
        account,
        code === 0 || wasIntentional ? 'INFO' : 'ERROR',
        `[shell] 进程退出 code=${code} signal=${signal || '-'}${wasIntentional ? '（主动停止）' : ''}`
      );
      if (wasIntentional) {
        r.status = 'stopped';
        r.reason = r.reason || '手动停止';
      } else {
        r.status = 'crashed';
        r.reason = `进程异常退出（code=${code}${signal ? ' signal=' + signal : ''}）`;
        const hint = this.diagnoseCrash(account);
        if (hint) r.reason += '｜' + hint;
        this.emitIncident(account, {
          type: 'crash',
          title: 'Yogurt 进程异常退出',
          detail: r.reason,
        });
        this.maybeAutoRestart(account, r);
      }
      this.emitState(account, r);
    });

    this.pushLog(account, 'INFO', `[shell] 启动 ${exe}（cwd=${dir}, port=${account.port}）`);
    return this.snapshot(account);
  }

  // 根据最近的日志猜崩溃原因，给面板/邮件一条能照着做的提示
  diagnoseCrash(account) {
    try {
      const text = this.bus
        .tail(account.id, 80)
        .map((line) => line.text)
        .join('\n');
      if (/app-info\.json/i.test(text)) {
        return '提示：账号目录缺少 app-info.json（protocol.version = custom 时必需）——改成内置版本，或放一份 app-info.json';
      }
      if (/Address already in use|EADDRINUSE|端口.*占用/i.test(text)) {
        return '提示：端口被占用，改 milky.http.port 或结束占用该端口的进程';
      }
      if (/签名|signing|signApi/i.test(text) && /(失败|错误|error|invalid|异常)/i.test(text)) {
        return '提示：签名服务可能不可用，检查 security.signApiUrl / pcLagrangeSignToken';
      }
      return null;
    } catch {
      return null;
    }
  }

  maybeAutoRestart(account, r) {    const cfg = this.cfg();
    const enabled = account.autoRestart === true || (account.autoRestart === undefined && cfg.yogurt.autoRestart);
    if (!enabled || this.shuttingDown) return;
    if (r.restartTimer) clearTimeout(r.restartTimer);
    r.restartTimer = setTimeout(() => {
      r.restartTimer = null;
      this.start(account.id).catch((err) => {
        this.pushLog(account, 'ERROR', '[shell] 自动重启失败：' + err.message);
      });
    }, 10000);
  }

  // ---- 停止 ----
  async stop(id, reason = '手动停止') {
    const account = store.findAccount(id);
    if (!account) throw new Error('账号不存在：' + id);
    const r = this.rt(id);
    if (!r.proc) {
      r.status = 'stopped';
      r.reason = reason;
      r.stoppedAt = Date.now();
      this.emitState(account, r);
      return this.snapshot(account);
    }
    r.intentionalStop = true;
    r.status = 'stopping';
    r.reason = reason;
    if (r.restartTimer) {
      clearTimeout(r.restartTimer);
      r.restartTimer = null;
    }
    this.emitState(account, r);
    const pid = r.pid;
    this.pushLog(account, 'WARN', `[shell] 停止进程 pid=${pid}（${reason}）`);
    this.killTree(pid);
    const deadline = Date.now() + (this.cfg().yogurt.killTimeoutMs || 8000);
    while (r.proc && Date.now() < deadline) await sleep(150);
    if (r.proc) {
      this.pushLog(account, 'ERROR', '[shell] 进程未退出，强制结束');
      this.killTree(pid);
      await sleep(600);
    }
    if (!r.proc) {
      r.status = r.status === 'offline' ? 'offline' : 'stopped';
      this.emitState(account, r);
    }
    return this.snapshot(account);
  }

  killTree(pid) {
    if (!pid) return;
    const { killPid } = require('./procs');
    killPid(pid).catch(() => {});
  }

  async restart(id) {
    await this.stop(id, '重启');
    await sleep(500);
    return this.start(id);
  }

  sendInput(id, text) {
    const r = this.rt(id);
    if (!r.proc || !r.proc.stdin || r.proc.stdin.destroyed) throw new Error('进程未运行，无法发送输入');
    r.proc.stdin.write(String(text) + '\n');
    this.pushLog(store.findAccount(id), 'INFO', '[shell] 已向进程标准输入发送：' + text);
    return true;
  }

  // ---- 日志处理：版本、在线、登录、掉线特征 ----
  handleLine(account, r, rawLine) {
    const entry = this.bus.append(account.id, rawLine);
    if (!entry) return;
    r.lastLine = { t: entry.t, text: entry.text };
    this.emit('log', { accountId: account.id, entry });

    const text = entry.text;
    const isChatLog = /Logging \[/.test(text);

    const vm = text.match(/Yogurt v([0-9A-Za-z.\-+]+)/);
    if (vm && r.version !== vm[1]) {
      r.version = vm[1];
      this.emitState(account, r);
    }

    if (isChatLog) return; // 聊天内容不参与判定，避免群友聊到「掉线」被误杀

    const cfg = this.cfg().yogurt;

    if (r.status === 'starting') {
      for (const p of cfg.loginPatterns || []) {
        if (text.includes(p)) {
          r.status = 'login';
          r.reason = '等待扫码/验证码登录';
          this.emitState(account, r);
          break;
        }
      }
    }

    for (const p of cfg.onlinePatterns || []) {
      if (text.includes(p) && r.status !== 'online') {
        r.status = 'online';
        r.reason = null;
        r.lastOnlineAt = Date.now();
        r.probeFailures = 0;
        this.emitState(account, r);
        break;
      }
    }

    if (r.status === 'online' || r.status === 'login' || r.status === 'starting') {
      for (const p of cfg.offlinePatterns || []) {
        if (text.includes(p)) {
          this.markOffline(account, `日志命中掉线特征「${p}」`, { kill: true });
          break;
        }
      }
    }
  }

  pushLog(account, level, text) {
    if (!account) return;
    const entry = this.bus.append(account.id, `${new Date().toLocaleTimeString('zh-CN', { hour12: false })} ${level} ${text}`);
    if (entry) this.emit('log', { accountId: account.id, entry });
  }

  emitState(account, r) {
    this.emit('state', { account, snapshot: this.snapshot(account) });
  }

  emitIncident(account, incident) {
    this.emit('incident', { account, snapshot: this.snapshot(account), ...incident });
  }

  // ---- 掉线：停进程 + 通知 ----
  async markOffline(account, reason, opts = {}) {
    const r = this.rt(account.id);
    if (r.status === 'offline') return;
    r.probeFailures = 0;
    const before = this.snapshot(account);
    r.status = 'offline';
    r.reason = reason;
    this.pushLog(account, 'ERROR', `[shell] 判定掉线：${reason}`);
    this.emitState(account, r);
    if (opts.kill !== false) {
      await this.stop(account.id, '掉线停机：' + reason);
      r.status = 'offline';
      r.reason = reason;
      this.emitState(account, r);
    }
    this.emitIncident(account, {
      type: 'offline',
      title: 'Yogurt 账号掉线，已停止进程',
      detail: reason,
      snapshot: before,
    });
  }

  resolveTarget(account) {
    const ac = store.readAccountConfig(account) || {};
    const httpCfg = (ac.milky && ac.milky.http) || {};
    const host = httpCfg.host || account.host || '127.0.0.1';
    const port = httpCfg.port || account.port;
    const prefix = httpCfg.prefix || '';
    const token = httpCfg.accessToken || account.accessToken || '';
    return {
      host,
      port,
      prefix,
      token,
      url: `http://${host === '0.0.0.0' ? '127.0.0.1' : host}:${port}${prefix}/api/get_login_info`,
    };
  }

  // ---- 探活 ----
  probeAccount(account) {
    const r = this.rt(account.id);
    if (!r.proc) return Promise.resolve(false);
    // 用启动时快照的目标地址，避免运行中改配置导致误判掉线（改配置需重启生效）
    const target = r.target || this.resolveTarget(account);
    const timeout = this.cfg().yogurt.probe.timeoutMs || 8000;

    return new Promise((resolve) => {
      const body = JSON.stringify({});
      const req = http.request(
        target.url,
        {
          method: 'POST',
          timeout,
          headers: {
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(body),
            ...(target.token ? { Authorization: 'Bearer ' + target.token } : {}),
          },
        },
        (res) => {
          let data = '';
          res.setEncoding('utf8');
          res.on('data', (c) => (data += c));
          res.on('end', () => {
            let json = null;
            try {
              json = JSON.parse(data);
            } catch {}
            const ok = res.statusCode === 200 && json && json.status === 'ok' && json.retcode === 0;
            if (ok) {
              r.lastProbeError = null;
              if (json.data && json.data.uin && String(json.data.uin) !== String(account.id)) {
                r.lastProbeError = `探活返回的 uin(${json.data.uin}) 与账号(${account.id}) 不一致`;
              }
            } else {
              r.lastProbeError = `HTTP ${res.statusCode} ${String(data).slice(0, 160)}`;
            }
            resolve(Boolean(ok));
          });
        }
      );
      req.on('timeout', () => {
        r.lastProbeError = '探活超时';
        req.destroy();
        resolve(false);
      });
      req.on('error', (err) => {
        r.lastProbeError = err.code || err.message;
        resolve(false);
      });
      req.end(body);
    });
  }

  async tick() {
    if (this.ticking) return; // 上一轮探活还没结束，跳过，避免重复计数
    this.ticking = true;
    try {
      await this.tickOnce();
    } finally {
      this.ticking = false;
    }
  }

  async tickOnce() {
    const cfg = this.cfg();
    const probe = cfg.yogurt.probe;
    const accounts = cfg.accounts;
    const now = Date.now();
    for (const account of accounts) {
      const r = this.rt(account.id);
      if (!r.proc) continue;
      if (r.status !== 'starting' && r.status !== 'login' && r.status !== 'online') continue;
      if (now < r.graceUntil) continue;
      if (now - r.lastProbeAt < (probe.intervalMs || 15000)) continue;
      r.lastProbeAt = now;
      const ok = await this.probeAccount(account);
      if (ok) {
        if (r.status !== 'online') {
          r.status = 'online';
          r.reason = null;
          r.lastOnlineAt = now;
          this.emitState(account, r);
        }
        r.probeFailures = 0;
        continue;
      }
      // 登录中（等人扫码/输验证码）不计入失败
      if (r.status === 'login') continue;
      r.probeFailures += 1;
      this.emitState(account, r);
      if (r.probeFailures >= (probe.failures || 3)) {
        await this.markOffline(account, `接口探活连续失败 ${r.probeFailures} 次（最后错误：${r.lastProbeError || '无响应'}）`);
      }
    }
  }

  async startAll() {
    for (const account of this.cfg().accounts) {
      if (account.autoStart === false) continue;
      if (account.enabled === false) continue;
      try {
        await this.start(account.id);
        await sleep(800);
      } catch (err) {
        this.pushLog(account, 'ERROR', '[shell] 自动启动失败：' + err.message);
      }
    }
  }

  // 面板被强杀时，子进程可能变孤儿并占着端口；启动时先清掉本面板账号目录下的残留
  async cleanupOrphans() {
    const { listYogurtProcesses, killPid } = require('./procs');
    const procs = await listYogurtProcesses();
    const killed = [];
    for (const p of procs) {
      const exe = String(p.exePath || '');
      if (!exe) continue;
      if (!exe.toLowerCase().startsWith(store.DATA_DIR.toLowerCase())) continue;
      const account = this.cfg().accounts.find((a) => {
        try {
          return exe.toLowerCase().startsWith(store.accountDir(a).toLowerCase());
        } catch {
          return false;
        }
      });
      await killPid(p.pid);
      killed.push({ pid: p.pid, exe });
      if (account) this.pushLog(account, 'WARN', `[shell] 清理上次面板遗留的进程 pid=${p.pid}`);
    }
    return killed;
  }

  async stopAll() {
    this.shuttingDown = true;
    for (const r of this.runtime.values()) {
      if (r.restartTimer) clearTimeout(r.restartTimer);
    }
    for (const account of this.cfg().accounts) {
      const r = this.rt(account.id);
      if (r.proc) {
        r.intentionalStop = true;
        try {
          await this.stop(account.id, '面板退出');
        } catch {}
      }
    }
  }
}

module.exports = { Supervisor, STATUS_LABEL };
