<#
The Papeleria launcher. The Start menu's Papeleria runs it in a console
window. It asks what to open, lets you pick the folder with the Windows folder
picker, makes a new piece when asked, and runs the editor in this window:
Ctrl C, or closing the window, stops the editor. The installer copies it into
%LOCALAPPDATA%\Programs\Papeleria, beside runtime\ and app\.

Written for Windows PowerShell 5.1 and later, in plain ASCII (see install.ps1).
#>
$ErrorActionPreference = 'Stop'

$node = Join-Path $PSScriptRoot 'runtime\node.exe'
$cli = Join-Path $PSScriptRoot 'app\lib\src\cli\index.js'

function Wait-Return([string]$Text) {
  Write-Host ''
  [void](Read-Host $Text)
}

# A folder typed or pasted, where no picker can be shown.
function Read-Folder([string]$Description) {
  Write-Host ''
  Write-Host $Description
  $typed = (Read-Host "Type or paste the folder's path (Enter alone goes back)").Trim().Trim('"')
  if (-not $typed) { return $null }
  if (-not (Test-Path -LiteralPath $typed -PathType Container)) {
    Write-Host "There is no folder at $typed."
    return $null
  }
  return (Resolve-Path -LiteralPath $typed).Path
}

# Select-Folder: the folder picked, or $null when the picker was cancelled.
function Select-Folder([string]$Description) {
  try {
    Add-Type -AssemblyName System.Windows.Forms
    $dialog = New-Object System.Windows.Forms.FolderBrowserDialog
    $owner = New-Object System.Windows.Forms.Form
  } catch {
    return Read-Folder $Description
  }
  try {
    $dialog.Description = $Description
    $dialog.ShowNewFolderButton = $true
    $dialog.SelectedPath = [Environment]::GetFolderPath('MyDocuments')
    # An owner that stays on top keeps the picker in front of this window.
    $owner.TopMost = $true
    $owner.ShowInTaskbar = $false
    if ($dialog.ShowDialog($owner) -eq [System.Windows.Forms.DialogResult]::OK) { return $dialog.SelectedPath }
    return $null
  } finally {
    $owner.Dispose()
    $dialog.Dispose()
  }
}

# Runs the CLI in this window, from the folder above the piece, so that its
# messages name the piece by its folder's name. Call it as a statement and
# read $script:Status: a function's value would take in what the CLI prints.
function Invoke-Papeleria([string]$Command, [string]$Folder, [string[]]$Before) {
  $script:Status = 1
  $parent = Split-Path -Parent $Folder
  $target = $Folder
  if ($parent) {
    Push-Location -LiteralPath $parent
    $target = Split-Path -Leaf $Folder
  }
  try {
    & $node $cli $Command @Before $target
    $script:Status = $LASTEXITCODE
  } finally {
    if ($parent) { Pop-Location }
  }
}

function Start-Editor([string]$Folder) {
  Write-Host ''
  Invoke-Papeleria 'edit' $Folder @()
  if ($script:Status -ne 0) { Wait-Return 'The editor stopped with an error. Press Enter to close this window' }
  exit $script:Status
}

function Open-Piece {
  $folder = Select-Folder 'Choose the piece folder: the one that holds papeleria.yaml.'
  if (-not $folder) { return }
  if (-not (Test-Path -LiteralPath (Join-Path $folder 'papeleria.yaml')) -and -not (Test-Path -LiteralPath (Join-Path $folder 'papeleria.json'))) {
    Write-Host ''
    Write-Host "$folder holds no papeleria.yaml, so it is not a Papeleria piece. Choose the folder that holds it, or make a new piece."
    return
  }
  Start-Editor $folder
}

function New-Piece([string]$Template) {
  $place = Select-Folder "Choose where the new $Template goes. An empty folder becomes the $Template itself: Make New Folder makes one."
  if (-not $place) { return }
  if (@(Get-ChildItem -LiteralPath $place -Force -ErrorAction SilentlyContinue).Count -eq 0) {
    $folder = $place
  } else {
    Write-Host ''
    Write-Host "$place is not empty, so the $Template goes in a new folder inside it."
    $name = (Read-Host "Name for the new folder [my-$Template]").Trim()
    if (-not $name) { $name = "my-$Template" }
    if ($name -eq '.' -or $name -eq '..' -or $name.IndexOfAny([System.IO.Path]::GetInvalidFileNameChars()) -ge 0) {
      Write-Host 'That cannot be a folder name; nothing was made.'
      return
    }
    $folder = Join-Path $place $name
  }
  Write-Host ''
  Invoke-Papeleria 'new' $folder @($Template)
  if ($script:Status -ne 0) {
    Wait-Return 'Nothing was made. Press Enter to go back'
    return
  }
  Start-Editor $folder
}

$Host.UI.RawUI.WindowTitle = 'Papeleria'
if (-not (Test-Path -LiteralPath $node) -or -not (Test-Path -LiteralPath $cli)) {
  Write-Host "This Papeleria installation is incomplete: $cli is missing. Run the Papeleria installer again."
  Wait-Return 'Press Enter to close this window'
  exit 2
}
$version = (& $node $cli --version | Out-String).Trim()

while ($true) {
  Write-Host ''
  Write-Host "Papeleria $version"
  Write-Host ''
  Write-Host '  1  Open a piece in the editor'
  Write-Host '  2  Make a new deck'
  Write-Host '  3  Make a new comic'
  Write-Host '  4  Make a new document'
  Write-Host '  q  Quit'
  Write-Host ''
  $choice = Read-Host 'Type 1, 2, 3, 4 or q, then press Enter'
  if ($null -eq $choice) { exit 0 }
  switch ($choice.Trim()) {
    '1' { Open-Piece }
    '2' { New-Piece 'deck' }
    '3' { New-Piece 'comic' }
    '4' { New-Piece 'document' }
    'q' { exit 0 }
    'Q' { exit 0 }
  }
}
