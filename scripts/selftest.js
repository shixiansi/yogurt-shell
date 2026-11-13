'use strict';

// 平台无关的自测：不联网、不需要装有 yogurt，校验跨平台逻辑是否正常。
// 用法：node scripts/selftest.js

const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');

const store = require('../src/store');
const platform = require('../src/platform');
const procfs = require('../src/sampler-linux');
const { extractZip } = require('../src/zipx');
const { compareVersions } = require('../src/updater');
const { stripAnsi, detectLevel } = require('../src/ansi');
const procs = require('../src/procs');

let pass = 0;
const failures = [];

function check(name, fn) {
  try {
    const result = fn();
    if (result === false) throw new Error('返回 false');
    pass += 1;
    console.log(`  ok   ${name}`);
  } catch (err) {
    failures.push({ name, error: err.message });
    console.log(`  FAIL ${name} -> ${err.message}`);
  }
}

function eq(actual, expected, label = '') {
  if (actual !== expected) throw new Error(`${label} 期望 ${JSON.stringify(expected)}，实际 ${JSON.stringify(actual)}`);
}

function tmpDir(prefix = 'ys-selftest-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

// ---------- 1. 平台差异 ----------
console.log('\n[1] 平台映射（exe 名字 / 发版包名）');
check('windows 包名与可执行文件名', () => {
  eq(platform.assetFor('win32', 'x64'), 'yogurt-windows-x64.zip');
  eq(platform.binNames('win32')[0], 'yogurt.exe');
});
check('linux x64 / arm64 包名', () => {
  eq(platform.assetFor('linux', 'x64'), 'yogurt-linux-x64.zip');
  eq(platform.assetFor('linux', 'arm64'), 'yogurt-linux-arm64.zip');
  eq(platform.binNames('linux')[0], 'yogurt.kexe');
});
check('macos 包名', () => {
  eq(platform.assetFor('darwin', 'arm64'), 'yogurt-macos-arm64.zip');
});
check('findBinary 能认出各平台文件名', () => {
  const dir = tmpDir();
  const linuxBin = path.join(dir, 'yogurt.kexe');
  fs.writeFileSync(linuxBin, '');
  eq(platform.findBinary(dir, 'linux'), linuxBin);
  eq(platform.findBinary(dir, 'win32'), null);
  const winBin = path.join(dir, 'yogurt.exe');
  fs.writeFileSync(winBin, '');
  eq(platform.findBinary(dir, 'win32'), winBin);
  fs.rmSync(dir, { recursive: true, force: true });
});

// ---------- 2. /proc 解析 ----------
console.log('\n[2] Linux /proc 解析');
const statFixture =
  '1234 (yogurt (kexe) worker) S 1 1234 1234 0 -1 4194560 ' +
  '120 0 12 0 300 200 0 0 20 0 29 0 987654 1073741824 2621 18446744073709551615 ' +
  '0 0 0 0 0 0 0 0 0 0 0 0 17 3 0 0 0 0 0 0 0 0 0 0 0 0\n';
check('parseStat：comm 里有空格/括号也能切对', () => {
  const parsed = procfs.parseStat(statFixture);
  eq(parsed.utime, 300, 'utime');
  eq(parsed.stime, 200, 'stime');
  eq(parsed.threads, 29, 'threads');
  eq(parsed.starttime, 987654, 'starttime');
});
check('parseStatus：VmRSS / RssAnon / Threads', () => {
  const status =
    'Name:\tyogurt\nState:\tS (sleeping)\nVmRSS:\t  204800 kB\nRssAnon:\t  153600 kB\nThreads:\t31\n';
  const parsed = procfs.parseStatus(status);
  eq(parsed.vmRss, 204800 * 1024, 'VmRSS');
  eq(parsed.rssAnon, 153600 * 1024, 'RssAnon');
  eq(parsed.threads, 31, 'Threads');
});
check('samplePid：用假 /proc 目录跑完整采样', () => {
  const root = tmpDir('ys-proc-');
  const pidDir = path.join(root, '4321');
  fs.mkdirSync(path.join(pidDir, 'fd'), { recursive: true });
  fs.writeFileSync(path.join(pidDir, 'stat'), statFixture);
  fs.writeFileSync(
    path.join(pidDir, 'status'),
    'VmRSS:\t  102400 kB\nRssAnon:\t  51200 kB\nThreads:\t7\n'
  );
  ['0', '1', '2', '3'].forEach((n) => fs.writeFileSync(path.join(pidDir, 'fd', n), ''));
  const sample = procfs.samplePid(4321, { procRoot: root, tickHz: 100 });
  eq(sample.cpuSeconds, 5, 'cpuSeconds=(300+200)/100');
  eq(sample.ws, 102400 * 1024, 'ws');
  eq(sample.priv, 51200 * 1024, 'priv');
  eq(sample.threads, 7, 'threads');
  eq(sample.handles, 4, 'handles=fd 数');
  fs.rmSync(root, { recursive: true, force: true });
});
check('sampleMany：pid 不存在时返回 alive=false', () => {
  const root = tmpDir('ys-proc-');
  const out = procfs.sampleMany([999999], { procRoot: root });
  eq(out.items[0].alive, false);
  fs.rmSync(root, { recursive: true, force: true });
});
if (process.platform === 'linux') {
  check('真实 /proc 上采样自己的进程', () => {
    const sample = procfs.samplePid(process.pid);
    if (!(sample.cpuSeconds >= 0)) throw new Error('cpuSeconds 异常');
    if (!(sample.ws > 0)) throw new Error('RSS 读不到');
    if (!(sample.threads >= 1)) throw new Error('线程数读不到');
  });
}

// ---------- 3. 内置 zip 解压 ----------
console.log('\n[3] 内置 zip 解压（更新包用）');
function buildZip(entries) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const entry of entries) {
    const nameBuf = Buffer.from(entry.name, 'utf8');
    const raw = Buffer.isBuffer(entry.data) ? entry.data : Buffer.from(entry.data, 'utf8');
    const stored = entry.store ? raw : zlib.deflateRawSync(raw);
    const method = entry.store ? 0 : 8;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x800, 6); // UTF-8 文件名
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(0, 10);
    local.writeUInt16LE(0, 12);
    local.writeUInt32LE(0, 14); // crc32（本实现不校验）
    local.writeUInt32LE(stored.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);
    const localBlock = Buffer.concat([local, nameBuf, stored]);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x800, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt16LE(0, 12);
    central.writeUInt16LE(0, 14);
    central.writeUInt32LE(0, 16);
    central.writeUInt32LE(stored.length, 20);
    central.writeUInt32LE(raw.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt16LE(0, 36);
    central.writeUInt32LE(0, 38);
    central.writeUInt32LE(offset, 42);
    const centralBlock = Buffer.concat([central, nameBuf]);

    locals.push(localBlock);
    centrals.push(centralBlock);
    offset += localBlock.length;
  }
  const cd = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(cd.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, eocd]);
}

