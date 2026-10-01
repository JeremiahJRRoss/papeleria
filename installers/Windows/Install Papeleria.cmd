@echo off
rem Installs Papeleria for this Windows account. Double-click this file.
rem It runs install.ps1, beside it, with Windows PowerShell; README.md, one
rem folder up, says what it does. Nothing needs an administrator.
setlocal
"%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe" -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0install.ps1" %*
set "papeleria_status=%ERRORLEVEL%"
echo.
pause
exit /b %papeleria_status%
