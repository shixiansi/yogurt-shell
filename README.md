# Yogurt Shell

[![ci](https://github.com/shixiansi/yogurt-shell/actions/workflows/ci.yml/badge.svg)](https://github.com/shixiansi/yogurt-shell/actions/workflows/ci.yml)
[![license](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

给 [Yogurt](https://acidify.ntqqrev.org/docs/yogurt/start)（Milky 协议端）套的一层「壳」：**本地网页面板 + 进程守护 + 掉线停机 + 邮件通知 + 资源/日志监控 + 一键更新 + 多账号多开**。

**Windows / Linux 都能跑**，零第三方依赖（只用 Node.js 内置模块；Windows 上额外借系统自带的 PowerShell 采样，Linux 上直接读 `/proc`），不用 `npm install`。

![面板](docs/panel.png)

---

## 1. 它解决什么问题

| 原来的痛点 | 现在 |
| --- | --- |
| 账号掉线后，上游（xunlu-core 等）还在不停调 `/api/...`，一直空转刷日志 | 面板探活 + 日志特征双重判定，**掉线即结束 yogurt 进程**，请求立刻 fast-fail，等人工恢复；不会偷偷自动重连去撞风控 |
| 掉线了没人知道 | 掉线 / 进程异常退出都会发邮件到你配好的邮箱（可多个收件人），邮件里带账号、端口、PID、运行时长、版本、**最后 40 行日志**和处置建议 |
| 看不到 yogurt 吃了多少 CPU/内存、日志在哪 | 卡片上实时显示 CPU（整机%）/ 内存 / 线程 / 句柄 + 4.5 分钟曲线；日志按账号落盘、可实时流式查看、过滤、下载 |
| 升级要手动停进程、换二进制、再重启 | 面板里点「更新」：查 GitHub Releases → 下载对应平台包 → sha256 校验 → 解压 → 停账号 → 换二进制（旧的自动备份）→ 重新拉起；github.com 直连不通时自动走镜像 |
| 想挂多个号只能复制一堆文件夹、怕端口冲突 | 每个账号一个目录（自己的 `config.json` / `session-store.json` / 日志），端口自动分配与校验，面板统一启停 |
| 面板被强杀后残留进程占着端口 | 面板启动时自动清理自己账号目录下的遗留 yogurt 进程（Windows 用 CIM 枚举，Linux 扫 `/proc`） |

---

## 2. 快速开始

环境要求：**Node.js 18+**（Windows 实测 Node 24）。不需要 `npm install`。

```bash
git clone https://github.com/shixiansi/yogurt-shell.git
cd yogurt-shell
```

### Windows

```bat
cd /d E:\lagrangeV2\yogurt-shell
start.cmd
:: 或 node server.js
:: 浏览器打开 http://127.0.0.1:3090/
```

### Linux / macOS

```bash
cd /path/to/yogurt-shell
chmod +x start.sh stop.sh scripts/*.sh     # 从 Windows 拷过去时尤其需要
./start.sh                                 # 或 node server.js
# 浏览器打开 http://127.0.0.1:3090/
```

启动后控制台会打印面板地址、数据目录、账号数量。**Ctrl+C 退出时会先停掉所有账号再退出**（保证不留无人监管的 yogurt）。

想脱离终端常驻：

```bash
# Linux：装成 systemd 用户服务（登录即启动，崩溃自动拉起）
bash scripts/install-autostart-systemd.sh

# 或者简单放后台
nohup node server.js >> data/panel.out.log 2>&1 &
./stop.sh        # 优雅停止（先停账号，再退面板）
```

```bat
:: Windows 后台启动
cmd /c start "" /min cmd /c "cd /d E:\lagrangeV2\yogurt-shell && node server.js >> data\panel.out.log 2>&1"
stop.cmd
```

改端口：`node server.js --port 3091`，或改 `data/config.json` 里的 `panel.port`。

### 接管一个已经在跑的 yogurt

1. 先停掉原来那个 yogurt 进程（否则两个进程抢同一个 QQ 会话与端口）。
2. 面板右上角「＋ 添加账号」→「导入现有目录（接管）」→ 填原来那个目录。
3. 面板会复制 `config.json` / `app-info.json` / `session-store*.json` / 该平台的 yogurt 二进制到新账号目录（原目录不动），端口沿用原配置，然后自动拉起。

> 本项目的接管流程在实机上验证过：把原有目录导入为账号后，会话直接可用，不需要重新扫码。

---

## 3. 掉线判定与停机（核心逻辑）

每轮（默认 15s）对每个在线账号做两件事：

1. **接口探活**：`POST http://<配置的 host:port>/api/get_login_info`（带 `accessToken`），要求 `200 + status=ok + retcode=0`。
   - 连续失败 `failures` 次（默认 3）→ 判定掉线。
   - 启动后有 `graceMs` 宽限期（默认 90s），扫码/登录过程不会被误判；状态为「登录中」时不累计失败次数。
   - 探活目标是**启动时快照**下来的地址，运行中改配置不会造成误判（改配置需重启生效）。
2. **日志特征匹配**：日志里出现 `被踢下线` / `您已在其他设备登录` / `登录已失效` / `KickedOffline` / `NotLoggedIn` …（可在设置里加词）→ 立即判定掉线。
   - 只匹配系统日志，**聊天内容（`Logging [...]` 行）会被跳过**，群友聊到「掉线」不会误杀。

判定掉线后依次执行：

```
标记状态「掉线停机」 → 结束进程树 → 写日志 → 记事件 → 发邮件
```

- 结束进程：Windows `taskkill /PID x /T /F`；Linux/macOS 走进程组 `kill(-pid, SIGKILL)`。
- **不会**自动重启（可在设置里单独打开「崩溃后自动重启」，但掉线路径永远不会自动重启）。
- 面板上点「启动」即可恢复；恢复后探活立即重新开始。

进程**异常退出**（非主动停止）也会记事件 + 发邮件，状态显示「异常退出」。

---

## 4. 邮件通知

面板右上角「⚙ 设置」→「邮件通知」：

| 字段 | 说明 |
| --- | --- |
| SMTP 服务器 / 端口 | QQ 邮箱 `smtp.qq.com:465`；163 `smtp.163.com:465`；Gmail `smtp.gmail.com:587` |
| 用户名 | 一般是完整邮箱地址 |
| 密码 / 授权码 | **QQ/163 要用「授权码」，不是登录密码** |
| 发件人 / 收件人 | 收件人可用逗号分隔多个 |
| 使用 SSL | 465 勾选；587 取消勾选（自动 STARTTLS） |
| 同类通知去重 | 默认 10 分钟内不重复发同一类通知，避免抖动刷屏 |

配好先点「发送测试邮件」验证。

实现上是一个内置的极简 SMTP 客户端：隐式 TLS(465)、STARTTLS(587)、`AUTH LOGIN` / `AUTH PLAIN`、`multipart/alternative`（纯文本 + HTML 两份），中文用 UTF-8 base64 编码。

邮件内容示例：

```
Yogurt 账号掉线，已停止进程

账号：示例账号（100000001）
主机：LAPTOP-EXAMPLE
端口：3000
状态：掉线停机
原因：接口探活连续失败 3 次（最后错误：ECONNREFUSED）
进程：已无进程
运行时长：3 小时 12 分
版本：0.1.0-dev.257
时间：2026/11/13 19:05:04

—— 最近日志（最后 40 行）——
...
```

---

## 5. 监控与日志

**占用采样**按平台走两条实现，输出同一种结构：

| 平台 | 实现 |
| --- | --- |
| Windows | 常驻一个 PowerShell 进程（`scripts/win-sampler.ps1`，每 3s 输出一行 NDJSON），用 `Get-Process` 读 CPU 时间 / 工作集 / 私有内存 / 线程 / 句柄 |
| Linux | 面板进程自己每 3s 读 `/proc/<pid>/stat`（utime+stime）、`/proc/<pid>/status`（VmRSS、RssAnon、Threads）、`/proc/<pid>/fd`（文件描述符数），不额外起进程 |

两边都换算成「整机 CPU%」并保存 4.5 分钟曲线。账号增删只更新 PID 名单，不重启采样。

**日志**：面板直接捕获 yogurt 的 stdout/stderr（所以不需要 Yogurt 自己写文件），逐行写入 `data/logs/<QQ号>.log`；超过 20MB 自动轮转，保留 6 份（可调）。

- 日志抽屉里可实时跟随、按关键字/等级过滤、「隐藏聊天」只看系统日志、一键下载、清空。
- 底部输入框可以直接向 yogurt 的 **标准输入** 发送内容：扫码登录后如果要求短信验证码 / Ticket，就在这里输入。
- 登录二维码：Yogurt 会写 `qrcode.png` 到账号目录，面板卡片上的「二维码」按钮直接显示；日志里打印的登录链接也可以点开。

---

## 6. 更新

面板「⭯ 更新」，三条路径都带**进度条**（检查 / 下载 / 解压 / 替换 / 完成，服务端通过 SSE 实时推送；上传 zip 时先显示浏览器上传进度）：

- **从本机已安装的 yogurt 安装**（不联网）：填/选一个已有路径即可 —— 支持「含 yogurt 可执行文件的目录」、「可执行文件本身」、「本地 .zip」。面板会自动发现来源：已下载的 dist、`data/updates/*.zip`、项目同级目录里像 yogurt 的文件夹、以及各账号「导入现有目录」时记录的来源。安装同样会先停账号、把旧文件备份到 `data/backups/`、装完自动拉起；`data/dist/local-*` 只保留最近 2 份。
- **从 GitHub 更新**：读 `SaltifyDev/yogurt-releases` 最新 release（`update.repo` 可改），按平台/架构自动选包 —— `yogurt-windows-x64.zip` / `yogurt-linux-x64.zip` / `yogurt-linux-arm64.zip` / `yogurt-macos-arm64.zip`（`update.asset` 留空即自动，填了则强制）。下载时用 release 的 `digest` 做 sha256 校验，解压到 `data/dist/<tag>/` 后逐账号替换（硬链接，同盘零拷贝），并补可执行权限。
- **本地 zip 上传安装**：没网时手动下载 zip 从面板上传，带上传进度。
- **镜像**：`github.com` 直连超时会自动换镜像（直连 → 已记住的镜像 → `https://gh-proxy.com/` → `https://ghfast.top/`），成功后把可用镜像记到配置里。
- **回滚**：`data/backups/` 里是每次替换前的旧文件，覆盖回账号目录再点「启动」即可。

「已安装版本」以**账号实际跑起来的版本**为准（有账号落后就提示可更新），dist 版本单独显示；本地安装的 `local-*` 目录不参与版本比较。

---

## 7. 多账号

- 每个账号独立目录：`data/accounts/<QQ号>/`（`config.json`、`app-info.json`、`session-store.json`、`qrcode.png`、该平台二进制）。
- 二进制文件名按平台：Windows `yogurt.exe`，Linux/macOS `yogurt.kexe`（或 `yogurt`）——识别、启动、更新、备份都用同一套映射。
- 端口自动分配、冲突校验；账号配置里的 `milky.http.port` 与面板记录双向同步。
- 卡片上「配置」可以直接编辑该账号的 `config.json`（JSON 校验 + 保存后提示重启生效）。
- 「删除」会把账号目录移动到 `data/trash/`，不直接销毁。

---

## 8. 目录结构

```
yogurt-shell/
├── server.js                  # 入口：装配各模块 + HTTP 服务 + 定时任务
├── start.cmd / stop.cmd       # Windows 启动 / 优雅停止
├── start.sh  / stop.sh        # Linux、macOS 启动 / 优雅停止
├── src/
│   ├── store.js               # 配置读写（data/config.json）、路径、端口分配
│   ├── logbus.js              # 每账号环形日志缓冲 + 落盘轮转 + 事件推送
│   ├── supervisor.js          # 进程守护：启停/杀进程树/状态机/探活/掉线判定
│   ├── metrics.js             # 采样聚合与历史曲线（Windows/Linux 两种后端）
│   ├── sampler-linux.js       # 读 /proc 的实现 + 可单测的解析函数
│   ├── listen.js              # 查进程「实际监听地址」（netstat / /proc/net/tcp）
│   ├── procs.js               # 跨平台进程枚举 / 结束进程 / 找 PowerShell
│   ├── platform.js            # 平台差异：二进制名、发版包名、可执行位
│   ├── console-tee.js         # 后台/重启进程时把控制台输出写进日志文件
│   ├── notifier.js            # 事件记录 + 邮件内容组装 + 去重
│   ├── smtp.js                # 内置 SMTP 客户端
│   ├── updater.js             # GitHub release 检查/下载/校验/安装
│   ├── zipx.js                # 内置 zip 解压（stored/deflate）
│   ├── accounts.js            # 账号创建/导入/改端口/删除/配置文本
│   ├── http.js                # 路由、SSE 实时推送、静态文件、令牌校验
│   └── ansi.js                # 剥离 ANSI 颜色、识别日志等级
├── scripts/
│   ├── win-sampler.ps1               # Windows 常驻采样器（NDJSON 输出）
│   ├── install-autostart.ps1         # Windows：加进「启动」文件夹
│   ├── install-autostart-systemd.sh  # Linux：systemd 用户服务
│   └── selftest.js                   # 平台无关自测（node scripts/selftest.js）
├── public/                    # 面板前端（原生 JS，无框架）
├── docs/                      # 截图
└── data/                      # 运行时数据（不进 git）
    ├── config.json            # 面板、账号、邮件、更新、判定参数
    ├── accounts/<QQ号>/       # 每账号的 yogurt 数据目录
    ├── logs/<QQ号>.log        # 捕获的日志（轮转）
    ├── dist/<tag>/            # 下载解压后的 yogurt 二进制
    ├── updates/               # 下载的 zip
    ├── backups/               # 更新前的旧二进制
    ├── runtime/panel.pid      # 面板进程号
    └── events.jsonl           # 事件流水
```

---

## 9. 开机自启

**Windows**

```powershell
powershell -ExecutionPolicy Bypass -File E:\lagrangeV2\yogurt-shell\scripts\install-autostart.ps1
```

在「启动」文件夹里创建一个指向 `start.cmd` 的快捷方式（窗口最小化）。不想要就删掉那个 `.lnk`。
想「不登录也跑」就用「任务计划程序」建登录时/开机时触发的任务，操作填 `start.cmd`，起始目录填项目目录。

**Linux（systemd 用户服务）**

```bash
bash scripts/install-autostart-systemd.sh
# 卸载
systemctl --user disable --now yogurt-shell && rm ~/.config/systemd/user/yogurt-shell.service
# 不想等到登录才跑
sudo loginctl enable-linger $USER
```

> 用 systemd 托管时，改完「设置 → 面板监听」请在 shell 里执行
> `systemctl --user restart yogurt-shell`——面板里的「重启面板」按钮会自动禁用，否则两边会抢同一个端口。

---

## 10. 安全提醒

- 面板默认只监听 `127.0.0.1:3090`。要让手机/另一台机器访问，在面板「⚙ 设置 → 面板监听」里把监听地址改成 `0.0.0.0`，**同时设一个访问令牌**（不设的话任何能连到这个端口的人都能启停你的 bot，面板顶部会显示“⚠ 无访问令牌”）。
- 改完监听地址必须**重启面板**才生效（设置里就有「⟳ 重启面板」按钮，会自动停账号 → 重启 → 重新拉起账号）。
- `data/accounts/<QQ号>/config.json` 里的密码是**明文**，`session-store.json` 等同于登录凭据，两者都不要外传、不要提交到 git。
- 掉线停机意味着账号需要人工介入（重新扫码/换签名 API/等风控过去），这是刻意的：宁可停，也不要反复请求把号撞死。

### 两个 host 别搞混

| 配置项 | 在哪 | 管什么 |
| --- | --- | --- |
| `panel.host` | `data/config.json` → 面板「设置 → 面板监听」 | **面板网页**监听在哪，决定你能不能远程打开面板 |
| `milky.http.host` | `data/accounts/<QQ号>/config.json` → 账号卡片「配置」 | **yogurt 的 Milky API** 监听在哪，决定别的程序能不能远程调 API |

两个都改成 `0.0.0.0` 才能「面板能远程打开 + API 能远程调用」。另外：

- 日志里 `HttpModule 127.0.0.1 调用 API /get_login_info` 里的 `127.0.0.1` 是**客户端来源 IP**（调用方在本机），跟监听地址无关，把 host 改成 `0.0.0.0` 它也不会变。
- 判断到底生效没有，看两处：① yogurt 启动日志里的 `Listen Address: 0.0.0.0:3000`；② 面板账号卡片上的「实际监听」——它会直接读进程的真实套接字（Windows `netstat -ano`，Linux `/proc/net/tcp`），配置和实际不一致时会用黄色标出来。
- `milky.http.host` 设成 `0.0.0.0` 且 `accessToken` 为空时，yogurt 会打印安全警告并**延迟 10 秒**再开始监听（不是卡死）。
- 云服务器还要记得在安全组/防火墙放行对应端口。

---

## 11. 常见问题

| 现象 | 原因 / 处理 |
| --- | --- |
| 面板打不开 | 端口被占：`node server.js --port 3091`；或看控制台报错（会明确提示 EADDRINUSE） |
| 卡片一直「启动中」 | 看日志抽屉：可能是扫码登录没完成（用「二维码」按钮，或在底部输入验证码） |
| 掉线判定太灵敏 | 设置里把「连续失败次数」调大、或把探活间隔调长；`graceMs` 加长可避免启动期误判 |
| 掉线判定没生效 | 该账号的 `config.json` 里 `milky.http.port` 与面板端口不一致；重启账号让配置生效 |
| 改成 `0.0.0.0` 没效果、日志里还是 127.0.0.1 | 见上面「两个 host 别搞混」：① 面板 host/port 只在启动时读，改完要重启面板；② 接管后生效的是 `data/accounts/<QQ号>/config.json`，旧目录那份已经作废；③ 日志里的 127.0.0.1 是客户端来源 IP，本来就不会变。以账号卡片的「实际监听」和 yogurt 的 `Listen Address` 为准 |
| 更新失败 `fetch failed` | `github.com` 不通，填镜像前缀（如 `https://gh-proxy.com/`），或改用「本地 zip 安装」 |
| 更新失败「压缩包里没有…」 | 下错了平台的包；面板默认按平台自动选包，`update.asset` 别乱填 |
| 更新后起不来 | `data/backups/` 里有旧二进制，覆盖回账号目录即可回滚；再点「启动」 |
| Linux 上 `./start.sh` 报 `bad interpreter` | 脚本被 Windows 改成了 CRLF：`sed -i 's/\r$//' start.sh stop.sh scripts/*.sh` |
| Linux 上提示 Permission denied | 二进制没执行位：`chmod +x data/accounts/*/yogurt*`；面板更新时会自动补 |
| 日志里全是聊天内容 | 日志抽屉点「隐藏聊天」，或设置里把 `coreLogLevel` 调成 `INFO`/`WARN` |
| 面板关掉后 yogurt 也跟着停了 | 这是设计：面板是守护进程，退出时会主动停掉所有账号，避免留下没人监管的 yogurt。想常驻用 systemd / 后台启动 |
| 想停掉所有账号但保留面板 | 面板上逐个点「停止」；`stop.cmd` / `./stop.sh` 是连面板一起优雅退出 |
| 面板被强杀后 yogurt 还在 | 重新启动面板会自动清理；或手动 `taskkill /IM yogurt.exe /F` / `pkill -f yogurt.kexe` |
| 用 Docker 跑 yogurt 怎么办 | 面板管的是**进程**，不是容器。要么把面板和 yogurt 装进同一个镜像/容器（入口改成 panel → 它再拉起 yogurt），要么让面板直接管理宿主上的二进制。纯容器内的 yogurt，掉线时面板 kill 不到，需要改造成 `docker stop` 方案 |

---

## 12. 自测

不需要装 yogurt、不需要联网，验证平台映射、`/proc` 解析、内置 zip、版本比较、进程识别等逻辑：

```bash
node scripts/selftest.js      # 或 npm run selftest
```

```
[1] 平台映射（exe 名字 / 发版包名）   ok
[2] Linux /proc 解析                 ok（用假 /proc 目录跑解析）
[3] 内置 zip 解压（更新包用）         ok（stored + deflate）
[4] 版本比较（更新判定）              ok
[5] 进程识别                         ok
[6] 基础工具                         ok
[7] 采样聚合                         ok
[8] 实际监听地址解析                 ok（netstat / /proc/net/tcp / 配置不匹配提示）
全部通过：19 项
```

---

## 13. 设计取舍（为什么这样写）

- **零依赖**：这类「看家」工具最怕装依赖失败/被墙。SMTP 客户端、zip 解压、SSE、采样都是用内置模块手写的。
- **跨平台只隔离在三个文件**：`platform.js`（二进制名/包名/执行位）、`procs.js`（进程枚举与结束）、`metrics.js` 的采样后端。业务逻辑和 UI 完全共用。
- **不需要 Yogurt 配合**：不上插件、不改协议端，纯外部观察（stdout + HTTP 探活），换任何 Milky 协议端都还能用（改一下探活路径即可）。
- **宁可停不可撞**：掉线后不动进程树以外的任何东西，不自动重连，交给人判断。
- **状态都在 data/**：换机器只要拷 `data/` 就能整体搬家（`dist/` 和 `backups/` 可以不拷；账号目录里的二进制要换成本平台的）。
