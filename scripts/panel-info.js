'use strict';

// 打印面板的端口和「给用户看的地址」：`3090 127.0.0.1`
// 给 start-background.cmd / .sh 用（避免在 shell 里内嵌 JS）
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
let cfg = {};
try {
  cfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'config.json'), 'utf8'));
} catch {}
const panel = cfg.panel || {};
const rawHost = String(panel.host || '127.0.0.1');
const shown = rawHost === '0.0.0.0' || rawHost === '::' || rawHost === '[::]' ? '127.0.0.1' : rawHost;
process.stdout.write(`${Number(panel.port) || 3090} ${shown}\n`);
