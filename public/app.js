'use strict';

/* 记录页面内异常，便于排查（也能在无头浏览器里读出来） */
window.__jsErrors = [];
window.addEventListener('error', (e) => window.__jsErrors.push(String(e.message || e)));
window.addEventListener('unhandledrejection', (e) =>
  window.__jsErrors.push('rejection: ' + ((e.reason && e.reason.message) || e.reason))
);

/* ---------------- 工具 ---------------- */
const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function fmtUptime(ms) {
  if (!ms || ms < 0) return '-';
  const s = Math.floor(ms / 1000);
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (d) return `${d}天${h}时`;
  if (h) return `${h}时${m}分`;
  if (m) return `${m}分${s % 60}秒`;
  return `${s}秒`;
}

function fmtTime(ts) {
  if (!ts) return '-';
  const d = new Date(ts);
  const pad = (n) => String(n).padStart(2, '0');
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

function fmtClock(ts) {
  const d = new Date(ts);
  const pad = (n) => String(n).padStart(2, '0');
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

function fmtBytes(n) {
  if (!n) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  let i = 0;
  let v = n;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(v >= 10 || i === 0 ? 0 : 1)} ${units[i]}`;
}

function toast(msg, kind = 'ok') {
  const el = document.createElement('div');
  el.className = 'toast ' + kind;
  el.textContent = msg;
  $('#toasts').appendChild(el);
  setTimeout(() => {
    el.style.opacity = '0';
    el.style.transition = '0.3s';
    setTimeout(() => el.remove(), 320);
  }, 4500);
}

/* ---------------- 状态 ---------------- */
const state = {
  accounts: [],
  settings: null,
  update: null,
  events: [],
  server: null,
  cards: new Map(),
  unseenEvents: 0,
  drawer: { id: null, lines: [], paused: false, filter: '', level: '', hideChat: false, es: null },
  es: null,
};

let token = localStorage.getItem('ys_token') || '';

/* ---------------- API ---------------- */
async function api(path, { method = 'GET', body, raw, headers = {} } = {}) {
  const opts = { method, headers: { ...headers } };
  if (token) opts.headers['x-panel-token'] = token;
  if (raw !== undefined) {
    opts.body = raw;
    opts.headers['Content-Type'] = opts.headers['Content-Type'] || 'application/octet-stream';
  } else if (body !== undefined) {
    opts.body = JSON.stringify(body);
    opts.headers['Content-Type'] = 'application/json';
  }
  const res = await fetch(path, opts);
  const text = await res.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = { raw: text };
  }
  if (res.status === 401) {
    askToken();
    throw new Error('需要访问令牌');
  }
  if (!res.ok) throw new Error((data && data.error) || 'HTTP ' + res.status);
  return data;
}

function askToken() {
  if ($('#token-input')) return;
  openModal('需要访问令牌', `
    <div class="field">
      <label>面板设置了访问令牌（data/config.json → panel.token）</label>
      <input class="input" id="token-input" placeholder="粘贴令牌" />
      <div class="hint">令牌保存在浏览器 localStorage，只需填一次。</div>
    </div>
    <div class="row"><button class="btn primary" id="token-save">保存并重试</button></div>
  `, {
    onOpen(body) {
      $('#token-save', body).onclick = () => {
        token = $('#token-input', body).value.trim();
        localStorage.setItem('ys_token', token);
        closeModal();
        location.reload();
      };
    },
  });
}

/* ---------------- 启动 ---------------- */
async function boot() {
  try {
    const data = await api('/api/state');
    applyState(data);
    connectStream();
  } catch (err) {
    $('#server-line').textContent = '连接失败：' + err.message;
    setTimeout(boot, 3000);
  }
}

function applyState(data) {
  state.server = data.server;
  state.settings = data.settings;
  state.update = data.update;
  state.events = data.events || [];
  state.accounts = data.accounts || [];
  renderSummary();
  renderAccounts();
  renderServerLine();
}

function renderServerLine() {
  const s = state.server;
  if (!s) return;
  const bindHost = s.bindHost || s.host;
  const bindPort = s.bindPort || s.port;
  const wildcard = bindHost === '0.0.0.0' || bindHost === '::';
  const parts = [
    `监听 ${bindHost}:${bindPort}`,
    `Node ${s.node}`,
    `${s.cores} 核`,
    `已运行 ${fmtUptime(s.uptimeMs)}`,
  ];
  if (wildcard) {
    const urls = (s.lanUrls || []).map((u) => u.url);
    parts.push(urls.length ? `局域网 ${urls.join(' / ')}` : '未发现局域网地址');
    if (!s.tokenRequired) parts.push('⚠ 无访问令牌');
  }
  if (s.metricsDisabled) parts.push('采样不可用：' + s.metricsDisabled);
  $('#server-line').textContent = parts.join(' · ');
}

function renderSummary() {
  const list = state.accounts;
  const online = list.filter((a) => a.status === 'online').length;
  const login = list.filter((a) => a.status === 'login' || a.status === 'starting').length;
  const bad = list.filter((a) => a.status === 'offline' || a.status === 'crashed').length;
  const mail = state.settings && state.settings.mail;
  const mailOn = mail && mail.enabled;
  const host = state.server ? `127.0.0.1:${state.server.port}` : '';
  $('#summary').innerHTML = `
    <span class="chip ok">在线 <b>${online}</b>/${list.length}</span>
    ${login ? `<span class="chip">登录中 <b>${login}</b></span>` : ''}
    ${bad ? `<span class="chip bad">掉线/异常 <b>${bad}</b></span>` : ''}
    <span class="chip ${mailOn ? 'ok' : ''}">邮件通知 <b>${mailOn ? '已开启' : '未开启'}</b></span>
    ${state.update && state.update.current ? `<span class="chip">版本 <b>${esc(state.update.current)}</b></span>` : ''}
  `;
  $('#empty').classList.toggle('hidden', list.length > 0);
  if (host) document.title = bad ? `⚠ ${bad} 异常 · Yogurt Shell` : 'Yogurt Shell';
}

/* ---------------- 账号卡片 ---------------- */
function renderAccounts() {
  const grid = $('#accounts');
  const seen = new Set();
  for (const acc of state.accounts) {
    seen.add(acc.id);
    let card = state.cards.get(acc.id);
    if (!card) {
      card = createCard(acc);
      state.cards.set(acc.id, card);
      grid.appendChild(card.el);
    }
    updateCard(acc, card);
  }
  for (const [id, card] of state.cards) {
    if (!seen.has(id)) {
      card.el.remove();
      state.cards.delete(id);
    }
  }
}

function createCard(acc) {
  const el = document.createElement('article');
  el.className = 'card';
  el.innerHTML = `
    <div class="card-top">
      <div class="who"><span class="name" data-f="name"></span><span class="uin"></span></div>
      <span class="pill"></span>
    </div>
    <div class="meta">
      <span>端口 <b data-f="port"></b></span>
      <span>版本 <b data-f="version"></b></span>
      <span>PID <b data-f="pid"></b></span>
      <span>运行 <b data-f="uptime"></b></span>
      <span>线程 <b data-f="threads"></b></span>
      <span>句柄 <b data-f="handles"></b></span>
      <span>实际监听 <b data-f="listen"></b></span>
    </div>
    <div class="charts">
      <div class="chart">
        <canvas data-f="cpuCanvas"></canvas>
        <div class="chart-label"><span>CPU（整机%）</span><b data-f="cpu"></b></div>
      </div>
      <div class="chart">
        <canvas data-f="memCanvas"></canvas>
        <div class="chart-label"><span>内存</span><b data-f="mem"></b></div>
      </div>
    </div>
    <div class="lastlog" data-f="lastlog">等待日志…</div>
    <div class="reason" data-f="reason"></div>
    <div class="actions">
      <button class="btn small primary" data-action="start">启动</button>
      <button class="btn small" data-action="stop">停止</button>
      <button class="btn small" data-action="restart">重启</button>
      <button class="btn small" data-action="logs">日志</button>
      <button class="btn small" data-action="config">配置</button>
      <button class="btn small" data-action="qr">二维码</button>
      <button class="btn small danger" data-action="delete">删除</button>
    </div>
  `;
  const f = (name) => el.querySelector(`[data-f="${name}"]`);
  const card = {
    el,
    name: f('name'),
    uin: el.querySelector('.uin'),
    pill: el.querySelector('.pill'),
    port: f('port'),
    version: f('version'),
    pid: f('pid'),
    uptime: f('uptime'),
    threads: f('threads'),
    handles: f('handles'),
    listen: f('listen'),
    cpu: f('cpu'),
    mem: f('mem'),
    cpuCanvas: f('cpuCanvas'),
    memCanvas: f('memCanvas'),
    lastlog: f('lastlog'),
    reason: f('reason'),
    buttons: {
      start: el.querySelector('[data-action="start"]'),
      stop: el.querySelector('[data-action="stop"]'),
      restart: el.querySelector('[data-action="restart"]'),
    },
    series: [],
  };
  el.addEventListener('click', (ev) => {
    const btn = ev.target.closest('[data-action]');
    if (!btn) return;
    onCardAction(acc.id, btn.dataset.action);
  });
  return card;
}

function updateCard(acc, card) {
  card.el.dataset.status = acc.status;
  card.name.textContent = acc.name || acc.id;
  card.uin.textContent = '(' + acc.id + ')';
  card.pill.textContent = acc.statusLabel || acc.status;
  card.pill.className = 'pill ' + acc.status;
  card.port.textContent = acc.port;
  card.version.textContent = acc.version || '-';
  card.pid.textContent = acc.pid || '-';
  card.uptime.textContent = acc.pid ? fmtUptime(acc.uptimeMs) : '-';

  const m = acc.metrics;
  card.cpu.textContent = m ? m.cpu.toFixed(1) + '%' : '-';
  card.mem.textContent = m ? m.mem + ' MB' : '-';
  card.threads.textContent = m ? m.threads : '-';
  card.handles.textContent = m ? m.handles : '-';

  if (Array.isArray(acc.series) && acc.series.length) card.series = acc.series.slice();
  drawSparkline(card.cpuCanvas, card.series.map((p) => p.cpu), '#38bdf8', 10);
  drawSparkline(card.memCanvas, card.series.map((p) => p.mem), '#3ddc97', 20);

  if (acc.lastLine && acc.lastLine.text) {
    card.lastlog.textContent = acc.lastLine.text;
  }
  const showReason = (acc.status === 'offline' || acc.status === 'crashed') && acc.reason;
  const warnReason = !showReason && acc.listenMismatch;
  card.reason.textContent = showReason ? acc.reason : warnReason || '';
  card.reason.classList.toggle('show', Boolean(showReason || warnReason));
  card.reason.classList.toggle('warn', Boolean(warnReason));
  card.listen.textContent =
    acc.listen && acc.listen.length
      ? acc.listen.map((item) => `${item.addr}:${item.port}`).join(', ')
      : acc.pid
        ? '读取中…'
        : '-';

  const running = ['starting', 'login', 'online', 'stopping'].includes(acc.status);
  card.buttons.start.disabled = running;
  card.buttons.stop.disabled = !acc.pid;
  card.buttons.restart.disabled = !running;
}

function drawSparkline(canvas, values, color, minMax) {
  const dpr = window.devicePixelRatio || 1;
  const w = canvas.clientWidth || 160;
  const h = canvas.clientHeight || 34;
  if (canvas.width !== Math.floor(w * dpr) || canvas.height !== Math.floor(h * dpr)) {
    canvas.width = Math.floor(w * dpr);
    canvas.height = Math.floor(h * dpr);
  }
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);
  ctx.strokeStyle = 'rgba(255,255,255,0.06)';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(0, h - 0.5);
  ctx.lineTo(w, h - 0.5);
  ctx.stroke();
  if (!values || values.length < 2) return;
  const max = Math.max(minMax || 1, ...values) * 1.15;
  const step = w / (values.length - 1);
  const grad = ctx.createLinearGradient(0, 0, 0, h);
  grad.addColorStop(0, color + '55');
  grad.addColorStop(1, color + '00');
  ctx.beginPath();
  values.forEach((v, i) => {
    const x = i * step;
    const y = h - (Math.min(v, max) / max) * (h - 3) - 2;
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  });
  ctx.strokeStyle = color;
  ctx.lineWidth = 1.6;
  ctx.lineJoin = 'round';
  ctx.stroke();
  ctx.lineTo(w, h);
  ctx.lineTo(0, h);
  ctx.closePath();
  ctx.fillStyle = grad;
  ctx.fill();
}

/* ---------------- 卡片操作 ---------------- */
async function onCardAction(id, action) {
  const acc = state.accounts.find((a) => a.id === id);
  if (!acc) return;
  try {
    if (action === 'start' || action === 'stop' || action === 'restart') {
      toast(`${acc.name}：${action === 'start' ? '启动中…' : action === 'stop' ? '停止中…' : '重启中…'}`);
      await api(`/api/accounts/${encodeURIComponent(id)}/action`, { method: 'POST', body: { action } });
      return;
    }
    if (action === 'logs') return openDrawer(id);
    if (action === 'config') return configModal(acc);
    if (action === 'qr') return qrModal(acc);
    if (action === 'delete') {
      if (!confirm(`确定删除账号「${acc.name}（${id}）」？\n账号目录会被移动到 data/trash，日志同时清理。`)) return;
      if (acc.pid) await api(`/api/accounts/${encodeURIComponent(id)}/action`, { method: 'POST', body: { action: 'stop' } });
      await api(`/api/accounts/${encodeURIComponent(id)}?deleteFiles=1`, { method: 'DELETE' });
      toast('账号已删除');
      const data = await api('/api/state');
      applyState(data);
    }
  } catch (err) {
    toast(err.message, 'error');
  }
}

/* ---------------- SSE ---------------- */
function connectStream() {
  if (state.es) state.es.close();
  const es = new EventSource('/api/stream' + (token ? '?token=' + encodeURIComponent(token) : ''));
  state.es = es;
  es.onmessage = (ev) => {
    let msg;
    try {
      msg = JSON.parse(ev.data);
    } catch {
      return;
    }
    if (msg.type === 'hello') {
      applyState(msg.state);
    } else if (msg.type === 'state') {
      const acc = state.accounts.find((a) => a.id === msg.account.id);
      if (acc) {
        Object.assign(acc, msg.account);
        const card = state.cards.get(acc.id);
        if (card) updateCard(acc, card);
      } else {
        state.accounts.push(msg.account);
      }
      renderSummary();
      renderAccounts();
    } else if (msg.type === 'metrics') {
      applyMetrics(msg);
    } else if (msg.type === 'event') {
      state.events.unshift(msg.event);
      state.unseenEvents += 1;
      const badge = $('#event-badge');
      badge.textContent = state.unseenEvents;
      badge.classList.remove('hidden');
      const kind = msg.event.mailStatus === 'failed' ? 'error' : 'warn';
      toast(`${msg.event.title}｜${msg.event.accountName || ''} ${msg.event.detail || ''}`.slice(0, 160), kind);
      if (state.drawer.id === msg.event.accountId) {
        // 事件也会写进日志，这里不用额外处理
      }
    } else if (msg.type === 'accounts') {
      api('/api/state').then(applyState).catch(() => {});
    }
  };
  es.onerror = () => {
    /* EventSource 自动重连 */
  };
}

function applyMetrics(msg) {
  const last = msg.last || {};
  for (const acc of state.accounts) {
    const m = last[acc.id];
    if (!m) continue;
    acc.metrics = { ...m };
    const series = Array.isArray(acc.series) ? acc.series : (acc.series = []);
    series.push({ t: m.t, cpu: m.cpu, mem: m.mem });
    while (series.length > 90) series.shift();
    const card = state.cards.get(acc.id);
    if (card) {
      card.cpu.textContent = m.cpu.toFixed(1) + '%';
      card.mem.textContent = m.mem + ' MB';
      card.threads.textContent = m.threads;
      card.handles.textContent = m.handles;
      drawSparkline(card.cpuCanvas, series.map((p) => p.cpu), '#38bdf8', 10);
      drawSparkline(card.memCanvas, series.map((p) => p.mem), '#3ddc97', 20);
      card.uptime.textContent = acc.pid ? fmtUptime(acc.uptimeMs) : '-';
    }
  }
  renderSummary();
}

/* ---------------- 日志抽屉 ---------------- */
function openDrawer(id) {
  const acc = state.accounts.find((a) => a.id === id);
  if (!acc) return;
  state.drawer.id = id;
  state.drawer.lines = [];
  $('#drawer-title').textContent = `${acc.name}（${id}）日志`;
  $('#drawer-status').textContent = acc.statusLabel || acc.status;
  $('#drawer-status').className = 'pill ' + acc.status;
  $('#drawer-meta').textContent = `端口 ${acc.port} · PID ${acc.pid || '-'}`;
  $('#console').innerHTML = '';
  $('#log-filter').value = '';
  $('#log-level').value = '';
  state.drawer.filter = '';
  state.drawer.level = '';
  $('#drawer').classList.add('open');
  $('#drawer-backdrop').classList.remove('hidden');
  if (state.drawer.es) state.drawer.es.close();
  const es = new EventSource(
    `/api/accounts/${encodeURIComponent(id)}/logs/stream?tail=400` +
      (token ? '&token=' + encodeURIComponent(token) : '')
  );
  state.drawer.es = es;
  es.onmessage = (ev) => {
    let msg;
    try {
      msg = JSON.parse(ev.data);
    } catch {
      return;
    }
    if (msg.type === 'history') {
      state.drawer.lines = msg.lines || [];
      renderConsole();
      scrollConsoleToBottom();
    } else if (msg.type === 'line') {
      pushDrawerLine(msg.entry);
    }
  };
}

function closeDrawer() {
  $('#drawer').classList.remove('open');
  $('#drawer-backdrop').classList.add('hidden');
  if (state.drawer.es) {
    state.drawer.es.close();
    state.drawer.es = null;
  }
  state.drawer.id = null;
}

function pushDrawerLine(entry) {
  state.drawer.lines.push(entry);
  if (state.drawer.lines.length > 4000) state.drawer.lines.splice(0, state.drawer.lines.length - 4000);
  if (state.drawer.paused) {
    updatePauseBadge();
    return;
  }
  if (!matchFilters(entry)) return;
  appendLineEl(entry);
}

function matchFilters(entry) {
  const { filter, level, hideChat } = state.drawer;
  if (level && entry.level !== level) return false;
  if (hideChat && /Logging \[/.test(entry.text)) return false;
  if (filter && !entry.text.toLowerCase().includes(filter.toLowerCase())) return false;
  return true;
}

function appendLineEl(entry) {
  const box = $('#console');
  const atBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 80;
  const el = document.createElement('div');
  el.className = 'ln lv-' + (entry.level || 'INFO');
  if (/ERROR|掉线|异常|失败|退出/.test(entry.text)) el.classList.add('hit');
  // Yogurt 自己的日志已经带时间，避免出现两个时间戳
  const hasOwnTime = /^\s*\d{1,2}:\d{2}:\d{2}/.test(entry.text);
  if (!hasOwnTime && entry.t) {
    const gut = document.createElement('span');
    gut.className = 'gutter';
    gut.textContent = fmtClock(entry.t);
    el.appendChild(gut);
  }
  const urlRe = /(https?:\/\/[^\s<>"']+)/g;
  let last = 0;
  let m;
  const text = entry.text;
  while ((m = urlRe.exec(text))) {
    if (m.index > last) el.appendChild(document.createTextNode(text.slice(last, m.index)));
    const a = document.createElement('a');
    a.href = m[1];
    a.target = '_blank';
    a.rel = 'noreferrer';
    a.textContent = m[1];
    el.appendChild(a);
    last = m.index + m[1].length;
  }
  if (last < text.length) el.appendChild(document.createTextNode(text.slice(last)));
  box.appendChild(el);
  while (box.childElementCount > 3000) box.removeChild(box.firstChild);
  if (atBottom) box.scrollTop = box.scrollHeight;
  return el;
}

function renderConsole() {
  const box = $('#console');
  box.innerHTML = '';
  const lines = state.drawer.lines.filter(matchFilters).slice(-1500);
  for (const entry of lines) appendLineEl(entry);
  scrollConsoleToBottom();
}

function scrollConsoleToBottom() {
  const box = $('#console');
  box.scrollTop = box.scrollHeight;
}

function updatePauseBadge() {
  const btn = $('#log-pause');
  btn.textContent = state.drawer.paused ? '▶ 恢复滚动' : '⏸ 暂停滚动';
}

/* ---------------- 模态框 ---------------- */
function openModal(title, bodyHtml, opts = {}) {
  $('#modal-title').textContent = title;
  const body = $('#modal-body');
  body.innerHTML = bodyHtml;
  $('#modal-root').classList.remove('hidden');
  if (opts.onOpen) opts.onOpen(body);
}

function closeModal() {
  $('#modal-root').classList.add('hidden');
  $('#modal-body').innerHTML = '';
}

function nextFreePort() {
  const used = new Set(state.accounts.map((a) => Number(a.port)));
  let p = 3000;
  while (used.has(p)) p += 1;
  return p;
}

function addAccountModal() {
  const port = nextFreePort();
  openModal(
    '添加账号',
    `
    <div class="tabs" id="add-tabs">
      <div class="tab active" data-tab="new">新建账号</div>
      <div class="tab" data-tab="import">导入现有目录（接管）</div>
    </div>

    <div data-pane="new">
      <div class="grid2">
        <div class="field"><label>QQ 号 *</label><input class="input" id="f-uin" placeholder="例如 100000001" /></div>
        <div class="field"><label>显示名称</label><input class="input" id="f-name" placeholder="留空则用 QQ 号" /></div>
        <div class="field"><label>Milky 端口 *</label><input class="input" id="f-port" value="${port}" /></div>
        <div class="field"><label>协议类型</label>
          <select class="input" id="f-os">
            <option value="Linux">Linux（PC）</option>
            <option value="Windows">Windows（PC）</option>
            <option value="Mac">Mac（PC）</option>
            <option value="AndroidPhone">AndroidPhone</option>
            <option value="AndroidPad">AndroidPad</option>
          </select>
        </div>
        <div class="field"><label>协议版本</label>
          <select class="input" id="f-version">
            <option value="custom">custom（用 app-info.json，推荐）</option>
            <option value="46494">46494（Linux）</option>
            <option value="39038">39038（Linux）</option>
            <option value="52194">52194（Mac）</option>
            <option value="52892">52892（Mac）</option>
            <option value="9.2.80">9.2.80（Android）</option>
          </select>
        </div>
        <div class="field"><label>签名 API URL</label><input class="input" id="f-sign" value="https://sign.shixiansi.pw/laptop/" /></div>
      </div>
      <div class="field" style="margin-top:12px">
        <label class="check"><input type="checkbox" id="f-autostart" checked /> 面板启动时自动拉起</label>
        <div class="hint">PC 协议首次登录会把二维码/链接打印到日志里，可在「日志」抽屉里看，或点卡片上的「二维码」。</div>
      </div>
      <div class="row" style="margin-top:14px"><button class="btn primary" id="f-submit">创建账号</button></div>
    </div>

    <div data-pane="import" class="hidden">
      <div class="field">
        <label>现有 yogurt 目录（绝对路径）*</label>
        <input class="input" id="i-dir" placeholder="例如 E:\\lagrangeV2\\yogurt-windows-x64 (1)" />
        <div class="hint">会复制 config.json / app-info.json / session-store*.json / 可执行文件到新账号目录，原目录不动。</div>
      </div>
      <div class="field"><label>显示名称</label><input class="input" id="i-name" placeholder="留空则自动生成" /></div>
      <div class="field"><label class="check"><input type="checkbox" id="i-autostart" checked /> 面板启动时自动拉起</label></div>
      <div class="hint">⚠ 接管前请先停掉原目录里正在跑的 yogurt，否则两个进程会抢同一个 QQ 会话与端口。</div>
      <div class="row" style="margin-top:14px"><button class="btn primary" id="i-submit">导入并接管</button></div>
    </div>
  `,
    {
      onOpen(body) {
        $$('#add-tabs .tab', body).forEach((tab) => {
          tab.onclick = () => {
            $$('#add-tabs .tab', body).forEach((t) => t.classList.toggle('active', t === tab));
            $$('[data-pane]', body).forEach((pane) => {
              pane.classList.toggle('hidden', pane.dataset.pane !== tab.dataset.tab);
            });
          };
        });
        $('#f-submit', body).onclick = async () => {
          try {
            const payload = {
              uin: $('#f-uin', body).value.trim(),
              name: $('#f-name', body).value.trim(),
              port: Number($('#f-port', body).value),
              os: $('#f-os', body).value,
              version: $('#f-version', body).value,
              signApiUrl: $('#f-sign', body).value.trim(),
              autoStart: $('#f-autostart', body).checked,
            };
            await api('/api/accounts', { method: 'POST', body: payload });
            closeModal();
            toast('账号已创建');
            applyState(await api('/api/state'));
          } catch (err) {
            toast(err.message, 'error');
          }
        };
        $('#i-submit', body).onclick = async () => {
          try {
            await api('/api/accounts/import', {
              method: 'POST',
              body: {
                fromDir: $('#i-dir', body).value.trim(),
                name: $('#i-name', body).value.trim(),
                autoStart: $('#i-autostart', body).checked,
              },
            });
            closeModal();
            toast('已导入账号');
            applyState(await api('/api/state'));
          } catch (err) {
            toast(err.message, 'error');
          }
        };
      },
    }
  );
}

function settingsModal() {
  const mail = state.settings.mail || {};
  const y = state.settings.yogurt || {};
  const panel = state.settings.panel || {};
  const probe = y.probe || {};
  const log = y.log || {};
  openModal(
    '设置',
    `
    <div class="section">
      <h3>面板监听</h3>
      <div class="desc">这里只影响面板本身，<b>改完必须重启面板</b>才生效。yogurt 自己的监听地址在账号卡片的「配置」里（<span class="mono">milky.http.host</span>），那是另一回事。</div>
      <div class="grid3">
        <div class="field">
          <label>监听地址</label>
          <input class="input" id="p-host" value="${esc(panel.host || '127.0.0.1')}" />
          <div class="hint">127.0.0.1 仅本机可访问；0.0.0.0 所有网卡（局域网/公网）</div>
        </div>
        <div class="field"><label>端口</label><input class="input" id="p-port" value="${panel.port || 3090}" /></div>
        <div class="field">
          <label>访问令牌</label>
          <input class="input" id="p-token" type="password" placeholder="${panel.tokenSet ? '已设置（留空则不修改）' : '留空表示不校验'}" />
          <div class="hint">对外监听时强烈建议设置</div>
        </div>
      </div>
      <div class="row" style="margin-top:10px">
        <button class="btn primary" id="p-save">保存</button>
        <button class="btn" id="p-clear">清除令牌</button>
        <button class="btn" id="p-restart">⟳ 重启面板</button>
      </div>
      <div class="hint" id="p-msg"></div>
    </div>

    <div class="section">
      <h3>邮件通知</h3>
      <div class="desc">账号掉线 / 进程异常退出时发邮件。支持 465 隐式 TLS、587 STARTTLS。</div>
      <label class="check"><input type="checkbox" id="m-enabled" ${mail.enabled ? 'checked' : ''}/> 启用邮件通知</label>
      <div class="grid2" style="margin-top:10px">
        <div class="field"><label>SMTP 服务器</label><input class="input" id="m-host" value="${esc(mail.host || '')}" placeholder="smtp.qq.com" /></div>
        <div class="field"><label>端口</label><input class="input" id="m-port" value="${mail.port || 465}" /></div>
        <div class="field"><label>用户名</label><input class="input" id="m-user" value="${esc(mail.user || '')}" placeholder="通常为完整邮箱地址" /></div>
        <div class="field"><label>密码 / 授权码</label><input class="input" id="m-pass" type="password" value="${esc(mail.pass || '')}" placeholder="QQ/163 用「授权码」" /></div>
        <div class="field"><label>发件人</label><input class="input" id="m-from" value="${esc(mail.from || '')}" placeholder="you@example.com" /></div>
        <div class="field"><label>收件人（逗号分隔）</label><input class="input" id="m-to" value="${esc((mail.to || []).join(','))}" placeholder="a@x.com,b@y.com" /></div>
        <div class="field"><label>主题前缀</label><input class="input" id="m-prefix" value="${esc(mail.subjectPrefix || '[Yogurt]')}" /></div>
        <div class="field"><label>同类通知去重（分钟）</label><input class="input" id="m-dedupe" value="${mail.dedupeMinutes || 0}" /></div>
      </div>
      <label class="check" style="margin-top:10px"><input type="checkbox" id="m-secure" ${mail.secure !== false ? 'checked' : ''}/> 使用 SSL（465）—— 587 请取消勾选</label>
      <div class="row" style="margin-top:12px">
        <button class="btn primary" id="m-save">保存邮件设置</button>
        <button class="btn" id="m-test">发送测试邮件</button>
      </div>
    </div>

    <div class="section">
      <h3>掉线判定</h3>
      <div class="desc">面板定时调 <span class="mono">/api/get_login_info</span> 探活；连续失败达到阈值即判定掉线 → 杀进程 → 发邮件，不会自动重试。</div>
      <div class="grid3">
        <div class="field"><label>探活间隔（毫秒）</label><input class="input" id="y-interval" value="${probe.intervalMs || 15000}" /></div>
        <div class="field"><label>超时（毫秒）</label><input class="input" id="y-timeout" value="${probe.timeoutMs || 8000}" /></div>
        <div class="field"><label>连续失败次数</label><input class="input" id="y-failures" value="${probe.failures || 3}" /></div>
        <div class="field"><label>启动宽限期（毫秒）</label><input class="input" id="y-grace" value="${probe.graceMs || 90000}" /></div>
        <div class="field"><label>日志保留大小（MB）</label><input class="input" id="y-logsize" value="${Math.round((log.maxBytes || 20971520) / 1048576)}" /></div>
        <div class="field"><label>日志保留份数</label><input class="input" id="y-logkeep" value="${log.keepFiles ?? 6}" /></div>
      </div>
      <div class="field" style="margin-top:10px">
        <label>掉线日志特征（每行一个）</label>
        <textarea class="input" id="y-patterns" style="min-height:120px">${esc((y.offlinePatterns || []).join('\n'))}</textarea>
        <div class="hint">日志里出现这些词就立即判定掉线（聊天内容会被忽略，不会误杀）。</div>
      </div>
      <label class="check" style="margin-top:10px"><input type="checkbox" id="y-autorestart" ${y.autoRestart ? 'checked' : ''}/> 崩溃后自动重启（默认关闭，掉线不会被自动重启）</label>
      <div class="row" style="margin-top:12px"><button class="btn primary" id="y-save">保存判定设置</button></div>
    </div>
  `,
    {
      onOpen(body) {
        const pMsg = $('#p-msg', body);
        const savePanel = async (extra = {}) => {
          try {
            const payload = {
              host: $('#p-host', body).value.trim(),
              port: Number($('#p-port', body).value),
              ...extra,
            };
            const tokenInput = $('#p-token', body).value;
            if (tokenInput) payload.token = tokenInput;
            const res = await api('/api/settings/panel', { method: 'PUT', body: payload });
            const notes = [];
            if (res.warning) notes.push('⚠ ' + res.warning);
            notes.push(res.needRestart ? '已保存，需要重启面板才生效（点「重启面板」）' : '已保存（与当前监听一致，无需重启）');
            pMsg.textContent = notes.join(' · ');
            applyState(await api('/api/state'));
          } catch (err) {
            pMsg.textContent = err.message;
          }
        };
        $('#p-save', body).onclick = () => savePanel();
        $('#p-clear', body).onclick = () => savePanel({ token: '' });
        const restartBtn = $('#p-restart', body);
        if (state.server && state.server.underSystemd) {
          restartBtn.disabled = true;
          restartBtn.title = 'systemd 托管中';
          pMsg.textContent = '当前由 systemd 托管：保存后在服务器上执行 systemctl --user restart yogurt-shell 生效。';
        } else {
          restartBtn.onclick = () => restartPanel(pMsg);
        }

        $('#m-save', body).onclick = async () => {
          try {
            const payload = {
              enabled: $('#m-enabled', body).checked,
              host: $('#m-host', body).value.trim(),
              port: Number($('#m-port', body).value),
              secure: $('#m-secure', body).checked,
              user: $('#m-user', body).value.trim(),
              from: $('#m-from', body).value.trim(),
              to: $('#m-to', body).value.split(',').map((s) => s.trim()).filter(Boolean),
              subjectPrefix: $('#m-prefix', body).value.trim(),
              dedupeMinutes: Number($('#m-dedupe', body).value),
            };
            const pass = $('#m-pass', body).value;
            if (pass && pass !== '••••••••') payload.pass = pass;
            await api('/api/settings/mail', { method: 'PUT', body: payload });
            applyState(await api('/api/state'));
            toast('邮件设置已保存');
          } catch (err) {
            toast(err.message, 'error');
          }
        };
        $('#m-test', body).onclick = async () => {
          const btn = $('#m-test', body);
          btn.disabled = true;
          btn.textContent = '发送中…';
          try {
            await api('/api/settings/mail/test', { method: 'POST', body: {} });
            toast('测试邮件已发送，请查收');
          } catch (err) {
            toast('发送失败：' + err.message, 'error');
          } finally {
            btn.disabled = false;
            btn.textContent = '发送测试邮件';
          }
        };
        $('#y-save', body).onclick = async () => {
          try {
            await api('/api/settings/yogurt', {
              method: 'PUT',
              body: {
                probe: {
                  intervalMs: Number($('#y-interval', body).value),
                  timeoutMs: Number($('#y-timeout', body).value),
                  failures: Number($('#y-failures', body).value),
                  graceMs: Number($('#y-grace', body).value),
                },
                autoRestart: $('#y-autorestart', body).checked,
                offlinePatterns: $('#y-patterns', body).value.split('\n').map((s) => s.trim()).filter(Boolean),
                log: {
                  maxBytes: Number($('#y-logsize', body).value) * 1048576,
                  keepFiles: Number($('#y-logkeep', body).value),
                },
              },
            });
            applyState(await api('/api/state'));
            toast('判定设置已保存');
          } catch (err) {
            toast(err.message, 'error');
          }
        };
      },
    }
  );
}

// 面板重启：发请求 → 等它回来 → 刷新页面（令牌可能刚改，刷新后会提示输入）
async function restartPanel(msgEl) {
  if (!confirm('重启面板会先停掉所有账号，2 秒后自动拉起并重新启动账号。继续？')) return;
  if (msgEl) msgEl.textContent = '正在重启…';
  try {
    await api('/api/panel/restart', { method: 'POST', body: {} });
  } catch (err) {
    if (msgEl) msgEl.textContent = '请求失败：' + err.message;
    return;
  }
  for (let i = 0; i < 45; i++) {
    await new Promise((r) => setTimeout(r, 800));
    try {
      const res = await fetch('/api/health', { headers: token ? { 'x-panel-token': token } : {} });
      if (res.ok) {
        location.reload();
        return;
      }
    } catch {}
  }
  if (msgEl) msgEl.textContent = '面板 36 秒内没回来：看 data/panel.out.log，或手动重新启动';
}

function updateModal() {
  const u = state.update || {};
  const latest = u.latest;
  const notes = latest && latest.notes ? latest.notes : '';
  openModal(
    '版本更新',
    `
    <div class="section">
      <h3>当前状态</h3>
      <div class="grid2">
        <div class="field"><label>账号实际运行版本（取最低）</label><div class="mono">${esc(u.current || '未知')}</div></div>
        <div class="field"><label>面板已下载版本（dist）</label><div class="mono">${esc(u.distTag || '无')}</div></div>
        <div class="field"><label>最新版本</label><div class="mono">${esc(latest ? latest.tag : '未检查')}${latest ? `（${fmtTime(new Date(latest.publishedAt).getTime())}）` : ''}</div></div>
      </div>
      <div class="hint">各账号实际版本：${state.accounts.map((a) => `${esc(a.name)}=${esc(a.version || '未知')}${a.pid ? '' : '（未运行）'}`).join('、') || '无'}</div>
      ${latest && latest.hasUpdate ? '<div class="hint" style="color:var(--warn)">有新版本可用。</div>' : latest ? '<div class="hint">已是最新版本。</div>' : ''}
      ${u.error ? `<div class="hint" style="color:var(--danger)">上次检查失败：${esc(u.error)}</div>` : ''}
    </div>

    <div class="section">
      <h3>更新</h3>
      <div class="desc">从 GitHub Releases 下载 <span class="mono">${esc((u.asset || 'yogurt-<平台>.zip'))}</span>，校验 sha256 后解压、替换各账号目录里的可执行文件（旧文件备份到 data/backups）。更新会先停掉正在运行的账号，装完自动拉起。</div>
      <div class="field"><label>下载镜像前缀（github.com 直连不通时自动使用）</label><input class="input" id="u-mirror" value="${esc((state.settings.update && state.settings.update.mirrorPrefix) || '')}" placeholder="https://gh-proxy.com/" /></div>
      <div class="row" style="margin-top:12px">
        <button class="btn" id="u-check">检查更新</button>
        <button class="btn primary" id="u-install">下载并安装${latest ? ' ' + esc(latest.tag) : '最新版'}</button>
      </div>
      ${notes ? `<pre class="code" style="margin-top:12px">${esc(notes)}</pre>` : ''}
    </div>

    <div class="section">
      <h3>本地 zip 安装</h3>
      <div class="desc">没法联网时，手动下载 yogurt-windows-x64.zip 后从这里上传安装。</div>
      <div class="row">
        <input type="file" id="u-file" class="input" accept=".zip" />
        <input class="input" id="u-tag" placeholder="版本标签（可选，如 v0.1.0-dev.257）" style="max-width:260px" />
        <button class="btn primary" id="u-upload">上传并安装</button>
      </div>
      <div class="hint" id="u-progress"></div>
    </div>

    <div class="section">
      <h3>已下载的版本</h3>
      <div class="hint">${(u.dists || []).map((d) => `${esc(d.tag)}${d.hasExe ? '' : '（缺少 exe）'}`).join('、') || '暂无'}</div>
    </div>
  `,
    {
      onOpen(body) {
        $('#u-check', body).onclick = async () => {
          const btn = $('#u-check', body);
          btn.disabled = true;
          btn.textContent = '检查中…';
          try {
            await api('/api/update/check');
            applyState(await api('/api/state'));
            updateModal();
            toast('已检查最新版本');
          } catch (err) {
            toast('检查失败：' + err.message, 'error');
            btn.disabled = false;
            btn.textContent = '检查更新';
          }
        };
        const mirror = $('#u-mirror', body);
        if (mirror) {
          mirror.onchange = async () => {
            try {
              await api('/api/settings/yogurt', { method: 'PUT', body: {} });
            } catch {}
          };
        }
        $('#u-install', body).onclick = async () => {
          const btn = $('#u-install', body);
          btn.disabled = true;
          btn.textContent = '下载安装中…';
          try {
            const r = await api('/api/update/install', { method: 'POST', body: { refresh: true } });
            const via = r.result ? `（${r.result.tag}）` : '';
            toast('更新完成 ' + via);
            applyState(await api('/api/state'));
            updateModal();
          } catch (err) {
            toast('更新失败：' + err.message, 'error');
            btn.disabled = false;
            btn.textContent = '重试安装';
          }
        };
        $('#u-upload', body).onclick = async () => {
          const file = $('#u-file', body).files[0];
          if (!file) return toast('先选一个 zip 文件', 'error');
          const tag = $('#u-tag', body).value.trim();
          const prog = $('#u-progress', body);
          prog.textContent = '上传中…';
          try {
            const res = await api(
              `/api/update/upload?name=${encodeURIComponent(file.name)}${tag ? '&tag=' + encodeURIComponent(tag) : ''}`,
              { method: 'PUT', raw: file }
            );
            prog.textContent = '安装完成：' + (res.result ? res.result.tag : '');
            toast('本地包安装完成');
            applyState(await api('/api/state'));
          } catch (err) {
            prog.textContent = '失败：' + err.message;
            toast(err.message, 'error');
          }
        };
      },
    }
  );
}

function eventsModal() {
  state.unseenEvents = 0;
  const badge = $('#event-badge');
  badge.classList.add('hidden');
  const rows = state.events
    .map(
      (e) => `<tr>
        <td class="mono">${fmtTime(e.t)}</td>
        <td>${esc(e.accountName || e.accountId || '-')}</td>
        <td>${esc(e.title || '')}<div class="muted">${esc(e.detail || '')}</div></td>
        <td class="mail-${esc(e.mailStatus || 'skipped')}">${esc(
        { sent: '已发送', failed: '发送失败', deduped: '已去重', disabled: '未启用', skipped: '跳过' }[e.mailStatus] || e.mailStatus || '-'
      )}${e.mailError ? `<div class="muted">${esc(e.mailError)}</div>` : ''}</td>
      </tr>`
    )
    .join('');
  openModal(
    '事件记录',
    `<table class="tbl">
      <thead><tr><th>时间</th><th>账号</th><th>事件</th><th>邮件</th></tr></thead>
      <tbody>${rows || '<tr><td colspan="4" class="muted">还没有事件</td></tr>'}</tbody>
    </table>`
  );
}

function configModal(acc) {
  openModal(
    `${acc.name} · config.json`,
    `
    <div class="hint">直接编辑账号目录里的 config.json。保存后会自动同步 milky.http.port 到面板。</div>
    <textarea class="input" id="c-text" spellcheck="false">加载中…</textarea>
    <div class="row"><button class="btn primary" id="c-save">保存</button>
    <span class="hint" id="c-msg"></span></div>
  `,
    {
      async onOpen(body) {
        try {
          const data = await api(`/api/accounts/${encodeURIComponent(acc.id)}/config`);
          const ta = $('#c-text', body);
          let text = data.text || '';
          try {
            text = JSON.stringify(JSON.parse(text), null, 4);
          } catch {}
          ta.value = text;
        } catch (err) {
          $('#c-text', body).value = '// 读取失败：' + err.message;
        }
        $('#c-save', body).onclick = async () => {
          const msg = $('#c-msg', body);
          try {
            await api(`/api/accounts/${encodeURIComponent(acc.id)}/config`, {
              method: 'PUT',
              raw: $('#c-text', body).value,
              headers: { 'Content-Type': 'application/json' },
            });
            msg.textContent = '已保存，重启该账号后生效';
            toast('配置已保存');
            applyState(await api('/api/state'));
          } catch (err) {
            msg.textContent = err.message;
            toast(err.message, 'error');
          }
        };
      },
    }
  );
}

function qrModal(acc) {
  openModal(
    `${acc.name} · 登录二维码`,
    `
    <div class="hint">Yogurt 首次登录（或 session 失效）时会把二维码写到账号目录的 qrcode.png，同时把链接打印在日志里。扫码后可在「日志」抽屉底部输入验证码。</div>
    <div style="text-align:center">
      <img src="/api/accounts/${encodeURIComponent(acc.id)}/qrcode?t=${Date.now()}" style="width:260px;height:260px;background:#fff;border-radius:12px;padding:8px" onerror="this.style.display='none';this.nextElementSibling.textContent='暂无 qrcode.png（可能已登录，或还没开始登录）';" />
      <div class="hint"></div>
    </div>
    <div class="row"><button class="btn" onclick="location.reload()">刷新面板</button></div>
  `,
    {
      onOpen() {},
    }
  );
}

/* ---------------- 弹窗/抽屉事件绑定 ---------------- */
document.addEventListener('click', (ev) => {
  const opener = ev.target.closest('[data-open]');
  if (opener) {
    const what = opener.dataset.open;
    if (what === 'add') addAccountModal();
    if (what === 'settings') settingsModal();
    if (what === 'update') updateModal();
    if (what === 'events') eventsModal();
    return;
  }
  if (ev.target.id === 'modal-root') closeModal();
  if (ev.target.id === 'modal-close') closeModal();
  if (ev.target.id === 'drawer-close') closeDrawer();
  if (ev.target.id === 'drawer-backdrop') closeDrawer();
});

document.addEventListener('keydown', (ev) => {
  if (ev.key === 'Escape') {
    closeModal();
    if (state.drawer.id) closeDrawer();
  }
});

$('#log-filter').addEventListener('input', (ev) => {
  state.drawer.filter = ev.target.value;
  renderConsole();
});
$('#log-level').addEventListener('change', (ev) => {
  state.drawer.level = ev.target.value;
  renderConsole();
});
$('#log-pause').addEventListener('click', () => {
  state.drawer.paused = !state.drawer.paused;
  updatePauseBadge();
  if (!state.drawer.paused) {
    renderConsole();
  }
});
$('#log-chat').addEventListener('click', () => {
  state.drawer.hideChat = !state.drawer.hideChat;
  $('#log-chat').textContent = state.drawer.hideChat ? '💬 显示聊天' : '💬 隐藏聊天';
  renderConsole();
});
$('#log-download').addEventListener('click', () => {
  if (!state.drawer.id) return;
  window.open(`/api/accounts/${encodeURIComponent(state.drawer.id)}/logs/download` + (token ? '?token=' + encodeURIComponent(token) : ''), '_blank');
});
$('#log-clear').addEventListener('click', async () => {
  if (!state.drawer.id) return;
  if (!confirm('清空该账号的日志文件与当前显示？')) return;
  try {
    await api(`/api/accounts/${encodeURIComponent(state.drawer.id)}/action`, { method: 'POST', body: { action: 'clear-logs' } });
    state.drawer.lines = [];
    renderConsole();
  } catch (err) {
    toast(err.message, 'error');
  }
});
$('#stdin-form').addEventListener('submit', async (ev) => {
  ev.preventDefault();
  const input = $('#stdin-input');
  const text = input.value;
  if (!state.drawer.id || !text) return;
  try {
    await api(`/api/accounts/${encodeURIComponent(state.drawer.id)}/input`, { method: 'POST', body: { text } });
    input.value = '';
  } catch (err) {
    toast(err.message, 'error');
  }
});

window.addEventListener('beforeunload', () => {
  if (state.es) state.es.close();
  if (state.drawer.es) state.drawer.es.close();
});

boot();

// 支持通过 #settings / #update / #events / #add 直接打开对应弹窗
window.addEventListener('hashchange', openFromHash);
window.addEventListener('load', () => setTimeout(openFromHash, 800));

function openFromHash() {
  const hash = (location.hash || '').replace('#', '');
  if (!hash) return;
  setTimeout(() => {
    if (hash === 'settings') settingsModal();
    else if (hash === 'update') updateModal();
    else if (hash === 'events') eventsModal();
    else if (hash === 'add') addAccountModal();
  }, 300);
}
