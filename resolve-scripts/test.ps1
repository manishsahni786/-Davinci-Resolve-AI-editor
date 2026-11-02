param(
  [string]$FuscriptPath
)

$ErrorActionPreference = "Stop"
$ProjectRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path

if (-not $FuscriptPath -or $FuscriptPath.Trim() -eq "") {
  $candidates = @()
  $installDir = $env:AVE_RESOLVE_INSTALL_DIR

  $envFile = Join-Path $ProjectRoot ".env"
  if (-not $installDir -and (Test-Path -LiteralPath $envFile)) {
    $line = Get-Content -LiteralPath $envFile |
      Where-Object { $_ -match '^\s*AVE_RESOLVE_INSTALL_DIR\s*=' } |
      Select-Object -First 1
    if ($line) {
      $installDir = ($line -replace '^\s*AVE_RESOLVE_INSTALL_DIR\s*=\s*', '').Trim().Trim('"').Trim("'")
    }
  }

  foreach ($settingsName in @("settings.json", "settings.example.json")) {
    $settingsFile = Join-Path $ProjectRoot "config\$settingsName"
    if (-not $installDir -and (Test-Path -LiteralPath $settingsFile)) {
      try {
        $settings = Get-Content -LiteralPath $settingsFile -Raw | ConvertFrom-Json
        if ($settings.resolveInstallDir) {
          $installDir = $settings.resolveInstallDir
        }
      } catch {
        Write-Warning "Could not parse $settingsFile"
      }
    }
  }

  if ($installDir) {
    $candidates += (Join-Path $installDir "fuscript.exe")
  }

  $resolveProcess = Get-Process -Name Resolve -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($resolveProcess -and $resolveProcess.Path) {
    $candidates += (Join-Path (Split-Path -Parent $resolveProcess.Path) "fuscript.exe")
  }

  $candidates += (Join-Path $env:ProgramFiles "Blackmagic Design\DaVinci Resolve\fuscript.exe")
  $candidates += (Join-Path ${env:ProgramFiles(x86)} "Blackmagic Design\DaVinci Resolve\fuscript.exe")

  foreach ($candidate in $candidates) {
    if (Test-Path -LiteralPath $candidate) {
      $FuscriptPath = $candidate
      break
    }
  }
}

if (-not $FuscriptPath -or -not (Test-Path -LiteralPath $FuscriptPath)) {
  throw "fuscript.exe not found. Pass -FuscriptPath or set AVE_RESOLVE_INSTALL_DIR."
}

& $FuscriptPath -l lua (Join-Path $ProjectRoot "resolve-scripts\tests\run.lua")
exit $LASTEXITCODE
