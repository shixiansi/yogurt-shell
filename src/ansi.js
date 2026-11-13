'use strict';

// Yogurt 的日志带 ANSI 颜色（config.logging.ansiLevel 默认 ANSI256）。
// 存档到文件时需要剥离，前端展示时单独解析。

const CSI = /\x1b\[[0-9;?]*[ -/]*[@-~]/g;
const OSC = /\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g;
const OTHER = /\x1b[@-_]/g;

function stripAnsi(text) {
  if (!text) return '';
  return String(text).replace(OSC, '').replace(CSI, '').replace(OTHER, '');
}

// 从一行日志里推断等级，用于过滤
function detectLevel(rawLine) {
  const line = stripAnsi(rawLine);
  const m = line.match(/\b(VERBOSE|TRACE|DEBUG|INFO|WARN|WARNING|ERROR|FATAL)\b/);
  if (m) {
    const lv = m[1] === 'WARNING' ? 'WARN' : m[1] === 'TRACE' ? 'VERBOSE' : m[1];
    return lv;
  }
  if (/^\s*(\[INFO\]|INFO\b)/.test(line)) return 'INFO';
  return 'INFO';
}

module.exports = { stripAnsi, detectLevel };
