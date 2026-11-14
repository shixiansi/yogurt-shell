'use strict';

const fs = require('fs');
const { execFile } = require('child_process');

// 查「进程实际在监听什么」，用来验证 config 里的 host 到底生效没有。
// Windows 用 netstat -ano（比 Get-NetTCPConnection 快），Linux 读 /proc。

// ---- Linux：/proc/net/tcp{,6} + /proc/<pid>/fd 里的 socket inode ----

// 0A = LISTEN；IPv4 是 8 位小端十六进制，IPv6 是 32 位
function decodeHexAddr(hex) {
  const text = String(hex || '');
  if (text.length === 8) {
    const value = parseInt(text, 16);
    if (!Number.isFinite(value)) return text;
    return [value & 0xff, (value >>> 8) & 0xff, (value >>> 16) & 0xff, (value >>> 24) & 0xff].join('.');
  }
  if (text.length === 32) {
    const groups = [];
    for (let i = 0; i < 32; i += 8) {
      const value = parseInt(text.slice(i, i + 8), 16);
      groups.push(value.toString(16));
    }
    // 全 0 就是 ::（所有网卡）
    const joined = groups.join(':');
    return /^0(:0)*$/.test(joined) ? '::' : joined;
  }
  return text;
}

function parseProcNetTcp(text) {
  const rows = [];
  const lines = String(text || '').split('\n');
  for (const line of lines.slice(1)) {
    const cols = line.trim().split(/\s+/);
    if (cols.length < 10) continue;
    const [addrHex, portHex] = cols[1].split(':');
    rows.push({
      addr: decodeHexAddr(addrHex),
      port: parseInt(portHex, 16),
      state: cols[3],
      inode: cols[9],
    });
  }
  return rows;
}

function socketInodes(pid, procRoot = '/proc') {
  const inodes = new Set();
  const dir = `${procRoot}/${pid}/fd`;
  let entries = [];
  try {
    entries = fs.readdirSync(dir);
  } catch {
    return inodes;
  }
  for (const entry of entries) {
    try {
      const target = fs.readlinkSync(`${dir}/${entry}`);
      const m = /^socket:\[(\d+)\]$/.exec(target);
      if (m) inodes.add(m[1]);
    } catch {}
  }
  return inodes;
}

function listenLinux(pid, options = {}) {
  const procRoot = options.procRoot || '/proc';
  const inodes = socketInodes(pid, procRoot);
  if (!inodes.size) return [];
  const result = [];
  for (const file of ['tcp', 'tcp6']) {
    let text = '';
    try {
      text = fs.readFileSync(`${procRoot}/net/${file}`, 'utf8');
    } catch {
      continue;
    }
    for (const row of parseProcNetTcp(text)) {
      if (row.state !== '0A') continue;
      if (!inodes.has(row.inode)) continue;
      result.push({ addr: row.addr, port: row.port });
    }
  }
  return dedupe(result);
}

// ---- Windows：netstat -ano ----
function parseNetstat(text) {
  const rows = [];
  for (const line of String(text || '').split(/\r?\n/)) {
    const cols = line.trim().split(/\s+/);
    if (cols.length < 4) continue;
    if (!/^TCP/i.test(cols[0])) continue;
    const stateCol = cols.find((c) => /^(LISTENING|LISTEN)$/i.test(c));
    if (!stateCol) continue;
    const pid = Number(cols[cols.length - 1]);
    const local = cols[1];
    const idx = local.lastIndexOf(':');
    if (idx <= 0) continue;
    const addr = local.slice(0, idx).replace(/^\[|\]$/g, '');
    const port = Number(local.slice(idx + 1));
    if (!Number.isFinite(port)) continue;
    rows.push({ addr, port, pid });
  }
  return rows;
}

function listenWindows(pid) {
  return new Promise((resolve) => {
    execFile('netstat', ['-ano', '-p', 'tcp'], { windowsHide: true, timeout: 8000, maxBuffer: 4 * 1024 * 1024 }, (err, stdout) => {
      if (err && !stdout) return resolve([]);
      const rows = parseNetstat(stdout).filter((r) => r.pid === Number(pid));
      resolve(dedupe(rows.map(({ addr, port }) => ({ addr, port }))));
    });
  });
}

