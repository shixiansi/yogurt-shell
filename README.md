# Yogurt Shell

给 [Yogurt](https://acidify.ntqqrev.org/docs/yogurt/start)（Milky 协议端）套的一层「壳」：**本地网页面板 + 进程守护 + 掉线停机 + 邮件通知 + 资源/日志监控 + 一键更新 + 多账号多开**。

零第三方依赖（只用 Node.js 内置模块 + Windows 自带 PowerShell 采样），不用 `npm install` 就能跑。

![面板](docs/panel.png)

---

## 1. 它解决什么问题

| 原来的痛点 | 现在 |
| --- | --- |
| 账号掉线后，上游（xunlu-core 等）还在不停调 `/api/...`，一直空转刷日志 | 面板探活 + 日志特征双重判定，**掉线即 `taskkill` 掉 yogurt 进程**，请求立刻 fast-fail，等人工恢复；不会偷偷自动重连去撞风控 |
| 掉线了没人知道 | 掉线 / 进程异常退出都会发邮件到你配好的邮箱（可多个收件人），邮件里带账号、端口、PID、运行时长、版本、**最后 40 行日志**和处置建议 |
| 看不到 yogurt 吃了多少 CPU/内存、日志在哪 | 卡片上实时显示 CPU（整机%）/ 内存 / 线程 / 句柄 + 4.5 分钟曲线；日志按账号落盘、可实时流式查看、过滤、下载 |
| 升级要手动停进程、换 exe、再重启 | 面板里点「更新」：查 GitHub Releases → 下载 → sha256 校验 → 解压 → 停账号 → 换 exe（旧 exe 自动备份）→ 重新拉起；github.com 直连不通时自动走镜像 |
| 想挂多个号只能复制一堆文件夹、怕端口冲突 | 每个账号一个目录（自己的 `config.json` / `session-store.json` / 日志），端口自动分配与校验，面板统一启停 |
| 面板被强杀后残留进程占着端口 | 面板启动时自动清理自己账号目录下的 `yogurt.exe` 遗留进程 |

---

## 2. 快速开始

环境要求：**Windows + Node.js 18+**（实测 Node 24）。不需要 `npm install`。

```bat
:: 1) 启动面板（双击 start.cmd 也可以）
cd /d E:\lagrangeV2\yogurt-shell
node server.js

:: 2) 浏览器打开
::    http://127.0.0.1:3090/
```

启动后控制台会打印面板地址、数据目录、账号数量。**按 Ctrl+C 退出时会先停掉所有账号再退出**（保证不留无人监管的 yogurt）。

改端口：`node server.js --port 3091`，或改 `data/config.json` 里的 `panel.port`。

### 接管一个已经在跑的 yogurt

1. 先停掉原来那个 yogurt 进程（否则两个进程抢同一个 QQ 会话与端口）。
2. 面板右上角「＋ 添加账号」→「导入现有目录（接管）」→ 填原来那个目录（例如 `E:\lagrangeV2\yogurt-windows-x64 (1)`）。
3. 面板会复制 `config.json` / `app-info.json` / `session-store*.json` / `yogurt.exe` 到新账号目录（原目录不动），端口沿用原配置，然后自动拉起。

> 本项目就是这么接管的：账号 `100000001` 从 `yogurt-windows-x64 (1)` 迁移到 `data/accounts/100000001/`，会话直接可用，没有重新扫码。

---

## 3. 掉线判定与停机（核心逻辑）

每轮（默认 15s）对每个在线账号做两件事：

1. **接口探活**：`POST http://<配置的 host:port>/api/get_login_info`（带 `accessToken`），要求 `200 + status=ok + retcode=0`。
   - 连续失败 `failures` 次（默认 3）→ 判定掉线。
   - 启动后有 `graceMs` 宽限期（默认 90s），扫码/登录过程不会被误判；状态为「登录中」时不累计失败次数。
2. **日志特征匹配**：日志里出现 `被踢下线` / `您已在其他设备登录` / `登录已失效` / `KickedOffline` / `NotLoggedIn` …（可在设置里加词）→ 立即判定掉线。
   - 只匹配系统日志，**聊天内容（`Logging [...]` 行）会被跳过**，群友聊到「掉线」不会误杀。

判定掉线后依次执行：

```
标记状态「掉线停机」 → taskkill /T /F 结束进程树 → 写日志 → 记事件 → 发邮件
```

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
主机：LAPTOP-...
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

- **占用**：常驻一个 PowerShell 采样进程（`scripts/win-sampler.ps1`，每 3s 一次），按 PID 读取 CPU 时间 / 工作集 / 私有内存 / 线程数 / 句柄数，在面板里算成「整机 CPU%」并画 4.5 分钟曲线。面板本身不重启采样进程，账号增删只更新 PID 名单。
- **日志**：面板直接捕获 yogurt 的 stdout/stderr（所以不需要 Yogurt 自己写文件），逐行写入 `data/logs/<QQ号>.log`；超过 20MB 自动轮转，保留 6 份（可调）。
  - 日志抽屉里可实时跟随、按关键字/等级过滤、「隐藏聊天」只看系统日志、一键下载、清空。
  - 底部输入框可以直接向 yogurt 的 **标准输入** 发送内容：扫码登录后如果要求短信验证码 / Ticket，就在这里输入。
  - 登录二维码：Yogurt 会写 `qrcode.png` 到账号目录，面板卡片上的「二维码」按钮直接显示；日志里打印的登录链接也可以点开。

---

## 6. 更新

面板「⭯ 更新」：

- **检查更新**：读 `SaltifyDev/yogurt-releases` 最新 release（`update.repo` 可改）。
- **下载并安装**：下载 `yogurt-windows-x64.zip` → 用 `digest` 里的 sha256 校验 → 解压到 `data/dist/<tag>/` → 对每个账号：停进程 → 备份旧 exe 到 `data/backups/` → 硬链接新 exe（同盘零拷贝，失败则复制）→ 自动拉起。
- **本地 zip 安装**：没网时手动下载 zip，从面板上传安装（浏览器直传，不需要额外组件）。
- **镜像**：`github.com` 直连超时会自动改用镜像前缀（默认顺序：直连 → 已记住的镜像 → `https://gh-proxy.com/` → `https://ghfast.top/`），成功后把可用的镜像记到配置里，下次直接用。

「已安装版本」以**账号实际跑起来的版本**为准（有账号落后就会提示可更新），dist 版本单独显示。

---

## 7. 多账号

- 每个账号独立目录：`data/accounts/<QQ号>/`（`config.json`、`app-info.json`、`session-store.json`、`qrcode.png`、`yogurt.exe`）。
- 端口自动分配、冲突校验；账号配置里的 `milky.http.port` 与面板记录双向同步。
- 卡片上「配置」可以直接编辑该账号的 `config.json`（JSON 校验 + 保存后提示重启生效）。
- 「删除」会把账号目录移动到 `data/trash/`，不直接销毁。

---

## 8. 目录结构

```
yogurt-shell/
├── server.js                  # 入口：装配各模块 + HTTP 服务 + 定时任务
├── start.cmd                  # 双击启动
├── src/
│   ├── store.js               # 配置读写（data/config.json）、路径、端口分配
│   ├── logbus.js              # 每账号环形日志缓冲 + 落盘轮转 + 事件推送
│   ├── supervisor.js          # 进程守护：启停/杀进程树/状态机/探活/掉线判定
│   ├── metrics.js             # CPU/内存采样聚合与历史曲线
│   ├── notifier.js            # 事件记录 + 邮件内容组装 + 去重
│   ├── smtp.js                # 内置 SMTP 客户端
│   ├── updater.js             # GitHub release 检查/下载/校验/安装
│   ├── zipx.js                # 内置 zip 解压（stored/deflate）
│   ├── accounts.js            # 账号创建/导入/改端口/删除/配置文本
│   ├── http.js                # 路由、SSE 实时推送、静态文件、令牌校验
│   ├── winproc.js             # 进程枚举 / 遗留进程清理
│   └── ansi.js                # 剥离 ANSI 颜色、识别日志等级
├── scripts/
│   ├── win-sampler.ps1        # 常驻采样器（NDJSON 输出）
│   └── install-autostart.ps1  # 加进「启动」文件夹，开机自启
├── public/                    # 面板前端（原生 JS，无框架）
└── data/                      # 运行时数据（不进 git）
    ├── config.json            # 面板、账号、邮件、更新、判定参数
    ├── accounts/<QQ号>/       # 每账号的 yogurt 数据目录
    ├── logs/<QQ号>.log        # 捕获的日志（轮转）
    ├── dist/<tag>/            # 下载解压后的 yogurt.exe
    ├── updates/               # 下载的 zip
    ├── backups/               # 更新前的旧 exe
    └── events.jsonl           # 事件流水（面板「事件」里的来源）
```

---

## 9. 开机自启

```powershell
powershell -ExecutionPolicy Bypass -File E:\lagrangeV2\yogurt-shell\scripts\install-autostart.ps1
```

会在当前用户的「启动」文件夹里创建一个指向 `start.cmd` 的快捷方式（窗口最小化）。不想要就删掉那个 `.lnk`。

想「不登录也跑」的话，用「任务计划程序」建一个登录时/开机时触发的任务，操作填 `start.cmd`，起始目录填项目目录。

---

## 10. 安全提醒

- 面板默认只监听 `127.0.0.1:3090`，**不要直接改成 0.0.0.0**；确实需要远程访问时，先设 `data/config.json` 的 `panel.token`（设了之后所有 `/api/*` 都要带令牌，前端会提示输入一次）。
- `data/accounts/<QQ号>/config.json` 里的密码是**明文**，`session-store.json` 等同于登录凭据，两者都不要外传、不要提交到 git。
- 掉线停机意味着账号需要人工介入（重新扫码/换签名 API/等风控过去），这是刻意的：宁可停，也不要反复请求把号撞死。

---

## 11. 常见问题

| 现象 | 原因 / 处理 |
| --- | --- |
| 面板打不开 | 端口被占：`node server.js --port 3091`；或看控制台报错 |
| 卡片一直「启动中」 | 看日志抽屉：可能是扫码登录没完成（用「二维码」按钮，或在底部输入验证码） |
| 掉线判定太灵敏 | 设置里把「连续失败次数」调大、或把探活间隔调长；`graceMs` 加长可避免启动期误判 |
| 掉线判定没生效 | 该账号的 `config.json` 里 `milky.http.port` 与面板端口不一致；重启账号让配置生效 |
| 更新失败 `fetch failed` | `github.com` 不通，填镜像前缀（如 `https://gh-proxy.com/`），或改用「本地 zip 安装」 |
| 更新后起不来 | `data/backups/` 里有旧 exe，覆盖回账号目录即可回滚；再点「启动」 |
| 更新完端口/协议不对 | 新版本可能改了配置项，面板「配置」里对照官方文档调整 |
| 日志里全是聊天内容 | 日志抽屉点「隐藏聊天」，或设置里把 `coreLogLevel` 调成 `INFO`/`WARN` |
| 面板被强杀后 yogurt 还在 | 重新启动面板会自动清理；或手动 `taskkill /IM yogurt.exe /F` |

---

## 12. 设计取舍（为什么这样写）

- **零依赖**：这类「看家」工具最怕装依赖失败/被墙。SMTP 客户端、zip 解压、SSE、采样都是用内置模块手写的。
- **不需要 Yogurt 配合**：不上插件、不改协议端，纯外部观察（stdout + HTTP 探活），换任何 Milky 协议端都还能用（改一下探活路径即可）。
- **宁可停不可撞**：掉线后不动进程树以外的任何东西，不自动重连，交给人判断。
- **状态都在 data/**：换机器只要拷 `data/` 就能整体搬家（`dist/` 和 `backups/` 可以不拷）。