check('解压 stored + deflate，含子目录', () => {
  const dir = tmpDir('ys-zip-');
  const zipPath = path.join(dir, 'yogurt-linux-x64.zip');
  fs.writeFileSync(
    zipPath,
    buildZip([
      { name: 'yogurt.kexe', data: 'BINARY-CONTENT-'.repeat(200), store: false },
      { name: 'README.txt', data: 'hello 中文', store: true },
      { name: 'lib/x.txt', data: 'nested', store: false },
    ])
  );
  const out = path.join(dir, 'out');
  const written = extractZip(zipPath, out);
  eq(written.length, 3);
  eq(fs.readFileSync(path.join(out, 'yogurt.kexe'), 'utf8').length, 'BINARY-CONTENT-'.repeat(200).length);
  eq(fs.readFileSync(path.join(out, 'README.txt'), 'utf8'), 'hello 中文');
  eq(fs.readFileSync(path.join(out, 'lib', 'x.txt'), 'utf8'), 'nested');
  fs.rmSync(dir, { recursive: true, force: true });
});
check('解压后 process.platform 与包内文件名匹配检查', () => {
  const dir = tmpDir('ys-zip-');
  const zipPath = path.join(dir, 'wrong.zip');
  fs.writeFileSync(zipPath, buildZip([{ name: 'README.txt', data: 'no binary', store: true }]));
  const out = path.join(dir, 'out');
  extractZip(zipPath, out);
  eq(platform.findBinary(out), null);
  fs.rmSync(dir, { recursive: true, force: true });
});