// ---- 统一入口（带缓存，避免每次刷新状态都扫一遍）----
const cache = new Map(); // pid -> {t, value}

function dedupe(list) {
  const seen = new Set();
  const out = [];
  for (const item of list) {
    const key = `${item.addr}:${item.port}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }
  return out;
}

async function listenAddresses(pid, { ttlMs = 6000 } = {}) {
  if (!pid) return [];
  const hit = cache.get(pid);
  if (hit && Date.now() - hit.t < ttlMs) return hit.value;
  let value = [];
  try {
    if (process.platform === 'win32') value = await listenWindows(pid);
    else if (process.platform === 'linux') value = listenLinux(pid);
  } catch {
    value = [];
  }
  cache.set(pid, { t: Date.now(), value });
  if (cache.size > 64) {
    for (const [key, item] of cache) {
      if (Date.now() - item.t > 60000) cache.delete(key);
    }
  }
  return value;
}

// 判断监听地址是否覆盖了配置里期望的 host
function isWildcard(addr) {
  return addr === '0.0.0.0' || addr === '::' || addr === '*';
}

function describeMismatch(expectedHost, expectedPort, listenList) {
  if (!listenList || !listenList.length) return null;
  const portsOk = listenList.some((l) => l.port === Number(expectedPort));
  const wildcard = listenList.some((l) => isWildcard(l.addr));
  const loopbackOnly = listenList.every((l) => l.addr === '127.0.0.1' || l.addr === '::1');
  const expectsWildcard = isWildcard(expectedHost);
  if (!portsOk) {
    return `配置端口 ${expectedPort} 与实际监听端口不一致（实际：${listenList.map((l) => l.port).join(',')}）`;
  }
  if (expectsWildcard && loopbackOnly) {
    return `配置写的是 ${expectedHost}，但进程实际只监听了回环地址（未生效，或进程没重启）`;
  }
  return null;
}

// ---- 查「谁占了这个端口」（启动前自检用）----
function listenInodeForPort(port, procRoot = '/proc') {
  for (const file of ['tcp', 'tcp6']) {
    let text = '';
    try {
      text = fs.readFileSync(`${procRoot}/net/${file}`, 'utf8');
    } catch {
      continue;
    }
    for (const row of parseProcNetTcp(text)) {
      if (row.state !== '0A') continue;
      if (row.port === Number(port)) return row.inode;
    }
  }
  return null;
}

function pidForInode(inode, procRoot = '/proc') {
  let entries = [];
  try {
    entries = fs.readdirSync(procRoot);
  } catch {
    return null;
  }
  for (const entry of entries) {
    if (!/^\d+$/.test(entry)) continue;
    const fdDir = path.join(procRoot, entry, 'fd');
    let fds = [];
    try {
      fds = fs.readdirSync(fdDir);
    } catch {
      continue;
    }
    for (const fd of fds) {
      let target = '';
      try {
        target = fs.readlinkSync(path.join(fdDir, fd));
      } catch {
        continue;
      }
      if (target === `socket:[${inode}]`) return Number(entry);
    }
  }
  return null;
}

function netstatText() {
  return new Promise((resolve) => {
    execFile('netstat', ['-ano', '-p', 'tcp'], { windowsHide: true, timeout: 8000, maxBuffer: 4 * 1024 * 1024 }, (err, stdout) => {
      resolve(err && !stdout ? '' : String(stdout || ''));
    });
  });
}

async function findPortOwner(port) {
  if (!port) return null;
  if (process.platform === 'win32') {
    const rows = parseNetstat(await netstatText()).filter((r) => r.port === Number(port));
    return rows.length ? { pid: rows[0].pid, addr: rows[0].addr } : null;
  }
  if (process.platform === 'linux') {
    const inode = listenInodeForPort(port);
    if (!inode) return null;
    return { pid: pidForInode(inode), inode };
  }
  return null;
}

module.exports = {
  listenAddresses,
  listenLinux,
  listenWindows,
  parseNetstat,
  parseProcNetTcp,
  decodeHexAddr,
  isWildcard,
  describeMismatch,
  findPortOwner,
  listenInodeForPort,
  pidForInode,
};
