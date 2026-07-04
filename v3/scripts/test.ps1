$ErrorActionPreference = "Stop"

Set-Location (Split-Path -Parent $PSScriptRoot)
if (Test-Path ".venv\Scripts\python.exe") {
  .\.venv\Scripts\python.exe -m pytest
} else {
  python -m pytest
}
npm test
