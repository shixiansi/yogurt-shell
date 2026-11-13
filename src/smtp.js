'use strict';

const net = require('net');
const tls = require('tls');
const os = require('os');
const crypto = require('crypto');

// 极简 SMTP 客户端（无第三方依赖）：支持 465 隐式 TLS、587/25 STARTTLS、AUTH LOGIN / PLAIN。

class ReplyReader {
  constructor(socket) {
    this.socket = socket;
    this.buffer = '';
    this.waiters = [];
    socket.on('data', (chunk) => {
      this.buffer += chunk.toString('utf8');
      this.tryResolve();
    });
    socket.on('error', (err) => this.fail(err));
    socket.on('close', () => this.fail(new Error('SMTP 连接已关闭')));
  }

  attach(socket) {
    this.socket = socket;
    this.buffer = '';
    socket.on('data', (chunk) => {
      this.buffer += chunk.toString('utf8');
      this.tryResolve();
    });
    socket.on('error', (err) => this.fail(err));
    socket.on('close', () => this.fail(new Error('SMTP 连接已关闭')));
  }

  fail(err) {
    const waiters = this.waiters.splice(0);
    waiters.forEach((w) => w.reject(err));
  }

  read() {
    return new Promise((resolve, reject) => {
      this.waiters.push({ resolve, reject });
      this.tryResolve();
    });
  }

  tryResolve() {
    while (this.waiters.length) {
      let pos = 0;
      let complete = false;
      let endPos = 0;
      const lines = [];
      while (true) {
        const idx = this.buffer.indexOf('\n', pos);
        if (idx < 0) break;
        const line = this.buffer.slice(pos, idx).replace(/\r$/, '');
        lines.push(line);
        pos = idx + 1;
        if (/^\d{3} /.test(line)) {
          complete = true;
          endPos = pos;
          break;
        }
      }
      if (!complete) return;
      this.buffer = this.buffer.slice(endPos);
      const last = lines[lines.length - 1];
      const code = parseInt(last.slice(0, 3), 10);
      const waiter = this.waiters.shift();
      waiter.resolve({ code, lines, text: lines.join('\n') });
    }
  }
}

function buildMessage({ from, fromName, to, subject, text, html }) {
  const boundary = 'yogurt-shell-' + crypto.randomBytes(8).toString('hex');
  const enc = (s) => Buffer.from(String(s), 'utf8').toString('base64').replace(/(.{76})/g, '$1\r\n');
  const addr = (a) => (/<.*>/.test(a) ? a : `<${a}>`);
  const date = new Date().toUTCString();
  const msgId = `<${Date.now()}.${crypto.randomBytes(6).toString('hex')}@yogurt-shell>`;
  const headers = [
    'Date: ' + date,
    'From: ' + (fromName ? `=?UTF-8?B?${Buffer.from(fromName, 'utf8').toString('base64')}?= ` : '') + addr(from),
    'To: ' + to.map(addr).join(', '),
    'Subject: =?UTF-8?B?' + Buffer.from(subject, 'utf8').toString('base64') + '?=',
    'Message-ID: ' + msgId,
    'MIME-Version: 1.0',
    'Content-Type: multipart/alternative; boundary="' + boundary + '"',
  ];
  const body = [
    '--' + boundary,
    'Content-Type: text/plain; charset=UTF-8',
    'Content-Transfer-Encoding: base64',
    '',
    enc(text),
    '--' + boundary,
    'Content-Type: text/html; charset=UTF-8',
    'Content-Transfer-Encoding: base64',
    '',
    enc(html || `<pre>${text}</pre>`),
    '--' + boundary + '--',
    '',
  ];
  return headers.join('\r\n') + '\r\n\r\n' + body.join('\r\n');
}

