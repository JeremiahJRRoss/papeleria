<#
Removes Papeleria from this Windows account: what install.ps1 added, and the
key Papeleria keeps for its image caches. Your pieces are never touched.

Settings > Apps > Installed apps > Papeleria > Uninstall runs the copy the
installer keeps. So does "Uninstall Papeleria.cmd", in the zip or in
%LOCALAPPDATA%\Programs\Papeleria. In PowerShell:

  powershell -NoProfile -ExecutionPolicy Bypass -File uninstall.ps1

Written for Windows PowerShell 5.1 and later, in plain ASCII (see install.ps1).
#>
[CmdletBinding()]
param(
  [switch]$Yes,
  [switch]$KeepState,
  [switch]$FromSettings,
  [switch]$Help
)

$ErrorActionPreference = 'Stop'

$Mark = 'written by the Papeleria installer'
$InstallDir = Join-Path $env:LOCALAPPDATA 'Programs\Papeleria'
$BinDir = Join-Path $InstallDir 'bin'
$UninstallKey = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\Papeleria'
# The Start menu's Programs folder; GetFolderPath answers '' when it cannot find it.
$StartMenuFolder = [Environment]::GetFolderPath('Programs')
if (-not $StartMenuFolder) { $StartMenuFolder = Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs' }
$StartMenuLink = Join-Path $StartMenuFolder 'Papeleria.lnk'
$StateDir = Join-Path $env:LOCALAPPDATA 'Papeleria'

function Stop-Uninstaller([string]$Message) {
  $exception = New-Object System.InvalidOperationException $Message
  $exception.Data['PapeleriaStop'] = $true
  throw $exception
}
function Say([string]$Text) { Write-Host $Text }
function Detail([string]$Text) { Write-Host "  $Text" }
function Step([string]$Text) { Write-Host ''; Write-Host $Text }
function Warn([string]$Text) { Write-Host "Warning: $Text" -ForegroundColor Yellow }

function Show-Usage {
  Say @"
Removes Papeleria from this Windows account: the installation in
$InstallDir, the papeleria command's folder on your PATH, the Start menu
entry, the entry in Settings > Apps, and the key Papeleria keeps in
$StateDir. Your pieces are never touched.

Options:
  -Yes         Do not ask before removing
  -KeepState   Keep Papeleria's key for its image caches
  -Help        Print this help
"@
}

# A window of its own, for an uninstallation that Settings started.
function Show-Message([string]$Text, [bool]$Failed) {
  if (-not $FromSettings) { return }
  try {
    Add-Type -AssemblyName System.Windows.Forms
    $icon = [System.Windows.Forms.MessageBoxIcon]::Information
    if ($Failed) { $icon = [System.Windows.Forms.MessageBoxIcon]::Warning }
    [void][System.Windows.Forms.MessageBox]::Show($Text, 'Papeleria', [System.Windows.Forms.MessageBoxButtons]::OK, $icon)
  } catch {
    Write-Host $Text  # no desktop to show a window on
  }
}

function Test-OurFile([string]$Path) {
  return (Test-Path -LiteralPath $Path -PathType Leaf) -and ([System.IO.File]::ReadAllText($Path).Contains($Mark))
}

function Get-RecordValue([string]$Key) {
  $record = Join-Path $InstallDir 'installation.txt'
  if (-not (Test-Path -LiteralPath $record)) { return $null }
  foreach ($line in [System.IO.File]::ReadAllLines($record)) {
    if ($line.StartsWith("$Key=")) { return $line.Substring($Key.Length + 1) }
  }
  return $null
}

function Get-UserPath {
  $key = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey('Environment')
  if (-not $key) { return '' }
  try { return [string]$key.GetValue('Path', '', [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames) } finally { $key.Close() }
}

function Set-UserPath([string]$Value) {
  $key = [Microsoft.Win32.Registry]::CurrentUser.CreateSubKey('Environment')
  try {
    $kind = [Microsoft.Win32.RegistryValueKind]::ExpandString
    if ($key.GetValueNames() -contains 'Path') { $kind = $key.GetValueKind('Path') }
    $key.SetValue('Path', $Value, $kind)
  } finally { $key.Close() }
  [Environment]::SetEnvironmentVariable('PAPELERIA_INSTALLER', 'refresh', 'User')
  [Environment]::SetEnvironmentVariable('PAPELERIA_INSTALLER', $null, 'User')
}

function Test-PathEntry([string]$Entry) {
  return [Environment]::ExpandEnvironmentVariables($Entry.Trim()).TrimEnd('\') -ieq $BinDir.TrimEnd('\')
}

function Test-OurLink {
  if (-not (Test-Path -LiteralPath $StartMenuLink)) { return $false }
  $shell = New-Object -ComObject WScript.Shell
  try {
    return $shell.CreateShortcut($StartMenuLink).Arguments.Contains((Join-Path $InstallDir 'launcher.ps1'))
  } finally {
    [void][System.Runtime.InteropServices.Marshal]::ReleaseComObject($shell)
  }
}

function Test-OurUninstallEntry {
  if (-not (Test-Path -LiteralPath $UninstallKey)) { return $false }
  $location = (Get-ItemProperty -LiteralPath $UninstallKey -ErrorAction SilentlyContinue).InstallLocation
  return $location -and ($location.TrimEnd('\') -ieq $InstallDir)
}

function Remove-UninstallEntry { Remove-Item -LiteralPath $UninstallKey -Recurse -Force }

function Get-RunningPapeleria {
  return @(Get-Process -Name node -ErrorAction SilentlyContinue | Where-Object {
      $path = $null
      # Another account's process hides its path; it is not ours either way.
      try { $path = $_.Path } catch { $path = $null }
      $path -and $path.StartsWith($InstallDir + '\', [System.StringComparison]::OrdinalIgnoreCase)
    })
}

# Remove-Item alone can trip over a tree this deep, and a file an antivirus
# scanner still holds; rd gets a second go.
function Remove-Folder([string]$Folder) {
  try { Remove-Item -LiteralPath $Folder -Recurse -Force } catch { Write-Verbose $_.Exception.Message }
  if (Test-Path -LiteralPath $Folder) {
    Start-Sleep -Seconds 2
    $saved = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try { & cmd.exe /d /c rd /s /q $Folder 2>&1 | Out-Null } finally { $ErrorActionPreference = $saved }
  }
  return -not (Test-Path -LiteralPath $Folder)
}

function Uninstall-Papeleria {
  Say 'Papeleria uninstaller for Windows'
  $items = New-Object System.Collections.Generic.List[string]
  $installed = Test-OurFile (Join-Path $InstallDir 'installation.txt')
  if ($installed) {
    $version = Get-RecordValue 'version'
    $items.Add("the installation, $InstallDir" + $(if ($version) { " (Papeleria $version)" } else { '' }))
  }
  $onPath = @((Get-UserPath) -split ';' | Where-Object { $_ -ne '' -and (Test-PathEntry $_) }).Count -gt 0
  if ($onPath) { $items.Add("the papeleria command's folder, $BinDir, on your PATH") }
  $link = Test-OurLink
  if ($link) { $items.Add('Papeleria in the Start menu') }
  $entry = Test-OurUninstallEntry
  if ($entry) { $items.Add('Papeleria in Settings > Apps > Installed apps') }
  if ($items.Count -eq 0) {
    Say "Papeleria is not installed for ${env:USERNAME}: there is nothing to remove."
    if (Test-Path -LiteralPath $InstallDir) { Say "$InstallDir exists but was not made by the Papeleria installer, so it is left alone." }
    Show-Message 'Papeleria is not installed for this account: there was nothing to remove.' $false
    return
  }
  $removeKey = (-not $KeepState) -and (-not $env:PAPELERIA_STATE_HOME) -and (Test-Path -LiteralPath (Join-Path $StateDir 'installation-key'))

  Step 'This removes:'
  foreach ($item in $items) { Detail $item }
  if ($removeKey) { Detail "Papeleria's installation key, in $StateDir" }
  Say 'Your pieces, wherever they are, stay as they are.'
  if (-not $Yes -and -not $FromSettings) {
    Write-Host ''
    $answer = Read-Host 'Remove Papeleria? [y/N]'
    if ($answer -notmatch '^[yY]') { Stop-Uninstaller 'nothing was removed.' }
  }
  if ((Get-RunningPapeleria).Count -gt 0) {
    Stop-Uninstaller "Papeleria is running from $InstallDir. Stop it first (Ctrl C in its window, or close the window), then uninstall it again."
  }

  Step 'Removing'
  if ($link) {
    Remove-Item -LiteralPath $StartMenuLink -Force
    Detail 'Removed Papeleria from the Start menu'
  }
  if ($onPath) {
    Set-UserPath ((@((Get-UserPath) -split ';' | Where-Object { $_ -ne '' -and -not (Test-PathEntry $_) })) -join ';')
    Detail "Removed $BinDir from your PATH"
  }
  if ($entry) {
    Remove-UninstallEntry
    Detail 'Removed Papeleria from Settings > Apps'
  }
  if ($installed) {
    Set-Location -LiteralPath $env:TEMP
    if (-not (Remove-Folder $InstallDir)) {
      Stop-Uninstaller "$InstallDir could not be removed completely. Close anything using it, then delete what is left of it yourself."
    }
    Detail "Removed $InstallDir"
  }
  $kept = $null
  if ($KeepState) {
    $kept = "Papeleria's installation key stays in $StateDir, as asked."
  } elseif ($env:PAPELERIA_STATE_HOME) {
    $kept = 'PAPELERIA_STATE_HOME is set, so the key in the folder it names stays: that folder is yours.'
  } elseif ($removeKey) {
    Get-ChildItem -LiteralPath $StateDir -Force -ErrorAction SilentlyContinue |
      Where-Object { $_.Name -eq 'installation-key' -or $_.Name -eq 'installation-key.lock' -or $_.Name -like 'installation-key.*.tmp' } |
      Remove-Item -Recurse -Force
    if (@(Get-ChildItem -LiteralPath $StateDir -Force -ErrorAction SilentlyContinue).Count -eq 0) {
      Remove-Item -LiteralPath $StateDir -Force -ErrorAction SilentlyContinue
    }
    Detail "Removed Papeleria's installation key from $StateDir"
  }

  Step 'Papeleria is removed.'
  if ($kept) { Detail $kept }
  Detail "In each piece, dist\ and .papeleria\ are generated; delete them yourself if you no longer want them."
  Show-Message 'Papeleria is removed. Your pieces are as they were.' $false
}

# Dot-sourced (by a test), the script only defines its functions.
if ($MyInvocation.InvocationName -eq '.') { return }
if ($Help) {
  Show-Usage
  exit 0
}
try {
  Uninstall-Papeleria
  exit 0
} catch {
  Write-Host ''
  if ($_.Exception.Data.Contains('PapeleriaStop')) {
    Write-Host "The uninstaller stopped: $($_.Exception.Message)" -ForegroundColor Red
  } else {
    Write-Host "The uninstaller stopped on an unexpected error: $($_.Exception.Message)" -ForegroundColor Red
    Write-Host $_.ScriptStackTrace
  }
  Show-Message "Papeleria was not removed: $($_.Exception.Message)" $true
  exit 1
}
