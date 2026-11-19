@echo off
setlocal
cd /d "%~dp0"
node "node_modules\@tgcloud\cli\bin\tgcloud.js" login
