'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const store = require('./src/store');
const { LogBus } = require('./src/logbus');
const { Supervisor } = require('./src/supervisor');
const { Metrics } = require('./src/metrics');
const { Notifier } = require('./src/notifier');
const { Updater } = require('./src/updater');
const { createServer } = require('./src/http');
const { teeConsole } = require('./src/console-tee');

function arg(name, fallback) {
  const idx = process.argv.indexOf('--' + name);
  if (idx >= 0 && process.argv[idx + 1]) return process.argv[idx + 1];
  const inline = process.argv.find((a) => a.startsWith('--' + name + '='));
  if (inline) return inline.split('=').slice(1).join('=');
  return fallback;
}

function stamp() {
  return new Date().toLocaleTimeString('zh-CN', { hour12: false });
}

function isWildcardHost(host) {
  return host === '0.0.0.0' || host === '::' || host === '[::]';
}

// 监听 0.0.0.0 时，列出本机各网卡的可访问地址，方便手机/另一台机器直接用
function lanUrls(port) {
  const urls = [];
  const nets = os.networkInterfaces();
  for (const [name, addrs] of Object.entries(nets)) {
    for (const addr of addrs || []) {
      const family = typeof addr.family === 'string' ? addr.family : addr.family === 4 ? 'IPv4' : 'IPv6';
      if (family === 'IPv4' && addr.internal === false) {
        urls.push({ name, url: `http://${addr.address}:${port}/` });
      }
    }
  }
  return urls;
}

// 重启面板：先把自己停干净（释放端口），再拉起一个 --start-delay 的新进程。
// 不用 cmd /c start：无控制台的父进程里 start 会静默失败（踩过）；
// 也不依赖 stdio 句柄继承：新进程自己把日志写进 panel.out.log。
function scheduleRestart() {
  const entry = path.resolve(process.argv[1] || path.join(store.ROOT, 'server.js'));
  const extra = [];
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--start-delay') {
      i += 1;
      continue;
    }
    if (argv[i].startsWith('--start-delay=')) continue;
    extra.push(argv[i]);
  }
  const logFile = path.join(store.DATA_DIR, 'panel.out.log');
  try {
    const child = spawn(process.execPath, [entry, ...extra, '--start-delay', '2500'], {
      cwd: store.ROOT,
      detached: true,
      windowsHide: true,
      env: { ...process.env, YOGURT_SHELL_LOG: logFile },
      stdio: 'ignore',
    });
    child.on('error', (err) => console.error('[restart] 拉起新面板失败：' + err.message));
    child.unref();
    return true;
  } catch (err) {
    console.error('[restart] 拉起新面板失败：' + err.message);
    return false;
  }
}

