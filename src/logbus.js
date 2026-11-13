'use strict';

const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');
const { stripAnsi, detectLevel } = require('./ansi');
const { PATHS } = require('./store');

// 每个账号一份内存环形缓冲 + 一个落盘文件（带轮转），并通过事件推给 SSE。
class LogBus extends EventEmitter {
  constructor(options = {}) {
    super();
    this.setMaxListeners(0);
    this.maxBytes = options.maxBytes || 20 * 1024 * 1024;
    this.keepFiles = options.keepFiles == null ? 6 : options.keepFiles;
    this.memoryLines = options.memoryLines || 2000;
    this.buffers = new Map();
    this.files = new Map();
    fs.mkdirSync(PATHS.logs, { recursive: true });
  }

  setLimits({ maxBytes, keepFiles, memoryLines }) {
    if (maxBytes) this.maxBytes = maxBytes;
    if (keepFiles != null) this.keepFiles = keepFiles;
    if (memoryLines) this.memoryLines = memoryLines;
  }

  logFile(accountId) {
    return path.join(PATHS.logs, String(accountId) + '.log');
  }

  buffer(accountId) {
    let buf = this.buffers.get(accountId);
    if (!buf) {
      buf = [];
      this.buffers.set(accountId, buf);
    }
    return buf;
  }

  writer(accountId) {
    let w = this.files.get(accountId);
    if (!w) {
      const file = this.logFile(accountId);
      try {
        w = { file, fd: fs.openSync(file, 'a'), size: fs.existsSync(file) ? fs.statSync(file).size : 0 };
      } catch {
        w = { file, fd: null, size: 0 };
      }
      this.files.set(accountId, w);
    }
    return w;
  }

  rotate(accountId, w) {
    try {
      if (w.fd != null) fs.closeSync(w.fd);
    } catch {}
    const rotated = path.join(PATHS.logs, `${accountId}.${Date.now()}.log`);
    try {
      fs.renameSync(w.file, rotated);
    } catch {}
    w.fd = fs.openSync(w.file, 'w');
    w.size = 0;
    this.prune(accountId);
  }

  prune(accountId) {
    try {
      const files = fs
        .readdirSync(PATHS.logs)
        .filter((f) => f.startsWith(String(accountId) + '.') && f.endsWith('.log'))
        .map((f) => ({ f, t: fs.statSync(path.join(PATHS.logs, f)).mtimeMs }))
        .sort((a, b) => b.t - a.t);
      files.slice(this.keepFiles).forEach((item) => {
        try {
          fs.unlinkSync(path.join(PATHS.logs, item.f));
        } catch {}
      });
    } catch {}
  }

  append(accountId, rawLine) {
    const clean = stripAnsi(rawLine).replace(/\r/g, '');
    if (!clean.trim()) return null;
    const entry = { t: Date.now(), level: detectLevel(rawLine), text: clean };
    const buf = this.buffer(accountId);
    buf.push(entry);
    if (buf.length > this.memoryLines) buf.splice(0, buf.length - this.memoryLines);

    const w = this.writer(accountId);
    try {
      if (w.fd != null) {
        const payload = Buffer.from(clean + '\n', 'utf8');
        if (w.size + payload.length > this.maxBytes) this.rotate(accountId, w);
        const w2 = this.writer(accountId);
        if (w2.fd != null) {
          fs.writeSync(w2.fd, payload);
          w2.size += payload.length;
        }
      }
    } catch {}

    this.emit('line', { accountId, entry });
    return entry;
  }

  meta(accountId) {
    const w = this.files.get(accountId);
    const file = this.logFile(accountId);
    let size = 0;
    try {
      size = fs.statSync(file).size;
    } catch {}
    return { file, size, writing: Boolean(w && w.fd != null) };
  }

  // 内存里没有（比如面板刚启动）时，从文件尾部读一段
  tail(accountId, limit = 500) {
    const buf = this.buffer(accountId);
    if (buf.length > 0) return buf.slice(-limit);
    const file = this.logFile(accountId);
    try {
      const stat = fs.statSync(file);
      const readBytes = Math.min(stat.size, 512 * 1024);
      const fd = fs.openSync(file, 'r');
      const data = Buffer.alloc(readBytes);
      fs.readSync(fd, data, 0, readBytes, stat.size - readBytes);
      fs.closeSync(fd);
      const lines = data
        .toString('utf8')
        .split('\n')
        .map((s) => s.replace(/\r$/, ''))
        .filter((s) => s.trim());
      return lines.slice(-limit).map((text) => ({ t: 0, level: detectLevel(text), text }));
    } catch {
      return [];
    }
  }

  clear(accountId) {
    this.buffers.set(accountId, []);
    const w = this.files.get(accountId);
    try {
      if (w && w.fd != null) fs.closeSync(w.fd);
    } catch {}
    this.files.delete(accountId);
    try {
      fs.rmSync(this.logFile(accountId), { force: true });
    } catch {}
  }
}

module.exports = { LogBus };
