$ErrorActionPreference = "Stop"

$source = Join-Path (Split-Path -Parent $PSScriptRoot) ".pi\models.json"
$targetDir = Join-Path $HOME ".pi\agent"
$target = Join-Path $targetDir "models.json"

New-Item -ItemType Directory -Force $targetDir | Out-Null
Copy-Item -LiteralPath $source -Destination $target -Force
Write-Host "Installed Pi Gemini model config to $target"
