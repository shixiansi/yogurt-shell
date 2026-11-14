'use strict';

// 一键后台启动（跨平台，供 start-background.sh / .cmd 调用）
// 逻辑：已在运行 → 提示；端口被占 → 说明；否则 detached 拉起，并等 /api/health 真的通
const fs = require('fs');
const path = require('path');
const net = require('net');
const http = require('http');
const { spawn } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const entry = path.join(ROOT, 'server.js');
const logFile = path.join(ROOT, 'data', 'panel.out.log');
const pidFile = path.join(ROOT, 'data', 'runtime', 'panel.pid');

let cfg = {};
try {
  cfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'config.json'), 'utf8'));
} catch {}
const panel = cfg.panel || {};
const rawHost = String(panel.host || '127.0.0.1');
const shownHost = rawHost === '0.0.0.0' || rawHost === '::' || rawHost === '[::]' ? '127.0.0.1' : rawHost;
const port = Number(panel.port) || 3090;
const url = `http://${shownHost}:${port}/`;

function health() {
  return new Promise((resolve) => {
    const req = http.request({ host: '127.0.0.1', port, path: '/api/health', method: 'GET', timeout: 1500 }, (res) => {
      res.resume();
      resolve(res.statusCode === 200);
    });
    req.on('timeout', () => {
      req.destroy();
      resolve(false);
    });
    req.on('error', () => resolve(false));
    req.end();
  });
}

function portInUse() {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once('error', (err) => resolve(err.code === 'EADDRINUSE'));
    server.once('listening', () => server.close(() => resolve(false)));
    server.listen(port, '127.0.0.1');
  });
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

(async () => {
  if (await health()) {
    console.log(`[yogurt-shell] 面板已经在运行：${url}`);
    console.log('  要停止：' + (process.platform === 'win32' ? '双击 stop.cmd' : './stop.sh'));
    process.exit(0);
  }

  if (await portInUse()) {
    console.error(`[yogurt-shell] 端口 ${port} 已被占用，但 /api/health 没有响应 —— 可能被别的程序占着。`);
    console.error(`  · 先看看 http://${shownHost}:${port}/`);
    console.error(`  · 想换端口：node server.js --port 3091`);
    process.exit(1);
  }

  fs.mkdirSync(path.dirname(pidFile), { recursive: true });
  const child = spawn(process.execPath, [entry, ...process.argv.slice(2)], {
    cwd: ROOT,
    detached: true,
    windowsHide: true,
    stdio: 'ignore',
    env: { ...process.env, YOGURT_SHELL_LOG: logFile },
  });
  child.unref();
  if (child.pid) {
    try {
      fs.writeFileSync(pidFile, String(child.pid), 'utf8');
    } catch {}
  }

  for (let i = 0; i < 30; i += 1) {
    await sleep(1000);
    if (await health()) {
      console.log(`[yogurt-shell] 已在后台启动（pid ${child.pid || '?'}）`);
      console.log(`  地址：${url}`);
      console.log(`  日志：${path.relative(ROOT, logFile)}`);
      console.log('  停止：' + (process.platform === 'win32' ? '双击 stop.cmd' : './stop.sh'));
      process.exit(0);
    }
  }

  console.error('[yogurt-shell] 启动超时，最近日志：');
  try {
    const text = fs.readFileSync(logFile, 'utf8').split('\n').slice(-20).join('\n');
    console.error(text);
  } catch {}
  try {
    fs.rmSync(pidFile, { force: true });
  } catch {}
  process.exit(1);
})();
