@echo off
setlocal
cd /d "%~dp0"
where node.exe >nul 2>&1
if errorlevel 1 goto bundled
node.exe "node_modules\@tgcloud\cli\bin\tgcloud.js" login
goto done
:bundled
powershell.exe -NoProfile -Command "$rt = Get-AppxPackage '*CodexPrimaryRuntime*' | Sort-Object Version -Descending | Select-Object -First 1; if (!$rt) { throw 'Node.js runtime unavailable' }; $node = Join-Path $rt.InstallLocation 'dependencies\node\bin\node.exe'; & $node 'node_modules/@tgcloud/cli/bin/tgcloud.js' login; exit $LASTEXITCODE"
:done
pause