function connectSocket({ host, port, secure, rejectUnauthorized = true, timeout }) {
  return new Promise((resolve, reject) => {
    const opts = { host, port, rejectUnauthorized };
    const socket = secure ? tls.connect(opts) : net.connect(opts);
    let settled = false;
    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        socket.destroy();
        reject(new Error(`连接 ${host}:${port} 超时`));
      }
    }, timeout);
    const onReady = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.setTimeout(0);
      resolve(socket);
    };
    socket.once(secure ? 'secureConnect' : 'connect', onReady);
    socket.once('error', (err) => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        reject(err);
      }
    });
  });
}

async function sendMail(options) {
  const {
    host,
    port,
    secure = port === 465,
    user = '',
    pass = '',
    from,
    to,
    subject,
    text,
    html,
    fromName = 'Yogurt Shell',
    rejectUnauthorized = true,
    timeout = 25000,
  } = options;

  if (!host) throw new Error('未配置 SMTP 服务器');
  if (!from) throw new Error('未配置发件人');
  const recipients = (Array.isArray(to) ? to : String(to || '').split(/[,;\s]+/)).filter(Boolean);
  if (!recipients.length) throw new Error('未配置收件人');

  let socket = await connectSocket({ host, port, secure, rejectUnauthorized, timeout });
  const reader = new ReplyReader(socket);
  const raw = [];
  const step = async (cmd, expectCodes) => {
    if (cmd != null) {
      raw.push('>> ' + (cmd.length > 200 ? cmd.slice(0, 200) + '…' : cmd));
      socket.write(cmd + '\r\n');
    }
    const reply = await reader.read();
    raw.push('<< ' + reply.text);
    if (expectCodes && !expectCodes.includes(reply.code)) {
      throw new Error(`SMTP 返回 ${reply.code}：${reply.text}`);
    }
    return reply;
  };

  const deadline = setTimeout(() => {
    try {
      socket.destroy();
    } catch {}
  }, timeout * 3);

  try {
    await step(null, [220]);
    const hostname = os.hostname() || 'localhost';
    let ehlo = await step(`EHLO ${hostname}`, [250]);

    if (!secure) {
      const caps = ehlo.lines.join('\n').toUpperCase();
      if (caps.includes('STARTTLS')) {
        await step('STARTTLS', [220]);
        socket.removeAllListeners('data');
        socket.removeAllListeners('error');
        socket.removeAllListeners('close');
        socket = await new Promise((resolve, reject) => {
          const upgraded = tls.connect({ socket, servername: host, rejectUnauthorized }, () => resolve(upgraded));
          upgraded.once('error', reject);
        });
        reader.attach(socket);
        ehlo = await step(`EHLO ${hostname}`, [250]);
      }
    }

    if (user) {
      const caps = ehlo.lines.join('\n').toUpperCase();
      const usePlain = /AUTH[^\n]*PLAIN/.test(caps) && !/AUTH[^\n]*LOGIN/.test(caps);
      if (usePlain) {
        const token = Buffer.from(`\u0000${user}\u0000${pass}`, 'utf8').toString('base64');
        await step(`AUTH PLAIN ${token}`, [235]);
      } else {
        await step('AUTH LOGIN', [334]);
        await step(Buffer.from(user, 'utf8').toString('base64'), [334]);
        await step(Buffer.from(pass, 'utf8').toString('base64'), [235]);
      }
    }

    await step(`MAIL FROM:<${from}>`, [250]);
    for (const rcpt of recipients) {
      await step(`RCPT TO:<${rcpt}>`, [250, 251]);
    }
    await step('DATA', [354]);
    const message = buildMessage({ from, fromName, to: recipients, subject, text, html });
    const stuffed = message
      .split('\r\n')
      .map((line) => (line.startsWith('.') ? '.' + line : line))
      .join('\r\n');
    raw.push('>> [message ' + message.length + ' bytes]');
    socket.write(stuffed + '\r\n.\r\n');
    await step(null, [250]);
    try {
      await step('QUIT', [221]);
    } catch {}
    return { ok: true, transcript: raw.slice(-12) };
  } finally {
    clearTimeout(deadline);
    try {
      socket.destroy();
    } catch {}
  }
}

module.exports = { sendMail };
