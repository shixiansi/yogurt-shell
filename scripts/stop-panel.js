'use strict';

// 停止面板：从 data/config.json 读端口/监听地址/访问令牌，然后调 /api/panel/shutdown
// 单独成文件是为了避免在 .cmd / .sh 里内嵌 JS 被 shell 的引号和特殊字符吃掉。
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
let cfg = {};
try {
  cfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'config.json'), 'utf8'));
} catch {}
const panel = cfg.panel || {};
const rawHost = String(panel.host || '127.0.0.1');
const host = rawHost === '0.0.0.0' || rawHost === '::' || rawHost === '[::]' ? '127.0.0.1' : rawHost;
const port = Number(panel.port) || 3090;
const token = String(panel.token || '').trim();
const url = `http://${host}:${port}/api/panel/shutdown`;

(async () => {
  try {
    const res = await fetch(url, { method: 'POST', headers: token ? { 'x-panel-token': token } : {} });
    const text = await res.text();
    if (res.ok) {
      console.log('[yogurt-shell] 已请求停止（先停掉所有账号，再退面板）');
      console.log(text);
      process.exit(0);
    }
    console.error(`[yogurt-shell] 停止失败：HTTP ${res.status} ${text}`);
    if (res.status === 401) {
      console.error('  → 面板的访问令牌和 data/config.json 里的 panel.token 不一致');
    }
    process.exit(2);
  } catch (err) {
    console.error(`[yogurt-shell] 连不上面板（${url}）：${err.message}`);
    console.error(`  → 面板可能没在运行，或者端口不是 ${port}（改过 panel.port 吗？）`);
    process.exit(3);
  }
})();
