param(
  [string]$ModelName = "vosk-model-en-us-0.22",
  [string]$ModelUrl = "https://alphacephei.com/vosk/models/vosk-model-en-us-0.22.zip",
  [switch]$Force
)

$ErrorActionPreference = "Stop"

$root = Split-Path -Parent $PSScriptRoot
$voskDir = Join-Path $root "Models\vosk"
$targetDir = Join-Path $voskDir $ModelName

if ((Test-Path $targetDir) -and -not $Force) {
  Write-Host "Vosk model already installed at $targetDir"
  exit 0
}

New-Item -ItemType Directory -Force $voskDir | Out-Null

$tempDir = Join-Path ([System.IO.Path]::GetTempPath()) "pythos-vosk-model"
$zipPath = Join-Path $tempDir "$ModelName.zip"

if (Test-Path $tempDir) {
  Remove-Item -LiteralPath $tempDir -Recurse -Force
}
New-Item -ItemType Directory -Force $tempDir | Out-Null

Write-Host "Downloading $ModelName..."
Invoke-WebRequest -Uri $ModelUrl -OutFile $zipPath

if ((Test-Path $targetDir) -and $Force) {
  Remove-Item -LiteralPath $targetDir -Recurse -Force
}

Write-Host "Extracting to $voskDir..."
Expand-Archive -LiteralPath $zipPath -DestinationPath $voskDir -Force

if (-not (Test-Path $targetDir)) {
  throw "Expected model folder was not created: $targetDir"
}

Remove-Item -LiteralPath $tempDir -Recurse -Force
Write-Host "Installed Vosk model to $targetDir"
