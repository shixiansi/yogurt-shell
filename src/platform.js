'use strict';

const fs = require('fs');
const path = require('path');

// 平台差异集中在这里：可执行文件名字、发版包名、可执行权限
const BIN_BY_PLATFORM = {
  win32: ['yogurt.exe'],
  linux: ['yogurt.kexe', 'yogurt'],
  darwin: ['yogurt.kexe', 'yogurt'],
};

function binNames(platform = process.platform) {
  return BIN_BY_PLATFORM[platform] || ['yogurt.kexe', 'yogurt'];
}

function defaultBinName(platform = process.platform) {
  return binNames(platform)[0];
}

// 找一个已存在的 yogurt 可执行文件（Windows 的 yogurt.exe / 其它平台的 yogurt.kexe、yogurt）
function findBinary(dir, platform = process.platform) {
  for (const name of binNames(platform)) {
    const file = path.join(dir, name);
    try {
      if (fs.statSync(file).isFile()) return file;
    } catch {}
  }
  return null;
}

// GitHub Releases 里对应平台的包名
function assetFor(platform = process.platform, arch = process.arch) {
  if (platform === 'win32') return 'yogurt-windows-x64.zip';
  if (platform === 'linux') return arch === 'arm64' ? 'yogurt-linux-arm64.zip' : 'yogurt-linux-x64.zip';
  if (platform === 'darwin') return 'yogurt-macos-arm64.zip';
  return `yogurt-${platform}-${arch}.zip`;
}

// zip 里不保留可执行位，解压/复制后补上
function ensureExecutable(file, platform = process.platform) {
  if (platform === 'win32') return;
  try {
    fs.chmodSync(file, 0o755);
  } catch {}
}

function label(platform = process.platform, arch = process.arch) {
  return `${platform}-${arch}`;
}

module.exports = { binNames, defaultBinName, findBinary, assetFor, ensureExecutable, label };
