@echo off
rem Removes Papeleria from this Windows account. Double-click this file.
rem It runs uninstall.ps1, beside it, with Windows PowerShell. Your pieces are
rem never touched. Settings > Apps > Installed apps can uninstall it too.
setlocal
"%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe" -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0uninstall.ps1" %*
set "papeleria_status=%ERRORLEVEL%"
echo.
pause
exit /b %papeleria_status%
