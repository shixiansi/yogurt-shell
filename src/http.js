'use strict';

const fs = require('fs');
const path = require('path');
const http = require('http');
const { URL } = require('url');
const store = require('./store');
const accountsMod = require('./accounts');
const { listenAddresses, describeMismatch } = require('./listen');
const selfupdate = require('./selfupdate');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

function sendJson(res, code, data) {
  const body = JSON.stringify(data);
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

function readBody(req, limit = 2 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        reject(new Error('请求体过大'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

async function readJson(req, limit) {
  const buf = await readBody(req, limit);
  if (!buf.length) return {};
  try {
    return JSON.parse(buf.toString('utf8'));
  } catch (err) {
    throw new Error('JSON 解析失败：' + err.message);
  }
}

function maskMail(mail) {
  return { ...mail, pass: mail.pass ? '••••••••' : '' };
}

// 二维码文件名不写死：不同版本的 yogurt 可能叫 qrcode.png / qr.png / qrcode.jpg…
const QR_MIME = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
};

function findQrFile(dir) {
  const preferred = ['qrcode.png', 'qr.png', 'qrcode.jpg', 'qrcode.jpeg', 'qr.jpg'];
  for (const name of preferred) {
    const file = path.join(dir, name);
    try {
      if (fs.statSync(file).isFile()) return { file, mime: QR_MIME[path.extname(file).toLowerCase()] || 'image/png' };
    } catch {}
  }
  // 兜底：目录里文件名带 qr 的图片，取最新的那个
  try {
    const candidates = fs
      .readdirSync(dir)
      .filter((name) => /qr/i.test(name) && QR_MIME[path.extname(name).toLowerCase()])
      .map((name) => {
        const file = path.join(dir, name);
        return { file, mime: QR_MIME[path.extname(name).toLowerCase()], t: fs.statSync(file).mtimeMs };
      })
      .sort((a, b) => b.t - a.t);
    if (candidates.length) return { file: candidates[0].file, mime: candidates[0].mime };
  } catch {}
  return null;
}

function createServer(ctx) {
  const { supervisor, metrics, notifier, bus, updater, meta } = ctx;
  const sseClients = new Set();
  const logClients = new Map(); // accountId -> Set<res>
  const publicDir = path.join(store.ROOT, 'public');

  function broadcast(payload) {
    const frame = 'data: ' + JSON.stringify(payload) + '\n\n';
    for (const res of sseClients) {
      try {
        res.write(frame);
      } catch {}
    }
  }

  supervisor.on('state', ({ snapshot }) => broadcast({ type: 'state', account: snapshot }));
  supervisor.on('log', ({ accountId, entry }) => {
    const set = logClients.get(accountId);
    if (!set) return;
    const frame = 'data: ' + JSON.stringify({ type: 'line', accountId, entry }) + '\n\n';
    for (const res of set) {
      try {
        res.write(frame);
      } catch {}
    }
  });
  metrics.on('sample', (data) => broadcast({ type: 'metrics', ...data }));
  notifier.on('event', (event) => broadcast({ type: 'event', event }));
  updater.on('progress', (progress) => broadcast({ type: 'update-progress', progress }));

  function requireAuth(req, url) {
    const token = (store.getConfig().panel.token || '').trim();
    if (!token) return true;
    const header = req.headers['x-panel-token'];
    const query = url.searchParams.get('token');
    const cookie = req.headers.cookie || '';
    const cookieToken = /(?:^|;\s*)ys_token=([^;]+)/.exec(cookie);
    return header === token || query === token || (cookieToken && decodeURIComponent(cookieToken[1]) === token);
  }

  async function statePayload() {
    const cfg = store.getConfig();
    const snaps = supervisor.snapshots();
    const list = await Promise.all(
      snaps.map(async (s) => {
        const m = metrics.current(s.id);
        let listen = [];
        let listenMismatch = null;
        if (s.pid) {
          listen = await listenAddresses(s.pid);
          const ac = store.readAccountConfig(store.findAccount(s.id) || { id: s.id });
          const httpCfg = (ac && ac.milky && ac.milky.http) || {};
          listenMismatch = describeMismatch(httpCfg.host || s.host, httpCfg.port || s.port, listen);
        }
        return {
          ...s,
          metrics: m || null,
          series: metrics.series(s.id),
          logMeta: bus.meta(s.id),
          listen,
          listenMismatch,
        };
      })
    );
    return {
      server: {
        now: Date.now(),
        port: cfg.panel.port,
        host: cfg.panel.host,
        bindHost: meta ? meta.bindHost : cfg.panel.host,
        bindPort: meta ? meta.bindPort : cfg.panel.port,
        lanUrls: meta ? meta.lanUrls : [],
        tokenRequired: Boolean((cfg.panel.token || '').trim()),
        underSystemd: Boolean(meta && meta.underSystemd),
        platform: process.platform,
        node: process.version,
        cores: require('os').cpus().length,
        metricsDisabled: metrics.disabled || null,
        uptimeMs: process.uptime() * 1000,
      },
      accounts: list,
      settings: {
        yogurt: cfg.yogurt,
        update: cfg.update,
        mail: maskMail(cfg.mail),
        panel: {
          host: cfg.panel.host,
          port: cfg.panel.port,
          tokenSet: Boolean((cfg.panel.token || '').trim()),
        },
      },
      update: {
        current: updater.currentVersion(),
        distTag: updater.distTag(),
        running: updater.runningVersions(),
        asset: updater.assetName(),
        latest: updater.state.latest,
        error: updater.state.error,
        lastCheck: updater.state.lastCheck,
        checking: updater.state.checking,
        dists: updater.installedDists(),
        progress: updater.progress,
        sources: updater.listSources(),
      },
      events: notifier.list(80),
    };
  }

  async function handleApi(req, res, url) {
    const cfg = store.getConfig();
    const pathname = url.pathname;
    const method = req.method || 'GET';

    // --- 状态 ---
    if (pathname === '/api/health' && method === 'GET') return sendJson(res, 200, { ok: true, now: Date.now() });

    // 停/重启面板：本机随便调；跨机调用必须配置了 panel.token（否则等于把开关暴露给全网）
    const isLoopback = /^(127\.0\.0\.1|::1|::ffff:127\.0\.0\.1)$/.test(req.socket.remoteAddress || '');
    const tokenSet = Boolean((cfg.panel.token || '').trim());
    if ((pathname === '/api/panel/shutdown' || pathname === '/api/panel/restart') && method === 'POST') {
      if (!isLoopback && !tokenSet) {
        return sendJson(res, 403, {
          error: '跨机操作面板需要先设置 panel.token（在「设置 → 面板监听」里）',
        });
      }
      const restarting = pathname.endsWith('/restart');
      if (restarting && meta && meta.underSystemd) {
        return sendJson(res, 409, {
          error: '面板由 systemd 托管，请用 `systemctl --user restart yogurt-shell`（面板里直接重启会和 systemd 抢端口）',
        });
      }
      sendJson(res, 200, {
        ok: true,
        message: restarting ? '面板正在重启（会先停掉所有账号，2 秒后自动拉起）' : '面板正在停止（会先停掉所有账号）',
      });
      setTimeout(() => {
        if (restarting && ctx.restart) ctx.restart();
        else if (ctx.shutdown) ctx.shutdown('api');
      }, 200);
      return;
    }
    if (pathname === '/api/state' && method === 'GET') return sendJson(res, 200, await statePayload());

    // --- SSE ---
    if (pathname === '/api/stream' && method === 'GET') {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
      });
      res.write('retry: 3000\n\n');
      res.write('data: ' + JSON.stringify({ type: 'hello', state: await statePayload() }) + '\n\n');
      sseClients.add(res);
      const timer = setInterval(() => {
        try {
          res.write(': ping\n\n');
        } catch {}
      }, 25000);
      req.on('close', () => {
        clearInterval(timer);
        sseClients.delete(res);
      });
      return;
    }

    const logStream = pathname.match(/^\/api\/accounts\/([^/]+)\/logs\/stream$/);
    if (logStream && method === 'GET') {
      const id = decodeURIComponent(logStream[1]);
      const tail = Number(url.searchParams.get('tail') || 300);
      res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
      });
      res.write('retry: 3000\n\n');
      res.write('data: ' + JSON.stringify({ type: 'history', accountId: id, lines: bus.tail(id, tail) }) + '\n\n');
      if (!logClients.has(id)) logClients.set(id, new Set());
      logClients.get(id).add(res);
      const timer = setInterval(() => {
        try {
          res.write(': ping\n\n');
        } catch {}
      }, 25000);
      req.on('close', () => {
        clearInterval(timer);
        const set = logClients.get(id);
        if (set) set.delete(res);
      });
      return;
    }

    // --- 账号增删改 ---
    if (pathname === '/api/accounts' && method === 'POST') {
      const body = await readJson(req);
      const result = accountsMod.create(body);
      broadcast({ type: 'accounts' });
      return sendJson(res, 200, { ok: true, account: result.account, exe: result.exe });
    }
    if (pathname === '/api/accounts/import' && method === 'POST') {
      const body = await readJson(req);
      const result = accountsMod.importAccount(body);
      broadcast({ type: 'accounts' });
      return sendJson(res, 200, { ok: true, ...result });
    }

    const accMatch = pathname.match(/^\/api\/accounts\/([^/]+)(?:\/(.*))?$/);
    if (accMatch) {
      const id = decodeURIComponent(accMatch[1]);
      const rest = accMatch[2] || '';
      const account = store.findAccount(id);
      if (!account) return sendJson(res, 404, { error: '账号不存在：' + id });

      if (!rest && method === 'PATCH') {
        const body = await readJson(req);
        const updated = accountsMod.update(id, body);
        broadcast({ type: 'accounts' });
        return sendJson(res, 200, { ok: true, account: updated });
      }
      if (!rest && method === 'DELETE') {
        const snap = supervisor.snapshot(account);
        if (snap.pid) await supervisor.stop(id, '删除账号');
        const removed = accountsMod.remove(id, { deleteFiles: url.searchParams.get('deleteFiles') === '1' });
        broadcast({ type: 'accounts' });
        return sendJson(res, 200, { ok: true, account: removed });
      }
      if (rest === 'diagnostics' && method === 'GET') {
        try {
          return sendJson(res, 200, { ok: true, diagnostics: accountsMod.diagnose(id) });
        } catch (err) {
          return sendJson(res, 400, { ok: false, error: err.message });
        }
      }
      if (rest === 'repair' && method === 'POST') {
        const body = await readJson(req);
        try {
          const result = accountsMod.repairAccount(id, body.mode || 'auto');
          broadcast({ type: 'accounts' });
          return sendJson(res, 200, { ok: true, result });
        } catch (err) {
          return sendJson(res, 400, { ok: false, error: err.message });
        }
      }
      if (rest === 'action' && method === 'POST') {
        const body = await readJson(req);
        const action = body.action;
        if (action === 'start') return sendJson(res, 200, { ok: true, account: await supervisor.start(id) });
        if (action === 'stop') return sendJson(res, 200, { ok: true, account: await supervisor.stop(id) });
        if (action === 'restart') return sendJson(res, 200, { ok: true, account: await supervisor.restart(id) });
        if (action === 'probe') {
          const ok = await supervisor.probeAccount(account);
          return sendJson(res, 200, { ok, snapshot: supervisor.snapshot(account), error: supervisor.rt(id).lastProbeError });
        }
        if (action === 'clear-logs') {
          bus.clear(id);
          return sendJson(res, 200, { ok: true });
        }
        return sendJson(res, 400, { error: '未知操作：' + action });
      }
      if (rest === 'input' && method === 'POST') {
        const body = await readJson(req);
        supervisor.sendInput(id, body.text ?? '');
        return sendJson(res, 200, { ok: true });
      }
      if (rest === 'logs' && method === 'GET') {
        const tail = Number(url.searchParams.get('tail') || 800);
        let lines = bus.tail(id, Math.min(5000, tail));
        const q = (url.searchParams.get('q') || '').trim();
        const level = (url.searchParams.get('level') || '').trim().toUpperCase();
        if (q) lines = lines.filter((l) => l.text.toLowerCase().includes(q.toLowerCase()));
        if (level) lines = lines.filter((l) => l.level === level);
        return sendJson(res, 200, { lines, meta: bus.meta(id) });
      }
      if (rest === 'logs/download' && method === 'GET') {
        const file = bus.logFile(id);
        if (!fs.existsSync(file)) return sendJson(res, 404, { error: '暂无日志文件' });
        const stat = fs.statSync(file);
        res.writeHead(200, {
          'Content-Type': 'text/plain; charset=utf-8',
          'Content-Length': stat.size,
          'Content-Disposition': `attachment; filename="${id}.log"`,
        });
        fs.createReadStream(file).pipe(res);
        return;
      }
      if (rest === 'config' && method === 'GET') {
        return sendJson(res, 200, { text: accountsMod.readConfigText(id) });
      }
      if (rest === 'config' && method === 'PUT') {
        const body = await readBody(req, 4 * 1024 * 1024);
        const parsed = accountsMod.writeConfigText(id, body.toString('utf8'));
        broadcast({ type: 'accounts' });
        return sendJson(res, 200, { ok: true, config: parsed });
      }
      if (rest === 'qrcode' && method === 'GET') {
        const dir = store.accountDir(account);
        const found = findQrFile(dir);
        if (!found) {
          return sendJson(res, 404, {
            error: `账号目录里没有二维码图片（已查找 ${dir} 下的 qrcode.png / qr.png / *qr*.png）`,
            dir,
          });
        }
        const stat = fs.statSync(found.file);
        res.writeHead(200, {
          'Content-Type': found.mime,
          'Content-Length': stat.size,
          'Cache-Control': 'no-store',
        });
        return fs.createReadStream(found.file).pipe(res);
      }
      return sendJson(res, 404, { error: '接口不存在' });
    }

    // --- 设置 ---
    if (pathname === '/api/settings/panel' && method === 'PUT') {
      const body = await readJson(req);
      const host = String(body.host === undefined ? cfg.panel.host : body.host).trim();
      const port = Number(body.port === undefined ? cfg.panel.port : body.port);
      const token = body.token === undefined ? cfg.panel.token : String(body.token || '').trim();
      const beforeToken = (cfg.panel.token || '').trim();
      if (host !== 'localhost' && !/^\[?[0-9a-fA-F:.]+\]?$/.test(host)) {
        return sendJson(res, 400, { error: '监听地址不合法：填 127.0.0.1（仅本机）、0.0.0.0（所有网卡）或具体 IP' });
      }
      if (!Number.isInteger(port) || port < 1 || port > 65535) {
        return sendJson(res, 400, { error: '端口必须是 1-65535 的整数' });
      }
      const bindHost = meta ? meta.bindHost : cfg.panel.host;
      const bindPort = meta ? meta.bindPort : cfg.panel.port;
      store.updateConfig((c) => {
        c.panel.host = host;
        c.panel.port = port;
        c.panel.token = token;
      });
      const needRestart = host !== bindHost || port !== bindPort || token !== beforeToken;
      const wildcard = host === '0.0.0.0' || host === '::';
      return sendJson(res, 200, {
        ok: true,
        needRestart,
        panel: { host, port, tokenSet: Boolean(token) },
        warning: wildcard && !token
          ? '已监听所有网卡但没有令牌：任何能连到该端口的人都能启停你的 bot，建议设置 panel.token'
          : null,
      });
    }
    if (pathname === '/api/settings/mail' && method === 'PUT') {
      const body = await readJson(req);
      const next = { ...cfg.mail, ...body };
      delete next.passMasked;
      if (body.pass === '••••••••') next.pass = cfg.mail.pass;
      if (typeof next.to === 'string') next.to = next.to.split(/[,;\s]+/).filter(Boolean);
      if (!Array.isArray(next.to)) next.to = [];
      next.port = Number(next.port) || 465;
      next.dedupeMinutes = Number(next.dedupeMinutes) || 0;
      store.updateConfig((c) => {
        c.mail = next;
      });
      return sendJson(res, 200, { ok: true, mail: maskMail(store.getConfig().mail) });
    }
    if (pathname === '/api/settings/mail/test' && method === 'POST') {
      const result = await notifier.testMail();
      return sendJson(res, 200, { ok: true, result });
    }
    if (pathname === '/api/settings/yogurt' && method === 'PUT') {
      const body = await readJson(req);
      store.updateConfig((c) => {
        const y = c.yogurt;
        if (body.probe) {
          y.probe.intervalMs = Number(body.probe.intervalMs) || y.probe.intervalMs;
          y.probe.timeoutMs = Number(body.probe.timeoutMs) || y.probe.timeoutMs;
          y.probe.failures = Number(body.probe.failures) || y.probe.failures;
          y.probe.graceMs = Number(body.probe.graceMs) || y.probe.graceMs;
        }
        if (body.autoRestart !== undefined) y.autoRestart = Boolean(body.autoRestart);
        if (Array.isArray(body.offlinePatterns)) y.offlinePatterns = body.offlinePatterns.filter(Boolean);
        if (Array.isArray(body.onlinePatterns)) y.onlinePatterns = body.onlinePatterns.filter(Boolean);
        if (body.log) {
          y.log.maxBytes = Number(body.log.maxBytes) || y.log.maxBytes;
          y.log.keepFiles = Number(body.log.keepFiles) || y.log.keepFiles;
          y.log.memoryLines = Number(body.log.memoryLines) || y.log.memoryLines;
        }
      });
      bus.setLimits(store.getConfig().yogurt.log);
      return sendJson(res, 200, { ok: true, yogurt: store.getConfig().yogurt });
    }

    // --- 更新 ---
    if (pathname === '/api/update/check' && method === 'GET') {
      try {
        const latest = await updater.check({ force: true });
        return sendJson(res, 200, { ok: true, latest });
      } catch (err) {
        return sendJson(res, 502, { ok: false, error: err.message });
      }
    }
    // --- 面板自身更新（git pull） ---
    if (pathname === '/api/panel/update' && method === 'GET') {
      try {
        return sendJson(res, 200, { ok: true, status: await selfupdate.status() });
      } catch (err) {
        return sendJson(res, 500, { ok: false, error: err.message });
      }
    }
    if (pathname === '/api/panel/update/check' && method === 'POST') {
      try {
        return sendJson(res, 200, { ok: true, status: await selfupdate.status({ fetch: true }) });
      } catch (err) {
        return sendJson(res, 500, { ok: false, error: err.message });
      }
    }
    if (pathname === '/api/panel/update/apply' && method === 'POST') {
      try {
        const result = await selfupdate.apply();
        return sendJson(res, 200, { ok: true, result });
      } catch (err) {
        return sendJson(res, 400, { ok: false, error: err.message });
      }
    }

    // --- 更新（yogurt） ---
    if (pathname === '/api/update/progress' && method === 'GET') {
      return sendJson(res, 200, { progress: updater.progress });
    }
    if (pathname === '/api/update/sources' && method === 'GET') {
      return sendJson(res, 200, { sources: updater.listSources() });
    }
    // 从本机已安装的 yogurt 安装（目录 / 可执行文件 / zip）
    if (pathname === '/api/update/local' && method === 'POST') {
      const body = await readJson(req);
      try {
        const result = await updater.installFromSource({
          sourcePath: body.path,
          tag: body.tag,
          restartRunning: body.restartRunning !== false,
        });
        broadcast({ type: 'accounts' });
        return sendJson(res, 200, { ok: true, result });
      } catch (err) {
        return sendJson(res, 400, { ok: false, error: err.message });
      }
    }
    if (pathname === '/api/update/install' && method === 'POST') {
      const body = await readJson(req);
      let latest = updater.state.latest;
      if (!latest || body.refresh) latest = await updater.check({ force: true });
      if (!latest.asset) {
        return sendJson(res, 400, {
          error: `最新 release 里没有 ${updater.assetName()}（可用：${(latest.assets || []).map((a) => a.name).join(', ') || '未知'}）`,
        });
      }
      const file = await updater.download(latest.asset.url, latest.asset.name, latest.asset.digest);
      const result = await updater.install({ zipPath: file.file, tag: latest.tag });
      broadcast({ type: 'accounts' });
      return sendJson(res, 200, { ok: true, result });
    }
    if (pathname === '/api/update/upload' && method === 'PUT') {
      const name = url.searchParams.get('name') || 'yogurt-windows-x64.zip';
      const tag = url.searchParams.get('tag') || null;
      const buf = await readBody(req, 200 * 1024 * 1024);
      if (!buf.length) return sendJson(res, 400, { error: '没有收到文件内容' });
      const target = path.join(store.PATHS.updates, path.basename(name));
      fs.mkdirSync(store.PATHS.updates, { recursive: true });
      fs.writeFileSync(target, buf);
      const result = await updater.install({ zipPath: target, tag });
      broadcast({ type: 'accounts' });
      return sendJson(res, 200, { ok: true, result });
    }

    if (pathname === '/api/events' && method === 'GET') {
      const limit = Number(url.searchParams.get('limit') || 100);
      return sendJson(res, 200, { events: notifier.list(limit) });
    }

    return sendJson(res, 404, { error: '接口不存在：' + method + ' ' + pathname });
  }

  function serveStatic(req, res, url) {
    let rel = decodeURIComponent(url.pathname);
    if (rel === '/' || rel === '') rel = '/index.html';
    const file = path.join(publicDir, path.normalize(rel).replace(/^([/\\])+/, ''));
    if (!file.startsWith(publicDir)) {
      res.writeHead(403);
      return res.end('forbidden');
    }
    fs.readFile(file, (err, data) => {
      if (err) {
        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
        return res.end('404');
      }
      res.writeHead(200, {
        'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
        'Cache-Control': 'no-cache',
      });
      res.end(data);
    });
  }

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://' + (req.headers.host || '127.0.0.1'));
    try {
      if (url.pathname.startsWith('/api/')) {
        if (!requireAuth(req, url)) return sendJson(res, 401, { error: '需要访问令牌', authRequired: true });
        await handleApi(req, res, url);
        return;
      }
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        res.writeHead(405);
        return res.end('method not allowed');
      }
      serveStatic(req, res, url);
    } catch (err) {
      if (!res.headersSent) return sendJson(res, 500, { error: err.message || String(err) });
      try {
        res.end();
      } catch {}
    }
  });

  return server;
}

module.exports = { createServer };
