param([ValidateRange(1,65535)][int]$Port = 4173)
$taskNode = Get-Command node -ErrorAction SilentlyContinue
if (-not $taskNode) { throw 'Node.js is required. Install it from nodejs.org, then run this script again.' }
& $taskNode.Source (Join-Path $PSScriptRoot 'server.mjs') --port $Port
