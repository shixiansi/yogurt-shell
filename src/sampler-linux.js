'use strict';

const fs = require('fs');
const path = require('path');

// Linux /proc 采样：CPU 时间、RSS、线程数、文件描述符数。
// 纯函数单独导出，方便在没有 Linux 的环境里用 fixture 做单元测试。

// /proc/<pid>/stat 的解析：comm 里可能有空格和括号，所以从最后一个 ')' 之后开始切
function parseStat(text) {
  const end = text.lastIndexOf(')');
  if (end < 0) throw new Error('非法 stat');
  const fields = text.slice(end + 2).trim().split(/\s+/);
  // fields[0] 是第 3 个字段（state），所以第 N 个字段 = fields[N - 3]
  const num = (index) => {
    const value = Number(fields[index]);
    return Number.isFinite(value) ? value : 0;
  };
  return {
    state: fields[0],
    utime: num(14 - 3),
    stime: num(15 - 3),
    threads: num(20 - 3),
    starttime: num(22 - 3),
  };
}

// /proc/<pid>/status
function parseStatus(text) {
  const grab = (key) => {
    const m = new RegExp('^' + key + ':\\s*(\\d+)', 'm').exec(text);
    return m ? Number(m[1]) : 0;
  };
  return {
    vmRss: grab('VmRSS') * 1024,
    rssAnon: grab('RssAnon') * 1024,
    threads: grab('Threads'),
  };
}

function tickHz() {
  const fromEnv = Number(process.env.CLK_TCK);
  return Number.isFinite(fromEnv) && fromEnv > 0 ? fromEnv : 100;
}

function samplePid(pid, options = {}) {
  const procRoot = options.procRoot || '/proc';
  const hz = options.tickHz || tickHz();
  const base = path.join(procRoot, String(pid));
  const stat = parseStat(fs.readFileSync(path.join(base, 'stat'), 'utf8'));
  let status = { vmRss: 0, rssAnon: 0, threads: stat.threads };
  try {
    status = parseStatus(fs.readFileSync(path.join(base, 'status'), 'utf8'));
  } catch {}
  let handles = 0;
  try {
    handles = fs.readdirSync(path.join(base, 'fd')).length;
  } catch {}
  return {
    pid: Number(pid),
    cpuSeconds: (stat.utime + stat.stime) / hz,
    ws: status.vmRss,
    priv: status.rssAnon || status.vmRss,
    threads: status.threads || stat.threads,
    handles,
  };
}

// 定时轮询一组 pid，输出和 Windows 采样器一致的结构，交给 Metrics 统一处理
function sampleMany(pids, options = {}) {
  const items = [];
  for (const pid of pids) {
    try {
      items.push(samplePid(pid, options));
    } catch {
      items.push({ pid, alive: false });
    }
  }
  return { t: Date.now(), items };
}

module.exports = { parseStat, parseStatus, samplePid, sampleMany, tickHz };
