<#
.SYNOPSIS
  Windows Watchdog & Health Check for zalo-tg bridge.
.DESCRIPTION
  Checks if the zalo-tg node process is running. If not running, launches a new
  visible PowerShell session executing 'npm start' in the project directory.
  Can be scheduled via Windows Task Scheduler to run every 1 hour.
#>

[CmdletBinding()]
param(
  [string]$ProjectPath = "C:\Users\it-115\Downloads\Thien\Zalo_Tg\zalo-tg"
)

$ErrorActionPreference = 'SilentlyContinue'

# Identify if node running index.ts / dist/index.js is active
$runningProcesses = Get-CimInstance Win32_Process | Where-Object {
  ($_.Name -match 'node\.exe' -or $_.Name -match 'tsx\.cmd') -and 
  ($_.CommandLine -match 'zalo-tg' -or $_.CommandLine -match 'src/index\.ts' -or $_.CommandLine -match 'dist/index\.js')
}

$timestamp = (Get-Date).ToString("yyyy-MM-dd HH:mm:ss")

if ($runningProcesses) {
  Write-Host "[$timestamp] [Watchdog] zalo-tg is running (PID(s): $($runningProcesses.ProcessId -join ', '))."
} else {
  Write-Host "[$timestamp] [Watchdog] zalo-tg is NOT running! Spawning new instance..." -ForegroundColor Yellow
  
  if (Test-Path $ProjectPath) {
    # Launch in a new PowerShell window with interactive console / TUI
    $startCmd = "Set-Location '$ProjectPath'; npm start"
    Start-Process powershell.exe -ArgumentList "-NoExit", "-Command", $startCmd -WorkingDirectory $ProjectPath
    Write-Host "[$timestamp] [Watchdog] Process spawned successfully in a new console." -ForegroundColor Green
  } else {
    Write-Error "[$timestamp] [Watchdog] Project path not found: $ProjectPath"
  }
}
