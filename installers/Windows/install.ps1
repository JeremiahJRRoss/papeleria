<#
Installs Papeleria for this Windows account. Double-click "Install Papeleria.cmd"
beside this file, which runs it; or, in PowerShell:

  powershell -NoProfile -ExecutionPolicy Bypass -File install.ps1

It downloads its own Node.js 22 (checked against the SHA-256 pinned in
shared\node-runtime.txt), installs Papeleria from the papeleria-*.tgz in the zip
into %LOCALAPPDATA%\Programs\Papeleria, puts its bin folder on your PATH, adds
Papeleria to the Start menu and to Settings > Apps > Installed apps, where it
can be uninstalled. Nothing needs an administrator. README.md, beside these
folders, has the details.

Written for Windows PowerShell 5.1, which Windows 11 includes, and later.
This file is plain ASCII on purpose: Windows PowerShell reads a script without
a byte-order mark in the system's code page.
#>
[CmdletBinding()]
param(
  [switch]$Yes,
  [string]$Tarball = '',
  [switch]$NoLauncher,
  [switch]$NoPath,
  [switch]$Help
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

$Mark = 'written by the Papeleria installer'
$InstallDir = Join-Path $env:LOCALAPPDATA 'Programs\Papeleria'
$BinDir = Join-Path $InstallDir 'bin'
$Shared = Join-Path (Split-Path -Parent $PSScriptRoot) 'shared'
$UninstallKey = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\Papeleria'
# The Start menu's Programs folder; GetFolderPath answers '' when it cannot find it.
$StartMenuFolder = [Environment]::GetFolderPath('Programs')
if (-not $StartMenuFolder) { $StartMenuFolder = Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs' }
$StartMenuLink = Join-Path $StartMenuFolder 'Papeleria.lnk'
$PowerShellExe = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
$NodeMirror = 'https://nodejs.org/dist'
if ($env:PAPELERIA_NODE_MIRROR) { $NodeMirror = $env:PAPELERIA_NODE_MIRROR.TrimEnd('/') }
$Utf8 = New-Object System.Text.UTF8Encoding $false
$script:StageRoot = $null

# Stop-Installer: ends the installation with a message for the person; the
# exception carries a mark, so the last catch tells it from an unexpected error.
function Stop-Installer([string]$Message) {
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
Installs Papeleria for this Windows account: its own Node.js, the papeleria
command and the Papeleria Start menu entry. Nothing needs an administrator.

Options:
  -Yes            Do not ask before installing
  -Tarball FILE   Install this papeleria-<version>.tgz
  -NoLauncher     Leave out the Start menu entry
  -NoPath         Do not put the papeleria command's folder on your PATH
  -Help           Print this help

Environment:
  PAPELERIA_NODE_MIRROR   A mirror of https://nodejs.org/dist to download Node.js from;
                          the file must still match the SHA-256 in node-runtime.txt
"@
}

# node-runtime.txt: "version <v>" and "<sha256>  <file>" lines.
function Get-NodePin([string]$Key) {
  foreach ($line in [System.IO.File]::ReadAllLines((Join-Path $Shared 'node-runtime.txt'))) {
    if ($line.StartsWith('#')) { continue }
    $parts = $line.Trim() -split '\s+'
    if ($parts.Count -lt 2) { continue }
    if ($Key -eq 'version' -and $parts[0] -eq 'version') { return $parts[1] }
    if ($Key -ne 'version' -and $parts[1] -eq $Key) { return $parts[0].ToLowerInvariant() }
  }
  return $null
}

# Runs a program with its output collected, whatever it writes to stderr.
function Invoke-Captured([string]$File, [string[]]$Arguments) {
  $saved = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  try {
    $lines = & $File @Arguments 2>&1 | ForEach-Object { "$_" }
    return [pscustomobject]@{ Code = $LASTEXITCODE; Text = (@($lines) -join "`n") }
  } finally {
    $ErrorActionPreference = $saved
  }
}

# The staged runtime's npm, run in a folder, its output shown as it comes.
# Call it as a statement and read $script:NpmStatus: a function's value would
# take in everything npm prints.
function Invoke-Npm([string]$Folder, [string[]]$Arguments) {
  Push-Location -LiteralPath $Folder
  $savedPath = $env:Path
  $script:NpmStatus = 1
  try {
    $env:Path = "$script:NodeDir;$env:Path"
    $env:npm_config_update_notifier = 'false'
    & (Join-Path $script:NodeDir 'node.exe') (Join-Path $script:NodeDir 'node_modules\npm\bin\npm-cli.js') @Arguments | Out-Host
    $script:NpmStatus = $LASTEXITCODE
  } finally {
    $env:Path = $savedPath
    Remove-Item Env:\npm_config_update_notifier -ErrorAction SilentlyContinue
    Pop-Location
  }
}

function Get-Tar {
  $tar = Join-Path $env:SystemRoot 'System32\tar.exe'
  if (-not (Test-Path $tar)) { Stop-Installer "$tar is missing; Windows 10 1803 and later include it." }
  return $tar
}

function Read-PackageJson([string]$TarballPath) {
  $result = Invoke-Captured (Get-Tar) @('-xzOf', $TarballPath, 'package/package.json')
  if ($result.Code -ne 0) { return $null }
  try { return $result.Text | ConvertFrom-Json } catch { return $null }
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

function Get-RunningPapeleria {
  return @(Get-Process -Name node -ErrorAction SilentlyContinue | Where-Object {
      $path = $null
      # Another account's process hides its path; it is not ours either way.
      try { $path = $_.Path } catch { $path = $null }
      $path -and $path.StartsWith($InstallDir + '\', [System.StringComparison]::OrdinalIgnoreCase)
    })
}

function Get-WindowsBuild { return [Environment]::OSVersion.Version.Build }

function Test-Administrator {
  $principal = [Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()
  return $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}

function Get-MachineArchitecture {
  $arch = $null
  try {
    $arch = (Get-ItemProperty 'HKLM:\SYSTEM\CurrentControlSet\Control\Session Manager\Environment' -Name PROCESSOR_ARCHITECTURE).PROCESSOR_ARCHITECTURE
  } catch {
    $arch = $null  # the process's own view follows
  }
  if (-not $arch) { $arch = $env:PROCESSOR_ARCHITECTURE }
  switch ($arch) {
    'AMD64' { return 'x64' }
    'ARM64' { return 'arm64' }
    default { Stop-Installer "Node.js 22 has no Windows build for this processor ($arch). Papeleria needs an x64 or ARM64 PC." }
  }
}

function Find-PapeleriaPackage {
  if ($Tarball) {
    if (-not (Test-Path -LiteralPath $Tarball -PathType Leaf)) { Stop-Installer "$Tarball does not exist." }
    return @{ Tarball = (Resolve-Path -LiteralPath $Tarball).Path; Source = $null }
  }
  $found = @(Get-ChildItem -LiteralPath (Split-Path -Parent $PSScriptRoot) -Filter 'papeleria-*.tgz' -File -ErrorAction SilentlyContinue)
  if ($found.Count -gt 1) { Stop-Installer 'there is more than one papeleria-*.tgz next to this folder. Keep the one to install, or name it with -Tarball.' }
  if ($found.Count -eq 1) { return @{ Tarball = $found[0].FullName; Source = $null } }
  # A download of the repository: installers\Windows sits in the application root.
  $source = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
  $manifest = Join-Path $source 'package.json'
  if (Test-Path -LiteralPath $manifest) {
    $json = $null
    try { $json = [System.IO.File]::ReadAllText($manifest) | ConvertFrom-Json } catch { $json = $null }
    if ($json -and $json.name -eq 'papeleria') { return @{ Tarball = $null; Source = $source } }
  }
  Stop-Installer 'no papeleria-<version>.tgz is next to this folder, and this is not a copy of the repository to build one from. Run the installer from the extracted Papeleria zip.'
}

function Install-Node([string]$Folder, [string]$Archive) {
  $version = Get-NodePin 'version'
  $expected = Get-NodePin $Archive
  if (-not $version -or -not $expected) { Stop-Installer "node-runtime.txt names no $Archive." }
  $url = "$NodeMirror/v$version/$Archive"
  $download = Join-Path $script:StageRoot $Archive
  Detail "Downloading $url"
  try {
    [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
    Invoke-WebRequest -Uri $url -OutFile $download -UseBasicParsing
  } catch {
    Stop-Installer "$url could not be downloaded ($($_.Exception.Message)). Check the network connection and any proxy settings, then run the installer again."
  }
  $actual = (Get-FileHash -LiteralPath $download -Algorithm SHA256).Hash.ToLowerInvariant()
  if ($actual -ne $expected) {
    Stop-Installer "the download's SHA-256 is $actual, not $expected as node-runtime.txt pins, so it was not used. Run the installer again; if this repeats, the file served is not the Node.js release the installer names."
  }
  Detail "SHA-256 matches the pinned $expected"
  Add-Type -AssemblyName System.IO.Compression.FileSystem
  $unpacked = Join-Path $script:StageRoot 'node-unpacked'
  [System.IO.Compression.ZipFile]::ExtractToDirectory($download, $unpacked)
  $top = @(Get-ChildItem -LiteralPath $unpacked -Directory)
  if ($top.Count -ne 1) { Stop-Installer "$Archive does not hold the one folder a Node.js release holds." }
  Move-Item -LiteralPath $top[0].FullName -Destination $Folder
  Remove-Item -LiteralPath $unpacked, $download -Recurse -Force
  $node = Join-Path $Folder 'node.exe'
  $ran = Invoke-Captured $node @('--version')
  if ($ran.Code -ne 0 -or $ran.Text.Trim() -ne "v$version") { Stop-Installer "the unpacked Node.js does not run on this computer ($node)." }
}

function Build-FromSource([string]$Source, [string]$Destination) {
  $hadModules = Test-Path -LiteralPath (Join-Path $Source 'node_modules')
  $hadLib = Test-Path -LiteralPath (Join-Path $Source 'lib')
  $cache = Join-Path $script:StageRoot 'npm-cache'
  Detail 'Installing the build tools (npm ci)'
  $env:PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD = '1'
  try {
    Invoke-Npm $Source @('ci', '--ignore-scripts', '--no-audit', '--no-fund', '--cache', $cache)
    if ($script:NpmStatus -ne 0) { Stop-Installer 'npm could not install the build tools. The messages above say why.' }
  } finally {
    Remove-Item Env:\PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD -ErrorAction SilentlyContinue
  }
  Detail 'Building (npm run build)'
  Invoke-Npm $Source @('run', 'build', '--silent')
  if ($script:NpmStatus -ne 0) { Stop-Installer 'the build failed. The messages above say why.' }
  Detail 'Packing (npm pack)'
  Invoke-Npm $Source @('pack', '--loglevel=warn', '--pack-destination', $Destination, '--cache', $cache)
  if ($script:NpmStatus -ne 0) { Stop-Installer 'npm pack failed. The messages above say why.' }
  if (-not $hadModules) { Remove-Item -LiteralPath (Join-Path $Source 'node_modules') -Recurse -Force -ErrorAction SilentlyContinue }
  if (-not $hadLib) { Remove-Item -LiteralPath (Join-Path $Source 'lib') -Recurse -Force -ErrorAction SilentlyContinue }
}

# The package and the dependency tree its npm-shrinkwrap.json pins, with no
# package's install script run (security audit F11: none of them needs one).
function Install-App([string]$TarballPath, [string]$Folder) {
  New-Item -ItemType Directory -Path $Folder -Force | Out-Null
  $result = Invoke-Captured (Get-Tar) @('-xzf', $TarballPath, '-C', $Folder, '--strip-components=1')
  if ($result.Code -ne 0) { Stop-Installer "$TarballPath could not be unpacked: $($result.Text)" }
  if (-not (Test-Path -LiteralPath (Join-Path $Folder 'npm-shrinkwrap.json'))) {
    Stop-Installer "$(Split-Path -Leaf $TarballPath) holds no npm-shrinkwrap.json, so its dependencies cannot be installed at the versions it was tested with. Use a tarball made by npm pack in the repository."
  }
  $arguments = @('ci', '--omit=dev', '--include=optional', '--ignore-scripts', '--no-audit', '--no-fund', '--cache', (Join-Path $script:StageRoot 'npm-cache'))
  Invoke-Npm $Folder $arguments
  if ($script:NpmStatus -ne 0) {
    Stop-Installer "npm could not install Papeleria's dependencies. The messages above say why; check the network connection and any proxy settings, then run the installer again."
  }
}

# The command answers, the image library loads, and a sample deck builds.
function Test-Installation([string]$Folder, [string]$Version) {
  $node = Join-Path $Folder 'runtime\node.exe'
  $cli = Join-Path $Folder 'app\lib\src\cli\index.js'
  $got = Invoke-Captured $node @($cli, '--version')
  if ($got.Code -ne 0 -or $got.Text.Trim() -ne $Version) { Stop-Installer "papeleria --version printed `"$($got.Text.Trim())`", not $Version." }
  Detail "papeleria --version: $($got.Text.Trim())"
  Push-Location (Join-Path $Folder 'app')
  try {
    # No double quotes in an argument: Windows PowerShell 5.1 does not escape them for the program.
    $library = Invoke-Captured $node @('-e', 'const s = require(''sharp''); process.stdout.write(''sharp '' + s.versions.sharp + '', libvips '' + s.versions.vips)')
  } finally { Pop-Location }
  if ($library.Code -ne 0) { Stop-Installer "the image library, sharp, does not load on this computer: $($library.Text)" }
  Detail "Image library: $($library.Text)"
  $scratch = Join-Path $script:StageRoot 'check'
  New-Item -ItemType Directory -Path $scratch -Force | Out-Null
  $env:PAPELERIA_STATE_HOME = Join-Path $scratch 'state'
  $env:PAPELERIA_NO_BROWSER = '1'
  Push-Location $scratch
  try {
    $made = Invoke-Captured $node @($cli, 'new', 'deck', 'check-deck')
    $built = $null
    if ($made.Code -eq 0) { $built = Invoke-Captured $node @($cli, 'build', 'check-deck') }
  } finally {
    Pop-Location
    Remove-Item Env:\PAPELERIA_STATE_HOME, Env:\PAPELERIA_NO_BROWSER -ErrorAction SilentlyContinue
  }
  if ($made.Code -ne 0 -or $built.Code -ne 0) {
    if ($made.Code -ne 0) { Write-Host $made.Text } else { Write-Host $built.Text }
    Stop-Installer 'a sample deck did not build with the new installation.'
  }
  Detail "Sample deck: $(@($built.Text -split "`n")[-1])"
  Remove-Item -LiteralPath $scratch -Recurse -Force
}

function Write-TextFile([string]$Path, [string]$Text) {
  [System.IO.File]::WriteAllText($Path, $Text, $Utf8)
}

# The papeleria command. It finds the installation from its own folder, so
# the file stays plain ASCII whatever the path holds; cmd.exe reads batch files
# in the console's code page.
function Write-CommandShim([string]$Folder) {
  New-Item -ItemType Directory -Path (Join-Path $Folder 'bin') -Force | Out-Null
  $text = "@echo off`r`n" +
    "rem The papeleria command, $Mark; the Papeleria uninstaller removes it.`r`n" +
    "`"%~dp0..\runtime\node.exe`" `"%~dp0..\app\lib\src\cli\index.js`" %*`r`n"
  Write-TextFile (Join-Path $Folder 'bin\papeleria.cmd') $text
}

function Get-UserPath {
  $key = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey('Environment')
  if (-not $key) { return '' }
  try { return [string]$key.GetValue('Path', '', [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames) } finally { $key.Close() }
}

# Writes the user's Path as the kind of value it was, then tells running
# programs, Explorer among them, so that new terminals see the change.
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

function Test-PathEntry([string]$Entry, [string]$Folder) {
  $expanded = [Environment]::ExpandEnvironmentVariables($Entry.Trim()).TrimEnd('\')
  return $expanded -ieq $Folder.TrimEnd('\')
}

function Add-ToUserPath([string]$Folder) {
  $current = Get-UserPath
  $entries = @($current -split ';' | Where-Object { $_ -ne '' })
  foreach ($entry in $entries) {
    if (Test-PathEntry $entry $Folder) { return $false }
  }
  Set-UserPath ((@($entries) + $Folder) -join ';')
  return $true
}

function New-StartMenuLink([string]$Icon) {
  New-Item -ItemType Directory -Path $StartMenuFolder -Force | Out-Null
  $shell = New-Object -ComObject WScript.Shell
  try {
    $link = $shell.CreateShortcut($StartMenuLink)
    $link.TargetPath = $PowerShellExe
    $link.Arguments = "-NoLogo -NoProfile -ExecutionPolicy Bypass -File `"$(Join-Path $InstallDir 'launcher.ps1')`""
    $link.WorkingDirectory = [Environment]::GetFolderPath('MyDocuments')
    $link.Description = 'Make and edit decks, comics and printable documents'
    if ($Icon) { $link.IconLocation = "$Icon,0" }
    $link.Save()
  } finally {
    [void][System.Runtime.InteropServices.Marshal]::ReleaseComObject($shell)
  }
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

function Register-Uninstall([string]$Version, [string]$Icon) {
  $size = (Get-ChildItem -LiteralPath $InstallDir -Recurse -File -Force | Measure-Object -Property Length -Sum).Sum
  New-Item -Path $UninstallKey -Force | Out-Null
  $values = [ordered]@{
    DisplayName     = 'Papeleria'
    DisplayVersion  = $Version
    Publisher       = 'Ross.moda'
    Comments        = 'Makes decks, comics and printable documents from folders of text, data and images'
    InstallLocation = $InstallDir
    InstallDate     = (Get-Date).ToString('yyyyMMdd')
    DisplayIcon     = $(if ($Icon) { $Icon } else { Join-Path $InstallDir 'runtime\node.exe' })
    UninstallString = "`"$PowerShellExe`" -NoLogo -NoProfile -ExecutionPolicy Bypass -File `"$(Join-Path $InstallDir 'uninstall.ps1')`" -FromSettings"
  }
  foreach ($name in $values.Keys) {
    New-ItemProperty -Path $UninstallKey -Name $name -Value $values[$name] -PropertyType String -Force | Out-Null
  }
  foreach ($name in @('NoModify', 'NoRepair')) {
    New-ItemProperty -Path $UninstallKey -Name $name -Value 1 -PropertyType DWord -Force | Out-Null
  }
  New-ItemProperty -Path $UninstallKey -Name 'EstimatedSize' -Value ([int]($size / 1KB)) -PropertyType DWord -Force | Out-Null
}

function Remove-Stage {
  if ($script:StageRoot -and (Test-Path -LiteralPath $script:StageRoot)) {
    Remove-Item -LiteralPath $script:StageRoot -Recurse -Force -ErrorAction SilentlyContinue
  }
}

function Install-Papeleria {
  Say 'Papeleria installer for Windows'
  if ($env:OS -ne 'Windows_NT') { Stop-Installer 'this is the installer for Windows. Use the one in the macOS or Ubuntu folder.' }
  $build = Get-WindowsBuild
  if ($build -lt 17763) { Stop-Installer "this is Windows build $build; Node.js 22 needs Windows 10 1809 or later, and Papeleria's target is Windows 11." }
  if ($build -lt 22000) { Warn "this is Windows 10 (build $build). The installer is written for Windows 11 and is expected to work here, but that has not been tried." }
  if (Test-Administrator) {
    Warn 'this window runs as an administrator, which the installer does not need. It installs for the account you signed in with.'
  }
  $arch = Get-MachineArchitecture
  $nodeVersion = Get-NodePin 'version'
  $archive = "node-v$nodeVersion-win-$arch.zip"
  $package = Find-PapeleriaPackage
  if ($package.Tarball) {
    $json = Read-PackageJson $package.Tarball
    if (-not $json -or $json.name -ne 'papeleria' -or -not $json.version) { Stop-Installer "$($package.Tarball) is not a Papeleria package." }
  } else {
    $json = [System.IO.File]::ReadAllText((Join-Path $package.Source 'package.json')) | ConvertFrom-Json
  }
  $version = [string]$json.version
  $previous = $null
  if (Test-Path -LiteralPath $InstallDir) {
    if (-not (Test-OurFile (Join-Path $InstallDir 'installation.txt'))) {
      Stop-Installer "$InstallDir exists and was not made by this installer, so it is left alone. Move it away, then run the installer again."
    }
    $previous = Get-RecordValue 'version'
  }
  $running = Get-RunningPapeleria
  if ($running.Count -gt 0) {
    Stop-Installer "Papeleria is running from $InstallDir. Stop it first (Ctrl C in its window, or close the window), then run the installer again."
  }

  Step "This installs, for $env:USERNAME only:"
  if ($package.Tarball) { Detail "Papeleria $version, from $(Split-Path -Leaf $package.Tarball)" } else { Detail "Papeleria $version, built from the source in $($package.Source)" }
  Detail "Node.js $nodeVersion, for Papeleria's use alone ($archive)"
  Detail "into $InstallDir"
  if (-not $NoPath) { Detail "the papeleria command, with $BinDir on your PATH" }
  if (-not $NoLauncher) { Detail 'Papeleria in the Start menu' }
  Detail 'Papeleria in Settings > Apps > Installed apps, to uninstall it from there'
  if ($previous) { Detail "It replaces the Papeleria $previous installed there." }
  Detail "It downloads Node.js from $NodeMirror and Papeleria's dependencies from the npm registry."
  if (-not $Yes) {
    Write-Host ''
    $answer = Read-Host 'Install? [Y/n]'
    if ($answer -match '^[nN]') { Stop-Installer 'nothing was installed.' }
  }

  # Everything is made beside the installation, then moved into place, so a
  # failure leaves any earlier installation as it was.
  $script:StageRoot = Join-Path (Split-Path -Parent $InstallDir) ".papeleria-install-$PID"
  Remove-Stage
  New-Item -ItemType Directory -Path $script:StageRoot -Force | Out-Null
  $staged = Join-Path $script:StageRoot 'Papeleria'
  New-Item -ItemType Directory -Path $staged -Force | Out-Null
  $script:NodeDir = Join-Path $staged 'runtime'

  Step "1/4  Node.js $nodeVersion"
  Install-Node $script:NodeDir $archive

  Step "2/4  Papeleria $version"
  $tarballPath = $package.Tarball
  if (-not $tarballPath) {
    Build-FromSource $package.Source $script:StageRoot
    $tarballPath = Join-Path $script:StageRoot "papeleria-$version.tgz"
    if (-not (Test-Path -LiteralPath $tarballPath)) { Stop-Installer "npm pack wrote no papeleria-$version.tgz." }
  }
  Detail 'Installing its dependencies (npm ci, at the versions the package pins)'
  Install-App $tarballPath (Join-Path $staged 'app')
  Remove-Item -LiteralPath (Join-Path $script:StageRoot 'npm-cache') -Recurse -Force -ErrorAction SilentlyContinue

  Step '3/4  Checking the new installation'
  Test-Installation $staged $version

  Step '4/4  Putting it in place'
  # Copies of the zip's files, without the download's mark: Windows treats a
  # marked script as coming from the internet each time it runs.
  foreach ($file in @('launcher.ps1', 'uninstall.ps1', 'Uninstall Papeleria.cmd')) {
    [System.IO.File]::WriteAllBytes((Join-Path $staged $file), [System.IO.File]::ReadAllBytes((Join-Path $PSScriptRoot $file)))
  }
  Write-CommandShim $staged
  $icon = $null
  if (-not $NoLauncher) {
    $made = Invoke-Captured (Join-Path $script:NodeDir 'node.exe') @((Join-Path $Shared 'make-icons.mjs'), (Join-Path $staged 'app'), 'ico', (Join-Path $staged 'papeleria.ico'))
    if ($made.Code -eq 0) { $icon = Join-Path $InstallDir 'papeleria.ico' }
  }
  $record = "# Papeleria installation, $Mark. The uninstaller reads this file.`r`n" +
    "version=$version`r`nnode=$nodeVersion`r`ninstalled=$((Get-Date).ToUniversalTime().ToString("yyyy-MM-dd'T'HH:mm:ss'Z'"))`r`n"
  Write-TextFile (Join-Path $staged 'installation.txt') $record

  if (Test-Path -LiteralPath $InstallDir) {
    try {
      Move-Item -LiteralPath $InstallDir -Destination (Join-Path $script:StageRoot 'previous')
    } catch {
      Stop-Installer "the installation in $InstallDir could not be moved aside ($($_.Exception.Message)). Close anything using it, then run the installer again."
    }
  }
  try {
    Move-Item -LiteralPath $staged -Destination $InstallDir
  } catch {
    if (Test-Path -LiteralPath (Join-Path $script:StageRoot 'previous')) { Move-Item -LiteralPath (Join-Path $script:StageRoot 'previous') -Destination $InstallDir }
    Stop-Installer "the new installation could not be moved to $InstallDir ($($_.Exception.Message))."
  }
  Detail "Installed in $InstallDir"

  if (-not $NoPath) {
    if (Add-ToUserPath $BinDir) { Detail "PATH: added $BinDir, for new terminal windows" } else { Detail "PATH: $BinDir is on it already" }
  }
  if (-not $NoLauncher) {
    try {
      New-StartMenuLink $icon
      Detail 'Start menu: Papeleria'
    } catch {
      Warn "the Start menu entry could not be made ($($_.Exception.Message)). Start Papeleria from $(Join-Path $InstallDir 'launcher.ps1')."
    }
  }
  Register-Uninstall $version $icon
  Detail 'Settings > Apps > Installed apps: Papeleria'

  Step "Papeleria $version is installed."
  if (-not $NoLauncher) { Detail 'To start it:               Papeleria in the Start menu' }
  Detail 'To remove it:              Settings > Apps > Installed apps > Papeleria > Uninstall'
  Detail 'In a new terminal window:  papeleria --help'
  $other = Get-Command papeleria -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($other -and -not $other.Source.StartsWith($BinDir, [System.StringComparison]::OrdinalIgnoreCase)) {
    Warn "another papeleria, $($other.Source), comes first on your PATH. Remove it, or run $BinDir\papeleria.cmd."
  }
}

# Dot-sourced (by a test), the script only defines its functions.
if ($MyInvocation.InvocationName -eq '.') { return }
if ($Help) {
  Show-Usage
  exit 0
}
$savedEncoding = [Console]::OutputEncoding
try {
  # Node.js writes UTF-8; read what the installer collects from it as such.
  [Console]::OutputEncoding = $Utf8
  Install-Papeleria
  exit 0
} catch {
  Write-Host ''
  if ($_.Exception.Data.Contains('PapeleriaStop')) {
    Write-Host "The installer stopped: $($_.Exception.Message)" -ForegroundColor Red
  } else {
    Write-Host "The installer stopped on an unexpected error: $($_.Exception.Message)" -ForegroundColor Red
    Write-Host $_.ScriptStackTrace
  }
  exit 1
} finally {
  Remove-Stage
  [Console]::OutputEncoding = $savedEncoding
}
