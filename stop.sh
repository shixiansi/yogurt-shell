#!/usr/bin/env bash
# 优雅停止：先停掉所有账号，再退出面板
set -e
cd "$(dirname "$0")"
node -e '
const fs = require("fs");
const port = JSON.parse(fs.readFileSync("data/config.json", "utf8")).panel.port;
fetch("http://127.0.0.1:" + port + "/api/panel/shutdown", { method: "POST" })
  .then((r) => r.text())
  .then((t) => console.log("已请求停止，面板会先停掉所有账号：" + t))
  .catch(() => console.log("面板似乎没在运行（或端口不是 " + port + "）"));
'
