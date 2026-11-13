'use strict';

const fs = require('fs');

// 把控制台输出同时追加到日志文件。
// 后台/重启出来的进程没有控制台，靠 stdio 句柄继承在 Windows 上会丢输出，所以自己写文件。
function teeConsole(file) {
  if (!file) return false;
  let fd = null;
  try {
    fd = fs.openSync(file, 'a');
  } catch {
    return false;
  }
  const origLog = console.log.bind(console);
  const origErr = console.error.bind(console);
  const write = (args, tag = '') => {
    try {
      fs.writeSync(fd, tag + args.map((a) => (typeof a === 'string' ? a : String(a))).join(' ') + '\n');
    } catch {}
  };
  console.log = (...args) => {
    origLog(...args);
    write(args);
  };
  console.error = (...args) => {
    origErr(...args);
    write(args, '[stderr] ');
  };
  return true;
}

module.exports = { teeConsole };
