#Requires -Version 5.1
$ErrorActionPreference = "Stop"

# Pull the local Gemma models that power Pythos's on-device brain.
#   gemma4:12b - default, best tool calling (~7.6 GB, 256K context)
#   gemma4:e2b - low-resource fallback for modest hardware (~1-2 GB)
#
# Requires Ollama: https://ollama.com/download

$defaultModel = if ($env:PYTHOS_OLLAMA_MODEL) { $env:PYTHOS_OLLAMA_MODEL } else { "gemma4:12b" }
$lowResourceModel = if ($env:PYTHOS_OLLAMA_LOW_RESOURCE_MODEL) { $env:PYTHOS_OLLAMA_LOW_RESOURCE_MODEL } else { "gemma4:e2b" }

if (-not (Get-Command ollama -ErrorAction SilentlyContinue)) {
    Write-Error "Ollama is not installed. Install it from https://ollama.com/download"
    exit 1
}

# Make sure a server is reachable; start one in the background if not.
try {
    Invoke-WebRequest -Uri "http://127.0.0.1:11434/api/tags" -UseBasicParsing -TimeoutSec 3 | Out-Null
} catch {
    Write-Host "Ollama server not reachable on 127.0.0.1:11434; starting 'ollama serve' in the background..."
    Start-Process -FilePath "ollama" -ArgumentList "serve" -WindowStyle Hidden
    for ($i = 0; $i -lt 30; $i++) {
        try {
            Invoke-WebRequest -Uri "http://127.0.0.1:11434/api/tags" -UseBasicParsing -TimeoutSec 2 | Out-Null
            break
        } catch { Start-Sleep -Seconds 1 }
    }
}

Write-Host "Pulling default model: $defaultModel"
ollama pull $defaultModel

Write-Host "Pulling low-resource model: $lowResourceModel"
try { ollama pull $lowResourceModel } catch { Write-Warning "Could not pull $lowResourceModel (optional)." }

Write-Host "Done. Installed models:"
ollama list
