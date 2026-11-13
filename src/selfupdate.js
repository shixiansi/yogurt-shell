'use strict';

const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const store = require('./store');

// 面板自身的更新：把项目目录当成 git 仓库，比对 origin/<branch> 后快进合并。
// 不依赖 gh、不写凭据；没装 git 或不是仓库时给出可读原因。

function runGit(args, timeoutMs = 60000) {
  return new Promise((resolve) => {
    execFile('git', args, { cwd: store.ROOT, timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024 }, (err, stdout, stderr) => {
      resolve({ ok: !err, stdout: String(stdout || '').trim(), stderr: String(stderr || '').trim(), error: err });
    });
  });
}

// 解析 `git log --pretty=format:%h%x09%cI%x09%s`
function parseGitLog(text) {
  return String(text || '')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [sha, date, ...rest] = line.split('\t');
      return { sha: sha || '', date: date || '', subject: rest.join('\t') || '' };
    });
}

function readPackageVersion() {
  try {
    return JSON.parse(fs.readFileSync(path.join(store.ROOT, 'package.json'), 'utf8')).version || null;
  } catch {
    return null;
  }
}

async function gitAvailable() {
  const res = await runGit(['--version'], 8000);
  if (!res.ok) return { ok: false, version: null };
  return { ok: true, version: res.stdout.replace(/^git version\s*/i, '') };
}

async function isRepo() {
  const res = await runGit(['rev-parse', '--is-inside-work-tree'], 8000);
  return res.ok && res.stdout === 'true';
}

async function currentBranch() {
  const res = await runGit(['rev-parse', '--abbrev-ref', 'HEAD'], 8000);
  if (!res.ok || !res.stdout || res.stdout === 'HEAD') {
    // 没有分支（detached）时退回配置/常见默认名
    const cfg = store.getConfig();
    return (cfg.panelUpdate && cfg.panelUpdate.branch) || 'main';
  }
  return res.stdout;
}

async function headInfo() {
  const shaRes = await runGit(['rev-parse', 'HEAD'], 8000);
  const logRes = await runGit(['log', '-1', '--pretty=format:%h%x09%cI%x09%s'], 8000);
  const [item] = parseGitLog(logRes.stdout);
  return {
    sha: shaRes.ok ? shaRes.stdout : null,
    date: item ? item.date : null,
    subject: item ? item.subject : null,
  };
}

async function isDirty() {
  const res = await runGit(['status', '--porcelain', '--untracked-files=no'], 15000);
  if (!res.ok) return null;
  return res.stdout.length > 0;
}

async function behindAhead(branch) {
  const res = await runGit(['rev-list', '--left-right', '--count', `HEAD...origin/${branch}`], 20000);
  if (!res.ok) return null;
  const [ahead, behind] = res.stdout.split(/\s+/).map((n) => Number(n) || 0);
  return { ahead, behind };
}

async function status({ fetch = false } = {}) {
  const pkgVersion = readPackageVersion();
  const git = await gitAvailable();
  if (!git.ok) {
    return { available: false, reason: '服务器上没有找到 git 命令，无法自动更新（可以手动拷代码覆盖）', pkgVersion };
  }
  if (!(await isRepo())) {
    return { available: false, reason: '项目目录不是 git 仓库（可能是拷贝部署的），无法自动更新', pkgVersion, gitVersion: git.version };
  }

  const branch = await currentBranch();
  const head = await headInfo();
  let dirty = await isDirty();
  const cfg = store.getConfig();
  const remoteUrlRes = await runGit(['config', '--get', `remote.origin.url`], 8000);
  const remoteUrl = remoteUrlRes.ok ? remoteUrlRes.stdout : null;
  let fetchError = null;

  if (fetch) {
    const res = await runGit(['fetch', '--prune', 'origin'], 90000);
    if (!res.ok) fetchError = (res.stderr || res.error.message || '').split('\n').slice(-3).join('\n');
  }
  const hasRemote = Boolean(remoteUrl);
  let counts = hasRemote ? await behindAhead(branch) : null;
  let incoming = [];
  if (hasRemote && counts && counts.behind > 0) {
    const logRes = await runGit(['log', `HEAD..origin/${branch}`, '--pretty=format:%h%x09%cI%x09%s', '-n', '10'], 30000);
    incoming = parseGitLog(logRes.stdout);
  }

  return {
    available: true,
    gitVersion: git.version,
    pkgVersion,
    branch,
    remoteUrl,
    head,
    dirty,
    ahead: counts ? counts.ahead : null,
    behind: counts ? counts.behind : null,
    incoming,
    fetched: Boolean(fetch) && !fetchError,
    fetchError,
    lastCheck: Date.now(),
  };
}

async function apply() {
  const git = await gitAvailable();
  if (!git.ok) throw new Error('没有 git 命令，无法自动更新');
  if (!(await isRepo())) throw new Error('项目目录不是 git 仓库，无法自动更新');

  const dirty = await isDirty();
  if (dirty) throw new Error('项目目录有未提交的改动，先处理掉再更新（git status 看看）');

  const branch = await currentBranch();
  const before = (await headInfo()).sha;

  const fetchRes = await runGit(['fetch', '--prune', 'origin'], 90000);
  if (!fetchRes.ok) {
    throw new Error('git fetch 失败：' + (fetchRes.stderr || fetchRes.error.message).split('\n').slice(-2).join(' '));
  }

  const pullRes = await runGit(['merge', '--ff-only', `origin/${branch}`], 90000);
  if (!pullRes.ok) {
    const detail = (pullRes.stderr || pullRes.stdout || pullRes.error.message || '').split('\n').slice(-3).join(' ');
    throw new Error('快进合并失败（本地有分叉提交？）：' + detail);
  }

  const after = await headInfo();
  const updated = Boolean(before && after.sha && before !== after.sha);
  store.updateConfig((c) => {
    c.panelUpdate = {
      ...(c.panelUpdate || {}),
      branch,
      lastApplyAt: Date.now(),
      lastApplyFrom: before,
      lastApplyTo: after.sha,
    };
  });
  return { updated, from: before, to: after.sha, branch, needsRestart: updated, head: after };
}

module.exports = { status, apply, parseGitLog, readPackageVersion };