async function main() {
  store.ensureDirs();
  if (process.env.YOGURT_SHELL_LOG) teeConsole(process.env.YOGURT_SHELL_LOG);
  const cfgFileExists = fs.existsSync(store.PATHS.config);
  const cfg = store.load();
  if (!cfgFileExists) store.save(cfg);

  const bus = new LogBus(cfg.yogurt.log);
  const supervisor = new Supervisor({ bus });
  const metrics = new Metrics();
  const notifier = new Notifier({ bus });
  const updater = new Updater({ supervisor });

  supervisor.on('incident', (payload) => {
    const { title, detail, account } = payload;
    console.log(`[${stamp()}] ! ${title} | ${account.id} | ${detail || ''}`);
    notifier.handleIncident(payload).catch((err) => console.error('[notifier]', err.message));
  });

  const port = Number(arg('port', process.env.YOGURT_SHELL_PORT || cfg.panel.port)) || 3090;
  const host = arg('host', cfg.panel.host || '127.0.0.1');
  if (port !== cfg.panel.port || host !== cfg.panel.host) {
    store.updateConfig((c) => {
      c.panel.port = port;
      c.panel.host = host;
    });
  }

  let shuttingDown = false;
  const meta = { bindHost: host, bindPort: port, lanUrls: [], restarting: false };
  const shutdown = async (reason) => {
    if (shuttingDown) return;
    shuttingDown = true;
    const restarted = String(reason) === 'restart';
    console.log(`\n[${stamp()}] 收到 ${reason}，停止所有账号并${restarted ? '重启面板' : '退出'}…`);
    try {
      await supervisor.stopAll();
    } catch (err) {
      console.error('[shutdown]', err.message);
    }
    metrics.stop();
    server.close();
    try {
      fs.rmSync(path.join(store.PATHS.runtime, 'panel.pid'), { force: true });
    } catch {}
    if (restarted) scheduleRestart();
    setTimeout(() => process.exit(0), 300);
  };

  const server = createServer({
    supervisor,
    metrics,
    notifier,
    bus,
    updater,
    shutdown,
    restart: () => shutdown('restart'),
    meta,
  });

  const startDelay = Number(arg('start-delay', 0));
  if (Number.isFinite(startDelay) && startDelay > 0) {
    console.log(`[${stamp()}] 面板重启中：等待 ${startDelay}ms 让旧进程释放端口…`);
    await new Promise((r) => setTimeout(r, startDelay));
  }

  await new Promise((resolve, reject) => {
    server.once('error', (err) => {
      if (err.code === 'EADDRINUSE') {
        reject(
          new Error(
            `端口 ${port} 已被占用：可能面板已经在运行（先打开 http://${host}:${port}/ 看看），或用 --port 换一个端口`
          )
        );
      } else if (err.code === 'EACCES') {
        reject(new Error(`没有权限监听 ${host}:${port}（<1024 的端口需要 root）`));
      } else {
        reject(err);
      }
    });
    server.listen(port, host, resolve);
  });

  metrics.start();
  setInterval(() => {
    metrics.setAccounts(supervisor.snapshots());
  }, 2000);
  setInterval(() => {
    supervisor.tick().catch((err) => console.error('[probe]', err.message));
  }, 3000);

  const accounts = store.getConfig().accounts;
  const online = supervisor.snapshots();
  meta.lanUrls = lanUrls(port);
  console.log('');
  console.log('  Yogurt Shell 已启动');
  console.log(`  监听地址：${host}:${port}${isWildcardHost(host) ? '（所有网卡）' : ''}`);
  if (isWildcardHost(host)) {
    console.log(`  本机访问：http://127.0.0.1:${port}/`);
    for (const item of meta.lanUrls) console.log(`  局域网访问：${item.url}   网卡 ${item.name}`);
    if (!meta.lanUrls.length) console.log('  局域网访问：未发现可用的非回环 IPv4 网卡');
    if (!store.getConfig().panel.token) {
      console.log('  ⚠ 已对外开放但未设置 panel.token：任何能连到该端口的人都能启停你的 bot');
      console.log('    到「设置 → 面板监听」里设一个令牌，或把监听地址改回 127.0.0.1');
    }
  } else {
    console.log(`  面板地址：http://${host}:${port}/`);
    console.log('  （只监听回环地址，别的机器访问不到；需要局域网访问请改「设置 → 面板监听」）');
  }
  console.log(`  数据目录：${store.DATA_DIR}`);
  console.log(`  Node ${process.version} / ${process.platform} / ${os.cpus().length} 核`);
  console.log(`  账号数：${accounts.length}｜自动启动：${accounts.filter((a) => a.autoStart !== false).length}`);
  if (store.getConfig().mail.enabled) {
    console.log(`  邮件通知：开（${store.getConfig().mail.to.join(', ') || '未配置收件人'}）`);
  } else {
    console.log('  邮件通知：关（面板右上角「通知设置」里开启）');
  }
  console.log('');

  if (store.getConfig().mail.enabled) {
    for (const s of online) console.log(`  - ${s.name}(${s.id}) ${s.statusLabel}`);
  }

  const orphans = await supervisor.cleanupOrphans().catch(() => []);
  if (orphans.length) console.log(`  已清理上次遗留进程：${orphans.map((o) => o.pid).join(', ')}`);

  supervisor.startAll().catch((err) => console.error('[start-all]', err.message));

  try {
    fs.writeFileSync(path.join(store.PATHS.runtime, 'panel.pid'), String(process.pid), 'utf8');
  } catch {}

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('uncaughtException', (err) => console.error('[uncaught]', err));
  process.on('unhandledRejection', (err) => console.error('[unhandled]', err));
}

main().catch((err) => {
  console.error('启动失败：', err.message);
  process.exit(1);
});