// ---------- 4. 版本比较 ----------
console.log('\n[4] 版本比较（更新判定）');
check('dev 构建号比较', () => {
  if (compareVersions('v0.1.0-dev.257', '0.1.0-dev.248') <= 0) throw new Error('257 应大于 248');
  if (compareVersions('v0.1.0-dev.248', 'v0.1.0-dev.257') >= 0) throw new Error('248 应小于 257');
  eq(compareVersions('v0.1.0-dev.257', '0.1.0-dev.257'), 0);
  if (compareVersions('0.1.0-dev.1000', '0.1.0-dev.257') <= 0) throw new Error('1000 应大于 257');
  if (compareVersions('0.2.0-dev.1', '0.1.9-dev.999') <= 0) throw new Error('0.2.0 应大于 0.1.9');
});
check('本地安装产生的 local-* 目录不算版本', () => {
  const { isVersionTag } = require('../src/updater');
  eq(isVersionTag('v0.1.0-dev.257'), true);
  eq(isVersionTag('0.1.0-dev.248'), true);
  eq(isVersionTag('local-yogurt-windows-x64__1_'), false);
  eq(isVersionTag('local-v0.1.0-dev.257'), false);
  eq(isVersionTag(''), false);
});

// ---------- 5. 进程名匹配（孤儿清理用） ----------
console.log('\n[5] 进程识别');
check('能认出三种可执行文件名，且不误伤', () => {
  eq(procs.matchesBinaryName('/opt/yogurt/yogurt.kexe', 'linux'), true);
  eq(procs.matchesBinaryName('/usr/local/bin/yogurt', 'linux'), true);
  eq(procs.matchesBinaryName('/tmp/yogurt.kexe (deleted)', 'linux'), true);
  eq(procs.matchesBinaryName('C:\\yogurt\\yogurt.exe', 'win32'), true);
  eq(procs.matchesBinaryName('/tmp/yogurt.kexe', 'win32'), false);
  eq(procs.matchesBinaryName('/tmp/yogurt2'), false);
  eq(procs.matchesBinaryName(''), false);
});

// ---------- 6. 其它基础工具 ----------
console.log('\n[6] 基础工具');
check('ANSI 剥离与等级识别', () => {
  const raw = '\u001b[32;1m19:00:00\u001b[39;22m \u001b[91mERROR\u001b[39m \u001b[91mboom\u001b[39m';
  eq(stripAnsi(raw), '19:00:00 ERROR boom');
  eq(detectLevel(raw), 'ERROR');
  eq(detectLevel('\u001b[93m WARN\u001b[39m something'), 'WARN');
});
check('配置深合并保留默认值', () => {
  const merged = store.mergeDefaults({ a: { b: 1, c: 2 }, list: [1] }, { a: { b: 9 } });
  eq(merged.a.b, 9);
  eq(merged.a.c, 2);
  eq(merged.list.length, 1);
});

// ---------- 7. 采样聚合（Windows/Linux 共用这段） ----------
console.log('\n[7] 采样聚合');
check('CPU 百分比按整机核数换算，内存按 MB 取整', () => {
  const { Metrics, CORES } = require('../src/metrics');
  const m = new Metrics();
  m.pidToAccount.set(4242, 'u1');
  m.ingest({ t: 1000, items: [{ pid: 4242, cpuSeconds: 1, ws: 209715200, priv: 104857600, threads: 9, handles: 33 }] });
  m.ingest({ t: 4000, items: [{ pid: 4242, cpuSeconds: 1.3, ws: 209715200, priv: 104857600, threads: 9, handles: 33 }] });
  const sample = m.current('u1');
  // 3 秒里用了 0.3s CPU = 单核 10%，再除以核数
  const expected = Number(((0.3 / 3) * 100 / CORES).toFixed(1));
  eq(sample.cpu, expected, 'cpu%');
  eq(sample.mem, 200, 'mem MB');
  eq(sample.memPrivate, 100, 'priv MB');
  eq(sample.threads, 9);
  eq(sample.handles, 33);
  eq(m.series('u1').length, 2);
});
check('进程消失后不再沿用旧样本', () => {
  const { Metrics } = require('../src/metrics');
  const m = new Metrics();
  m.pidToAccount.set(7, 'u2');
  m.ingest({ t: 1000, items: [{ pid: 7, cpuSeconds: 1, ws: 1024, threads: 1, handles: 1 }] });
  m.ingest({ t: 2000, items: [{ pid: 7, alive: false }] });
  eq(m.series('u2').length, 1);
});

