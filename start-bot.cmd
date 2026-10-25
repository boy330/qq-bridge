@echo off
chcp 65001 >nul
setlocal
cd /d "%~dp0"

rem 优先用 PATH 里的 node；没有就用 DSH 自带的 node
where node >nul 2>nul
if %errorlevel%==0 (
  node bot.mjs
  goto :end
)

set "DSH_NODE=%USERPROFILE%\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe"
if exist "%DSH_NODE%" (
  "%DSH_NODE%" bot.mjs
  goto :end
)

echo [错误] 没找到 node，请先安装 Node.js 22 或更高版本： https://nodejs.org/
pause

:end
endlocal
