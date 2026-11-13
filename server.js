'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const store = require('./src/store');
const { LogBus } = require('./src/logbus');
const { Supervisor } = require('./src/supervisor');
const { Metrics } = require('./src/metrics');
const { Notifier } = require('./src/notifier');
const { Updater } = require('./src/updater');
const { createServer } = require('./src/http');

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

async function main() {
  store.ensureDirs();
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
  const shutdown = async (reason) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`\n[${stamp()}] 收到 ${reason}，停止所有账号并退出…`);
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
    setTimeout(() => process.exit(0), 300);
  };

  const server = createServer({ supervisor, metrics, notifier, bus, updater, shutdown });

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
  console.log('');
  console.log('  Yogurt Shell 已启动');
  console.log(`  面板地址：http://${host === '0.0.0.0' ? '127.0.0.1' : host}:${port}/`);
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
