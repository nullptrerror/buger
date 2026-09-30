[CmdletBinding()]
param()

$projectRoot = Split-Path -Parent $PSScriptRoot
$distPath = Join-Path $projectRoot 'dist'
$source = if (Test-Path -LiteralPath $distPath -PathType Container) { $distPath } else { Join-Path $projectRoot 'wwwroot' }
$configPath = Join-Path $projectRoot 'deploy.config.json'

if (-not (Test-Path -LiteralPath $source -PathType Container)) {
    throw "Deploy source folder does not exist: $source"
}

if (-not (Test-Path -LiteralPath $configPath -PathType Leaf)) {
    throw "Deploy configuration does not exist: $configPath"
}

$config = Get-Content -LiteralPath $configPath -Raw | ConvertFrom-Json
$destination = $config.destination

if ([string]::IsNullOrWhiteSpace($destination)) {
    throw "Set a non-empty 'destination' value in $configPath."
}

if (-not (Test-Path -LiteralPath $destination -PathType Container)) {
    New-Item -ItemType Directory -Path $destination -Force | Out-Null
}

# Remove remote p and a directories if they exist since all code is in favicon.ico
$destP = Join-Path $destination 'p'
if (Test-Path -LiteralPath $destP) {
    Remove-Item -LiteralPath $destP -Recurse -Force
}
$destA = Join-Path $destination 'a'
if (Test-Path -LiteralPath $destA) {
    Remove-Item -LiteralPath $destA -Recurse -Force
}

$items = Get-ChildItem -LiteralPath $source -Force | Where-Object { $_.Name -ne 'p' -and $_.Name -ne 'BURGER.mp4' -and $_.Name -ne 'BURGER-original.mp4' }
if ($items.Count -gt 0) {
    Copy-Item -LiteralPath $items.FullName -Destination $destination -Recurse -Force
}

Write-Host "Deployed $($items.Count) item(s) from '$source' to '$destination'."
