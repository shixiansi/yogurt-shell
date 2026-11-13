'use strict';

const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');
const store = require('./store');
const { sendMail } = require('./smtp');

const EVENT_LIMIT = 500;

function fmtTime(ts) {
  if (!ts) return '-';
  const d = new Date(ts);
  return d.toLocaleString('zh-CN', { hour12: false });
}

function fmtDuration(ms) {
  if (!ms || ms < 0) return '-';
  const s = Math.floor(ms / 1000);
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  const parts = [];
  if (d) parts.push(d + ' 天');
  if (h) parts.push(h + ' 小时');
  parts.push(m + ' 分');
  parts.push(s % 60 + ' 秒');
  return parts.join(' ');
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

class Notifier extends EventEmitter {
  constructor({ bus }) {
    super();
    this.setMaxListeners(0);
    this.bus = bus;
    this.events = [];
    this.lastSent = new Map();
    this.loadEvents();
  }

  loadEvents() {
    try {
      if (!fs.existsSync(store.PATHS.events)) return;
      const raw = fs.readFileSync(store.PATHS.events, 'utf8').trim().split('\n').filter(Boolean).slice(-EVENT_LIMIT);
      this.events = raw.map((line) => {
        try {
          return JSON.parse(line);
        } catch {
          return null;
        }
      }).filter(Boolean);
    } catch {}
  }

  record(event) {
    const full = { id: event.id || `${Date.now()}-${Math.random().toString(16).slice(2, 8)}`, t: event.t || Date.now(), ...event };
    this.events.push(full);
    if (this.events.length > EVENT_LIMIT) this.events.splice(0, this.events.length - EVENT_LIMIT);
    try {
      fs.appendFileSync(store.PATHS.events, JSON.stringify(full) + '\n', 'utf8');
    } catch {}
    this.emit('event', full);
    return full;
  }

  list(limit = 100) {
    return this.events.slice(-limit).reverse();
  }

  lastLogs(accountId, n = 40) {
    const lines = this.bus.tail(accountId, n);
    return lines.map((l) => l.text);
  }

  buildMail({ account, snapshot, type, title, detail }) {
    const cfg = store.getConfig();
    const logs = this.lastLogs(account.id, 40);
    const port = snapshot ? snapshot.port : account.port;
    const lines = [
      `账号：${account.name || ''}（${account.id}）`,
      `主机：${cfg.hostName || ''}${require('os').hostname()}`,
      `端口：${port}`,
      `状态：${snapshot ? snapshot.statusLabel : '-'}`,
      `原因：${detail || '-'}`,
      `进程：${snapshot && snapshot.pid ? 'pid ' + snapshot.pid : '已无进程'}`,
      `运行时长：${snapshot ? fmtDuration(snapshot.uptimeMs) : '-'}`,
      `版本：${snapshot && snapshot.version ? snapshot.version : '未知'}`,
      `时间：${fmtTime(Date.now())}`,
      '',
      '—— 最近日志（最后 40 行）——',
      ...logs,
      '',
      '—— 处理建议 ——',
      '1. 打开 Yogurt Shell 面板查看该账号日志与占用；',
      '2. 确认网络/签名 API 正常、账号是否需要重新扫码登录；',
      '3. 处理完成后在面板点「启动」恢复；掉线后进程已被停止，不会再发请求。',
    ];
    const text = `${title}\n\n${lines.join('\n')}`;
    const html = `<h3>${escapeHtml(title)}</h3>
<table style="border-collapse:collapse;font-size:13px">
${[
  ['账号', `${account.name || ''}（${account.id}）`],
  ['主机', require('os').hostname()],
  ['端口', String(port)],
  ['状态', snapshot ? snapshot.statusLabel : '-'],
  ['原因', detail || '-'],
  ['进程', snapshot && snapshot.pid ? 'pid ' + snapshot.pid : '已无进程'],
  ['运行时长', snapshot ? fmtDuration(snapshot.uptimeMs) : '-'],
  ['版本', (snapshot && snapshot.version) || '未知'],
  ['时间', fmtTime(Date.now())],
]
  .map(([k, v]) => `<tr><td style="padding:2px 12px 2px 0;color:#666">${escapeHtml(k)}</td><td style="padding:2px 0">${escapeHtml(v)}</td></tr>`)
  .join('\n')}
</table>
<p style="margin-top:16px;color:#666;font-size:13px">最近日志（最后 40 行）</p>
<pre style="background:#0f1419;color:#d6deeb;padding:12px;border-radius:6px;font-size:12px;overflow:auto;max-height:420px">${escapeHtml(logs.join('\n'))}</pre>
<p style="font-size:13px;color:#666">掉线后进程已被停止，不会再向账号发送请求。处理完成后在面板点「启动」恢复。</p>`;
    return { text, html, subject: `${cfg.mail.subjectPrefix || '[Yogurt]'} ${title} - ${account.name || account.id}` };
  }

  async handleIncident({ account, snapshot, type, title, detail }) {
    const cfg = store.getConfig();
    const mail = cfg.mail;
    const event = {
      kind: type,
      accountId: account.id,
      accountName: account.name,
      title,
      detail,
      mailStatus: 'skipped',
      mailError: null,
    };

    if (this.bus) {
      this.bus.append(account.id, `${new Date().toLocaleTimeString('zh-CN', { hour12: false })} WARN [shell] 事件：${title}｜${detail || ''}`);
    }

    if (!mail.enabled) {
      event.mailStatus = 'disabled';
      event.mailError = '邮件通知未启用';
      const rec = this.record(event);
      this.emit('event', rec);
      return rec;
    }
    if (!mail.host || !mail.from || !(mail.to && mail.to.length)) {
      event.mailStatus = 'failed';
      event.mailError = 'SMTP 配置不完整（host / from / to）';
      const rec = this.record(event);
      this.emit('event', rec);
      return rec;
    }

    const dedupeKey = `${type}:${account.id}`;
    const windowMs = Math.max(0, Number(mail.dedupeMinutes || 0)) * 60000;
    const last = this.lastSent.get(dedupeKey) || 0;
    if (windowMs > 0 && Date.now() - last < windowMs) {
      event.mailStatus = 'deduped';
      event.mailError = `${Math.round(windowMs / 60000)} 分钟内已发过同类通知，本次不重复发送`;
      const rec = this.record(event);
      return rec;
    }

    const built = this.buildMail({ account, snapshot, type, title, detail });
    try {
      await sendMail({
        host: mail.host,
        port: Number(mail.port) || 465,
        secure: mail.secure !== false,
        user: mail.user,
        pass: mail.pass,
        from: mail.from,
        to: mail.to,
        subject: built.subject,
        text: built.text,
        html: built.html,
        rejectUnauthorized: mail.rejectUnauthorized !== false,
      });
      event.mailStatus = 'sent';
      this.lastSent.set(dedupeKey, Date.now());
    } catch (err) {
      event.mailStatus = 'failed';
      event.mailError = err.message;
      if (this.bus) {
        this.bus.append(account.id, `${new Date().toLocaleTimeString('zh-CN', { hour12: false })} ERROR [shell] 邮件通知发送失败：${err.message}`);
      }
    }
    const rec = this.record(event);
    this.emit('event', rec);
    return rec;
  }

  async testMail() {
    const cfg = store.getConfig();
    const mail = cfg.mail;
    if (!mail.host || !mail.from || !(mail.to && mail.to.length)) {
      throw new Error('请先填写 SMTP 服务器、发件人和至少一个收件人');
    }
    const text = [
      '这是一封来自 Yogurt Shell 的测试邮件。',
      '',
      `时间：${fmtTime(Date.now())}`,
      `主机：${require('os').hostname()}`,
      `已配置账号：${cfg.accounts.map((a) => `${a.name || ''}(${a.id})`).join('、') || '无'}`,
      '',
      '收到这封邮件说明 SMTP 配置可用；此后账号掉线 / 进程异常退出会自动发送同类邮件。',
    ].join('\n');
    const result = await sendMail({
      host: mail.host,
      port: Number(mail.port) || 465,
      secure: mail.secure !== false,
      user: mail.user,
      pass: mail.pass,
      from: mail.from,
      to: mail.to,
      subject: `${cfg.mail.subjectPrefix || '[Yogurt]'} 测试邮件`,
      text,
      html: `<pre style="font-size:13px">${escapeHtml(text)}</pre>`,
    });
    this.record({
      kind: 'mail-test',
      title: '测试邮件已发送',
      detail: (mail.to || []).join(', '),
      mailStatus: 'sent',
    });
    return result;
  }
}

module.exports = { Notifier, fmtTime, fmtDuration };
