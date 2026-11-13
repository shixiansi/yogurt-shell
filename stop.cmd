@echo off
chcp 65001 >nul
setlocal
cd /d "%~dp0"
node -e "const fs=require('fs');const p=JSON.parse(fs.readFileSync('data/config.json','utf8')).panel.port;fetch('http://127.0.0.1:'+p+'/api/panel/shutdown',{method:'POST'}).then(r=>r.text()).then(t=>console.log('已请求停止，面板会先停掉所有账号：'+t)).catch(e=>console.log('面板似乎没在运行：'+e.message));"
timeout /t 2 >nul
