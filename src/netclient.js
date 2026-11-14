'use strict';

const http = require('http');
const https = require('https');
const net = require('net');
const tls = require('tls');

// 零依赖 HTTP 客户端：支持 http(s) 直连，以及经过 HTTP 代理（CONNECT 隧道）访问 https。
// 为什么不用 fetch：Node 的 fetch 不读环境变量里的代理，也没有内置 ProxyAgent，
// 而这个项目的原则是不引第三方依赖。

function parseProxy(proxy) {
  const text = String(proxy || '').trim();
  if (!text) return null;
  const withScheme = /^[a-z0-9+.-]+:\/\//i.test(text) ? text : 'http://' + text;
  let url;
  try {
    url = new URL(withScheme);
  } catch {
    throw new Error('代理地址无法解析：' + text + '（示例：http://127.0.0.1:7890）');
  }
  if (!/^https?:$/.test(url.protocol)) {
    throw new Error('暂不支持 ' + url.protocol.replace(':', '') + ' 代理，请填 http:// 或 https:// 代理（Clash/V2Ray 的 HTTP 端口）');
  }
  return {
    protocol: url.protocol,
    host: url.hostname,
    port: Number(url.port) || (url.protocol === 'https:' ? 443 : 8080),
    auth: url.username
      ? Buffer.from(`${decodeURIComponent(url.username)}:${decodeURIComponent(url.password || '')}`).toString('base64')
      : null,
    raw: text,
  };
}

// 在代理上开一条到 host:port 的隧道
function openTunnel(proxy, host, port, timeoutMs) {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host: proxy.host, port: proxy.port });
    let settled = false;
    const fail = (err) => {
      if (settled) return;
      settled = true;
      try {
        socket.destroy();
      } catch {}
      reject(err);
    };
    socket.setTimeout(timeoutMs, () => fail(new Error(`连接代理 ${proxy.host}:${proxy.port} 超时`)));
    socket.once('error', fail);
    const lines = [`CONNECT ${host}:${port} HTTP/1.1`, `Host: ${host}:${port}`];
    if (proxy.auth) lines.push('Proxy-Authorization: Basic ' + proxy.auth);
    socket.write(lines.join('\r\n') + '\r\n\r\n');

    let buffer = '';
    const onData = (chunk) => {
      buffer += chunk.toString('latin1');
      const idx = buffer.indexOf('\r\n\r\n');
      if (idx < 0) return;
      socket.removeListener('data', onData);
      const statusLine = buffer.split('\r\n')[0] || '';
      const code = Number(statusLine.split(/\s+/)[1]);
      if (code !== 200) {
        return fail(new Error(`代理 CONNECT 被拒绝：${statusLine || '无响应'}`));
      }
      settled = true;
      socket.setTimeout(0);
      socket.removeAllListeners('error');
      resolve(socket);
    };
    socket.on('data', onData);
  });
}

function requestOnce(target, options) {
  const { method = 'GET', headers = {}, timeoutMs = 20000, proxy } = options;
  const isHttps = target.protocol === 'https:';

  return new Promise((resolve, reject) => {
    let settled = false;
    const fail = (err) => {
      if (settled) return;
      settled = true;
      reject(err);
    };

    const onResponse = (res) => {
      settled = true;
      resolve({ status: res.statusCode || 0, headers: res.headers, stream: res });
    };

    const buildOpts = (createConnection) => ({
      method,
      headers,
      agent: false,
      timeout: timeoutMs,
      ...(createConnection ? { createConnection } : {}),
    });

    (async () => {
      try {
        if (!proxy) {
          const mod = isHttps ? https : http;
          const req = mod.request(target, buildOpts(null), onResponse);
          req.setTimeout(timeoutMs, () => req.destroy(new Error('请求超时（' + timeoutMs + 'ms）')));
          req.on('error', fail);
          req.end();
          return;
        }

        if (!isHttps) {
          // http 目标：直接以「绝对 URI」形式发给代理
          const req = http.request(
            {
              host: proxy.host,
              port: proxy.port,
              method,
              path: target.href,
              headers: { ...headers, Host: target.host },
              agent: false,
              timeout: timeoutMs,
            },
            onResponse
          );
          req.setTimeout(timeoutMs, () => req.destroy(new Error('请求超时（' + timeoutMs + 'ms）')));
          req.on('error', fail);
          req.end();
          return;
        }

        const socket = await openTunnel(proxy, target.hostname, Number(target.port) || 443, timeoutMs);
        const secureSocket = tls.connect({ socket, servername: target.hostname });
        secureSocket.once('error', fail);
        await new Promise((res, rej) => {
          secureSocket.once('secureConnect', res);
          secureSocket.once('error', rej);
        });
        const req = https.request(
          target,
          buildOpts(() => secureSocket),
          onResponse
        );
        req.setTimeout(timeoutMs, () => req.destroy(new Error('请求超时（' + timeoutMs + 'ms）')));
        req.on('error', fail);
        req.end();
      } catch (err) {
        fail(err);
      }
    })();
  });
}

// 自动跟随重定向（默认 6 跳），返回 { status, headers, stream, url }
async function openRequest(rawUrl, options = {}) {
  const proxy = parseProxy(options.proxy);
  let current = new URL(rawUrl);
  const maxRedirects = options.maxRedirects == null ? 6 : options.maxRedirects;

  for (let hop = 0; hop <= maxRedirects; hop += 1) {
    const res = await requestOnce(current, { ...options, proxy });
    const location = res.headers && res.headers.location;
    if (res.status >= 300 && res.status < 400 && location) {
      try {
        res.stream.resume(); // 丢弃重定向响应体
      } catch {}
      current = new URL(location, current);
      continue;
    }
    return { ...res, url: current.toString() };
  }
  throw new Error('重定向次数过多（>' + maxRedirects + '）');
}

async function readAll(stream) {
  const chunks = [];
  for await (const chunk of stream) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  return Buffer.concat(chunks);
}

async function readJson(rawUrl, options = {}) {
  const res = await openRequest(rawUrl, options);
  const body = await readAll(res.stream);
  if (res.status < 200 || res.status >= 300) {
    throw new Error(`HTTP ${res.status} ${String(body.toString('utf8')).slice(0, 200)}`);
  }
  try {
    return JSON.parse(body.toString('utf8'));
  } catch {
    throw new Error('返回内容不是 JSON：' + body.toString('utf8').slice(0, 120));
  }
}

module.exports = { openRequest, readAll, readJson, parseProxy };
