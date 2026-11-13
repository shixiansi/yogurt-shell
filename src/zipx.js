'use strict';

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

// 极简 zip 解压（stored / deflate），用于更新包，避免引入第三方依赖。
function extractZip(zipPath, destDir) {
  const buf = fs.readFileSync(zipPath);
  if (buf.length < 22) throw new Error('zip 文件过小');

  let eocd = -1;
  const minPos = Math.max(0, buf.length - 22 - 65535);
  for (let i = buf.length - 22; i >= minPos; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error('不是合法的 zip（找不到 EOCD）');

  const count = buf.readUInt16LE(eocd + 10);
  const cdOffset = buf.readUInt32LE(eocd + 16);
  let p = cdOffset;
  const written = [];

  for (let i = 0; i < count; i++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error('zip 中央目录损坏');
    const flags = buf.readUInt16LE(p + 8);
    const method = buf.readUInt16LE(p + 10);
    const compSize = buf.readUInt32LE(p + 20);
    const uncompSize = buf.readUInt32LE(p + 24);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const localOffset = buf.readUInt32LE(p + 42);
    const nameBuf = buf.subarray(p + 46, p + 46 + nameLen);
    const name = (flags & 0x800 ? nameBuf.toString('utf8') : nameBuf.toString('binary'));
    p += 46 + nameLen + extraLen + commentLen;

    if (!name || name.endsWith('/')) continue;
    const safe = path.normalize(name).replace(/^([/\\])+/, '');
    if (safe.startsWith('..')) continue;

    if (compSize === 0xffffffff || uncompSize === 0xffffffff) {
      throw new Error('暂不支持 zip64 压缩包，请手动解压后放到账号目录');
    }

    if (buf.readUInt32LE(localOffset) !== 0x04034b50) throw new Error('zip 本地头损坏：' + name);
    const lNameLen = buf.readUInt16LE(localOffset + 26);
    const lExtraLen = buf.readUInt16LE(localOffset + 28);
    const dataStart = localOffset + 30 + lNameLen + lExtraLen;
    const comp = buf.subarray(dataStart, dataStart + compSize);

    let data;
    if (method === 0) data = Buffer.from(comp);
    else if (method === 8) data = zlib.inflateRawSync(comp);
    else throw new Error('不支持的压缩方式 ' + method + '：' + name);

    const target = path.join(destDir, safe);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, data);
    written.push(safe);
  }
  return written;
}

module.exports = { extractZip };