// ---------- 8. 实际监听地址解析 ----------
console.log('\n[8] 实际监听地址（配置 vs 真实监听）');
const listen = require('../src/listen');
check('/proc/net/tcp 解析与十六进制解码', () => {
  eq(listen.decodeHexAddr('0100007F'), '127.0.0.1', '回环');
  eq(listen.decodeHexAddr('00000000'), '0.0.0.0', '所有网卡');
  eq(listen.decodeHexAddr('00000000000000000000000000000000'), '::', 'IPv6 所有网卡');
  const text = [
    '  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode',
    '   0: 00000000:0BB8 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 12345 1 0 100 0 0 10 0',
    '   1: 0100007F:0BB8 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 67890 1 0 100 0 0 10 0',
    '   2: 0100007F:1F90 0100007F:D431 01 00000000:00000000 00:00000000 00000000  1000        0 11111 1 0 100 0 0 10 0',
  ].join('\n');
  const rows = listen.parseProcNetTcp(text);
  eq(rows.length, 3);
  eq(rows[0].addr, '0.0.0.0');
  eq(rows[0].port, 3000);
  eq(rows[0].state, '0A');
  eq(rows[0].inode, '12345');
  eq(rows[1].addr, '127.0.0.1');
});
check('netstat -ano 解析（Windows）', () => {
  const text = [
    '',
    '活动连接',
    '',
    '  协议  本地地址          外部地址        状态           PID',
    '  TCP    0.0.0.0:3000           0.0.0.0:0              LISTENING       19884',
    '  TCP    127.0.0.1:3090         0.0.0.0:0              LISTENING       18252',
    '  TCP    127.0.0.1:3000         127.0.0.1:52344        ESTABLISHED     19884',
    '  TCP    [::]:135               [::]:0                 LISTENING       900',
  ].join('\r\n');
  const rows = listen.parseNetstat(text);
  eq(rows.length, 3, '只看 LISTENING');
  eq(rows[0].addr, '0.0.0.0');
  eq(rows[0].port, 3000);
  eq(rows[0].pid, 19884);
  eq(rows[1].pid, 18252);
  eq(rows[2].addr, '::');
});
check('配置写了 0.0.0.0 但只监听回环 → 给出提示', () => {
  const bad = listen.describeMismatch('0.0.0.0', 3000, [{ addr: '127.0.0.1', port: 3000 }]);
  if (!bad || !/未生效/.test(bad)) throw new Error('应当提示未生效，实际：' + bad);
  const ok = listen.describeMismatch('0.0.0.0', 3000, [{ addr: '0.0.0.0', port: 3000 }]);
  eq(ok, null, '正常情况不该报错');
  const localOk = listen.describeMismatch('127.0.0.1', 3000, [{ addr: '0.0.0.0', port: 3000 }]);
  eq(localOk, null, '监听了所有网卡当然包含回环');
  const portBad = listen.describeMismatch('127.0.0.1', 3000, [{ addr: '127.0.0.1', port: 3999 }]);
  if (!portBad || !/端口/.test(portBad)) throw new Error('应当提示端口不一致');
});

// ---------- 汇总 ----------
console.log(`\n平台：${process.platform}-${process.arch} / Node ${process.version}`);
if (failures.length) {
  console.log(`\n${failures.length} 项失败，${pass} 项通过：`);
  for (const f of failures) console.log(` - ${f.name}: ${f.error}`);
  process.exit(1);
}
console.log(`\n全部通过：${pass} 项`);
