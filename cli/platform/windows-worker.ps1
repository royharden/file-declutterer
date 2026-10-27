param([Parameter(Mandatory=$true)][int]$ParentPid)
$ErrorActionPreference = 'Stop'
try {
  Add-Type -Path (Join-Path $PSScriptRoot 'windows-worker.cs')
  [FileDeclutterer.NativeWorker]::Run($ParentPid)
} catch {
  [Console]::Error.WriteLine('Native helper startup failed: ' + $_.Exception.Message)
  exit 70
}
