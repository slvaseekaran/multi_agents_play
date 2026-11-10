<#
 Builds the Agent Dashboard desktop app and creates a Windows shortcut. Run from Windows PowerShell:

   powershell -ExecutionPolicy Bypass -File \\wsl.localhost\<Distro>\...\scripts\install-windows.ps1
   (or double-click Install-AgentDashboard.cmd in the project folder)

 Options:  -Distro <name>            WSL distribution (default: your default distro)
           -InstallPrerequisites     install Rust + Visual Studio Build Tools via winget if missing (asks for admin)
#>
param([string]$Distro = '', [switch]$InstallPrerequisites)
$ErrorActionPreference = 'Stop'
function Step($m) { Write-Host "`n==> $m" -ForegroundColor Green }
function Have($c) { [bool](Get-Command $c -ErrorAction SilentlyContinue) }

# --- WSL distro + project location (as a Linux path)
if (-not $Distro) {
  $line = (wsl.exe -l -v | ForEach-Object { $_ -replace "`0", '' } | Where-Object { $_ -match '^\s*\*' } | Select-Object -First 1)
  $Distro = ($line -replace '^\s*\*\s*', '' -split '\s+')[0]
}
if (-not $Distro) { throw 'No WSL distribution found.' }
$ProjectWin = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..')).TrimEnd('\')
if ($ProjectWin -match '^\\\\(wsl\.localhost|wsl\$)\\[^\\]+(\\.*)$') {
  $ProjectLinux = $Matches[2].Replace('\', '/')            # \\wsl.localhost\Distro\home\me\x -> /home/me/x
} else {
  $ProjectLinux = (wsl.exe -d $Distro wslpath -a $ProjectWin).Trim()   # project on a Windows drive
}
Write-Host "WSL distro : $Distro`nProject    : $ProjectLinux"

# --- prerequisites
Step 'Checking prerequisites'
$vswhere = "${env:ProgramFiles(x86)}\Microsoft Visual Studio\Installer\vswhere.exe"
$haveMsvc = (Test-Path $vswhere) -and [bool](& $vswhere -products * -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath)
$haveRust = (Have 'cargo') -or (Test-Path "$env:USERPROFILE\.cargo\bin\cargo.exe")
$missing = @()
if (-not (Have 'node')) { $missing += 'Node.js (winget install OpenJS.NodeJS.LTS)' }
if (-not $haveRust)     { $missing += 'Rust (winget install Rustlang.Rustup)' }
if (-not $haveMsvc)     { $missing += 'Visual Studio Build Tools with the C++ workload (winget install Microsoft.VisualStudio.2022.BuildTools)' }
if ($missing.Count -gt 0) {
  if (-not $InstallPrerequisites) {
    Write-Host 'Missing prerequisites:' -ForegroundColor Yellow; $missing | ForEach-Object { Write-Host "  - $_" }
    throw 'Install them (or re-run with -InstallPrerequisites), then run this script again.'
  }
  if (-not (Have 'node')) { winget install --id OpenJS.NodeJS.LTS -e --accept-package-agreements --accept-source-agreements }
  if (-not $haveRust)     { winget install --id Rustlang.Rustup -e --accept-package-agreements --accept-source-agreements }
  if (-not $haveMsvc)     { winget install --id Microsoft.VisualStudio.2022.BuildTools -e --accept-package-agreements --accept-source-agreements --override '--quiet --wait --norestart --add Microsoft.VisualStudio.Workload.VCTools --includeRecommended' }
  $env:Path = [Environment]::GetEnvironmentVariable('Path', 'Machine') + ';' + [Environment]::GetEnvironmentVariable('Path', 'User') + ";$env:USERPROFILE\.cargo\bin"
  if (-not (Have 'cargo')) { throw 'Rust was installed but is not on PATH yet. Open a new PowerShell window and re-run this script.' }
}
$env:Path += ";$env:USERPROFILE\.cargo\bin"
if (-not (Have 'rustc')) { rustup default stable-x86_64-pc-windows-msvc }

# --- backend inside WSL
Step 'Preparing the backend inside WSL'
wsl.exe -d $Distro --cd $ProjectLinux -- bash scripts/install-backend.sh
if ($LASTEXITCODE -ne 0) { throw 'Backend setup failed.' }

# --- build on the Windows disk (cargo/npm are slow and fragile on \\wsl$ paths)
$Root  = Join-Path $env:LOCALAPPDATA 'AgentDashboard'
$Build = Join-Path $Root 'build'
Step "Syncing sources to $Build"
New-Item -ItemType Directory -Force $Build | Out-Null
robocopy $ProjectWin $Build /MIR /XD node_modules target dist .venv legacy-node data .git gen /XF *.pyc /NFL /NDL /NJH /NJS /NP | Out-Null
if ($LASTEXITCODE -ge 8) { throw 'Source sync failed.' }

Push-Location $Build
try {
  Step 'Installing UI dependencies'
  npm ci --no-audit --no-fund
  if ($LASTEXITCODE -ne 0) { throw 'npm ci failed' }
  Step 'Building the desktop app (first build downloads and compiles crates: several minutes)'
  npx tauri build --no-bundle
  if ($LASTEXITCODE -ne 0) { throw 'tauri build failed' }
} finally { Pop-Location }

# --- install
Step 'Installing'
$Exe = Join-Path $Root 'AgentDashboard.exe'
Get-Process AgentDashboard -ErrorAction SilentlyContinue | Stop-Process -Force
Start-Sleep 3
Copy-Item (Join-Path $Build 'src-tauri\target\release\agent-dashboard.exe') $Exe -Force

$Cfg = Join-Path $env:APPDATA 'AgentDashboard'
New-Item -ItemType Directory -Force $Cfg | Out-Null
@{ distro = $Distro; backendDir = "$ProjectLinux/backend"; port = 7777 } | ConvertTo-Json | Set-Content (Join-Path $Cfg 'config.json') -Encoding ascii

$ws = New-Object -ComObject WScript.Shell
foreach ($dir in @([Environment]::GetFolderPath('Desktop'), (Join-Path ([Environment]::GetFolderPath('Programs')) ''))) {
  $lnk = $ws.CreateShortcut((Join-Path $dir 'Agent Dashboard.lnk'))
  $lnk.TargetPath = $Exe; $lnk.WorkingDirectory = $Root; $lnk.IconLocation = "$Exe,0"; $lnk.Description = 'Claude Code agent dashboard (WSL2)'
  $lnk.Save()
}
Write-Host "`nDone. Launch 'Agent Dashboard' from your Desktop or Start menu." -ForegroundColor Green
Write-Host "Backend log: $env:LOCALAPPDATA\AgentDashboard\backend.log"
